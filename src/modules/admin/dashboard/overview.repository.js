import { query } from '../../../config/database.js'
import { CANCELLED, DAY_IST, PLACED, REFUND_EVENTS_CTE, placedAs } from '../../business-analytics/sales-rules.js'

/**
 * Overview numbers. Every query takes [start, end, shopId] — an India-calendar-day window ([start, end) as instants) and an
 * optional store. All "what is a sale / cancellation / refund" rules come from sales-rules.js (shared with Business
 * Analytics); nothing here re-decides them.
 */
const SHOP = `($3::uuid IS NULL OR o.shop_id = $3)`
const WINDOW = `o.created_at >= $1 AND o.created_at < $2`

const one = async (sql, params) => (await query(sql, params)).rows[0]
const many = async (sql, params) => (await query(sql, params)).rows

export class OverviewRepository {
  /** Sales that really happened in the window (by order day) and how many of them were later refunded in full. */
  async sales(args) {
    return one(
      `WITH ${REFUND_EVENTS_CTE}
       SELECT COUNT(*)::int AS placed,
              COALESCE(SUM(o.total_amount), 0)::numeric(14,2) AS gross,
              COUNT(DISTINCT o.user_id)::int AS buyers,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.payment_method = 'COD'), 0)::numeric(14,2) AS cod_gross,
              COUNT(*) FILTER (WHERE r.is_full)::int AS fully_refunded,
              COALESCE(SUM(o.total_amount) FILTER (WHERE r.is_full), 0)::numeric(14,2) AS fully_refunded_value
         FROM orders o LEFT JOIN refund_events r ON r.order_id = o.id
        WHERE ${PLACED} AND ${WINDOW} AND ${SHOP}`, args)
  }

  /** Money handed back, dated by the refund day (not the order day). Cancelled orders are not sales, so not counted. */
  async refunds(args) {
    return one(
      `WITH ${REFUND_EVENTS_CTE}
       SELECT COUNT(*)::int AS n, COALESCE(SUM(ref.amt), 0)::numeric(14,2) AS amount
         FROM refund_events ref JOIN orders o ON o.id = ref.order_id
        WHERE NOT ${CANCELLED} AND ref.at >= $1 AND ref.at < $2 AND ${SHOP}`, args)
  }

  /** Orders cancelled in the window after they had been confirmed (an unpaid order that expired is not a loss). */
  async cancelled(args) {
    return one(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(o.total_amount), 0)::numeric(14,2) AS amount
         FROM orders o
         JOIN LATERAL (SELECT MAX(h.changed_at) AS at FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'CANCELLED') c ON TRUE
        WHERE ${CANCELLED} AND c.at >= $1 AND c.at < $2 AND ${SHOP}
          AND EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'CONFIRMED')`, args)
  }

  /** One row per India calendar day in the window — empty days included so charts have no gaps. */
  async daily(args) {
    return many(
      `WITH ${REFUND_EVENTS_CTE},
       days AS (SELECT d::date AS day FROM generate_series(($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date,
                                                          (($2::timestamptz - interval '1 second') AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day') d)
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
              COALESCE(s.orders, 0)::int AS orders, COALESCE(s.full, 0)::int AS fully_refunded,
              COALESCE(s.gross, 0)::numeric(14,2) AS gross, COALESCE(s.cod, 0)::numeric(14,2) AS cod,
              COALESCE(r.amount, 0)::numeric(14,2) AS refunds, COALESCE(c.n, 0)::int AS cancelled
         FROM days
         LEFT JOIN (SELECT ${DAY_IST} AS d, COUNT(*) AS orders, COUNT(*) FILTER (WHERE rf.is_full) AS full, SUM(o.total_amount) AS gross,
                           SUM(o.total_amount) FILTER (WHERE o.payment_method = 'COD') AS cod
                      FROM orders o LEFT JOIN refund_events rf ON rf.order_id = o.id
                     WHERE ${PLACED} AND ${WINDOW} AND ${SHOP} GROUP BY 1) s ON s.d = days.day
         LEFT JOIN (SELECT (ref.at AT TIME ZONE 'Asia/Kolkata')::date AS d, SUM(ref.amt) AS amount
                      FROM refund_events ref JOIN orders o ON o.id = ref.order_id
                     WHERE NOT ${CANCELLED} AND ref.at >= $1 AND ref.at < $2 AND ${SHOP} GROUP BY 1) r ON r.d = days.day
         LEFT JOIN (SELECT (c.at AT TIME ZONE 'Asia/Kolkata')::date AS d, COUNT(*) AS n
                      FROM orders o
                      JOIN LATERAL (SELECT MAX(h.changed_at) AS at FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'CANCELLED') c ON TRUE
                     WHERE ${CANCELLED} AND c.at >= $1 AND c.at < $2 AND ${SHOP}
                       AND EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'CONFIRMED') GROUP BY 1) c ON c.d = days.day
        ORDER BY days.day`, args)
  }

  /** Orders by India hour of day, sales that stood only (cancelled and fully refunded orders are not demand we served). */
  async hours(args) {
    return many(
      `WITH ${REFUND_EVENTS_CTE}
       SELECT EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, COUNT(*)::int AS orders
         FROM orders o LEFT JOIN refund_events r ON r.order_id = o.id
        WHERE ${PLACED} AND COALESCE(r.is_full, false) = false AND ${WINDOW} AND ${SHOP}
        GROUP BY 1 ORDER BY 1`, args)
  }

  /** Best sellers by revenue. Units are real quantities (the old widget counted order lines). */
  async topProducts(args, limit) {
    return many(
      `WITH ${REFUND_EVENTS_CTE}
       SELECT p.id, p.name, p.thumbnail_url, c.name AS category,
              SUM(oi.quantity)::int AS units_sold, COALESCE(SUM(oi.total), 0)::numeric(14,2) AS revenue, COUNT(DISTINCT o.id)::int AS orders
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN products p ON p.id = oi.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN refund_events r ON r.order_id = o.id
        WHERE ${PLACED} AND COALESCE(r.is_full, false) = false AND ${WINDOW} AND ${SHOP}
        GROUP BY p.id, p.name, p.thumbnail_url, c.name
        ORDER BY revenue DESC LIMIT ${Number(limit)}`, args)
  }

  async categories(args) {
    return many(
      `WITH ${REFUND_EVENTS_CTE}
       SELECT COALESCE(c.name, 'Uncategorised') AS category, COALESCE(SUM(oi.total), 0)::numeric(14,2) AS revenue, SUM(oi.quantity)::int AS units
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN products p ON p.id = oi.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN refund_events r ON r.order_id = o.id
        WHERE ${PLACED} AND COALESCE(r.is_full, false) = false AND ${WINDOW} AND ${SHOP}
        GROUP BY 1 ORDER BY revenue DESC`, args)
  }

  /** B2B vs B2C vs ... split of the same sales (no refund netting; shown as share of gross). */
  async channels(args) {
    return many(
      `SELECT (CASE WHEN o.buyer_gstin IS NOT NULL OR o.b2b_approval_status IS NOT NULL THEN 'B2B' ELSE 'B2C' END) AS channel,
              COUNT(*)::int AS orders, COALESCE(SUM(o.total_amount), 0)::numeric(14,2) AS gross
         FROM orders o WHERE ${PLACED} AND ${WINDOW} AND ${SHOP} GROUP BY 1`, args)
  }

  /** Buyers in the window: how many, how many were new to us, how many came back. */
  async buyers(args) {
    return one(
      `SELECT COUNT(*)::int AS buyers,
              COUNT(*) FILTER (WHERE b.earlier = 0)::int AS new_buyers,
              COUNT(*) FILTER (WHERE b.earlier > 0 OR b.n >= 2)::int AS repeat_buyers
         FROM (SELECT o.user_id, COUNT(*) AS n,
                      (SELECT COUNT(*) FROM orders o0 WHERE o0.user_id = o.user_id AND ${placedAs('o0')} AND o0.created_at < $1
                          AND ($3::uuid IS NULL OR o0.shop_id = $3)) AS earlier
                 FROM orders o WHERE ${PLACED} AND ${WINDOW} AND ${SHOP} GROUP BY o.user_id) b`, args)
  }

  /** Registered customers (HQ) — people who have an account, whether or not they ever ordered. */
  async registered(start, end) {
    return one(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS joined
         FROM users WHERE role = 'CUSTOMER'`, [start, end])
  }

  /** Right-now numbers (not tied to the period filter). IST today for the "today" figures. */
  async live(shopId) {
    return one(
      `SELECT COUNT(*) FILTER (WHERE o.status = 'CONFIRMED')::int AS new_orders,
              COUNT(*) FILTER (WHERE o.status IN ('PREPARING','PACKED'))::int AS preparing,
              COUNT(*) FILTER (WHERE o.status = 'OUT_FOR_DELIVERY')::int AS out_for_delivery,
              COUNT(*) FILTER (WHERE o.status = 'DELIVERED' AND (o.delivered_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date)::int AS delivered_today,
              COUNT(*) FILTER (WHERE o.status = 'PENDING' AND (o.payment_expires_at IS NULL OR o.payment_expires_at > NOW()))::int AS awaiting_payment,
              COALESCE(SUM(GREATEST(o.total_amount - COALESCE(o.wallet_amount_used, 0), 0)) FILTER (
                WHERE o.payment_method = 'COD' AND o.payment_status <> 'PAID' AND o.status IN ('CONFIRMED','PREPARING','PACKED','OUT_FOR_DELIVERY')), 0)::numeric(14,2) AS cod_to_collect,
              COALESCE(SUM(GREATEST(o.total_amount - COALESCE(o.wallet_amount_used, 0), 0)) FILTER (
                WHERE o.payment_method = 'COD' AND o.status = 'DELIVERED' AND (o.delivered_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date), 0)::numeric(14,2) AS cod_collected_today
         FROM orders o
        WHERE o.created_at >= NOW() - interval '45 days' AND ($1::uuid IS NULL OR o.shop_id = $1)`, [shopId])
  }

  async pendingRefundRequests(shopId) {
    return one(
      `SELECT COUNT(*)::int AS n FROM refund_requests rr JOIN orders o ON o.id = rr.order_id
        WHERE rr.status = 'PENDING' AND ($1::uuid IS NULL OR o.shop_id = $1)`, [shopId])
  }
}
