import { getClient, query } from '../../config/database.js'
import { ShopProductsRepository } from '../shop-products/shop-products.repository.js'

/** Run `fn(client)` in one transaction. */
export async function withTransaction(fn) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

const ENTRY_SELECT = `
  e.id, e.entry_no, e.product_id, e.vendor_id, e.unit, e.expected_qty, e.received_qty, e.damaged_qty, e.unit_price, e.purchase_total,
  to_char(e.procured_on, 'YYYY-MM-DD') AS procured_on, e.invoice_ref, e.receiving_note, e.destination_shop_id, e.purpose, e.business_account_id, e.reservation_note,
  e.status, e.created_by, e.created_at,
  p.name AS product_name, p.sku AS product_sku, v.name AS vendor_name, ds.name AS destination_name, b.company_name AS business_name,
  COALESCE(al.qty, 0)::int AS allocated, COALESCE(ca.qty, 0)::int AS central_adjusted`
const ENTRY_FROM = `
  FROM procurement_entries e
  JOIN products p ON p.id = e.product_id
  JOIN vendors v ON v.id = e.vendor_id
  LEFT JOIN shops ds ON ds.id = e.destination_shop_id
  LEFT JOIN business_accounts b ON b.id = e.business_account_id
  LEFT JOIN LATERAL (SELECT SUM(quantity) AS qty FROM procurement_allocations WHERE entry_id = e.id AND status = 'APPLIED') al ON TRUE
  LEFT JOIN LATERAL (SELECT SUM(quantity) AS qty FROM procurement_adjustments WHERE entry_id = e.id AND shop_id IS NULL) ca ON TRUE`

export class ProcurementRepository {
  stock = new ShopProductsRepository()

  // ─── vendors ───
  async vendors({ includeInactive = false } = {}) {
    const { rows } = await query(
      `SELECT v.id, v.name, v.phone, v.notes, v.is_active, v.created_at,
              COUNT(e.id) FILTER (WHERE e.status = 'ACTIVE')::int AS entries
         FROM vendors v LEFT JOIN procurement_entries e ON e.vendor_id = v.id
        WHERE ($1 OR v.is_active) GROUP BY v.id ORDER BY LOWER(v.name)`,
      [includeInactive],
    )
    return rows
  }
  async vendorById(id, client) {
    return ((client ?? { query }).query(`SELECT id, name, is_active FROM vendors WHERE id = $1`, [id])).then((r) => r.rows[0] ?? null)
  }
  async vendorByName(name, client) {
    return ((client ?? { query }).query(`SELECT id, name, is_active FROM vendors WHERE LOWER(name) = LOWER($1)`, [name])).then((r) => r.rows[0] ?? null)
  }
  async createVendor({ name, phone, notes }, actorId, client) {
    const { rows } = await (client ?? { query }).query(
      `INSERT INTO vendors (name, phone, notes, created_by) VALUES ($1,$2,$3,$4) RETURNING id, name, phone, notes, is_active, created_at`,
      [name, phone ?? null, notes ?? null, actorId],
    )
    return rows[0]
  }
  async updateVendor(id, { name, phone, notes, isActive }) {
    const { rows } = await query(
      `UPDATE vendors SET name = COALESCE($2, name), phone = COALESCE($3, phone), notes = COALESCE($4, notes), is_active = COALESCE($5, is_active)
        WHERE id = $1 RETURNING id, name, phone, notes, is_active, created_at`,
      [id, name ?? null, phone ?? null, notes ?? null, isActive ?? null],
    )
    return rows[0] ?? null
  }

  // ─── lookups ───
  async product(id, client) {
    const { rows } = await (client ?? { query }).query(`SELECT id, name, sku, net_quantity FROM products WHERE id = $1`, [id])
    return rows[0] ?? null
  }
  async shop(id, client) {
    const { rows } = await (client ?? { query }).query(`SELECT id, name, branch_code, is_active FROM shops WHERE id = $1`, [id])
    return rows[0] ?? null
  }
  async businessAccount(id) {
    const { rows } = await query(`SELECT id, company_name, status FROM business_accounts WHERE id = $1`, [id])
    return rows[0] ?? null
  }

  // ─── entries ───
  async insertEntry(client, d) {
    const { rows } = await client.query(
      `INSERT INTO procurement_entries (product_id, vendor_id, unit, expected_qty, received_qty, damaged_qty, unit_price, purchase_total, procured_on,
                                        invoice_ref, receiving_note, destination_shop_id, purpose, business_account_id, reservation_note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [d.productId, d.vendorId, d.unit ?? null, d.expectedQty, d.receivedQty, d.damagedQty, d.unitPrice, d.purchaseTotal, d.procuredOn,
        d.invoiceRef ?? null, d.receivingNote ?? null, d.destinationShopId ?? null, d.purpose, d.businessAccountId ?? null, d.reservationNote ?? null, d.createdBy],
    )
    return rows[0].id
  }

  async entry(id, client) {
    const { rows } = await (client ?? { query }).query(`SELECT ${ENTRY_SELECT} ${ENTRY_FROM} WHERE e.id = $1`, [id])
    return rows[0] ?? null
  }
  /** Lock the entry row (serialises concurrent splits / adjustments) and return it with live figures. */
  async lockEntry(client, id) {
    const lock = await client.query(`SELECT id FROM procurement_entries WHERE id = $1 FOR UPDATE`, [id])
    if (lock.rows.length === 0) return null
    return this.entry(id, client)
  }

  async list({ from, to, vendorId, productId, shopId, status, purpose, search, limit = 25, offset = 0 }) {
    const where = ['TRUE']
    const p = []
    const add = (sql, v) => { p.push(v); where.push(sql.replaceAll('$$', `$${p.length}`)) }
    if (from) add('e.procured_on >= $$', from)
    if (to) add('e.procured_on <= $$', to)
    if (vendorId) add('e.vendor_id = $$', vendorId)
    if (productId) add('e.product_id = $$', productId)
    if (status) add('e.status = $$', status)
    if (purpose) add('e.purpose = $$', purpose)
    if (shopId) add(`(e.destination_shop_id = $$ OR EXISTS (SELECT 1 FROM procurement_allocations a WHERE a.entry_id = e.id AND a.shop_id = $$ AND a.status = 'APPLIED'))`, shopId)
    if (search) add(`(p.name ILIKE '%' || $$ || '%' OR e.invoice_ref ILIKE '%' || $$ || '%' OR e.entry_no::text = $$)`, search)
    const total = (await query(`SELECT COUNT(*)::int AS n ${ENTRY_FROM} WHERE ${where.join(' AND ')}`, p)).rows[0].n
    const { rows } = await query(
      `SELECT ${ENTRY_SELECT} ${ENTRY_FROM} WHERE ${where.join(' AND ')} ORDER BY e.procured_on DESC, e.entry_no DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, p,
    )
    return { rows, total }
  }

  async allocations(entryId, client) {
    const { rows } = await (client ?? { query }).query(
      `SELECT a.id, a.shop_id, s.name AS shop_name, a.quantity, a.status, a.note, a.created_at, a.reversed_at
         FROM procurement_allocations a JOIN shops s ON s.id = a.shop_id WHERE a.entry_id = $1 ORDER BY a.created_at`, [entryId])
    return rows
  }
  async adjustments(entryId, client) {
    const { rows } = await (client ?? { query }).query(
      `SELECT j.id, j.kind, j.quantity, j.shop_id, s.name AS shop_name, j.unit_cost, j.reason, j.created_at, u.name AS actor_name
         FROM procurement_adjustments j LEFT JOIN shops s ON s.id = j.shop_id LEFT JOIN users u ON u.id = j.created_by
        WHERE j.entry_id = $1 ORDER BY j.created_at`, [entryId])
    return rows
  }
  async events(entryId) {
    const { rows } = await query(
      `SELECT ev.kind, ev.detail, ev.created_at, u.name AS actor_name FROM procurement_events ev LEFT JOIN users u ON u.id = ev.actor_id
        WHERE ev.entry_id = $1 ORDER BY ev.id`, [entryId])
    return rows
  }
  async logEvent(client, entryId, actorId, kind, detail = {}) {
    await client.query(`INSERT INTO procurement_events (entry_id, actor_id, kind, detail) VALUES ($1,$2,$3,$4)`, [entryId, actorId, kind, JSON.stringify(detail)])
  }

  // ─── allocation ───
  /** The store's row for the product — created (stock 0) when the store does not carry it yet. Soft-deleted rows are refused. */
  async ensureShopProduct(client, shopId, productId) {
    const found = await client.query(`SELECT id, deleted_at, stock_quantity FROM shop_products WHERE shop_id = $1 AND product_id = $2`, [shopId, productId])
    if (found.rows[0]) return found.rows[0].deleted_at ? null : { id: found.rows[0].id, created: false }
    const ins = await client.query(`INSERT INTO shop_products (shop_id, product_id, stock_quantity) VALUES ($1,$2,0) RETURNING id`, [shopId, productId])
    return { id: ins.rows[0].id, created: true }
  }
  async setCostPrice(client, shopProductId, unitPrice) {
    await client.query(`UPDATE shop_products SET cost_price = $2, updated_at = NOW() WHERE id = $1`, [shopProductId, unitPrice])
  }
  applyStock(client, args) {
    return this.stock.applyStockChange(client, { ...args, source: 'DASHBOARD' })
  }
  async insertAllocation(client, { entryId, shopId, shopProductId, quantity, movementId, note, actorId }) {
    const { rows } = await client.query(
      `INSERT INTO procurement_allocations (entry_id, shop_id, shop_product_id, quantity, movement_id, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [entryId, shopId, shopProductId, quantity, movementId, note ?? null, actorId])
    return rows[0].id
  }
  async allocation(client, id) {
    const { rows } = await client.query(`SELECT id, entry_id, shop_id, shop_product_id, quantity, status FROM procurement_allocations WHERE id = $1 FOR UPDATE`, [id])
    return rows[0] ?? null
  }
  async markReversed(client, id, { movementId, actorId }) {
    await client.query(`UPDATE procurement_allocations SET status = 'REVERSED', reversal_movement_id = $2, reversed_by = $3, reversed_at = NOW() WHERE id = $1`, [id, movementId, actorId])
  }
  /** What a store still holds from this entry: applied allocations − adjustments already taken from that store. */
  async shopHeld(client, entryId, shopId) {
    const { rows } = await client.query(
      `SELECT COALESCE((SELECT SUM(quantity) FROM procurement_allocations WHERE entry_id = $1 AND shop_id = $2 AND status = 'APPLIED'), 0)::int
            - COALESCE((SELECT SUM(quantity) FROM procurement_adjustments WHERE entry_id = $1 AND shop_id = $2), 0)::int AS held`, [entryId, shopId])
    return rows[0].held
  }
  async shopProductFor(client, shopId, productId) {
    const { rows } = await client.query(`SELECT id FROM shop_products WHERE shop_id = $1 AND product_id = $2 AND deleted_at IS NULL`, [shopId, productId])
    return rows[0]?.id ?? null
  }
  async insertAdjustment(client, { entryId, kind, quantity, shopId, movementId, unitCost, reason, actorId }) {
    const { rows } = await client.query(
      `INSERT INTO procurement_adjustments (entry_id, kind, quantity, shop_id, movement_id, unit_cost, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [entryId, kind, quantity, shopId, movementId, unitCost, reason, actorId])
    return rows[0].id
  }
  async counts(client, entryId) {
    const { rows } = await client.query(
      `SELECT (SELECT COUNT(*) FROM procurement_allocations WHERE entry_id = $1)::int AS allocation_count,
              (SELECT COUNT(*) FROM procurement_adjustments WHERE entry_id = $1)::int AS adjustment_count`, [entryId])
    return { allocationCount: rows[0].allocation_count, adjustmentCount: rows[0].adjustment_count }
  }
  async setStatus(client, id, status) {
    await client.query(`UPDATE procurement_entries SET status = $2, updated_at = NOW() WHERE id = $1`, [id, status])
  }
  async setPurpose(client, id, { purpose, businessAccountId, reservationNote }) {
    await client.query(
      `UPDATE procurement_entries SET purpose = $2, business_account_id = $3, reservation_note = $4, updated_at = NOW() WHERE id = $1`,
      [id, purpose, businessAccountId ?? null, reservationNote ?? null])
  }

  // ─── reports ───
  async vendorSummary({ start, end, vendorId }) {
    const { rows } = await query(
      `SELECT v.id AS vendor_id, v.name AS vendor_name, COUNT(*)::int AS entries, COUNT(DISTINCT e.product_id)::int AS products,
              SUM(e.received_qty)::int AS received_qty, SUM(e.expected_qty)::int AS expected_qty, SUM(GREATEST(e.expected_qty - e.received_qty, 0))::int AS shortage_qty,
              SUM(e.damaged_qty)::int AS damaged_qty, SUM(e.purchase_total)::numeric(14,2) AS purchase_value
         FROM procurement_entries e JOIN vendors v ON v.id = e.vendor_id
        WHERE e.status = 'ACTIVE' AND e.procured_on >= $1::date AND e.procured_on <= $2::date AND ($3::uuid IS NULL OR e.vendor_id = $3)
        GROUP BY v.id, v.name ORDER BY purchase_value DESC`, [start, end, vendorId ?? null])
    return rows
  }
  async vendorProducts({ start, end, vendorId }) {
    const { rows } = await query(
      `SELECT e.product_id, p.name AS product_name, SUM(e.received_qty)::int AS received_qty, SUM(e.damaged_qty)::int AS damaged_qty,
              SUM(e.purchase_total)::numeric(14,2) AS purchase_value,
              (ARRAY_AGG(e.unit_price ORDER BY e.procured_on DESC, e.entry_no DESC))[1] AS last_unit_price
         FROM procurement_entries e JOIN products p ON p.id = e.product_id
        WHERE e.status = 'ACTIVE' AND e.procured_on >= $1::date AND e.procured_on <= $2::date AND e.vendor_id = $3
        GROUP BY e.product_id, p.name ORDER BY purchase_value DESC`, [start, end, vendorId])
    return rows
  }

  /** Per-entry movement of stock for the period, with per-store split and adjustments by kind. */
  async reconciliationEntries({ start, end, productId, vendorId }) {
    const { rows } = await query(
      `SELECT ${ENTRY_SELECT},
              COALESCE((SELECT jsonb_agg(jsonb_build_object('shopId', a.shop_id, 'shopName', s.name, 'quantity', a.quantity) ORDER BY s.name)
                          FROM procurement_allocations a JOIN shops s ON s.id = a.shop_id WHERE a.entry_id = e.id AND a.status = 'APPLIED'), '[]'::jsonb) AS per_shop,
              COALESCE((SELECT jsonb_object_agg(k.kind, k.qty) FROM (SELECT kind, SUM(quantity)::int AS qty FROM procurement_adjustments WHERE entry_id = e.id AND shop_id IS NULL GROUP BY kind) k), '{}'::jsonb) AS central_by_kind,
              COALESCE((SELECT jsonb_object_agg(k.kind, k.qty) FROM (SELECT kind, SUM(quantity)::int AS qty FROM procurement_adjustments WHERE entry_id = e.id AND shop_id IS NOT NULL GROUP BY kind) k), '{}'::jsonb) AS store_by_kind
         ${ENTRY_FROM}
        WHERE e.status = 'ACTIVE' AND e.procured_on >= $1::date AND e.procured_on <= $2::date
          AND ($3::uuid IS NULL OR e.product_id = $3) AND ($4::uuid IS NULL OR e.vendor_id = $4)
        ORDER BY e.procured_on DESC, e.entry_no DESC LIMIT 500`, [start, end, productId ?? null, vendorId ?? null])
    return rows
  }
  /** Units and revenue sold for products, and what stores hold now. "Placed" = not PENDING / CANCELLED. */
  async salesAndStock({ productIds, from, to }) {
    if (productIds.length === 0) return []
    const { rows } = await query(
      `SELECT x.product_id,
              COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                         WHERE oi.product_id = x.product_id AND o.status NOT IN ('PENDING','CANCELLED') AND o.created_at >= $2 AND o.created_at < $3), 0)::int AS sold_qty,
              COALESCE((SELECT SUM(oi.total) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                         WHERE oi.product_id = x.product_id AND o.status NOT IN ('PENDING','CANCELLED') AND o.created_at >= $2 AND o.created_at < $3), 0)::numeric(14,2) AS sales_value,
              COALESCE((SELECT SUM(stock_quantity) FROM shop_products WHERE product_id = x.product_id AND deleted_at IS NULL), 0)::int AS store_stock_now
         FROM UNNEST($1::uuid[]) AS x(product_id)`, [productIds, from, to])
    return rows
  }
}
