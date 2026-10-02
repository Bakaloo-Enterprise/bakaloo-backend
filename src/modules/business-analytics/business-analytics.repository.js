import { query } from '../../config/database.js'

/**
 * Business Analytics queries (Phase 12). Everything is computed live from the real tables — no report tables, so a
 * late refund or a corrected stock record simply makes the next read right.
 *
 * Every query takes the same filters as $3 (store id or NULL) and $4 ('B2B' | 'B2C' | NULL); $1/$2 are the period
 * ([start, end) as instants for order data, the same dates as YYYY-MM-DD for purchase data).
 *
 * Channel: an order is B2B when it was placed by a business account — the GSTIN snapshot taken at order time or the
 * B2B credit flow marker. Everything else is B2C.
 */
const CH = `(CASE WHEN o.buyer_gstin IS NOT NULL OR o.b2b_approval_status IS NOT NULL THEN 'B2B' ELSE 'B2C' END)`
const ORDER_FILTER = `($3::uuid IS NULL OR o.shop_id = $3) AND ($4::text IS NULL OR ${CH} = $4)`
/** An order that really happened: not still waiting for payment and not cancelled. Refunded orders count (refunds are shown separately). */
const PLACED = `o.status NOT IN ('PENDING', 'CANCELLED')`
const DAY_IST = `((o.created_at AT TIME ZONE 'Asia/Kolkata')::date)`

const one = async (sql, params) => (await query(sql, params)).rows[0]
const many = async (sql, params) => (await query(sql, params)).rows

export class BusinessAnalyticsRepository {
  async sales(args) {
    return one(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(o.total_amount), 0)::numeric(14,2) AS gross, COUNT(DISTINCT o.user_id)::int AS customers
         FROM orders o WHERE ${PLACED} AND o.created_at >= $1 AND o.created_at < $2 AND ${ORDER_FILTER}`, args)
  }
  async salesByDay(args) {
    return many(
      `SELECT to_char(${DAY_IST}, 'YYYY-MM-DD') AS day, COUNT(*)::int AS orders, COALESCE(SUM(o.total_amount), 0)::numeric(14,2) AS gross
         FROM orders o WHERE ${PLACED} AND o.created_at >= $1 AND o.created_at < $2 AND ${ORDER_FILTER} GROUP BY 1 ORDER BY 1`, args)
  }

  /**
   * Money handed back, counted once per order and dated by when it was refunded: an approved refund request, or — for
   * orders with no request — a gateway refund. Cancelled orders are excluded: they are not in gross sales to begin with.
   */
  async refunds(args) {
    return one(
      `WITH req AS (SELECT order_id, SUM(refund_amount) AS amt, MAX(processed_at) AS at FROM refund_requests WHERE status = 'APPROVED' AND refund_amount IS NOT NULL GROUP BY order_id),
            pay AS (SELECT order_id, SUM(refund_amount) AS amt, MAX(updated_at) AS at FROM payments WHERE refund_amount > 0 GROUP BY order_id),
            ref AS (SELECT COALESCE(req.order_id, pay.order_id) AS order_id, COALESCE(req.amt, pay.amt) AS amt, COALESCE(req.at, pay.at) AS at
                      FROM req FULL JOIN pay ON pay.order_id = req.order_id)
       SELECT COUNT(*)::int AS n, COALESCE(SUM(ref.amt), 0)::numeric(14,2) AS amount
         FROM ref JOIN orders o ON o.id = ref.order_id
        WHERE o.status <> 'CANCELLED' AND ref.at >= $1 AND ref.at < $2 AND ${ORDER_FILTER}`, args)
  }

  /** Orders cancelled in the period AFTER they had been confirmed (an unpaid order that expired is not leakage). */
  async cancelled(args) {
    return one(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(o.total_amount), 0)::numeric(14,2) AS amount
         FROM orders o
         JOIN LATERAL (SELECT MAX(h.changed_at) AS at FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'CANCELLED') c ON TRUE
        WHERE o.status = 'CANCELLED' AND c.at >= $1 AND c.at < $2
          AND EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'CONFIRMED') AND ${ORDER_FILTER}`, args)
  }

  /** Platform commission on delivered orders — the same formula as the store settlement: subtotal × the store's rate. */
  async commission(args) {
    return one(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(ROUND(o.subtotal * COALESCE(s.commission_rate, 0) / 100, 2)), 0)::numeric(14,2) AS amount
         FROM orders o JOIN shops s ON s.id = o.shop_id
        WHERE o.status = 'DELIVERED' AND o.delivered_at >= $1 AND o.delivered_at < $2 AND ${ORDER_FILTER}`, args)
  }

  /** Goods that came back into store stock, valued at the price the customer paid (or the store's price when unlinked). */
  async returns(args) {
    return one(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(m.quantity_delta * COALESCE(oi.price, sp.sale_price, sp.price, p.price)), 0)::numeric(14,2) AS amount
         FROM stock_movements m
         JOIN shop_products sp ON sp.id = m.shop_product_id JOIN products p ON p.id = m.product_id
         LEFT JOIN orders o ON o.id = m.order_id
         LEFT JOIN LATERAL (SELECT price FROM order_items WHERE order_id = m.order_id AND product_id = m.product_id LIMIT 1) oi ON TRUE
        WHERE m.type = 'RETURN_STOCK' AND m.created_at >= $1 AND m.created_at < $2
          AND ($3::uuid IS NULL OR m.shop_id = $3)
          AND ($4::text IS NULL OR (CASE WHEN o.id IS NULL THEN 'B2C' ELSE ${CH} END) = $4)`, args)
  }

  /**
   * What was paid to buy stock in the period (by purchase date). With a store filter: the part of each purchase that was
   * sent to that store. B2B = stock bought for a B2B reservation; B2C = everything else.
   */
  async procurementCost([from, to, shopId, channel]) {
    return one(
      `SELECT COUNT(*)::int AS entries,
              COALESCE(SUM(CASE WHEN $3::uuid IS NULL THEN e.purchase_total ELSE a.qty * e.unit_price END), 0)::numeric(14,2) AS amount
         FROM procurement_entries e
         LEFT JOIN LATERAL (SELECT SUM(quantity) AS qty FROM procurement_allocations WHERE entry_id = e.id AND shop_id = $3 AND status = 'APPLIED') a ON TRUE
        WHERE e.status = 'ACTIVE' AND e.procured_on >= $1::date AND e.procured_on <= $2::date
          AND ($3::uuid IS NULL OR a.qty > 0)
          AND ($4::text IS NULL OR (CASE WHEN e.purpose = 'B2B_RESERVED' THEN 'B2B' ELSE 'B2C' END) = $4)`, [from, to, shopId, channel])
  }

  /**
   * Recorded loss: damaged at the door, damage / wastage / authorised adjustments from procurement, and damaged stock
   * written off at a store outside procurement (valued at the store's cost price — unpriced ones are counted so the
   * screen can say so). A vendor return is recovered cost and a B2B supply is a sale: neither is a loss.
   */
  async trackedLoss([from, to, shopId, channel]) {
    const door = await one(
      `SELECT COALESCE(SUM(e.damaged_qty * e.unit_price), 0)::numeric(14,2) AS amount FROM procurement_entries e
        WHERE e.status = 'ACTIVE' AND e.damaged_qty > 0 AND e.procured_on >= $1::date AND e.procured_on <= $2::date
          AND ($3::uuid IS NULL OR e.destination_shop_id = $3)
          AND ($4::text IS NULL OR (CASE WHEN e.purpose = 'B2B_RESERVED' THEN 'B2B' ELSE 'B2C' END) = $4)`, [from, to, shopId, channel])
    const adj = await one(
      `SELECT COALESCE(SUM(j.quantity * j.unit_cost), 0)::numeric(14,2) AS amount
         FROM procurement_adjustments j JOIN procurement_entries e ON e.id = j.entry_id
        WHERE j.kind IN ('DAMAGE','WASTAGE','AUTHORIZED_ADJUSTMENT')
          AND (j.created_at AT TIME ZONE 'Asia/Kolkata')::date >= $1::date AND (j.created_at AT TIME ZONE 'Asia/Kolkata')::date <= $2::date
          AND ($3::uuid IS NULL OR j.shop_id = $3)
          AND ($4::text IS NULL OR (CASE WHEN e.purpose = 'B2B_RESERVED' THEN 'B2B' ELSE 'B2C' END) = $4)`, [from, to, shopId, channel])
    const store = await one(
      `SELECT COALESCE(SUM(-m.quantity_delta * COALESCE(sp.cost_price, 0)), 0)::numeric(14,2) AS amount,
              COUNT(*) FILTER (WHERE sp.cost_price IS NULL)::int AS unpriced
         FROM stock_movements m JOIN shop_products sp ON sp.id = m.shop_product_id
        WHERE m.type = 'DAMAGED_STOCK' AND COALESCE(m.metadata->>'fromProcurement', '') = ''
          AND (m.created_at AT TIME ZONE 'Asia/Kolkata')::date >= $1::date AND (m.created_at AT TIME ZONE 'Asia/Kolkata')::date <= $2::date
          AND ($3::uuid IS NULL OR m.shop_id = $3) AND ($4::text IS NULL OR $4 = 'B2C')`, [from, to, shopId, channel])
    return { door: door.amount, adjustments: adj.amount, storeDamage: store.amount, unpriced: store.unpriced }
  }

  // ─── drill-downs ───
  async products(args, { start, end, limit }) {
    const cur = await many(
      `SELECT oi.product_id, p.name, p.sku, SUM(oi.quantity)::int AS units, SUM(oi.total)::numeric(14,2) AS revenue, COUNT(DISTINCT o.id)::int AS orders, COUNT(DISTINCT o.user_id)::int AS buyers,
              (SELECT COUNT(*) FROM (SELECT o2.user_id FROM order_items oi2 JOIN orders o2 ON o2.id = oi2.order_id
                                      WHERE oi2.product_id = oi.product_id AND o2.status NOT IN ('PENDING','CANCELLED') AND o2.created_at >= $1 AND o2.created_at < $2
                                        AND ($3::uuid IS NULL OR o2.shop_id = $3) AND ($4::text IS NULL OR (CASE WHEN o2.buyer_gstin IS NOT NULL OR o2.b2b_approval_status IS NOT NULL THEN 'B2B' ELSE 'B2C' END) = $4)
                                      GROUP BY o2.user_id HAVING COUNT(DISTINCT o2.id) >= 2) rep)::int AS repeat_buyers
         FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
        WHERE ${PLACED} AND o.created_at >= $1 AND o.created_at < $2 AND ${ORDER_FILTER}
        GROUP BY oi.product_id, p.name, p.sku ORDER BY revenue DESC LIMIT ${Number(limit) * 3}`, args)
    const ids = cur.map((r) => r.product_id)
    const prev = ids.length === 0 ? [] : await many(
      `SELECT oi.product_id, SUM(oi.quantity)::int AS units FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE ${PLACED} AND o.created_at >= $1 AND o.created_at < $2 AND ${ORDER_FILTER} AND oi.product_id = ANY($5::uuid[]) GROUP BY oi.product_id`,
      [start, end, args[2], args[3], ids])
    return { cur, prev }
  }

  async customers(args, { limit }) {
    return many(
      `SELECT o.user_id, u.name, u.phone, MAX(ba.company_name) AS company, COUNT(*)::int AS orders, SUM(o.total_amount)::numeric(14,2) AS spend, MAX(o.created_at) AS last_order_at,
              (SELECT COUNT(*) FROM orders o0 WHERE o0.user_id = o.user_id AND o0.status NOT IN ('PENDING','CANCELLED') AND o0.created_at < $1)::int AS earlier_orders,
              BOOL_OR(o.buyer_gstin IS NOT NULL OR o.b2b_approval_status IS NOT NULL) AS is_b2b
         FROM orders o JOIN users u ON u.id = o.user_id LEFT JOIN business_accounts ba ON ba.user_id = o.user_id
        WHERE ${PLACED} AND o.created_at >= $1 AND o.created_at < $2 AND ${ORDER_FILTER}
        GROUP BY o.user_id, u.name, u.phone ORDER BY spend DESC LIMIT ${Number(limit)}`, args)
  }
  async customerRepeat(args) {
    return one(
      `SELECT COUNT(*)::int AS customers,
              COUNT(*) FILTER (WHERE c.n >= 2 OR c.earlier > 0)::int AS repeat_customers
         FROM (SELECT o.user_id, COUNT(*) AS n,
                      (SELECT COUNT(*) FROM orders o0 WHERE o0.user_id = o.user_id AND o0.status NOT IN ('PENDING','CANCELLED') AND o0.created_at < $1) AS earlier
                 FROM orders o WHERE ${PLACED} AND o.created_at >= $1 AND o.created_at < $2 AND ${ORDER_FILTER} GROUP BY o.user_id) c`, args)
  }

  async stores(args) {
    return many(
      `SELECT s.id AS shop_id, s.name, s.branch_code,
              COALESCE(o.orders, 0)::int AS orders, COALESCE(o.gross, 0)::numeric(14,2) AS gross, COALESCE(u.units, 0)::int AS units,
              COALESCE(c.n, 0)::int AS cancelled_orders, COALESCE(c.amount, 0)::numeric(14,2) AS cancelled_value,
              COALESCE(r.amount, 0)::numeric(14,2) AS refunds, COALESCE(rt.amount, 0)::numeric(14,2) AS returns,
              f.avg_minutes, COALESCE(mv.received, 0)::int AS received_units, COALESCE(mv.sold, 0)::int AS sold_units, COALESCE(mv.damaged, 0)::int AS damaged_units
         FROM shops s
         LEFT JOIN LATERAL (SELECT COUNT(*) AS orders, SUM(o.total_amount) AS gross
                              FROM orders o WHERE o.shop_id = s.id AND ${PLACED} AND o.created_at >= $1 AND o.created_at < $2 AND ($4::text IS NULL OR ${CH} = $4)) o ON TRUE
         LEFT JOIN LATERAL (SELECT SUM(oi.quantity) AS units FROM order_items oi JOIN orders o ON o.id = oi.order_id
                             WHERE o.shop_id = s.id AND ${PLACED} AND o.created_at >= $1 AND o.created_at < $2 AND ($4::text IS NULL OR ${CH} = $4)) u ON TRUE
         LEFT JOIN LATERAL (SELECT COUNT(*) AS n, SUM(o.total_amount) AS amount FROM orders o
                              JOIN LATERAL (SELECT MAX(h.changed_at) AS at FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'CANCELLED') cc ON TRUE
                             WHERE o.shop_id = s.id AND o.status = 'CANCELLED' AND cc.at >= $1 AND cc.at < $2
                               AND EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'CONFIRMED') AND ($4::text IS NULL OR ${CH} = $4)) c ON TRUE
         LEFT JOIN LATERAL (SELECT SUM(x.amt) AS amount FROM (
                              SELECT COALESCE(rq.amt, py.amt) AS amt, COALESCE(rq.at, py.at) AS at, o.shop_id, o.status, o.buyer_gstin, o.b2b_approval_status
                                FROM orders o
                                LEFT JOIN (SELECT order_id, SUM(refund_amount) AS amt, MAX(processed_at) AS at FROM refund_requests WHERE status='APPROVED' AND refund_amount IS NOT NULL GROUP BY order_id) rq ON rq.order_id = o.id
                                LEFT JOIN (SELECT order_id, SUM(refund_amount) AS amt, MAX(updated_at) AS at FROM payments WHERE refund_amount > 0 GROUP BY order_id) py ON py.order_id = o.id
                               WHERE o.shop_id = s.id AND (rq.order_id IS NOT NULL OR py.order_id IS NOT NULL)) x
                             WHERE x.status <> 'CANCELLED' AND x.at >= $1 AND x.at < $2
                               AND ($4::text IS NULL OR (CASE WHEN x.buyer_gstin IS NOT NULL OR x.b2b_approval_status IS NOT NULL THEN 'B2B' ELSE 'B2C' END) = $4)) r ON TRUE
         LEFT JOIN LATERAL (SELECT SUM(m.quantity_delta * COALESCE(sp.sale_price, sp.price, p.price)) AS amount FROM stock_movements m
                              JOIN shop_products sp ON sp.id = m.shop_product_id JOIN products p ON p.id = m.product_id
                             WHERE m.shop_id = s.id AND m.type = 'RETURN_STOCK' AND m.created_at >= $1 AND m.created_at < $2) rt ON TRUE
         LEFT JOIN LATERAL (SELECT AVG(EXTRACT(EPOCH FROM (o.delivered_at - o.created_at)) / 60)::numeric(10,1) AS avg_minutes FROM orders o
                             WHERE o.shop_id = s.id AND o.status = 'DELIVERED' AND o.delivered_at >= $1 AND o.delivered_at < $2 AND ($4::text IS NULL OR ${CH} = $4)) f ON TRUE
         LEFT JOIN LATERAL (SELECT SUM(m.quantity_delta) FILTER (WHERE m.type IN ('PROCUREMENT_RECEIPT','PROCUREMENT_REVERSAL')) AS received,
                                   -SUM(m.quantity_delta) FILTER (WHERE m.type = 'ORDER_DEDUCTION') AS sold,
                                   -SUM(m.quantity_delta) FILTER (WHERE m.type = 'DAMAGED_STOCK') AS damaged
                              FROM stock_movements m WHERE m.shop_id = s.id AND m.created_at >= $1 AND m.created_at < $2) mv ON TRUE
        WHERE s.is_active AND ($3::uuid IS NULL OR s.id = $3) ORDER BY gross DESC NULLS LAST, s.name`, args)
  }

  async channelSplit(args) {
    return many(
      `SELECT ${CH} AS channel, COUNT(*)::int AS orders, COALESCE(SUM(o.total_amount), 0)::numeric(14,2) AS gross, COUNT(DISTINCT o.user_id)::int AS customers
         FROM orders o WHERE ${PLACED} AND o.created_at >= $1 AND o.created_at < $2 AND ($3::uuid IS NULL OR o.shop_id = $3) AND ($4::text IS NULL OR TRUE) GROUP BY 1`, args)
  }
}
