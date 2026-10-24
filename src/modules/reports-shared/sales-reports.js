import { query } from '../../config/database.js'
import { CANCELLED, DAY_IST, PLACED, REFUND_EVENTS_CTE } from '../business-analytics/sales-rules.js'
import { istDayStart } from '../../utils/business-period.js'

/**
 * The sales-side reports for BOTH the HQ Reports page and a store's Reports page, built on the same sales rules as the
 * Command Center and Business Analytics (business-analytics/sales-rules.js):
 *   - a sale is an order that was placed and not cancelled / still unpaid (cancelled-then-refunded counts as cancelled);
 *   - a refund is dated by the day it was paid back; an order refunded in full is not an order;
 *   - days are India calendar days.
 * Every query takes the same three parameters: $1 start, $2 end (instants, [start, end), NULL = no limit) and
 * $3 store ids (uuid[], NULL = every store). Nothing a person types is ever placed in the SQL text.
 */
export const WINDOW = (col) => `($1::timestamptz IS NULL OR ${col} >= $1::timestamptz) AND ($2::timestamptz IS NULL OR ${col} < $2::timestamptz)`
export const SHOP = `($3::uuid[] IS NULL OR o.shop_id = ANY($3::uuid[]))`
const REFUND_DAY = `((rf.at AT TIME ZONE 'Asia/Kolkata')::date)`
const DAY_TEXT = (d) => `to_char(${d}, 'YYYY-MM-DD')`

const bad = (message) => Object.assign(new Error(message), { statusCode: 400 })

/** "2026-03-10" in, India-day instants out. Anything that is not a real date is a clear 400, not a database error. */
export function scopeOf({ from, to } = {}, shopIds = null) {
  const start = from ? istDayStart(from) : null
  const endDay = to ? istDayStart(to) : null
  if (from && !start) throw bad('“from” must be a real date like 2026-03-10.')
  if (to && !endDay) throw bad('“to” must be a real date like 2026-03-31.')
  const end = endDay ? new Date(endDay.getTime() + 86_400_000) : null
  if (start && end && start >= end) throw bad('“from” must not be after “to”.')
  return { start, end, shopIds: shopIds && shopIds.length ? shopIds : null }
}

export const args = (s) => [s.start, s.end, s.shopIds]
export const rows = async (sql, params) => (await query(sql, params)).rows

/** Sales that stood: placed, and not refunded in full. */
export const STOOD = `${PLACED} AND COALESCE(rf.is_full, false) = false`

/** One page of a grouped query, with the real number of groups behind it. */
async function page({ cte = '', rowsSql, countSql, s, extra = [], limit, offset }) {
  const withSql = cte ? `WITH ${cte}` : ''
  const [data, total] = await Promise.all([
    rows(`${withSql} ${rowsSql} LIMIT $${args(s).length + 1} OFFSET $${args(s).length + 2}`, [...args(s), limit, offset, ...extra]),
    rows(`${withSql} ${countSql}`, args(s)),
  ])
  return { data, total: Number(total[0]?.total ?? 0) }
}

const toNum = (v) => (v === null || v === undefined ? v : Number(v))
const money = (r, ...keys) => { for (const k of keys) r[k] = toNum(r[k]); return r }

export const salesReports = {
  /** Value of the orders that stood, by day, before refunds. */
  async gmv(s, p, limit) {
    const offset = (p - 1) * limit
    const out = await page({
      s, limit, offset,
      rowsSql: `SELECT ${DAY_TEXT(DAY_IST)} AS date, SUM(o.total_amount)::numeric(14,2) AS gmv, COUNT(*)::int AS order_count
                  FROM orders o WHERE ${PLACED} AND ${WINDOW('o.created_at')} AND ${SHOP} GROUP BY ${DAY_IST} ORDER BY ${DAY_IST} DESC`,
      countSql: `SELECT COUNT(DISTINCT ${DAY_IST})::int AS total FROM orders o WHERE ${PLACED} AND ${WINDOW('o.created_at')} AND ${SHOP}`,
    })
    out.data.forEach((r) => money(r, 'gmv'))
    return out
  },

  /** How many orders ended in each status, by day. A cancelled order that was refunded afterwards still shows as cancelled. */
  async orders(s, p, limit) {
    const offset = (p - 1) * limit
    const status = `(CASE WHEN ${CANCELLED} THEN 'CANCELLED' ELSE o.status::text END)`
    return page({
      s, limit, offset,
      rowsSql: `SELECT ${DAY_TEXT(DAY_IST)} AS date, ${status} AS status, COUNT(*)::int AS count
                  FROM orders o WHERE ${WINDOW('o.created_at')} AND ${SHOP} GROUP BY ${DAY_IST}, ${status} ORDER BY ${DAY_IST} DESC, ${status}`,
      countSql: `SELECT COUNT(*)::int AS total FROM (SELECT DISTINCT ${DAY_IST}, ${status} FROM orders o WHERE ${WINDOW('o.created_at')} AND ${SHOP}) g`,
    })
  },

  /** Sold, given back and kept, by day. Sales are dated by the order, refunds by the day the money went back. */
  async revenue(s, p, limit) {
    const offset = (p - 1) * limit
    const cte = `${REFUND_EVENTS_CTE},
      sold AS (SELECT ${DAY_IST} AS day, SUM(o.total_amount) AS gross, COUNT(*) FILTER (WHERE COALESCE(rf.is_full, false) = false) AS orders
                 FROM orders o LEFT JOIN refund_events rf ON rf.order_id = o.id WHERE ${PLACED} AND ${WINDOW('o.created_at')} AND ${SHOP} GROUP BY 1),
      back AS (SELECT ${REFUND_DAY} AS day, SUM(rf.amt) AS amt FROM refund_events rf JOIN orders o ON o.id = rf.order_id
                WHERE NOT ${CANCELLED} AND ${WINDOW('rf.at')} AND ${SHOP} GROUP BY 1),
      days AS (SELECT day FROM sold UNION SELECT day FROM back)`
    const out = await page({
      cte, s, limit, offset,
      rowsSql: `SELECT ${DAY_TEXT('d.day')} AS date, COALESCE(s.gross, 0)::numeric(14,2) AS gross_revenue, COALESCE(b.amt, 0)::numeric(14,2) AS refunded,
                       (COALESCE(s.gross, 0) - COALESCE(b.amt, 0))::numeric(14,2) AS net_revenue, COALESCE(s.orders, 0)::int AS orders
                  FROM days d LEFT JOIN sold s ON s.day = d.day LEFT JOIN back b ON b.day = d.day ORDER BY d.day DESC`,
      countSql: `SELECT COUNT(*)::int AS total FROM days`,
    })
    out.data.forEach((r) => money(r, 'gross_revenue', 'refunded', 'net_revenue'))
    return out
  },

  /** Money paid back, by the day it was paid back. Cancelled orders are not sales, so they are not refunds. */
  async refunds(s, p, limit) {
    const offset = (p - 1) * limit
    const cte = `${REFUND_EVENTS_CTE},
      back AS (SELECT ${REFUND_DAY} AS day, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE rf.is_full)::int AS whole, SUM(rf.amt) AS amt
                 FROM refund_events rf JOIN orders o ON o.id = rf.order_id WHERE NOT ${CANCELLED} AND ${WINDOW('rf.at')} AND ${SHOP} GROUP BY 1)`
    const out = await page({
      cte, s, limit, offset,
      rowsSql: `SELECT ${DAY_TEXT('day')} AS date, n AS refund_count, whole AS full_refunds, amt::numeric(14,2) AS refund_amount FROM back ORDER BY day DESC`,
      countSql: `SELECT COUNT(*)::int AS total FROM back`,
    })
    out.data.forEach((r) => money(r, 'refund_amount'))
    return out
  },

  /** Per store: orders that stood and money kept. Used by both "Shop performance" and "Top shops". */
  async stores(s, p, limit, { topShape = false } = {}) {
    const offset = (p - 1) * limit
    const cte = `${REFUND_EVENTS_CTE},
      sold AS (SELECT o.shop_id, SUM(o.total_amount) AS gross, COUNT(*) FILTER (WHERE COALESCE(rf.is_full, false) = false) AS orders
                 FROM orders o LEFT JOIN refund_events rf ON rf.order_id = o.id WHERE ${PLACED} AND o.shop_id IS NOT NULL AND ${WINDOW('o.created_at')} AND ${SHOP} GROUP BY 1),
      back AS (SELECT o.shop_id, SUM(rf.amt) AS amt FROM refund_events rf JOIN orders o ON o.id = rf.order_id
                WHERE NOT ${CANCELLED} AND o.shop_id IS NOT NULL AND ${WINDOW('rf.at')} AND ${SHOP} GROUP BY 1)`
    const net = `(sold.gross - COALESCE(back.amt, 0))`
    const select = topShape
      ? `SELECT s.id AS shop_id, s.name AS shop_name, ${net}::numeric(14,2) AS total_revenue, sold.orders::int AS total_orders`
      : `SELECT s.id AS shop_id, s.name AS shop_name, sold.orders::int AS order_count, ${net}::numeric(14,2) AS revenue, (${net} / NULLIF(sold.orders, 0))::numeric(14,2) AS avg_order_value`
    const out = await page({
      cte, s, limit, offset,
      rowsSql: `${select} FROM sold JOIN shops s ON s.id = sold.shop_id LEFT JOIN back ON back.shop_id = sold.shop_id ORDER BY ${net} DESC, s.name`,
      countSql: `SELECT COUNT(*)::int AS total FROM sold`,
    })
    out.data.forEach((r) => money(r, 'revenue', 'avg_order_value', 'total_revenue'))
    return out
  },

  /** Best sellers by quantity, from orders that stood. */
  async products(s, p, limit) {
    const offset = (p - 1) * limit
    const cte = REFUND_EVENTS_CTE
    const from = `order_items oi JOIN orders o ON o.id = oi.order_id JOIN products pr ON pr.id = oi.product_id LEFT JOIN refund_events rf ON rf.order_id = o.id
                  WHERE ${STOOD} AND ${WINDOW('o.created_at')} AND ${SHOP}`
    const out = await page({
      cte, s, limit, offset,
      rowsSql: `SELECT oi.product_id, pr.name AS product_name, SUM(oi.quantity)::int AS total_quantity, SUM(oi.price * oi.quantity)::numeric(14,2) AS total_revenue
                  FROM ${from} GROUP BY oi.product_id, pr.name ORDER BY total_quantity DESC, pr.name`,
      countSql: `SELECT COUNT(DISTINCT oi.product_id)::int AS total FROM ${from}`,
    })
    out.data.forEach((r) => money(r, 'total_revenue'))
    return out
  },

  /** Coupons: how often used and how much was given, on orders that stood. */
  async coupons(s, p, limit) {
    const offset = (p - 1) * limit
    const from = `orders o LEFT JOIN refund_events rf ON rf.order_id = o.id LEFT JOIN coupons c ON c.code = o.coupon_code
                  WHERE ${STOOD} AND o.coupon_code IS NOT NULL AND ${WINDOW('o.created_at')} AND ${SHOP}`
    const out = await page({
      cte: REFUND_EVENTS_CTE, s, limit, offset,
      rowsSql: `SELECT c.id AS coupon_id, o.coupon_code AS coupon_code, COUNT(*)::int AS usage_count, SUM(o.discount_amount)::numeric(14,2) AS total_discount
                  FROM ${from} GROUP BY c.id, o.coupon_code ORDER BY usage_count DESC, o.coupon_code`,
      countSql: `SELECT COUNT(DISTINCT o.coupon_code)::int AS total FROM ${from}`,
    })
    out.data.forEach((r) => money(r, 'total_discount'))
    return out
  },

  /** Riders: deliveries made in the period (by the day delivered) and how long they took. Cancelled orders are not deliveries. */
  async riders(s, p, limit, { shopShape = false } = {}) {
    const offset = (p - 1) * limit
    const from = `orders o JOIN users u ON u.id = o.rider_id WHERE o.rider_id IS NOT NULL AND o.delivered_at IS NOT NULL AND NOT ${CANCELLED} AND ${WINDOW('o.delivered_at')} AND ${SHOP}`
    const out = await page({
      s, limit, offset,
      rowsSql: `SELECT o.rider_id, ${shopShape ? 'u.name AS rider_name' : 'u.name AS full_name, u.phone'}, COUNT(*)::int AS deliveries,
                       AVG(EXTRACT(EPOCH FROM (o.delivered_at - o.assigned_at))) AS avg_delivery_seconds
                  FROM ${from} GROUP BY o.rider_id, u.name${shopShape ? '' : ', u.phone'} ORDER BY deliveries DESC, u.name`,
      countSql: `SELECT COUNT(DISTINCT o.rider_id)::int AS total FROM ${from}`,
    })
    out.data.forEach((r) => money(r, 'avg_delivery_seconds'))
    return out
  },

  /** Totals for a window: sold, given back, kept, orders that stood, buyers, discounts given. Shared by the Analytics page and its comparison. */
  async totals(s) {
    const r = (await rows(
      `WITH ${REFUND_EVENTS_CTE},
        sold AS (SELECT SUM(o.total_amount) AS gross, COUNT(*) AS placed,
                        COUNT(*) FILTER (WHERE COALESCE(rf.is_full, false) = false) AS orders,
                        COUNT(DISTINCT o.user_id) FILTER (WHERE COALESCE(rf.is_full, false) = false) AS buyers,
                        COALESCE(SUM(COALESCE(o.discount_amount, 0)) FILTER (WHERE COALESCE(rf.is_full, false) = false), 0) AS discounts
                   FROM orders o LEFT JOIN refund_events rf ON rf.order_id = o.id WHERE ${PLACED} AND ${WINDOW('o.created_at')} AND ${SHOP}),
        back AS (SELECT COALESCE(SUM(rf.amt), 0) AS amt FROM refund_events rf JOIN orders o ON o.id = rf.order_id WHERE NOT ${CANCELLED} AND ${WINDOW('rf.at')} AND ${SHOP})
       SELECT COALESCE(sold.gross, 0)::numeric(14,2) AS gross, back.amt::numeric(14,2) AS refunds, sold.orders::int AS orders, sold.buyers::int AS buyers, sold.discounts::numeric(14,2) AS discounts
         FROM sold, back`, args(s)))[0]
    const gross = Number(r.gross)
    const refunds = Number(r.refunds)
    const net = Math.round((gross - refunds) * 100) / 100
    return { gross, refunds, net, orders: r.orders, buyers: r.buyers, discounts: Number(r.discounts), avgOrderValue: r.orders > 0 ? Math.round((net / r.orders) * 100) / 100 : 0 }
  },

  /** Sold / given back / kept per day, week or month (India calendar), including periods that only had refunds. */
  async trend(s, unit = 'day') {
    const u = { day: 'day', week: 'week', month: 'month' }[unit] ?? 'day' // whitelisted: this is the only text put into the SQL
    const bucket = (col) => `date_trunc('${u}', ${col} AT TIME ZONE 'Asia/Kolkata')::date`
    const r = await rows(
      `WITH ${REFUND_EVENTS_CTE},
        sold AS (SELECT ${bucket('o.created_at')} AS period, SUM(o.total_amount) AS gross, COUNT(*) FILTER (WHERE COALESCE(rf.is_full, false) = false) AS orders,
                        COALESCE(SUM(COALESCE(o.discount_amount, 0)) FILTER (WHERE COALESCE(rf.is_full, false) = false), 0) AS discount
                   FROM orders o LEFT JOIN refund_events rf ON rf.order_id = o.id WHERE ${PLACED} AND ${WINDOW('o.created_at')} AND ${SHOP} GROUP BY 1),
        back AS (SELECT ${bucket('rf.at')} AS period, SUM(rf.amt) AS amt FROM refund_events rf JOIN orders o ON o.id = rf.order_id
                  WHERE NOT ${CANCELLED} AND ${WINDOW('rf.at')} AND ${SHOP} GROUP BY 1),
        periods AS (SELECT period FROM sold UNION SELECT period FROM back)
       SELECT ${DAY_TEXT('p.period')} AS period, COALESCE(s.gross, 0)::numeric(14,2) AS gross, COALESCE(b.amt, 0)::numeric(14,2) AS refunds,
              (COALESCE(s.gross, 0) - COALESCE(b.amt, 0))::numeric(14,2) AS net, COALESCE(s.orders, 0)::int AS orders, COALESCE(s.discount, 0)::numeric(14,2) AS discount
         FROM periods p LEFT JOIN sold s ON s.period = p.period LEFT JOIN back b ON b.period = p.period ORDER BY p.period`, args(s))
    return r.map((x) => ({ period: x.period, gross: Number(x.gross), refunds: Number(x.refunds), net: Number(x.net), orders: x.orders, discount: Number(x.discount) }))
  },
}
