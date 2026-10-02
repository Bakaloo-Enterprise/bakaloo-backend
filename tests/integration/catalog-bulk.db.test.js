/**
 * Bulk catalog (Phase 12). Real Postgres, opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/catalog-bulk.db.test.js
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PH = (n) => `9999017${String(n).padStart(3, '0')}`

describe.skipIf(!enabled)('Bulk catalog', () => {
  let query, closePool, svc, mgr, shopA, shopB, rice, oil, salt
  const actor = () => ({ userId: mgr })
  const csv = (rows) => Buffer.from(rows.map((r) => r.join(',')).join('\n'))
  const HEAD = ['SKU', 'Branch Code', 'Stock', 'Retail Price', 'Sale Price', 'Wholesale Price', 'Cost Price', 'Available']
  const upload = (rows, name = 'sheet.csv') => svc.preview({ buffer: csv([HEAD, ...rows]), filename: name, userId: mgr })

  const mkShop = async (code, active = true) => (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ($1,$2,$3,'DB 12','Kolkata','WB','700091',22.5,88.3,$4) RETURNING id`, [`T13 Shop ${code}`, `t13-shop-${code}`, code, active])).rows[0].id
  const mkProduct = async (name, sku, barcode = null, price = 50) => (await query(`INSERT INTO products (name, slug, price, sku, barcode, net_quantity) VALUES ($1,$2,$3,$4,$5,'1 unit') RETURNING id`, [name, `t13-${sku}`.toLowerCase(), price, sku, barcode])).rows[0].id
  const assign = async (shopId, productId, o = {}) => (await query(
    `INSERT INTO shop_products (shop_id, product_id, stock_quantity, price, sale_price, cost_price, is_available) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [shopId, productId, o.stock ?? 4, o.price ?? null, o.sale ?? null, o.cost ?? null, o.available ?? true])).rows[0].id
  const sp = async (shopId, productId) => (await query(`SELECT * FROM shop_products WHERE shop_id=$1 AND product_id=$2`, [shopId, productId])).rows[0]
  const ledger = async (productId) => (await query(`SELECT type, quantity_delta, quantity_after FROM stock_movements WHERE product_id=$1 ORDER BY created_at, id`, [productId])).rows

  async function cleanup() {
    await query(`DELETE FROM audit_logs WHERE target_type IN ('catalog_bulk_batch','shop_product') AND actor_user_id IN (SELECT id FROM users WHERE phone LIKE '9999017%')`)
    await query(`DELETE FROM catalog_bulk_batches WHERE created_by IN (SELECT id FROM users WHERE phone LIKE '9999017%')`)
    await query(`DELETE FROM stock_movements WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't13-shop-%')`)
    await query(`DELETE FROM shop_products WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't13-shop-%')`)
    await query(`DELETE FROM products WHERE slug LIKE 't13-%'`)
    await query(`DELETE FROM shops WHERE slug LIKE 't13-shop-%'`)
    await query(`DELETE FROM users WHERE phone LIKE '9999017%'`)
  }
  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { CatalogBulkRepository } = await import('../../src/modules/catalog-bulk/catalog-bulk.repository.js')
    const { CatalogBulkService } = await import('../../src/modules/catalog-bulk/catalog-bulk.service.js')
    svc = new CatalogBulkService({ repo: new CatalogBulkRepository() })
  })
  beforeEach(async () => {
    await cleanup()
    mgr = (await query(`INSERT INTO users (phone,name,email,role) VALUES ($1,'T13 Manager',$2,'ADMIN') RETURNING id`, [PH(1), `${PH(1)}@t.local`])).rows[0].id
    shopA = await mkShop('BA'); shopB = await mkShop('BB')
    rice = await mkProduct('T13 Rice', 'T13-RICE', '8902000000001'); oil = await mkProduct('T13 Oil', 'T13-OIL', '8902000000002', 120); salt = await mkProduct('T13 Salt', 'T13-SALT')
    await assign(shopA, rice, { stock: 4 }); await assign(shopA, oil, { stock: 10, price: 118 }); await assign(shopB, rice, { stock: 0, available: false })
  })
  afterAll(async () => { await cleanup(); await closePool() })

  describe('preview', () => {
    it('classifies rows and changes NOTHING', async () => {
      const b = await upload([
        ['T13-RICE', 'BA', '10', '55', '50', '', '30', ''],      // valid
        ['T13-OIL', 'BA', '10', '118', '', '', '', ''],          // unchanged
        ['T13-NOPE', 'BA', '1', '', '', '', '', ''],             // unknown product
        ['T13-SALT', 'BA', '5', '', '', '', '', ''],             // not assigned
        ['T13-RICE', 'ZZ', '5', '', '', '', '', ''],             // unknown store
        ['T13-RICE', 'BA', '12', '', '', '', '', ''],            // duplicate of row 2
        ['T13-RICE', 'BB', 'x', '', '', '', '', ''],             // bad stock
      ])
      expect(b.status).toBe('PREVIEW')
      expect(b.totals).toMatchObject({ rows: 7, valid: 1, unchanged: 1, errors: 5, shops: 1, products: 1 })
      const errs = (await svc.rows(b.id, { status: 'ERROR' })).items
      expect(errs.map((e) => e.rowNo)).toEqual([4, 5, 6, 7, 8])
      expect(errs[0].errors[0]).toMatch(/No product found/)
      expect(errs[1].errors[0]).toMatch(/not assigned/)
      expect(errs[2].errors[0]).toMatch(/No store with branch code/)
      expect(errs[3].errors[0]).toMatch(/Same product and store as row 2/)
      const valid = (await svc.rows(b.id, { status: 'VALID' })).items[0]
      expect(valid.summary).toBe('Stock 4 → 10, Retail price — → 55, Sale price — → 50, Cost price — → 30')
      expect(valid.product).toMatchObject({ sku: 'T13-RICE' })
      expect((await sp(shopA, rice)).stock_quantity).toBe(4)
      expect(Number((await sp(shopA, rice)).price ?? 0)).toBe(0)
      expect(await ledger(rice)).toHaveLength(0)
    })
    it('finds products by barcode or id and stores by id', async () => {
      const buffer = csv([['Barcode', 'Shop ID', 'Stock'], ['8902000000001', shopA, '9'], [rice, shopB, '3']].map((r, i) => (i === 2 ? ['', ...r.slice(1)] : r)))
      const b = await svc.preview({ buffer, filename: 'x.csv', userId: mgr })
      expect(b.totals.valid + b.totals.errors).toBe(2)
      expect((await svc.rows(b.id, { status: 'VALID' })).items).toHaveLength(1)
    })
    it('refuses an inactive store and an ambiguous barcode', async () => {
      const off = await mkShop('BX', false); await assign(off, rice, { stock: 1 })
      await mkProduct('T13 Twin', 'T13-TWIN', '8902000000001')
      const b = await svc.preview({ buffer: csv([['Barcode', 'Branch Code', 'Stock'], ['8902000000001', 'BA', '9'], ['T13-X', 'BX', '1']]), filename: 'x.csv', userId: mgr })
      const errs = (await svc.rows(b.id, { status: 'ERROR' })).items.map((e) => e.errors[0])
      expect(errs[0]).toMatch(/More than one product/)
      expect(errs[1]).toMatch(/No product found|not active/)
    })
    it('explains an unusable sheet', async () => {
      await expect(svc.preview({ buffer: csv([['Name', 'Colour'], ['a', 'b']]), filename: 'x.csv', userId: mgr })).rejects.toMatchObject({ code: 'MISSING_PRODUCT_COLUMN' })
      await expect(svc.preview({ buffer: csv([['SKU', 'Branch Code', 'Stock']]), filename: 'x.csv', userId: mgr })).rejects.toMatchObject({ code: 'EMPTY_FILE' })
      await expect(svc.preview({ buffer: Buffer.from('x'), filename: 'x.pdf', userId: mgr })).rejects.toMatchObject({ code: 'BAD_FILE' })
    })
    it('refuses a sheet over the row limit', async () => {
      const rows = Array.from({ length: 5001 }, () => ['T13-RICE', 'BA', '1', '', '', '', '', ''])
      await expect(upload(rows)).rejects.toMatchObject({ code: 'TOO_MANY_ROWS' })
    })
    it('reads a real .xlsx (numbers typed as numbers)', async () => {
      const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('s')
      ws.addRow(HEAD); ws.addRow(['T13-RICE', 'BA', 12, 55.5, 50, null, null, 'yes'])
      const b = await svc.preview({ buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: 'sheet.xlsx', userId: mgr })
      expect(b.totals).toMatchObject({ valid: 1, errors: 0 })
      expect((await svc.rows(b.id, {})).items[0].changes.price).toEqual({ from: null, to: 55.5 })
    })
  })

  describe('apply', () => {
    it('applies prices, availability and stock — stock through the ledger — and audits the batch', async () => {
      const b = await upload([['T13-RICE', 'BA', '10', '55', '50', '40', '30', 'yes'], ['T13-OIL', 'BA', '7', '', '', '', '', 'no']])
      const r = await svc.apply(b.id, {}, actor())
      expect(r.status).toBe('APPLIED')
      expect(r.result).toMatchObject({ appliedRows: 2, shops: 1, products: 2, stockMovements: 2 })
      const a = await sp(shopA, rice)
      expect(a.stock_quantity).toBe(10)
      expect([Number(a.price), Number(a.sale_price), Number(a.wholesale_price), Number(a.cost_price)]).toEqual([55, 50, 40, 30])
      const o = await sp(shopA, oil)
      expect([o.stock_quantity, o.is_available]).toEqual([7, false])
      expect(await ledger(rice)).toEqual([{ type: 'BULK_UPDATE', quantity_delta: 6, quantity_after: 10 }])
      expect(await ledger(oil)).toEqual([{ type: 'BULK_UPDATE', quantity_delta: -3, quantity_after: 7 }])
      const audit = await query(`SELECT action, after FROM audit_logs WHERE target_id=$1`, [b.id])
      expect(audit.rows[0]).toMatchObject({ action: 'catalog.bulk.apply' })
      expect(audit.rows[0].after.rows).toBe(2)
    })
    it('clearing a sale price and restocking an unavailable product works', async () => {
      await query(`UPDATE shop_products SET sale_price = 40 WHERE shop_id=$1 AND product_id=$2`, [shopA, rice])
      const b = await upload([['T13-RICE', 'BA', '', '', '-', '', '', ''], ['T13-RICE', 'BB', '6', '', '', '', '', 'yes']])
      await svc.apply(b.id, {}, actor())
      expect((await sp(shopA, rice)).sale_price).toBeNull()
      expect(await sp(shopB, rice)).toMatchObject({ stock_quantity: 6, is_available: true })
    })
    it('never applies silently when there are errors — unless the person confirms skipping them', async () => {
      const b = await upload([['T13-RICE', 'BA', '10', '', '', '', '', ''], ['T13-NOPE', 'BA', '1', '', '', '', '', '']])
      await expect(svc.apply(b.id, {}, actor())).rejects.toMatchObject({ code: 'HAS_ERRORS', statusCode: 409 })
      expect((await sp(shopA, rice)).stock_quantity).toBe(4)
      const r = await svc.apply(b.id, { skipErrors: true }, actor())
      expect(r.result).toMatchObject({ appliedRows: 1, skippedRows: 1 })
      expect((await sp(shopA, rice)).stock_quantity).toBe(10)
    })
    it('a batch can be applied once, even by two people at the same moment', async () => {
      const b = await upload([['T13-RICE', 'BA', '10', '', '', '', '', '']])
      const out = await Promise.allSettled([svc.apply(b.id, {}, actor()), svc.apply(b.id, {}, actor())])
      expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
      expect(out.find((x) => x.status === 'rejected').reason.code).toBe('NOT_PREVIEW')
      expect(await ledger(rice)).toHaveLength(1)
    })
    it('refuses everything if a price changed since the preview (all or nothing)', async () => {
      const b = await upload([['T13-RICE', 'BA', '10', '55', '', '', '', ''], ['T13-OIL', 'BA', '7', '125', '', '', '', '']])
      await query(`UPDATE shop_products SET price = 99 WHERE shop_id=$1 AND product_id=$2`, [shopA, oil])
      await expect(svc.apply(b.id, {}, actor())).rejects.toMatchObject({ code: 'STALE_PREVIEW', statusCode: 409 })
      expect((await sp(shopA, rice)).stock_quantity).toBe(4) // the good row was not applied either
      expect(await ledger(rice)).toHaveLength(0)
      expect((await svc.get(b.id)).status).toBe('PREVIEW') // can be discarded or re-uploaded
    })
    it('sets stock to the sheet’s number at the moment of applying, even if orders moved it meanwhile', async () => {
      const b = await upload([['T13-RICE', 'BA', '10', '', '', '', '', '']])
      await query(`UPDATE shop_products SET stock_quantity = 2, updated_at = NOW() WHERE shop_id=$1 AND product_id=$2`, [shopA, rice]) // customer orders
      await svc.apply(b.id, {}, actor())
      expect((await sp(shopA, rice)).stock_quantity).toBe(10)
      expect(await ledger(rice)).toEqual([{ type: 'BULK_UPDATE', quantity_delta: 8, quantity_after: 10 }])
    })
    it('refuses nothing-to-apply, wrong state and missing confirmation paths', async () => {
      const same = await upload([['T13-OIL', 'BA', '10', '', '', '', '', '']])
      await expect(svc.apply(same.id, {}, actor())).rejects.toMatchObject({ code: 'NOTHING_TO_APPLY' })
      await expect(svc.apply('00000000-0000-4000-8000-000000000000', {}, actor())).rejects.toMatchObject({ statusCode: 404 })
      await svc.discard(same.id)
      await expect(svc.apply(same.id, {}, actor())).rejects.toMatchObject({ code: 'NOT_PREVIEW' })
      await expect(svc.discard(same.id)).rejects.toMatchObject({ code: 'NOT_PREVIEW' })
    })
  })

  describe('files', () => {
    it('the exported catalog uploads back as "no changes"', async () => {
      const buffer = await svc.exportCatalog({ shopId: shopA })
      const b = await svc.preview({ buffer, filename: 'catalog.xlsx', userId: mgr })
      expect(b.totals.errors).toBe(0)
      expect(b.totals.valid).toBe(0)
      expect(b.totals.unchanged).toBe(2)
    })
    it('the template is a valid sheet with the right headers', async () => {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(await svc.template())
      expect(wb.worksheets[0].getRow(1).values.slice(1, 4)).toEqual(['SKU', 'Branch Code', 'Stock'])
    })
  })

  describe('bulk enable / disable / assign', () => {
    it('ASSIGN: dry run counts, then creates unavailable zero-stock rows; existing rows untouched', async () => {
      const args = { action: 'ASSIGN', productIds: [rice, salt], shopIds: [shopA, shopB] }
      const dry = await svc.setAvailability(args, actor())
      expect(dry).toMatchObject({ dryRun: true, willChange: 2, alreadyDone: 2, applied: 0 })
      expect(await sp(shopA, salt)).toBeUndefined()
      const done = await svc.setAvailability({ ...args, dryRun: false }, actor())
      expect(done.applied).toBe(2)
      expect(await sp(shopA, salt)).toMatchObject({ stock_quantity: 0, is_available: false })
      expect((await sp(shopA, rice)).stock_quantity).toBe(4)
    })
    it('ASSIGN restores a store row that was removed', async () => {
      await query(`UPDATE shop_products SET deleted_at = NOW() WHERE shop_id=$1 AND product_id=$2`, [shopA, oil])
      await svc.setAvailability({ action: 'ASSIGN', productIds: [oil], shopIds: [shopA], dryRun: false }, actor())
      expect((await sp(shopA, oil)).deleted_at).toBeNull()
    })
    it('ENABLE skips products with no stock; DISABLE turns off only what is on', async () => {
      const en = await svc.setAvailability({ action: 'ENABLE', productIds: [rice], shopIds: [shopA, shopB], dryRun: false }, actor())
      expect(en).toMatchObject({ willChange: 0, alreadyDone: 1, skipped: { noStock: 1 } })
      expect((await sp(shopB, rice)).is_available).toBe(false)
      const dis = await svc.setAvailability({ action: 'DISABLE', productIds: [rice, oil], shopIds: [shopA], dryRun: false }, actor())
      expect(dis).toMatchObject({ applied: 2 })
      expect((await sp(shopA, oil)).is_available).toBe(false)
      const again = await svc.setAvailability({ action: 'DISABLE', productIds: [rice], shopIds: [shopA, shopB], dryRun: false }, actor())
      expect(again).toMatchObject({ applied: 0, alreadyDone: 2 })
    })
    it('counts products a store does not carry and ignores inactive stores', async () => {
      const off = await mkShop('BO', false)
      const r = await svc.setAvailability({ action: 'DISABLE', productIds: [salt], shopIds: [shopA, off] }, actor())
      expect(r).toMatchObject({ willChange: 0, skipped: { notAssigned: 1 }, inactiveStores: ['T13 Shop BO'] })
    })
    it('validates the request', async () => {
      await expect(svc.setAvailability({ action: 'X', productIds: [rice], shopIds: [shopA] }, actor())).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(svc.setAvailability({ action: 'ENABLE', productIds: [], shopIds: [shopA] }, actor())).rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })
})
