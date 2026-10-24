import { query } from '../../../config/database.js'
import { CANCELLED, PLACED, REFUND_EVENTS_CTE } from '../../business-analytics/sales-rules.js'
import { STOOD, SHOP, WINDOW, args, rows, salesReports, scopeOf } from '../../reports-shared/sales-reports.js'

/**
 * Analytics, on the same sales rules as the Command Center and the Reports pages (business-analytics/sales-rules.js):
 *   - a sale = an order that was placed and not cancelled / unpaid (cancelled-then-refunded counts as cancelled);
 *   - money kept = sold − refunds (refunds dated the day they were paid back); an order refunded in full is not an order;
 *   - days, weeks and months are India calendar periods, and the end date you pick is INCLUDED (the old queries compared
 *     against midnight at the START of the end date, so the last selected day — usually today — was missing).
 * `startDate` / `endDate` are India dates ("2026-03-10"). `shopId` limits everything to one store.
 */
const scope = ({ startDate, endDate, shopId }) => scopeOf({ from: startDate, to: endDate }, shopId ? [shopId] : null)
const num = (v) => (v === null || v === undefined ? 0 : Number(v))

export class AdminAnalyticsRepository {
  async getSalesAnalytics({ startDate, endDate, groupBy = 'day', shopId }) {
    const s = scope({ startDate, endDate, shopId })
    const [series, t] = await Promise.all([salesReports.trend(s, groupBy), salesReports.totals(s)])
    return {
      summary: {
        total_revenue: t.net, // money kept
        total_orders: t.orders,
        avg_order_value: t.avgOrderValue,
        unique_customers: t.buyers,
        total_discounts: t.discounts,
        gross_sales: t.gross,
        total_refunds: t.refunds,
      },
      timeSeries: series.map((r) => ({
        period: r.period,
        revenue: r.net,
        orders: r.orders,
        avg_order_value: r.orders > 0 ? Math.round((r.net / r.orders) * 100) / 100 : 0,
        total_discount: r.discount,
        gross_sales: r.gross,
        refunds: r.refunds,
      })),
    }
  }

  async getProductPerformance({ startDate, endDate, limit = 20, shopId }) {
    const s = scope({ startDate, endDate, shopId })
    const r = await rows(
      `WITH ${REFUND_EVENTS_CTE}
       SELECT p.id, p.name, p.thumbnail_url, c.name AS category,
              SUM(oi.quantity)::int AS units_sold,
              SUM(oi.total) AS revenue,
              COUNT(DISTINCT o.user_id)::int AS unique_buyers,
              COALESCE(pv.views, 0)::int AS views,
              CASE WHEN COALESCE(pv.views, 0) > 0 THEN ROUND(SUM(oi.quantity)::numeric / pv.views * 100, 2) ELSE 0 END AS conversion_rate
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN products p ON p.id = oi.product_id
         LEFT JOIN refund_events rf ON rf.order_id = o.id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN (SELECT product_id, COUNT(*)::int AS views FROM product_views GROUP BY product_id) pv ON pv.product_id = p.id
        WHERE ${STOOD} AND ${WINDOW('o.created_at')} AND ${SHOP}
        GROUP BY p.id, p.name, p.thumbnail_url, c.name, pv.views
        ORDER BY revenue DESC, p.name
        LIMIT $4`, [...args(s), limit])
    return r.map((x) => ({ ...x, revenue: num(x.revenue), conversion_rate: num(x.conversion_rate) }))
  }

  /**
   * Cohort retention: customers grouped by the month they signed up, and how many of them had an order that stood in each
   * later month (India months). Platform-wide, except the "active" measure can be limited to one store.
   */
  async getCustomerCohorts({ shopId } = {}) {
    const r = await rows(
      `WITH ${REFUND_EVENTS_CTE},
       cohorts AS (SELECT DATE_TRUNC('month', u.created_at AT TIME ZONE 'Asia/Kolkata')::date AS cohort_month, u.id AS user_id FROM users u WHERE u.role = 'CUSTOMER'),
       orders_by_month AS (
         SELECT c.cohort_month, DATE_TRUNC('month', o.created_at AT TIME ZONE 'Asia/Kolkata')::date AS order_month, COUNT(DISTINCT c.user_id)::int AS active_users
           FROM cohorts c JOIN orders o ON o.user_id = c.user_id LEFT JOIN refund_events rf ON rf.order_id = o.id
          WHERE ${STOOD} AND ($1::uuid IS NULL OR o.shop_id = $1)
          GROUP BY c.cohort_month, DATE_TRUNC('month', o.created_at AT TIME ZONE 'Asia/Kolkata')::date),
       cohort_sizes AS (SELECT cohort_month, COUNT(*)::int AS size FROM cohorts GROUP BY cohort_month)
       SELECT TO_CHAR(obm.cohort_month, 'YYYY-MM-DD') AS cohort_month, cs.size AS cohort_size, TO_CHAR(obm.order_month, 'YYYY-MM-DD') AS order_month, obm.active_users, ROUND(obm.active_users::numeric / cs.size * 100, 2) AS retention_pct
         FROM orders_by_month obm JOIN cohort_sizes cs ON cs.cohort_month = obm.cohort_month
        ORDER BY obm.cohort_month, obm.order_month`, [shopId ?? null])
    return r.map((x) => ({ ...x, retention_pct: num(x.retention_pct) }))
  }

  async getDeliveryAnalytics({ startDate, endDate, shopId }) {
    const s = scope({ startDate, endDate, shopId })
    // delivery_assignments has no shop column; the store comes from its order. A delivery that happened counts even if the order was refunded later.
    const from = `FROM delivery_assignments da JOIN orders o ON o.id = da.order_id WHERE da.status = 'DELIVERED' AND ${WINDOW('da.delivered_at')} AND ${SHOP}`
    const [[summary], byHour] = await Promise.all([
      rows(
        `SELECT COUNT(*)::int AS total_deliveries, AVG(da.delivery_time_minutes) AS avg_delivery_time, AVG(da.distance_km) AS avg_distance, AVG(da.rating) AS avg_rating,
                COUNT(CASE WHEN da.delivery_time_minutes <= 30 THEN 1 END)::int AS on_time_count, SUM(da.tip_amount) AS total_tips ${from}`, args(s)),
      rows(
        `SELECT EXTRACT(HOUR FROM da.delivered_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, COUNT(*)::int AS deliveries, AVG(da.delivery_time_minutes) AS avg_time
           ${from} GROUP BY hour ORDER BY hour`, args(s)),
    ])
    const onTimePct = summary.total_deliveries > 0 ? Math.round((summary.on_time_count / summary.total_deliveries) * 100) : 0
    return {
      summary: {
        total_deliveries: summary.total_deliveries,
        avg_delivery_time: num(summary.avg_delivery_time).toFixed(1),
        avg_distance: num(summary.avg_distance).toFixed(2),
        avg_rating: num(summary.avg_rating).toFixed(2),
        on_time_percentage: onTimePct,
        total_tips: num(summary.total_tips),
      },
      byHour: byHour.map((r) => ({ hour: r.hour, deliveries: r.deliveries, avg_time: num(r.avg_time).toFixed(1) })),
    }
  }

  /**
   * Money. `gross` = what customers were billed on orders that stood (item prices, fees, tax and tip, AFTER coupons);
   * `discounts` = the coupon money already taken off those bills (shown for information — it is NOT subtracted again);
   * `refunds` = money paid back in the period; `net` = gross − refunds.
   */
  async getFinancialReport({ startDate, endDate, shopId }) {
    const s = scope({ startDate, endDate, shopId })
    const [t, [fees], byPayment, [taxRow], [gstConfig]] = await Promise.all([
      salesReports.totals(s),
      rows(
        `WITH ${REFUND_EVENTS_CTE}
         SELECT COALESCE(SUM(COALESCE(o.delivery_fee, 0)), 0) AS delivery_fees
           FROM orders o LEFT JOIN refund_events rf ON rf.order_id = o.id WHERE ${STOOD} AND ${WINDOW('o.created_at')} AND ${SHOP}`, args(s)),
      rows(
        `WITH ${REFUND_EVENTS_CTE}
         SELECT o.payment_method, SUM(o.total_amount) AS revenue, COUNT(*)::int AS count
           FROM orders o LEFT JOIN refund_events rf ON rf.order_id = o.id WHERE ${STOOD} AND ${WINDOW('o.created_at')} AND ${SHOP}
          GROUP BY o.payment_method ORDER BY revenue DESC`, args(s)),
      // GST is a real, exclusive charge persisted per order (orders.tax_amount), so the breakdown sums what was actually charged.
      rows(
        `WITH ${REFUND_EVENTS_CTE}
         SELECT COALESCE(SUM(o.tax_amount), 0) AS gst_amount, COALESCE(SUM(o.total_amount - COALESCE(o.tax_amount, 0)), 0) AS taxable_amount
           FROM orders o LEFT JOIN refund_events rf ON rf.order_id = o.id WHERE ${STOOD} AND ${WINDOW('o.created_at')} AND ${SHOP}`, args(s)),
      rows(`SELECT gst_rate FROM fee_settings WHERE scope = 'GLOBAL' LIMIT 1`, []),
    ])
    const gstRate = num(gstConfig?.gst_rate)
    const round = (n) => Math.round(num(n) * 100) / 100
    return {
      revenue: { gross: t.gross, discounts: t.discounts, delivery_fees: round(fees.delivery_fees), refunds: t.refunds, net: t.net, order_count: t.orders },
      byPaymentMethod: byPayment.map((r) => ({ ...r, revenue: num(r.revenue) })),
      gstBreakdown: t.orders > 0 ? [{ gst_rate: gstRate, taxable_amount: round(taxRow.taxable_amount), gst_amount: round(taxRow.gst_amount) }] : [],
    }
  }

  async getCartEnhancementAnalytics({ startDate, endDate, shopId }) {
    const s = scope({ startDate, endDate, shopId })
    const base = `FROM orders o LEFT JOIN refund_events rf ON rf.order_id = o.id WHERE ${STOOD} AND ${WINDOW('o.created_at')} AND ${SHOP}`
    const [[summary], popular] = await Promise.all([
      rows(
        `WITH ${REFUND_EVENTS_CTE}
         SELECT COALESCE(SUM(COALESCE(o.tip_amount, 0)), 0) AS total_tips, COALESCE(AVG(NULLIF(o.tip_amount, 0)), 0) AS average_tip,
                COUNT(CASE WHEN COALESCE(o.tip_amount, 0) > 0 THEN 1 END)::int AS tipped_orders,
                COALESCE(SUM(COALESCE(o.delivery_fee, 0)), 0) AS total_delivery_fees, COALESCE(SUM(COALESCE(o.handling_fee, 0)), 0) AS total_handling_fees,
                COALESCE(SUM(COALESCE(o.late_night_fee, 0)), 0) AS total_late_night_fees ${base}`, args(s)),
      rows(
        `WITH ${REFUND_EVENTS_CTE}
         SELECT o.tip_amount AS amount, COUNT(*)::int AS frequency ${base} AND COALESCE(o.tip_amount, 0) > 0
          GROUP BY o.tip_amount ORDER BY frequency DESC, o.tip_amount DESC LIMIT 1`, args(s)),
    ])
    return {
      tipAnalytics: { totalTips: num(summary.total_tips), averageTip: num(summary.average_tip), mostPopularAmount: popular[0] ? num(popular[0].amount) : null, tippedOrders: summary.tipped_orders || 0 },
      feeRevenue: { totalDeliveryFees: num(summary.total_delivery_fees), totalHandlingFees: num(summary.total_handling_fees), totalLateNightFees: num(summary.total_late_night_fees) },
    }
  }

  /** Two periods side by side on the same rules; both end dates are inclusive. */
  async getComparisonStats(period1Start, period1End, period2Start, period2End, shopId) {
    const stats = async (from, to) => {
      const t = await salesReports.totals(scope({ startDate: from, endDate: to, shopId }))
      return { revenue: t.net, orders: t.orders, customers: t.buyers, aov: t.avgOrderValue }
    }
    const [current, previous] = await Promise.all([stats(period1Start, period1End), stats(period2Start, period2End)])
    const pctChange = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : 0)
    return {
      current,
      previous,
      changes: { revenue: pctChange(current.revenue, previous.revenue), orders: pctChange(current.orders, previous.orders), customers: pctChange(current.customers, previous.customers), aov: pctChange(current.aov, previous.aov) },
    }
  }

  /** Where orders go: by city on the delivery address. Each order's refund is taken off the area it was delivered to. */
  async getGeographicAnalytics({ startDate, endDate, shopId }) {
    const s = scope({ startDate, endDate, shopId })
    const r = await rows(
      `WITH ${REFUND_EVENTS_CTE}
       SELECT COALESCE(NULLIF(TRIM(o.delivery_address->>'city'), ''), 'Unknown') AS area,
              COUNT(*) FILTER (WHERE COALESCE(rf.is_full, false) = false)::int AS orders,
              SUM(o.total_amount - COALESCE(rf.amt, 0)) AS revenue,
              COUNT(DISTINCT o.user_id) FILTER (WHERE COALESCE(rf.is_full, false) = false)::int AS customers,
              (SUM(o.total_amount - COALESCE(rf.amt, 0)) / NULLIF(COUNT(*) FILTER (WHERE COALESCE(rf.is_full, false) = false), 0)) AS avg_order_value
         FROM orders o LEFT JOIN refund_events rf ON rf.order_id = o.id
        WHERE ${PLACED} AND ${WINDOW('o.created_at')} AND ${SHOP}
        GROUP BY area ORDER BY revenue DESC`, args(s))
    return r.map((x) => ({ area: x.area, orders: x.orders, revenue: num(x.revenue), customers: x.customers, avg_order_value: num(x.avg_order_value) }))
  }

  /**
   * Stock on the shelves that has not sold for 60 days (or ever). "Sold" = an order that stood, in the SAME store(s) the stock
   * is in — the old query looked at sales from every store, so one store's dead stock hid behind another's sales.
   */
  async getDeadStockProducts({ limit = 20, shopId }) {
    const r = await rows(
      `WITH ${REFUND_EVENTS_CTE},
       shelf AS (
         SELECT p.id, p.name, p.sku, c.name AS category, SUM(sp.stock_quantity)::int AS stock_quantity, MIN(sp.created_at) AS stocked_at
           FROM shop_products sp JOIN products p ON p.id = sp.product_id LEFT JOIN categories c ON c.id = p.category_id
          WHERE sp.stock_quantity > 0 AND sp.deleted_at IS NULL AND ($1::uuid IS NULL OR sp.shop_id = $1)
          GROUP BY p.id, p.name, p.sku, c.name)
       SELECT sh.*, ls.last_sold_at FROM shelf sh
         LEFT JOIN LATERAL (SELECT MAX(o.created_at) AS last_sold_at FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN refund_events rf ON rf.order_id = o.id
                             WHERE oi.product_id = sh.id AND ${STOOD} AND ($1::uuid IS NULL OR o.shop_id = $1)) ls ON TRUE
        WHERE ls.last_sold_at IS NULL OR ls.last_sold_at < NOW() - INTERVAL '60 days'
        ORDER BY ls.last_sold_at ASC NULLS FIRST, sh.name
        LIMIT $2`, [shopId ?? null, limit])
    const now = Date.now()
    return r.map((x) => {
      const reference = x.last_sold_at || x.stocked_at
      return {
        id: x.id, name: x.name, sku: x.sku, stock_quantity: x.stock_quantity, last_sold_at: x.last_sold_at,
        days_since_sold: reference ? Math.floor((now - new Date(reference).getTime()) / 86400000) : 0, category: x.category || null,
      }
    })
  }
}
