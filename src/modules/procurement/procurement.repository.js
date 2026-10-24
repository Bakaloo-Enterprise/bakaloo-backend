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

const VENDOR_COLS = `v.trade_name, v.gstin, v.address, v.contact_person, v.payment_terms, v.credit_days, v.upi_id, v.bank_name, v.bank_account_no, v.bank_ifsc`
const ENTRY_SELECT = `
  e.id, e.entry_no, e.product_id, e.vendor_id, e.unit, e.expected_qty, e.received_qty, e.damaged_qty, e.unit_price, e.purchase_total,
  to_char(e.procured_on, 'YYYY-MM-DD') AS procured_on, e.invoice_ref, e.receiving_note, e.destination_shop_id, e.purpose, e.business_account_id, e.reservation_note,
  e.status, e.created_by, e.created_at, e.owed_qty, e.received_at,
  (SELECT COUNT(*) FROM procurement_documents d WHERE d.entry_id = e.id AND d.kind = 'INVOICE')::int AS invoice_count,
  p.name AS product_name, p.sku AS product_sku, p.pack_size, p.pack_unit, p.product_family_id, v.name AS vendor_name, ds.name AS destination_name, b.company_name AS business_name,
  COALESCE(al.qty, 0)::int AS allocated, COALESCE(tr.qty, 0)::int AS in_transit, COALESCE(ca.qty, 0)::int AS central_adjusted, COALESCE(rv.qty, 0)::int AS reserved, COALESCE(cv.qty, 0)::int AS converted`
const ENTRY_FROM = `
  FROM procurement_entries e
  JOIN products p ON p.id = e.product_id
  JOIN vendors v ON v.id = e.vendor_id
  LEFT JOIN shops ds ON ds.id = e.destination_shop_id
  LEFT JOIN business_accounts b ON b.id = e.business_account_id
  LEFT JOIN LATERAL (SELECT SUM(quantity) AS qty FROM procurement_allocations WHERE entry_id = e.id AND status IN ('APPLIED','IN_TRANSIT')) al ON TRUE
  LEFT JOIN LATERAL (SELECT SUM(quantity) AS qty FROM procurement_allocations WHERE entry_id = e.id AND status = 'IN_TRANSIT') tr ON TRUE
  LEFT JOIN LATERAL (SELECT SUM(quantity) AS qty FROM procurement_adjustments WHERE entry_id = e.id AND shop_id IS NULL) ca ON TRUE
  LEFT JOIN LATERAL (SELECT SUM(quantity) AS qty FROM b2b_reservations WHERE entry_id = e.id AND status = 'RESERVED') rv ON TRUE
  LEFT JOIN LATERAL (SELECT SUM(units_used) AS qty FROM procurement_conversions WHERE entry_id = e.id AND status = 'APPLIED') cv ON TRUE`

export class ProcurementRepository {
  stock = new ShopProductsRepository()

  // ─── vendors ───
  async vendors({ includeInactive = false } = {}) {
    const { rows } = await query(
      `SELECT v.id, v.name, v.phone, v.notes, v.is_active, v.created_at, ${VENDOR_COLS},
              COUNT(e.id) FILTER (WHERE e.status = 'ACTIVE')::int AS entries
         FROM vendors v LEFT JOIN procurement_entries e ON e.vendor_id = v.id
        WHERE ($1 OR v.is_active) GROUP BY v.id ORDER BY LOWER(v.name)`,
      [includeInactive],
    )
    return rows
  }
  async vendorById(id, client) {
    return ((client ?? { query }).query(`SELECT v.id, v.name, v.phone, v.notes, v.is_active, v.created_at, ${VENDOR_COLS} FROM vendors v WHERE v.id = $1`, [id])).then((r) => r.rows[0] ?? null)
  }
  async vendorByName(name, client) {
    return ((client ?? { query }).query(`SELECT id, name, is_active FROM vendors WHERE LOWER(name) = LOWER($1)`, [name])).then((r) => r.rows[0] ?? null)
  }
  async createVendor({ name, phone, notes, ...profile }, actorId, client) {
    const { rows } = await (client ?? { query }).query(
      `INSERT INTO vendors (name, phone, notes, created_by, trade_name, gstin, address, contact_person, payment_terms, credit_days, upi_id, bank_name, bank_account_no, bank_ifsc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'CASH'),COALESCE($10,0),$11,$12,$13,$14) RETURNING id, name`,
      [name, phone ?? null, notes ?? null, actorId, profile.tradeName ?? null, profile.gstin ?? null, profile.address ?? null, profile.contactPerson ?? null,
        profile.paymentTerms ?? null, profile.creditDays ?? null, profile.upiId ?? null, profile.bankName ?? null, profile.bankAccountNo ?? null, profile.bankIfsc ?? null],
    )
    return this.vendorById(rows[0].id, client)
  }
  /** `undefined` leaves a column alone; `null` clears it. */
  async updateVendor(id, patch) {
    const cols = { name: 'name', phone: 'phone', notes: 'notes', isActive: 'is_active', tradeName: 'trade_name', gstin: 'gstin', address: 'address', contactPerson: 'contact_person',
      paymentTerms: 'payment_terms', creditDays: 'credit_days', upiId: 'upi_id', bankName: 'bank_name', bankAccountNo: 'bank_account_no', bankIfsc: 'bank_ifsc' }
    const sets = []
    const p = [id]
    for (const [k, col] of Object.entries(cols)) if (patch[k] !== undefined) { p.push(patch[k]); sets.push(`${col} = $${p.length}`) }
    if (sets.length === 0) return this.vendorById(id)
    const { rowCount } = await query(`UPDATE vendors SET ${sets.join(', ')} WHERE id = $1`, p)
    return rowCount ? this.vendorById(id) : null
  }

  // ─── supplier money ───
  /** Bills = received purchases, each with the credit for goods sent back (VENDOR_RETURN at the price we paid). */
  async bills(vendorId) {
    const { rows } = await query(
      `SELECT e.id, e.entry_no, e.vendor_id, to_char(e.procured_on, 'YYYY-MM-DD') AS procured_on, e.purchase_total AS total, p.name AS product_name, e.invoice_ref,
              COALESCE((SELECT SUM(a.quantity * a.unit_cost) FROM procurement_adjustments a WHERE a.entry_id = e.id AND a.kind = 'VENDOR_RETURN'), 0)::numeric(14,2) AS credit,
              (SELECT COUNT(*) FROM procurement_documents d WHERE d.entry_id = e.id AND d.kind = 'INVOICE')::int AS invoice_count
         FROM procurement_entries e JOIN products p ON p.id = e.product_id
        WHERE e.status = 'ACTIVE' AND ($1::uuid IS NULL OR e.vendor_id = $1) ORDER BY e.procured_on, e.entry_no`, [vendorId ?? null])
    return rows
  }
  async onTheWay(vendorId) {
    const { rows } = await query(
      `SELECT e.vendor_id, COUNT(*)::int AS n, COALESCE(SUM(e.purchase_total), 0)::numeric(14,2) AS value
         FROM procurement_entries e WHERE e.status = 'ORDERED' AND ($1::uuid IS NULL OR e.vendor_id = $1) GROUP BY e.vendor_id`, [vendorId ?? null])
    return rows
  }
  async paymentTotals() {
    const { rows } = await query(`SELECT vendor_id, SUM(amount)::numeric(14,2) AS total FROM vendor_payments WHERE voided_at IS NULL GROUP BY vendor_id`)
    return rows
  }
  async payments(vendorId, { limit = 50 } = {}) {
    const { rows } = await query(
      `SELECT y.id, y.amount, y.method, to_char(y.paid_on, 'YYYY-MM-DD') AS paid_on, y.reference, y.note, y.created_at, y.voided_at, y.void_reason, u.name AS actor_name
         FROM vendor_payments y LEFT JOIN users u ON u.id = y.created_by WHERE y.vendor_id = $1 ORDER BY y.paid_on DESC, y.created_at DESC LIMIT ${Number(limit)}`, [vendorId])
    return rows
  }
  async paidTotal(client, vendorId) {
    const { rows } = await client.query(`SELECT COALESCE(SUM(amount), 0)::numeric(14,2) AS total FROM vendor_payments WHERE vendor_id = $1 AND voided_at IS NULL`, [vendorId])
    return rows[0].total
  }
  async lockVendor(client, id) {
    const { rows } = await client.query(`SELECT id, name, is_active FROM vendors WHERE id = $1 FOR UPDATE`, [id])
    return rows[0] ?? null
  }
  async insertPayment(client, { vendorId, amount, method, paidOn, reference, note, actorId }) {
    const { rows } = await client.query(
      `INSERT INTO vendor_payments (vendor_id, amount, method, paid_on, reference, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [vendorId, amount, method, paidOn, reference ?? null, note ?? null, actorId])
    return rows[0].id
  }
  async paymentById(client, id) {
    const { rows } = await client.query(`SELECT id, vendor_id, amount, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, voided_at FROM vendor_payments WHERE id = $1 FOR UPDATE`, [id])
    return rows[0] ?? null
  }
  async voidPayment(client, id, { actorId, reason }) {
    await client.query(`UPDATE vendor_payments SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1`, [id, actorId, reason])
  }

  // ─── repacking bulk stock into pack sizes ───
  async setPackSize(productId, { size, unit }) {
    const { rows } = await query(`UPDATE products SET pack_size = $2, pack_unit = $3, updated_at = NOW() WHERE id = $1 RETURNING id, name, pack_size, pack_unit`, [productId, size, unit])
    return rows[0] ?? null
  }
  /** The other pack sizes of the same product family (e.g. Potato 500 g, Potato 1 kg), with the size each one holds. */
  async familyPacks(productId, familyId) {
    const { rows } = await query(
      `SELECT id, name, option_label, thumbnail_url, net_quantity, pack_size, pack_unit FROM products
        WHERE product_family_id = $2 AND id <> $1 AND is_active = true ORDER BY pack_size NULLS LAST, name`, [productId, familyId])
    return rows
  }
  async packProducts(ids, client) {
    const { rows } = await (client ?? { query }).query(`SELECT id, name, product_family_id, pack_size, pack_unit, is_active FROM products WHERE id = ANY($1::uuid[])`, [ids])
    return rows
  }
  async insertConversion(client, { entryId, unitsUsed, unitSize, gramsUsed, gramsPacked, gramsLost, note, actorId }) {
    const { rows } = await client.query(
      `INSERT INTO procurement_conversions (entry_id, units_used, unit_size, grams_used, grams_packed, grams_lost, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [entryId, unitsUsed, unitSize, gramsUsed, gramsPacked, gramsLost, note ?? null, actorId])
    return rows[0].id
  }
  async insertConversionLine(client, { conversionId, shopId, productId, shopProductId, packs, packSize, unitCost, movementId }) {
    await client.query(
      `INSERT INTO procurement_conversion_lines (conversion_id, shop_id, product_id, shop_product_id, packs, pack_size, unit_cost, movement_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [conversionId, shopId, productId, shopProductId, packs, packSize, unitCost, movementId])
  }
  async conversions(entryId) {
    const { rows } = await query(
      `SELECT c.id, c.units_used, c.unit_size, c.grams_used, c.grams_packed, c.grams_lost, c.status, c.note, c.created_at, c.reversed_at, u.name AS actor_name,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('shopName', s.name, 'productName', p.name, 'packs', l.packs, 'packSize', l.pack_size, 'unitCost', l.unit_cost::float) ORDER BY s.name, p.name)
                          FROM procurement_conversion_lines l JOIN shops s ON s.id = l.shop_id JOIN products p ON p.id = l.product_id WHERE l.conversion_id = c.id), '[]'::jsonb) AS lines
         FROM procurement_conversions c LEFT JOIN users u ON u.id = c.created_by WHERE c.entry_id = $1 ORDER BY c.created_at`, [entryId])
    return rows
  }
  async conversionForUpdate(client, id) {
    const { rows } = await client.query(`SELECT id, entry_id, status FROM procurement_conversions WHERE id = $1 FOR UPDATE`, [id])
    return rows[0] ?? null
  }
  async conversionLines(client, conversionId) {
    const { rows } = await client.query(`SELECT l.id, l.shop_id, l.shop_product_id, l.packs, l.product_id, p.name AS product_name FROM procurement_conversion_lines l JOIN products p ON p.id = l.product_id WHERE l.conversion_id = $1`, [conversionId])
    return rows
  }
  async markConversionReversed(client, id, actorId) {
    await client.query(`UPDATE procurement_conversions SET status = 'REVERSED', reversed_by = $2, reversed_at = NOW() WHERE id = $1`, [id, actorId])
  }
  async setLineReversal(client, lineId, movementId) {
    await client.query(`UPDATE procurement_conversion_lines SET reversal_movement_id = $2 WHERE id = $1`, [lineId, movementId])
  }

  // ─── documents ───
  async documents(entryId) {
    const { rows } = await query(`SELECT id, kind, file_name, mime_type, size_bytes, created_at FROM procurement_documents WHERE entry_id = $1 ORDER BY created_at`, [entryId])
    return rows
  }
  async insertDocument(client, { entryId, kind, fileName, mime, size, data, actorId }) {
    const { rows } = await client.query(
      `INSERT INTO procurement_documents (entry_id, kind, file_name, mime_type, size_bytes, data, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [entryId, kind, fileName, mime, size, data, actorId])
    return rows[0].id
  }
  async documentFile(id) {
    const { rows } = await query(`SELECT id, entry_id, file_name, mime_type, data FROM procurement_documents WHERE id = $1`, [id])
    return rows[0] ?? null
  }
  async deleteDocument(client, id) {
    const { rows } = await client.query(`DELETE FROM procurement_documents WHERE id = $1 RETURNING entry_id, kind, file_name`, [id])
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
                                        invoice_ref, receiving_note, destination_shop_id, purpose, business_account_id, reservation_note, created_by, status, received_at, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::varchar,CASE WHEN $17::varchar = 'ORDERED' THEN NULL ELSE NOW() END,CASE WHEN $17::varchar = 'ORDERED' THEN NULL ELSE $16::uuid END) RETURNING id`,
      [d.productId, d.vendorId, d.unit ?? null, d.expectedQty, d.receivedQty, d.damagedQty, d.unitPrice, d.purchaseTotal, d.procuredOn,
        d.invoiceRef ?? null, d.receivingNote ?? null, d.destinationShopId ?? null, d.purpose, d.businessAccountId ?? null, d.reservationNote ?? null, d.createdBy, d.status ?? 'ACTIVE'],
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

  async list({ from, to, vendorId, productId, shopId, status, owed, purpose, search, limit = 25, offset = 0 }) {
    const where = ['TRUE']
    const p = []
    const add = (sql, v) => { p.push(v); where.push(sql.replaceAll('$$', `$${p.length}`)) }
    if (from) add('e.procured_on >= $$', from)
    if (to) add('e.procured_on <= $$', to)
    if (vendorId) add('e.vendor_id = $$', vendorId)
    if (productId) add('e.product_id = $$', productId)
    if (status) add('e.status = $$', status)
    if (owed) where.push('e.owed_qty > 0')
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
  async insertAllocation(client, { entryId, shopId, shopProductId, quantity, movementId, note, actorId, inTransit = false }) {
    const { rows } = await client.query(
      `INSERT INTO procurement_allocations (entry_id, shop_id, shop_product_id, quantity, movement_id, note, created_by, status, applied_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::varchar, CASE WHEN $8::varchar = 'APPLIED' THEN NOW() END) RETURNING id`, [entryId, shopId, shopProductId, quantity, movementId, note ?? null, actorId, inTransit ? 'IN_TRANSIT' : 'APPLIED'])
    return rows[0].id
  }
  /** Transfers sent "on the way", oldest first, for the Arrived / Cancel list. */
  async transitList() {
    const { rows } = await query(
      `SELECT a.id, a.quantity, a.created_at, a.note, e.id AS entry_id, e.entry_no, p.name AS product_name, v.name AS vendor_name, s.name AS shop_name, u.name AS actor_name
         FROM procurement_allocations a JOIN procurement_entries e ON e.id = a.entry_id JOIN products p ON p.id = e.product_id JOIN vendors v ON v.id = e.vendor_id
         JOIN shops s ON s.id = a.shop_id LEFT JOIN users u ON u.id = a.created_by WHERE a.status = 'IN_TRANSIT' ORDER BY a.created_at`)
    return rows
  }
  async allocationFull(client, id) {
    const { rows } = await client.query(`SELECT a.id, a.entry_id, a.shop_id, a.shop_product_id, a.quantity, a.status, s.name AS shop_name FROM procurement_allocations a JOIN shops s ON s.id = a.shop_id WHERE a.id = $1 FOR UPDATE OF a`, [id])
    return rows[0] ?? null
  }
  async markTransferReceived(client, id, { quantity, movementId, userId }) {
    await client.query(`UPDATE procurement_allocations SET status = 'APPLIED', quantity = $2, movement_id = $3, applied_at = NOW(), received_by = $4 WHERE id = $1`, [id, quantity, movementId, userId])
  }
  async markCancelled(client, id, userId) {
    await client.query(`UPDATE procurement_allocations SET status = 'CANCELLED', reversed_by = $2, reversed_at = NOW() WHERE id = $1`, [id, userId])
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
              (SELECT COUNT(*) FROM procurement_adjustments WHERE entry_id = $1)::int AS adjustment_count,
              (SELECT COUNT(*) FROM b2b_reservations WHERE entry_id = $1 AND status = 'RESERVED')::int AS reservation_count,
              (SELECT COUNT(*) FROM procurement_conversions WHERE entry_id = $1 AND status = 'APPLIED')::int AS conversion_count`, [entryId])
    return { allocationCount: rows[0].allocation_count, adjustmentCount: rows[0].adjustment_count, reservationCount: rows[0].reservation_count, conversionCount: rows[0].conversion_count }
  }
  async markReceived(client, id, { receivedQty, damagedQty, owedQty, note, userId }) {
    await client.query(
      `UPDATE procurement_entries SET status = 'ACTIVE', received_qty = $2, damaged_qty = $3, owed_qty = $4, receiving_note = COALESCE($5, receiving_note),
              received_at = NOW(), received_by = $6, updated_at = NOW() WHERE id = $1`, [id, receivedQty, damagedQty, owedQty, note ?? null, userId])
  }
  async addArrival(client, id, quantity) {
    await client.query(`UPDATE procurement_entries SET received_qty = received_qty + $2, owed_qty = owed_qty - $2, updated_at = NOW() WHERE id = $1`, [id, quantity])
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

  /** For each supplier: the three products we buy from them most, and the day of the latest purchase. */
  async vendorUsuals() {
    const { rows } = await query(
      `SELECT vendor_id, (ARRAY_AGG(name ORDER BY n DESC, last_on DESC))[1:3] AS products, to_char(MAX(last_on), 'YYYY-MM-DD') AS last_on
         FROM (SELECT e.vendor_id, p.name, COUNT(*)::int AS n, MAX(e.procured_on) AS last_on
                 FROM procurement_entries e JOIN products p ON p.id = e.product_id WHERE e.status IN ('ACTIVE', 'ORDERED') GROUP BY e.vendor_id, p.name) x
        GROUP BY vendor_id`)
    return rows
  }
}
