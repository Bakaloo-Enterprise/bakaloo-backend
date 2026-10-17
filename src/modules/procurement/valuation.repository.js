import { query } from '../../config/database.js'

const QTY_AT = (p) => `COALESCE(
  (SELECT m.quantity_after FROM stock_movements m WHERE m.shop_product_id = sp.id AND m.created_at < ${p} ORDER BY m.created_at DESC, m.id DESC LIMIT 1),
  (SELECT m.quantity_before FROM stock_movements m WHERE m.shop_product_id = sp.id AND m.created_at >= ${p} ORDER BY m.created_at ASC, m.id ASC LIMIT 1),
  sp.stock_quantity)`

/** Reads for stock valuation. Everything is derived from the audited ledgers; nothing here writes. */
export class ValuationRepository {
  /** Every shelf row with what it held at the start and end of the window (reconstructed from the stock ledger). */
  async shelves(start, end) {
    const { rows } = await query(
      `SELECT sp.id, sp.shop_id, sp.product_id, s.name AS shop_name, p.name AS product_name, sp.cost_price, sp.stock_quantity,
              ${QTY_AT('$1')}::int AS qty_start, ${QTY_AT('$2')}::int AS qty_end
         FROM shop_products sp JOIN shops s ON s.id = sp.shop_id JOIN products p ON p.id = sp.product_id`, [start, end])
    return rows
  }

  /** Stock movements in the window with the order line they belong to, the sales channel and the purchase price for receipts. */
  async movements(start, end) {
    const { rows } = await query(
      `SELECT m.shop_product_id, m.type, m.quantity_delta AS delta, m.quantity_before AS before, m.created_at AS at, m.order_id,
              ol.price AS line_price,
              CASE WHEN o.id IS NULL THEN NULL WHEN o.b2b_approval_status IS NOT NULL OR o.buyer_gstin IS NOT NULL THEN 'B2B' ELSE 'B2C' END AS channel,
              COALESCE((m.metadata->>'unitCost')::numeric, pe.unit_price) AS entry_price,
              (m.metadata ? 'conversionId') AS from_repack
         FROM stock_movements m
         LEFT JOIN orders o ON o.id = m.order_id
         LEFT JOIN LATERAL (SELECT oi.price FROM order_items oi WHERE oi.order_id = m.order_id AND oi.product_id = m.product_id LIMIT 1) ol ON TRUE
         LEFT JOIN procurement_entries pe ON pe.id = CASE WHEN m.metadata->>'procurementEntryId' ~ '^[0-9a-f-]{36}$' THEN (m.metadata->>'procurementEntryId')::uuid END
        WHERE m.created_at >= $1 AND m.created_at < $2 ORDER BY m.shop_product_id, m.created_at`, [start, end])
    return rows
  }

  async snapshot(month) {
    const { rows } = await query(`SELECT shop_product_id, qty, avg_cost::float AS avg_cost FROM period_stock_snapshots WHERE month = $1`, [month])
    return rows
  }

  /** Bought stock that is still in the warehouse at an instant, per purchase, valued at that purchase's own price. */
  async warehouseAsOf(instant) {
    const { rows } = await query(
      `SELECT e.id, e.entry_no, e.unit_price::float AS price, p.name AS product, v.name AS vendor,
              CASE WHEN e.received_at < $1 THEN e.received_qty
                     - COALESCE((SELECT SUM((ev.detail->>'quantity')::int) FROM procurement_events ev WHERE ev.entry_id = e.id AND ev.kind = 'ARRIVED_LATER' AND ev.created_at >= $1), 0)
                   ELSE 0 END AS received,
              CASE WHEN e.received_at < $1 THEN e.damaged_qty ELSE 0 END AS damaged,
              COALESCE((SELECT SUM(a.quantity) FROM procurement_allocations a WHERE a.entry_id = e.id AND a.applied_at < $1), 0)
                - COALESCE((SELECT SUM(a.quantity) FROM procurement_allocations a WHERE a.entry_id = e.id AND a.status = 'REVERSED' AND a.reversed_at < $1), 0) AS sent,
              COALESCE((SELECT SUM(a.quantity) FROM procurement_allocations a WHERE a.entry_id = e.id AND a.created_at < $1 AND (a.applied_at IS NULL OR a.applied_at >= $1) AND (a.status <> 'CANCELLED' OR a.reversed_at >= $1)), 0) AS transit,
              COALESCE((SELECT SUM(j.quantity) FROM procurement_adjustments j WHERE j.entry_id = e.id AND j.shop_id IS NULL AND j.created_at < $1), 0) AS adj,
              COALESCE((SELECT SUM(c.units_used) FROM procurement_conversions c WHERE c.entry_id = e.id AND c.created_at < $1), 0)
                - COALESCE((SELECT SUM(c.units_used) FROM procurement_conversions c WHERE c.entry_id = e.id AND c.reversed_at < $1), 0) AS conv,
              COALESCE((SELECT SUM(c.grams_lost * e.unit_price::float / c.unit_size) FROM procurement_conversions c WHERE c.entry_id = e.id AND c.created_at < $1), 0)
                - COALESCE((SELECT SUM(c.grams_lost * e.unit_price::float / c.unit_size) FROM procurement_conversions c WHERE c.entry_id = e.id AND c.reversed_at < $1), 0) AS conv_lost_value
         FROM procurement_entries e JOIN products p ON p.id = e.product_id JOIN vendors v ON v.id = e.vendor_id WHERE e.status <> 'CANCELLED'`, [instant])
    return rows
  }

  /** Stock taken out of the warehouse hold for a reason, in the window, at the PURCHASE price (a replacement's credit is 0, its stock value is not). */
  async warehouseOut(start, end) {
    const { rows } = await query(
      `SELECT j.kind, SUM(j.quantity)::int AS units, SUM(j.quantity * e.unit_price)::float AS value
         FROM procurement_adjustments j JOIN procurement_entries e ON e.id = j.entry_id
        WHERE j.shop_id IS NULL AND j.created_at >= $1 AND j.created_at < $2 GROUP BY j.kind`, [start, end])
    return rows
  }

  /** Goods delivered straight from the warehouse hold to a B2B request in the window, with the price agreed for them (if any). */
  async directSupplies(start, end) {
    const { rows } = await query(
      `SELECT x.quantity, e.unit_price::float AS cost, i.unit_price::float AS sell
         FROM b2b_reservations x
         JOIN procurement_entries e ON e.id = x.entry_id
         LEFT JOIN b2b_requirement_items i ON i.requirement_id = x.requirement_id AND i.product_id = x.product_id
        WHERE x.status = 'FULFILLED' AND x.closed_at >= $1 AND x.closed_at < $2`, [start, end])
    return rows
  }
}
