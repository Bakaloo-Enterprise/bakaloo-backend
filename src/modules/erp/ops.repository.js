import { query } from '../../config/database.js'
import { PLACED, REFUND_EVENTS_CTE } from '../business-analytics/sales-rules.js'

/**
 * Operations ERP reads. Window args are [start, end) instants plus an optional store; `from`/`to` are India dates.
 * Sales follow the shared sales rules; stock follows the stock ledger (stock_movements) exactly.
 */
const SHOP_M = `($3::uuid IS NULL OR m.shop_id = $3)`
const many = async (sql, params) => (await query(sql, params)).rows

export class OpsRepository {
  /** Per product, what happened to the shelves in the window, plus opening and closing from the ledger itself. */
  async ledger([start, end, shopId]) {
    return many(
      `WITH win AS (
         SELECT m.product_id,
                SUM(m.quantity_delta) FILTER (WHERE m.type = 'PROCUREMENT_RECEIPT')::int AS bought,
                COALESCE(-SUM(m.quantity_delta) FILTER (WHERE m.type = 'ORDER_DEDUCTION'), 0)::int AS sold_out,
                COALESCE(SUM(m.quantity_delta) FILTER (WHERE m.type = 'CANCELLATION_RESTORE'), 0)::int AS cancel_back,
                COALESCE(SUM(m.quantity_delta) FILTER (WHERE m.type = 'RETURN_STOCK'), 0)::int AS returned,
                COALESCE(-SUM(m.quantity_delta) FILTER (WHERE m.type = 'DAMAGED_STOCK'), 0)::int AS wasted,
                COALESCE(SUM(m.quantity_delta) FILTER (WHERE m.type IN ('MANUAL_ADJUSTMENT','BULK_UPDATE','PROCUREMENT_REVERSAL')), 0)::int AS adjusted
           FROM stock_movements m WHERE m.created_at >= $1::timestamptz AND m.created_at < $2::timestamptz AND ${SHOP_M} GROUP BY m.product_id),
       closing AS (
         SELECT product_id, SUM(qty)::int AS qty FROM (
           SELECT DISTINCT ON (m.shop_product_id) m.product_id, m.quantity_after AS qty FROM stock_movements m
            WHERE m.created_at < $2::timestamptz AND ${SHOP_M} ORDER BY m.shop_product_id, m.created_at DESC, m.id) x GROUP BY product_id),
       opening AS (
         SELECT product_id, SUM(qty)::int AS qty FROM (
           SELECT DISTINCT ON (m.shop_product_id) m.product_id, m.quantity_after AS qty FROM stock_movements m
            WHERE m.created_at < $1::timestamptz AND ${SHOP_M} ORDER BY m.shop_product_id, m.created_at DESC, m.id) x GROUP BY product_id),
       now_stock AS (
         SELECT sp.product_id, SUM(sp.stock_quantity)::int AS qty FROM shop_products sp
          WHERE sp.deleted_at IS NULL AND ($3::uuid IS NULL OR sp.shop_id = $3) GROUP BY sp.product_id)
       SELECT p.id AS product_id, p.name, c.name AS category, p.unit, p.net_quantity, p.shelf_life, p.target_margin_pct, p.target_wastage_pct,
              COALESCE(o.qty, 0) AS opening, COALESCE(cl.qty, 0) AS closing, COALESCE(ns.qty, 0) AS stock_now,
              COALESCE(w.bought, 0) AS bought, COALESCE(w.sold_out, 0) AS sold_out, COALESCE(w.cancel_back, 0) AS cancel_back,
              COALESCE(w.returned, 0) AS returned, COALESCE(w.wasted, 0) AS wasted, COALESCE(w.adjusted, 0) AS adjusted
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN win w ON w.product_id = p.id LEFT JOIN closing cl ON cl.product_id = p.id LEFT JOIN opening o ON o.product_id = p.id LEFT JOIN now_stock ns ON ns.product_id = p.id
        WHERE p.deleted_at IS NULL AND (w.product_id IS NOT NULL OR COALESCE(cl.qty, 0) > 0 OR COALESCE(o.qty, 0) > 0)`, [start, end, shopId])
  }

  /** What sold and for how much: orders that stood (not cancelled, not unpaid, not refunded in full). */
  async sales([start, end, shopId]) {
    return many(
      `WITH ${REFUND_EVENTS_CTE}
       SELECT oi.product_id, SUM(oi.quantity)::int AS units, COALESCE(SUM(oi.total), 0)::numeric(14,2) AS revenue, COUNT(DISTINCT o.id)::int AS orders
         FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN refund_events r ON r.order_id = o.id
        WHERE ${PLACED} AND COALESCE(r.is_full, false) = false AND o.created_at >= $1::timestamptz AND o.created_at < $2::timestamptz AND ($3::uuid IS NULL OR o.shop_id = $3)
        GROUP BY oi.product_id`, [start, end, shopId])
  }

  /** Cost per unit: what the latest purchase (up to the end of the window) cost, and the day's own average if we bought that day. */
  async costs([start, end, shopId]) {
    return many(
      `SELECT p.id AS product_id,
              (SELECT e.unit_price FROM procurement_entries e WHERE e.product_id = p.id AND e.status = 'ACTIVE' AND e.created_at < $2::timestamptz
                  AND ($3::uuid IS NULL OR e.destination_shop_id = $3) ORDER BY e.created_at DESC LIMIT 1) AS last_cost,
              (SELECT SUM(e.purchase_total) / NULLIF(SUM(e.received_qty), 0) FROM procurement_entries e WHERE e.product_id = p.id AND e.status = 'ACTIVE'
                  AND e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz AND ($3::uuid IS NULL OR e.destination_shop_id = $3)) AS window_cost,
              (SELECT AVG(sp.cost_price) FROM shop_products sp WHERE sp.product_id = p.id AND sp.cost_price IS NOT NULL AND ($3::uuid IS NULL OR sp.shop_id = $3)) AS shop_cost,
              (SELECT AVG(COALESCE(sp2.sale_price, sp2.price)) FROM shop_products sp2 WHERE sp2.product_id = p.id AND sp2.deleted_at IS NULL AND ($3::uuid IS NULL OR sp2.shop_id = $3)) AS shelf_price,
              p.cost_price AS catalog_cost, p.price AS catalog_price
         FROM products p WHERE p.deleted_at IS NULL`, [start, end, shopId])
  }

  /** Money spent buying stock, and what was damaged at the door, in the window. */
  async purchases([from, to, shopId]) {
    return many(
      `SELECT e.product_id, v.name AS vendor, SUM(e.purchase_total)::numeric(14,2) AS spend, SUM(e.received_qty)::int AS qty,
              SUM(e.damaged_qty)::int AS damaged_qty, SUM(e.damaged_qty * e.unit_price)::numeric(14,2) AS damaged_value
         FROM procurement_entries e JOIN vendors v ON v.id = e.vendor_id
        WHERE e.status = 'ACTIVE' AND e.procured_on >= $1::date AND e.procured_on <= $2::date AND ($3::uuid IS NULL OR e.destination_shop_id = $3)
        GROUP BY e.product_id, v.name`, [from, to, shopId])
  }

  /** Spoilage written off, by India day, product and reason, valued at the cost of the last purchase before it. */
  async wastage([start, end, shopId]) {
    return many(
      `SELECT to_char((m.created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day, m.product_id,
              COALESCE(NULLIF(m.metadata->>'reason', ''), NULLIF(m.reason, ''), 'Other') AS reason,
              SUM(-m.quantity_delta)::int AS qty,
              SUM(-m.quantity_delta * COALESCE(rc.cost, sp.cost_price, p.cost_price, 0))::numeric(14,2) AS value
         FROM stock_movements m
         JOIN shop_products sp ON sp.id = m.shop_product_id JOIN products p ON p.id = m.product_id
         LEFT JOIN LATERAL (SELECT (r.metadata->>'unitCost')::numeric AS cost FROM stock_movements r
                             WHERE r.shop_product_id = m.shop_product_id AND r.type = 'PROCUREMENT_RECEIPT' AND r.created_at <= m.created_at AND r.metadata ? 'unitCost'
                             ORDER BY r.created_at DESC LIMIT 1) rc ON TRUE
        WHERE m.type = 'DAMAGED_STOCK' AND m.created_at >= $1::timestamptz AND m.created_at < $2::timestamptz AND ${SHOP_M}
        GROUP BY 1, 2, 3`, [start, end, shopId])
  }

  /** Units sold per product per India day (orders that stood) — the raw material of the forecast. */
  async dailyUnits([start, end, shopId]) {
    return many(
      `WITH ${REFUND_EVENTS_CTE}
       SELECT oi.product_id, to_char((o.created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day, SUM(oi.quantity)::int AS units
         FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN refund_events r ON r.order_id = o.id
        WHERE ${PLACED} AND COALESCE(r.is_full, false) = false AND o.created_at >= $1::timestamptz AND o.created_at < $2::timestamptz AND ($3::uuid IS NULL OR o.shop_id = $3)
          AND NOT (o.buyer_gstin IS NOT NULL OR o.b2b_approval_status IS NOT NULL)
        GROUP BY 1, 2`, [start, end, shopId])
  }

  /** Orders by India hour of day (orders that stood, home delivery) — tells how much of a day's selling is still ahead. */
  async hours([start, end, shopId]) {
    return many(
      `WITH ${REFUND_EVENTS_CTE}
       SELECT EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, COUNT(*)::int AS orders
         FROM orders o LEFT JOIN refund_events r ON r.order_id = o.id
        WHERE ${PLACED} AND COALESCE(r.is_full, false) = false AND o.created_at >= $1::timestamptz AND o.created_at < $2::timestamptz AND ($3::uuid IS NULL OR o.shop_id = $3)
          AND NOT (o.buyer_gstin IS NOT NULL OR o.b2b_approval_status IS NOT NULL)
        GROUP BY 1`, [start, end, shopId])
  }

  /** Stock on the shelves now, and what is already on its way (ordered, not yet received). */
  async stockAndIncoming(shopId) {
    return many(
      `SELECT p.id AS product_id, p.name, c.name AS category, p.unit, p.net_quantity, p.shelf_life, p.target_wastage_pct, COALESCE(p.cost_price, 0) AS catalog_cost,
              COALESCE(SUM(sp.stock_quantity) FILTER (WHERE sp.deleted_at IS NULL AND ($1::uuid IS NULL OR sp.shop_id = $1)), 0)::int AS stock,
              COALESCE(AVG(sp.cost_price) FILTER (WHERE sp.cost_price IS NOT NULL), p.cost_price, 0) AS cost,
              (SELECT COALESCE(SUM(e.expected_qty), 0)::int FROM procurement_entries e WHERE e.product_id = p.id AND e.status = 'ORDERED'
                  AND ($1::uuid IS NULL OR e.destination_shop_id = $1 OR e.destination_shop_id IS NULL)) AS incoming
         FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN shop_products sp ON sp.product_id = p.id
        WHERE p.deleted_at IS NULL AND p.is_active = true GROUP BY p.id, c.name`, [shopId])
  }

  async setTargets(productId, { marginPct, wastagePct }) {
    const { rows } = await query(
      `UPDATE products SET target_margin_pct = $2, target_wastage_pct = $3, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id, target_margin_pct, target_wastage_pct`,
      [productId, marginPct, wastagePct])
    return rows[0] ?? null
  }

  /** Customers by the month of their first order that stood, and how many of them ordered again k months later (from `since` back 6 months). */
  async cohorts(until) {
    return many(
      `WITH first_order AS (SELECT o.user_id, date_trunc('month', MIN(o.created_at AT TIME ZONE 'Asia/Kolkata'))::date AS m FROM orders o WHERE ${PLACED} GROUP BY 1),
            act AS (SELECT DISTINCT o.user_id, date_trunc('month', o.created_at AT TIME ZONE 'Asia/Kolkata')::date AS m FROM orders o WHERE ${PLACED} AND o.created_at < ($1::timestamptz + interval '1 month')),
            win AS (SELECT $1::timestamptz AT TIME ZONE 'Asia/Kolkata' AS d)
       SELECT to_char(f.m, 'YYYY-MM') AS cohort, ((EXTRACT(YEAR FROM a.m) - EXTRACT(YEAR FROM f.m)) * 12 + EXTRACT(MONTH FROM a.m) - EXTRACT(MONTH FROM f.m))::int AS k, COUNT(DISTINCT f.user_id)::int AS n
         FROM first_order f JOIN act a ON a.user_id = f.user_id, win
        WHERE f.m >= (date_trunc('month', win.d) - interval '5 months')::date AND f.m <= date_trunc('month', win.d)::date AND a.m >= f.m
        GROUP BY 1, 2 ORDER BY 1, 2`, [until])
  }

  /** What is on one store's shelves right now (for the wastage entry picker). */
  async shelf(shopId) {
    return many(
      `SELECT sp.id AS shop_product_id, p.id AS product_id, p.name, p.net_quantity, c.name AS category, sp.stock_quantity AS stock
         FROM shop_products sp JOIN products p ON p.id = sp.product_id LEFT JOIN categories c ON c.id = p.category_id
        WHERE sp.shop_id = $1 AND sp.deleted_at IS NULL AND p.deleted_at IS NULL AND sp.stock_quantity > 0 ORDER BY p.name`, [shopId])
  }
  async shopProduct(shopId, productId) {
    return (await many(`SELECT sp.id, sp.stock_quantity AS stock, p.name FROM shop_products sp JOIN products p ON p.id = sp.product_id WHERE sp.shop_id = $1 AND sp.product_id = $2 AND sp.deleted_at IS NULL`, [shopId, productId]))[0] ?? null
  }
}
