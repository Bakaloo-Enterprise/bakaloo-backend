import { query } from '../../config/database.js'
import { ShopProductsRepository } from '../shop-products/shop-products.repository.js'
export { withTransaction } from '../procurement/procurement.repository.js'

const CURRENT = `sp.id, sp.shop_id, sp.product_id, sp.price, sp.sale_price, sp.wholesale_price, sp.cost_price, sp.stock_quantity, sp.is_available,
  sp.max_order_qty, sp.low_stock_threshold, sp.updated_at, p.price AS product_price`

export class CatalogBulkRepository {
  stock = new ShopProductsRepository()

  async productsBy(by, values) {
    if (values.length === 0) return []
    const col = { id: 'id', sku: 'sku', barcode: 'barcode' }[by]
    const cast = by === 'id' ? '::uuid[]' : '::text[]'
    const { rows } = await query(`SELECT id, name, sku, barcode, price FROM products WHERE ${col} = ANY($1${cast})`, [values])
    return rows
  }
  async shopsByCode(codes) {
    if (codes.length === 0) return []
    const { rows } = await query(`SELECT id, name, branch_code, is_active FROM shops WHERE branch_code = ANY($1::text[])`, [codes])
    return rows
  }
  async shopsById(ids) {
    if (ids.length === 0) return []
    const { rows } = await query(`SELECT id, name, branch_code, is_active FROM shops WHERE id = ANY($1::uuid[])`, [ids])
    return rows
  }
  async currentFor(pairs) {
    if (pairs.length === 0) return []
    const { rows } = await query(
      `SELECT ${CURRENT} FROM shop_products sp JOIN products p ON p.id = sp.product_id
         JOIN UNNEST($1::uuid[], $2::uuid[]) AS x(s, pr) ON sp.shop_id = x.s AND sp.product_id = x.pr WHERE sp.deleted_at IS NULL`,
      [pairs.map((p) => p.shopId), pairs.map((p) => p.productId)])
    return rows
  }

  async createBatch(client, { fileName, userId, totals }) {
    const { rows } = await client.query(
      `INSERT INTO catalog_bulk_batches (file_name, total_rows, valid_rows, error_rows, unchanged_rows, shops_affected, products_affected, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, status, created_at`,
      [fileName ?? null, totals.total, totals.valid, totals.errors, totals.unchanged, totals.shops, totals.products, userId])
    return rows[0]
  }
  async insertRows(client, batchId, rows) {
    for (let i = 0; i < rows.length; i += 1000) {
      await client.query(
        `INSERT INTO catalog_bulk_rows (batch_id, row_no, raw, status, errors, shop_id, product_id, shop_product_id, changes, before_updated_at)
         SELECT $1, r.row_no, r.raw, r.status, r.errors, r.shop_id, r.product_id, r.shop_product_id, r.changes, r.before_updated_at
           FROM jsonb_to_recordset($2::jsonb) AS r(row_no int, raw jsonb, status text, errors jsonb, shop_id uuid, product_id uuid, shop_product_id uuid, changes jsonb, before_updated_at timestamptz)`,
        [batchId, JSON.stringify(rows.slice(i, i + 1000))])
    }
  }

  async batch(id, client) {
    const { rows } = await (client ?? { query }).query(
      `SELECT b.id, b.file_name, b.status, b.total_rows, b.valid_rows, b.error_rows, b.unchanged_rows, b.shops_affected, b.products_affected, b.created_at, b.applied_at,
              cu.name AS created_by_name, au.name AS applied_by_name
         FROM catalog_bulk_batches b LEFT JOIN users cu ON cu.id = b.created_by LEFT JOIN users au ON au.id = b.applied_by WHERE b.id = $1`, [id])
    return rows[0] ?? null
  }
  async batches(limit = 20) {
    const { rows } = await query(
      `SELECT b.id, b.file_name, b.status, b.total_rows, b.valid_rows, b.error_rows, b.unchanged_rows, b.created_at, b.applied_at, cu.name AS created_by_name
         FROM catalog_bulk_batches b LEFT JOIN users cu ON cu.id = b.created_by ORDER BY b.created_at DESC LIMIT $1`, [limit])
    return rows
  }
  async rows(batchId, { status, limit = 100, offset = 0 }) {
    const p = [batchId]
    let where = 'r.batch_id = $1'
    if (status) { p.push(status); where += ` AND r.status = $${p.length}` }
    const total = (await query(`SELECT COUNT(*)::int AS n FROM catalog_bulk_rows r WHERE ${where}`, p)).rows[0].n
    const { rows } = await query(
      `SELECT r.row_no, r.raw, r.status, r.errors, r.changes, pr.name AS product_name, pr.sku AS product_sku, s.name AS shop_name, s.branch_code
         FROM catalog_bulk_rows r LEFT JOIN products pr ON pr.id = r.product_id LEFT JOIN shops s ON s.id = r.shop_id
        WHERE ${where} ORDER BY r.row_no LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, p)
    return { rows, total }
  }
  /** Claim the batch for applying: only a PREVIEW batch can be claimed, once. */
  async claim(client, id, userId) {
    const { rows } = await client.query(
      `UPDATE catalog_bulk_batches SET status = 'APPLIED', applied_by = $2, applied_at = NOW() WHERE id = $1 AND status = 'PREVIEW' RETURNING id`, [id, userId])
    return rows.length > 0
  }
  async validRows(client, id) {
    const { rows } = await client.query(
      `SELECT row_no, shop_id, product_id, shop_product_id, changes, before_updated_at FROM catalog_bulk_rows WHERE batch_id = $1 AND status = 'VALID' ORDER BY shop_product_id, row_no`, [id])
    return rows
  }
  async lockShopProducts(client, ids) {
    const { rows } = await client.query(`SELECT id, deleted_at, price, sale_price, wholesale_price, cost_price, is_available, max_order_qty, low_stock_threshold, stock_quantity FROM shop_products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids])
    return rows
  }
  async discard(id) {
    const { rowCount } = await query(`UPDATE catalog_bulk_batches SET status = 'DISCARDED' WHERE id = $1 AND status = 'PREVIEW'`, [id])
    return rowCount > 0
  }
  applyStock(client, args) { return this.stock.applyStockChange(client, { ...args, source: 'DASHBOARD' }) }
  async updateFields(client, id, sets) {
    const cols = Object.keys(sets)
    if (cols.length === 0) return
    const assign = cols.map((c, i) => `${c} = $${i + 2}`).join(', ')
    await client.query(`UPDATE shop_products SET ${assign}, updated_at = NOW() WHERE id = $1`, [id, ...cols.map((c) => sets[c])])
  }

  async exportRows({ shopId, limit = 50_000 }) {
    const { rows } = await query(
      `SELECT p.sku, p.barcode, p.name, s.branch_code, sp.stock_quantity, sp.price, sp.sale_price, sp.wholesale_price, sp.cost_price, sp.is_available, sp.max_order_qty, sp.low_stock_threshold
         FROM shop_products sp JOIN products p ON p.id = sp.product_id JOIN shops s ON s.id = sp.shop_id
        WHERE sp.deleted_at IS NULL AND ($1::uuid IS NULL OR sp.shop_id = $1) ORDER BY s.branch_code, p.name LIMIT $2`, [shopId ?? null, limit])
    return rows
  }

  // ─── enable / disable / assign ───
  async pairs(productIds, shopIds) {
    const { rows } = await query(
      `SELECT p.id AS product_id, s.id AS shop_id, sp.id AS shop_product_id, sp.deleted_at, sp.is_available, sp.stock_quantity
         FROM UNNEST($1::uuid[]) AS pid(id) JOIN products p ON p.id = pid.id
         CROSS JOIN UNNEST($2::uuid[]) AS sid(id) JOIN shops s ON s.id = sid.id
         LEFT JOIN shop_products sp ON sp.product_id = p.id AND sp.shop_id = s.id`, [productIds, shopIds])
    return rows
  }
  async setAvailability(client, ids, available) {
    await client.query(
      `UPDATE shop_products SET is_available = $2, sold_out_at = CASE WHEN $2 THEN NULL ELSE COALESCE(sold_out_at, NOW()) END, updated_at = NOW() WHERE id = ANY($1::uuid[])`,
      [ids, available])
  }
  async assign(client, pairs) {
    for (let i = 0; i < pairs.length; i += 1000) {
      const part = pairs.slice(i, i + 1000)
      await client.query(
        `INSERT INTO shop_products (shop_id, product_id, stock_quantity, is_available, sold_out_at)
         SELECT x.s, x.p, 0, false, NOW() FROM UNNEST($1::uuid[], $2::uuid[]) AS x(s, p)
         ON CONFLICT (shop_id, product_id) DO UPDATE SET deleted_at = NULL, is_available = false, updated_at = NOW() WHERE shop_products.deleted_at IS NOT NULL`,
        [part.map((x) => x.shopId), part.map((x) => x.productId)])
    }
  }
}
