import ExcelJS from 'exceljs'
import { BusinessError } from '../../utils/business-error.js'
import { emitInTx } from '../../utils/audit-log.js'
import { readSheet } from '../whatsapp-crm/prospect-import.js'
import { invalidateCatalogCaches } from './catalog-cache.js'
import { withTransaction } from './catalog-bulk.repository.js'
import { FIELDS, FIELD_LABEL, LOOKUP_ERROR, MAX_ROWS, describeChanges, diffRow, mapHeaders, productKey } from './catalog-bulk.rules.js'

const MAX_PAIRS = 20_000
const sameValue = (a, b) => (typeof b === 'boolean' || typeof a === 'boolean' ? Boolean(a) === Boolean(b) : (a == null && b == null) || (a != null && b != null && Math.round(Number(a) * 100) === Math.round(Number(b) * 100)))

/**
 * Bulk catalog (Phase 12): per-store stock, prices and availability from an Excel/CSV sheet.
 * SAFE BY DESIGN: an upload only creates a preview. Nothing is changed until a person confirms, rows with errors are
 * never applied silently, and an apply that finds the store's data changed since the preview refuses as a whole.
 */
export class CatalogBulkService {
  constructor({ repo }) {
    Object.assign(this, { repo })
  }

  // ─── upload → preview ───
  async preview({ buffer, filename, userId }) {
    let records
    try {
      records = await readSheet(buffer, filename)
    } catch (err) {
      throw new BusinessError(err.message?.startsWith('Upload a') ? err.message : 'That file could not be read. Use a .csv or .xlsx file.', 400, 'BAD_FILE')
    }
    if (records.length === 0) throw new BusinessError('The file has no rows.', 400, 'EMPTY_FILE')
    if (records.length > MAX_ROWS) throw new BusinessError(`Too many rows (${records.length}). Upload at most ${MAX_ROWS} at a time.`, 400, 'TOO_MANY_ROWS')
    const { map, unknown } = mapHeaders(Object.keys(records[0]))

    // sheet row → cells keyed by OUR column names
    const sheet = records.map((rec, i) => ({ rowNo: i + 2, raw: rec, cells: Object.fromEntries(Object.entries(map).map(([canon, h]) => [canon, rec[h] ?? ''])) }))

    const keys = sheet.map((r) => productKey(r.cells))
    const byKind = { id: new Set(), sku: new Set(), barcode: new Set() }
    keys.forEach((k) => k && byKind[k.by].add(k.value))
    const validUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    const [byId, bySku, byBarcode] = await Promise.all([
      this.repo.productsBy('id', [...byKind.id].filter(validUuid)), this.repo.productsBy('sku', [...byKind.sku]), this.repo.productsBy('barcode', [...byKind.barcode]),
    ])
    const find = (k) => {
      const list = k.by === 'id' ? byId.filter((p) => p.id === k.value.toLowerCase()) : k.by === 'sku' ? bySku.filter((p) => p.sku === k.value) : byBarcode.filter((p) => p.barcode === k.value)
      return list.length === 1 ? { product: list[0] } : { error: list.length === 0 ? LOOKUP_ERROR.UNKNOWN_PRODUCT(k.value) : LOOKUP_ERROR.AMBIGUOUS_PRODUCT(k.value) }
    }
    const codes = [...new Set(sheet.map((r) => String(r.cells.branch_code ?? '').trim()).filter(Boolean))]
    const ids = [...new Set(sheet.map((r) => String(r.cells.shop_id ?? '').trim()).filter(validUuid))]
    const shops = [...(await this.repo.shopsByCode(codes)), ...(await this.repo.shopsById(ids))]
    const shopFor = (cells) => {
      const code = String(cells.branch_code ?? '').trim()
      const id = String(cells.shop_id ?? '').trim().toLowerCase()
      const s = code ? shops.find((x) => x.branch_code === code) : shops.find((x) => x.id === id)
      if (!code && !id) return { error: LOOKUP_ERROR.NO_STORE }
      if (!s) return { error: LOOKUP_ERROR.UNKNOWN_STORE(code || id) }
      if (!s.is_active) return { error: LOOKUP_ERROR.INACTIVE_STORE(s.branch_code) }
      return { shop: s }
    }

    const resolved = sheet.map((r, i) => {
      const k = keys[i]
      if (!k) return { ...r, error: LOOKUP_ERROR.NO_PRODUCT }
      const p = find(k)
      if (p.error) return { ...r, error: p.error }
      const s = shopFor(r.cells)
      if (s.error) return { ...r, error: s.error }
      return { ...r, product: p.product, shop: s.shop }
    })
    const current = await this.repo.currentFor(resolved.filter((r) => r.product && r.shop).map((r) => ({ shopId: r.shop.id, productId: r.product.id })))
    const curBy = new Map(current.map((c) => [`${c.shop_id}:${c.product_id}`, c]))

    const firstSeen = new Map()
    const out = resolved.map((r) => {
      const base = { row_no: r.rowNo, raw: r.raw, shop_id: r.shop?.id ?? null, product_id: r.product?.id ?? null, shop_product_id: null, changes: {}, before_updated_at: null }
      if (r.error) return { ...base, status: 'ERROR', errors: [r.error] }
      const key = `${r.shop.id}:${r.product.id}`
      if (firstSeen.has(key)) return { ...base, status: 'ERROR', errors: [LOOKUP_ERROR.DUPLICATE(firstSeen.get(key))] }
      firstSeen.set(key, r.rowNo)
      const cur = curBy.get(key)
      if (!cur) return { ...base, status: 'ERROR', errors: [LOOKUP_ERROR.NOT_ASSIGNED] }
      const { errors, changes } = diffRow({ ...cur, productPrice: cur.product_price }, r.cells)
      const common = { ...base, shop_product_id: cur.id, before_updated_at: cur.updated_at }
      if (errors.length) return { ...common, status: 'ERROR', errors }
      if (Object.keys(changes).length === 0) return { ...common, status: 'UNCHANGED', errors: [] }
      return { ...common, status: 'VALID', errors: [], changes }
    })

    const valid = out.filter((r) => r.status === 'VALID')
    const totals = {
      total: out.length, valid: valid.length, errors: out.filter((r) => r.status === 'ERROR').length, unchanged: out.filter((r) => r.status === 'UNCHANGED').length,
      shops: new Set(valid.map((r) => r.shop_id)).size, products: new Set(valid.map((r) => r.product_id)).size,
    }
    const batch = await withTransaction(async (client) => {
      const b = await this.repo.createBatch(client, { fileName: filename, userId, totals })
      await this.repo.insertRows(client, b.id, out)
      return b
    })
    return { ...(await this.get(batch.id)), ignoredColumns: unknown }
  }

  async get(id) {
    const b = await this.repo.batch(id)
    if (!b) throw new BusinessError('Upload not found.', 404, 'BATCH_NOT_FOUND')
    const shape = {
      id: b.id, fileName: b.file_name, status: b.status, createdAt: b.created_at, appliedAt: b.applied_at, createdBy: b.created_by_name, appliedBy: b.applied_by_name,
      totals: { rows: b.total_rows, valid: b.valid_rows, errors: b.error_rows, unchanged: b.unchanged_rows, shops: b.shops_affected, products: b.products_affected },
    }
    return shape
  }
  async list() {
    return (await this.repo.batches()).map((b) => ({ id: b.id, fileName: b.file_name, status: b.status, createdAt: b.created_at, appliedAt: b.applied_at, createdBy: b.created_by_name, totals: { rows: b.total_rows, valid: b.valid_rows, errors: b.error_rows, unchanged: b.unchanged_rows } }))
  }
  async rows(id, q) {
    await this.get(id)
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500)
    const { rows, total } = await this.repo.rows(id, { status: q.status, limit, offset: Math.max(Number(q.offset) || 0, 0) })
    return {
      total, limit,
      items: rows.map((r) => ({ rowNo: r.row_no, status: r.status, errors: r.errors, product: r.product_name ? { name: r.product_name, sku: r.product_sku } : null, store: r.shop_name ? { name: r.shop_name, branchCode: r.branch_code } : null, changes: r.changes, summary: describeChanges(r.changes), raw: r.raw })),
    }
  }
  async discard(id) {
    const b = await this.get(id)
    if (b.status !== 'PREVIEW') throw new BusinessError('Only an upload that has not been applied can be discarded.', 409, 'NOT_PREVIEW')
    await this.repo.discard(id)
    return { id }
  }

  // ─── confirm → apply ───
  async apply(id, { skipErrors = false } = {}, actor) {
    const info = await withTransaction(async (client) => {
      const b = await this.repo.batch(id, client)
      if (!b) throw new BusinessError('Upload not found.', 404, 'BATCH_NOT_FOUND')
      if (b.status !== 'PREVIEW') throw new BusinessError(b.status === 'APPLIED' ? 'This upload was already applied.' : 'This upload was discarded.', 409, 'NOT_PREVIEW')
      if (b.error_rows > 0 && !skipErrors) throw new BusinessError(`${b.error_rows} row(s) have errors. Fix the sheet and upload again, or confirm that you want to skip them.`, 409, 'HAS_ERRORS', { errors: b.error_rows })
      if (b.valid_rows === 0) throw new BusinessError('There is nothing to apply: no row would change anything.', 409, 'NOTHING_TO_APPLY')
      if (!(await this.repo.claim(client, id, actor.userId))) throw new BusinessError('This upload was just applied by someone else.', 409, 'NOT_PREVIEW')

      const rows = await this.repo.validRows(client, id)
      const locked = new Map((await this.repo.lockShopProducts(client, rows.map((r) => r.shop_product_id))).map((l) => [l.id, l]))
      // A row is stale when someone changed one of the fields this row sets (price, availability…) since the preview.
      // Stock is different: customers' orders move it all day, so it is SET to the sheet's number at the moment of applying.
      const stale = rows.filter((r) => {
        const l = locked.get(r.shop_product_id)
        if (!l || l.deleted_at) return true
        const have = { price: l.price, sale_price: l.sale_price, wholesale_price: l.wholesale_price, cost_price: l.cost_price, available: l.is_available, max_order_qty: l.max_order_qty, low_stock_threshold: l.low_stock_threshold }
        return Object.entries(r.changes).some(([f, c]) => f !== 'stock' && !sameValue(have[f], c.from))
      })
      if (stale.length) throw new BusinessError(`${stale.length} product(s) were changed by someone else since this preview. Nothing was applied — upload the sheet again.`, 409, 'STALE_PREVIEW', { rows: stale.slice(0, 20).map((r) => r.row_no) })

      let stockMoves = 0
      for (const r of rows) {
        const c = r.changes
        const delta = c.stock ? Number(c.stock.to) - Number(locked.get(r.shop_product_id).stock_quantity) : 0
        if (delta !== 0) {
          try {
            await this.repo.applyStock(client, {
              shopProductId: r.shop_product_id, delta, type: 'BULK_UPDATE', reason: `Bulk update (upload ${id.slice(0, 8)}, row ${r.row_no})`,
              actor: { userId: actor.userId }, metadata: { batchId: id, rowNo: r.row_no },
            })
            stockMoves += 1
          } catch (err) {
            if (err?.code === 'STOCK_NEGATIVE_FORBIDDEN') throw new BusinessError(`Row ${r.row_no}: stock would go negative.`, 409, 'STOCK_NEGATIVE')
            throw err
          }
        }
        const sets = {}
        for (const f of ['price', 'sale_price', 'wholesale_price', 'cost_price', 'max_order_qty', 'low_stock_threshold']) if (c[f]) sets[f] = c[f].to
        if (c.available) {
          sets.is_available = c.available.to
          sets.sold_out_at = c.available.to ? null : new Date()
        }
        await this.repo.updateFields(client, r.shop_product_id, sets)
      }
      const shopIds = [...new Set(rows.map((r) => r.shop_id))]
      const productIds = [...new Set(rows.map((r) => r.product_id))]
      await emitInTx(client, 'catalog.bulk.apply', {
        actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'catalog_bulk_batch', target_id: id,
        after: { rows: rows.length, shops: shopIds.length, products: productIds.length, stockMoves, skippedErrors: b.error_rows, fileName: b.file_name },
      })
      return { applied: rows.length, shopIds, productIds, stockMoves, skipped: b.error_rows }
    })
    await invalidateCatalogCaches({ shopIds: info.shopIds, productIds: info.productIds })
    return { ...(await this.get(id)), result: { appliedRows: info.applied, shops: info.shopIds.length, products: info.productIds.length, stockMovements: info.stockMoves, skippedRows: info.skipped } }
  }

  // ─── bulk enable / disable / assign ───
  async setAvailability({ action, productIds, shopIds, dryRun = true }, actor) {
    if (!['ENABLE', 'DISABLE', 'ASSIGN'].includes(action)) throw new BusinessError('Action must be ENABLE, DISABLE or ASSIGN.', 400, 'VALIDATION', { action: 'Invalid' })
    const products = [...new Set(productIds ?? [])]
    const shopsWanted = [...new Set(shopIds ?? [])]
    if (products.length === 0 || shopsWanted.length === 0) throw new BusinessError('Choose at least one product and one store.', 400, 'VALIDATION', { productIds: 'Empty' })
    if (products.length * shopsWanted.length > MAX_PAIRS) throw new BusinessError(`That is more than ${MAX_PAIRS} product-store pairs at once. Narrow it down.`, 400, 'TOO_MANY')
    const shops = await this.repo.shopsById(shopsWanted)
    const inactive = shops.filter((s) => !s.is_active).map((s) => s.name)
    const pairs = (await this.repo.pairs(products, shopsWanted)).filter((p) => shops.find((s) => s.id === p.shop_id)?.is_active)
    const plan = { willChange: [], alreadyDone: 0, skipped: { noStock: 0, notAssigned: 0, removed: 0 } }
    for (const p of pairs) {
      const exists = p.shop_product_id && !p.deleted_at
      if (action === 'ASSIGN') {
        if (exists) plan.alreadyDone += 1
        else plan.willChange.push(p)
      } else if (!exists) {
        plan.skipped[p.shop_product_id ? 'removed' : 'notAssigned'] += 1
      } else if (action === 'ENABLE') {
        if (p.is_available) plan.alreadyDone += 1
        else if (Number(p.stock_quantity) === 0) plan.skipped.noStock += 1
        else plan.willChange.push(p)
      } else if (!p.is_available) plan.alreadyDone += 1
      else plan.willChange.push(p)
    }
    const summary = {
      action, dryRun, stores: shops.length - inactive.length, products: products.length, willChange: plan.willChange.length, alreadyDone: plan.alreadyDone, skipped: plan.skipped, inactiveStores: inactive,
      applied: 0,
    }
    if (dryRun || plan.willChange.length === 0) return summary
    await withTransaction(async (client) => {
      if (action === 'ASSIGN') await this.repo.assign(client, plan.willChange.map((p) => ({ shopId: p.shop_id, productId: p.product_id })))
      else await this.repo.setAvailability(client, plan.willChange.map((p) => p.shop_product_id), action === 'ENABLE')
      await emitInTx(client, `catalog.bulk.${action.toLowerCase()}`, {
        actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'shop_product', target_id: null,
        after: { products: products.length, stores: shops.length, changed: plan.willChange.length },
      })
    })
    await invalidateCatalogCaches({ shopIds: plan.willChange.map((p) => p.shop_id), productIds: plan.willChange.map((p) => p.product_id) })
    return { ...summary, applied: plan.willChange.length }
  }

  // ─── files ───
  async template() {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Update')
    ws.addRow(['SKU', 'Branch Code', 'Stock', 'Retail Price', 'Sale Price', 'Wholesale Price', 'Cost Price', 'Available', 'Max Per Order', 'Low Stock Alert'])
    ws.addRow(['EXAMPLE-SKU', 'BR01', 25, 49.5, 45, 40, 32, 'yes', 10, 5])
    ws.getRow(1).font = { bold: true }
    ws.columns.forEach((c) => { c.width = 16 })
    const help = wb.addWorksheet('How to use')
    ;[
      ['Each row = one product in one store. Identify the product by SKU, Barcode or Product ID, and the store by Branch Code.'],
      ['Leave a cell blank to keep the current value. Type - or clear in a price column to remove it (the product price is used again).'],
      ['Stock is the NEW total for that store (not an amount to add). Every change is recorded in the stock history.'],
      ['Available: yes / no. A product with 0 stock cannot be made available.'],
      ['After you upload, you see a preview with every change and every error. Nothing changes until you confirm.'],
    ].forEach((r) => help.addRow(r))
    help.getColumn(1).width = 120
    return Buffer.from(await wb.xlsx.writeBuffer())
  }
  async exportCatalog({ shopId }) {
    const rows = await this.repo.exportRows({ shopId })
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Catalog')
    ws.addRow(['SKU', 'Barcode', 'Name (for reference — ignored on upload)', 'Branch Code', 'Stock', 'Retail Price', 'Sale Price', 'Wholesale Price', 'Cost Price', 'Available', 'Max Per Order', 'Low Stock Alert'])
    for (const r of rows) ws.addRow([r.sku, r.barcode, r.name, r.branch_code, r.stock_quantity, r.price == null ? null : Number(r.price), r.sale_price == null ? null : Number(r.sale_price), r.wholesale_price == null ? null : Number(r.wholesale_price), r.cost_price == null ? null : Number(r.cost_price), r.is_available ? 'yes' : 'no', r.max_order_qty, r.low_stock_threshold])
    ws.getRow(1).font = { bold: true }
    ws.columns.forEach((c) => { c.width = 18 })
    return Buffer.from(await wb.xlsx.writeBuffer())
  }
}

export const BULK_FIELDS = FIELDS.map((f) => ({ field: f, label: FIELD_LABEL[f] }))
