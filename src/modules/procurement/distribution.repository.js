import { query } from '../../config/database.js'

/** Reads and writes for "send this purchase where it is needed". Stock itself still moves only through ProcurementService.applySplit. */
export class DistributionRepository {
  /** Confirmed requests that still need units of this product (asked − already reserved). */
  async openRequests(productId, client) {
    const { rows } = await (client ?? { query }).query(
      `SELECT r.id, r.req_no, r.customer_name, to_char(r.delivery_date, 'YYYY-MM-DD') AS due, i.quantity AS asked,
              COALESCE((SELECT SUM(x.quantity) FROM b2b_reservations x WHERE x.requirement_id = r.id AND x.product_id = i.product_id AND x.status = 'RESERVED'), 0)::int AS reserved
         FROM b2b_requirement_items i JOIN b2b_requirements r ON r.id = i.requirement_id
        WHERE r.status = 'CONFIRMED' AND i.product_id = $1 ORDER BY r.delivery_date NULLS LAST, r.created_at`, [productId])
    return rows
  }

  /** App B2B orders waiting for approval, per store: stock is taken from that store when an admin approves. */
  async appDemand(productId) {
    const { rows } = await query(
      `SELECT o.shop_id, SUM(oi.quantity)::int AS qty FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.product_id = $1 AND o.b2b_approval_status = 'PENDING' AND o.status::text <> 'CANCELLED' AND o.shop_id IS NOT NULL GROUP BY o.shop_id`, [productId])
    return rows
  }

  /** Active stores that carry the product, with what they hold and their low-stock line. */
  async shopsCarrying(productId) {
    const { rows } = await query(
      `SELECT s.id AS shop_id, s.name, sp.stock_quantity AS stock, sp.low_stock_threshold AS low
         FROM shop_products sp JOIN shops s ON s.id = sp.shop_id
        WHERE sp.product_id = $1 AND sp.deleted_at IS NULL AND sp.is_available IS NOT FALSE AND s.is_active AND s.deleted_at IS NULL ORDER BY s.name`, [productId])
    return rows
  }

  async lockRequests(client, ids) {
    const { rows } = await client.query(`SELECT id, status, customer_name, req_no FROM b2b_requirements WHERE id = ANY($1::uuid[]) FOR UPDATE`, [ids])
    return rows
  }

  async insertReservation(client, { requirementId, productId, entryId, quantity, actorId }) {
    const { rows } = await client.query(
      `INSERT INTO b2b_reservations (requirement_id, product_id, entry_id, quantity, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [requirementId, productId, entryId, quantity, actorId])
    return rows[0].id
  }

  async reservationsOf(requirementId) {
    const { rows } = await query(
      `SELECT x.id, x.product_id, x.quantity, x.status, x.entry_id, e.entry_no, p.name AS product_name, v.name AS vendor_name
         FROM b2b_reservations x JOIN procurement_entries e ON e.id = x.entry_id JOIN products p ON p.id = x.product_id JOIN vendors v ON v.id = e.vendor_id
        WHERE x.requirement_id = $1 ORDER BY x.created_at`, [requirementId])
    return rows
  }

  async reservationsForRequests(ids) {
    if (ids.length === 0) return []
    const { rows } = await query(`SELECT requirement_id, product_id, SUM(quantity)::int AS qty FROM b2b_reservations WHERE requirement_id = ANY($1::uuid[]) AND status = 'RESERVED' GROUP BY 1, 2`, [ids])
    return rows
  }

  async reservationById(client, id) {
    const { rows } = await client.query(`SELECT id, requirement_id, entry_id, quantity, status FROM b2b_reservations WHERE id = $1 FOR UPDATE`, [id])
    return rows[0] ?? null
  }
  async openReservations(client, requirementId) {
    const { rows } = await client.query(
      `SELECT x.id, x.entry_id, x.quantity, e.unit_price, e.entry_no FROM b2b_reservations x JOIN procurement_entries e ON e.id = x.entry_id
        WHERE x.requirement_id = $1 AND x.status = 'RESERVED' FOR UPDATE OF x`, [requirementId])
    return rows
  }
  async closeReservation(client, id, status) {
    await client.query(`UPDATE b2b_reservations SET status = $2, closed_at = NOW() WHERE id = $1`, [id, status])
  }
  /** The stock leaves the purchase's central holding exactly once: as the existing B2B_SUPPLY adjustment. */
  async insertSupplyAdjustment(client, { entryId, quantity, unitCost, reason, actorId }) {
    await client.query(
      `INSERT INTO procurement_adjustments (entry_id, kind, quantity, shop_id, movement_id, unit_cost, reason, created_by) VALUES ($1,'B2B_SUPPLY',$2,NULL,NULL,$3,$4,$5)`,
      [entryId, quantity, unitCost, reason, actorId])
  }
  async logEntryEvent(client, entryId, actorId, kind, detail) {
    await client.query(`INSERT INTO procurement_events (entry_id, actor_id, kind, detail) VALUES ($1,$2,$3,$4)`, [entryId, actorId, kind, JSON.stringify(detail)])
  }
}
