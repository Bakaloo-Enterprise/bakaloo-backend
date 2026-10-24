import { query } from '../../../config/database.js'
import { redis } from '../../../config/redis.js'
import { OverviewRepository } from './overview.repository.js'
import { OverviewService } from './overview.service.js'

/**
 * Every order-money number here comes from OverviewService, which builds on the shared sales rules
 * (business-analytics/sales-rules.js). Do not re-derive "revenue" or "orders" in this file: a sale is an order that was
 * placed and not cancelled, a refund is subtracted on the day it was paid back, and a fully refunded order is not an order.
 */
export class DashboardRepository {
  constructor(overview = new OverviewService({ repo: new OverviewRepository() })) {
    this.overview = overview
  }

  /**
   * Enhanced dashboard stats with comparison period + sparklines
   * @param {'today'|'week'|'month'} period
   * @param {string|null} [shopId] - when present, every order-derived stat
   *   is scoped to this shop instead of the whole platform (R17 shop
   *   scoping — a shop-staff caller must only see their own numbers).
   */
  async getStats(period, shopId = null) {
    const [ov, products, riders, today] = await Promise.all([
      this.overview.overview({ period, shopId, topLimit: 1 }),
      this._productStats(null, null, null, shopId),
      this._riderStats(),
      this._todayStats(shopId),
    ])
    const c = ov.comparison
    return {
      revenue: { current: ov.money.netRevenue, previous: c.netRevenue.previous, change_pct: c.netRevenue.changePct ?? 0, sparkline: ov.series.map((d) => d.net),
        gross: ov.money.grossSales, refunds: ov.money.refunds, cancelled_value: ov.money.cancelledValue },
      orders: { current: ov.orders.net, previous: c.orders.previous, change_pct: c.orders.changePct ?? 0, sparkline: ov.series.map((d) => d.orders),
        placed: ov.orders.placed, refunded: ov.orders.fullyRefunded, cancelled: ov.orders.cancelled, awaiting_payment: ov.live.awaitingPayment, new_orders: ov.live.newOrders },
      products,
      customers: {
        current: ov.customers.registered ?? ov.customers.buyers,
        new_this_period: ov.customers.joinedInPeriod ?? ov.customers.newBuyers,
        change_pct: 0,
        repeat_rate: ov.customers.repeatRatePct ?? 0,
      },
      riders,
      today,
    }
  }

  /**
   * Flat KPI summary for the HQ Dashboard page's top strip
   * (`GET /admin/dashboard/kpis`). Shop-scoped when `shopId` is present:
   * totalShops/activeShops collapse to "this shop only" rather than
   * leaking the platform-wide shop count to shop staff.
   */
  async getKpis(shopId = null) {
    const [allTime, riderRow, shopRow, daily] = await Promise.all([
      this.overview.allTime(shopId),
      query(
        `SELECT COUNT(*)::int AS total_riders,
                COUNT(*) FILTER (WHERE is_online = true)::int AS online_riders
           FROM rider_profiles`
      ),
      shopId
        ? query(
            `SELECT 1::int AS total_shops,
                    COUNT(*) FILTER (WHERE is_active = true)::int AS active_shops
               FROM shops WHERE id = $1`,
            [shopId]
          )
        : query(
            `SELECT COUNT(*)::int AS total_shops,
                    COUNT(*) FILTER (WHERE is_active = true)::int AS active_shops
               FROM shops`
          ),
      this.getStats('today', shopId),
    ])

    const r = riderRow.rows[0]
    const s = shopRow.rows[0]

    return {
      totalRevenue: allTime.netRevenue,
      totalOrders: allTime.orders.net,
      totalCustomers: allTime.buyers,
      totalShops: s.total_shops,
      activeShops: s.active_shops,
      totalRiders: r.total_riders,
      onlineRiders: r.online_riders,
      avgOrderValue: allTime.avgOrderValue ?? 0,
      pendingOrders: daily.orders.new_orders ?? 0,
      todayRevenue: daily.revenue.current,
      todayOrders: daily.orders.current,
      revenueChange: daily.revenue.change_pct,
      ordersChange: daily.orders.change_pct,
    }
  }

  async getRevenueChart(days = 7, shopId = null) {
    return this.overview.dailySeries(days, shopId)
  }

  async getOrdersByHour(shopId = null) {
    const hours = await this.overview.hourly(30, shopId)
    const total = hours.reduce((t, r) => t + r.order_count, 0)
    return { hours, avgOrders: Math.round(total / 24) }
  }

  async getTopProducts(limit = 10, shopId = null) {
    return this.overview.products(30, shopId, limit)
  }

  async getLowStockAlerts(threshold = 10, shopId = null) {
    if (shopId) {
      // Shop-scoped: stock lives on shop_products (per-shop overlay), not
      // the global products catalog.
      const { rows } = await query(
        `SELECT sp.id, p.name, p.thumbnail_url, sp.stock_quantity, sp.low_stock_threshold, p.category_id
           FROM shop_products sp
           JOIN products p ON p.id = sp.product_id
          WHERE sp.shop_id = $1
            AND sp.is_available = true
            AND sp.stock_quantity <= COALESCE(sp.low_stock_threshold, $2)
          ORDER BY sp.stock_quantity ASC
          LIMIT 50`,
        [shopId, threshold]
      )
      return rows
    }

    const { rows } = await query(
      `SELECT id, name, thumbnail_url, stock_quantity, low_stock_threshold, category_id
       FROM products
       WHERE is_active = true
         AND stock_quantity <= COALESCE(low_stock_threshold, $1)
       ORDER BY stock_quantity ASC
       LIMIT 50`,
      [threshold]
    )
    return rows
  }

  /**
   * "Pending orders" = orders waiting for the store to accept them (CONFIRMED) — the same number as "new orders" on the
   * Command Center. Orders still waiting for the customer to pay are not orders yet; they are returned as awaiting_payment.
   */
  async getPendingActions(shopId = null) {
    if (shopId) {
      const { rows } = await query(
        `SELECT
           (SELECT COUNT(*) FROM orders WHERE status = 'CONFIRMED' AND shop_id = $1)::int AS pending_orders,
           (SELECT COUNT(*) FROM orders WHERE status = 'CONFIRMED' AND shop_id = $1)::int AS confirmed_orders,
           (SELECT COUNT(*) FROM orders WHERE status = 'PENDING' AND shop_id = $1 AND (payment_expires_at IS NULL OR payment_expires_at > NOW()))::int AS awaiting_payment,
           (SELECT COUNT(*) FROM rider_profiles WHERE is_approved = false)::int AS pending_riders,
           (SELECT COUNT(*) FROM shop_products WHERE shop_id = $1 AND is_available = true AND stock_quantity <= COALESCE(low_stock_threshold, 10))::int AS low_stock_products,
           (SELECT COUNT(*) FROM rider_payouts WHERE status = 'PENDING')::int AS pending_payouts`,
        [shopId]
      )
      return rows[0]
    }

    const { rows } = await query(
      `SELECT
         (SELECT COUNT(*) FROM orders WHERE status = 'CONFIRMED')::int AS pending_orders,
         (SELECT COUNT(*) FROM orders WHERE status = 'CONFIRMED')::int AS confirmed_orders,
         (SELECT COUNT(*) FROM orders WHERE status = 'PENDING' AND (payment_expires_at IS NULL OR payment_expires_at > NOW()))::int AS awaiting_payment,
         (SELECT COUNT(*) FROM rider_profiles WHERE is_approved = false)::int AS pending_riders,
         (SELECT COUNT(*) FROM products WHERE is_active = true AND stock_quantity <= COALESCE(low_stock_threshold, 10))::int AS low_stock_products,
         (SELECT COUNT(*) FROM rider_payouts WHERE status = 'PENDING')::int AS pending_payouts`
    )
    return rows[0]
  }

  async getLiveStats(shopId = null) {
    const [stats, onlineRiders] = await Promise.all([
      this._todayStats(shopId),
      this._riderStats(),
    ])
    return { today: stats, riders: onlineRiders }
  }

  async getCategoryRevenue(shopId = null) {
    return this.overview.categoryRevenue(30, shopId)
  }

  // ─── PRIVATE HELPERS ────────────────────────────────

  /**
   * Shop-scoped product counts read shop_products (the per-shop stock
   * overlay) instead of the global products catalog — "how many products
   * is MY shop stocking/low-on" rather than the platform-wide catalog size.
   */
  async _productStats(currentStart, previousStart, previousEnd, shopId = null) {
    if (shopId) {
      const { rows } = await query(
        `SELECT
           COUNT(*) FILTER (WHERE is_available = true)::int AS total,
           COUNT(*) FILTER (WHERE is_available = true AND stock_quantity > COALESCE(low_stock_threshold, 10))::int AS active,
           COUNT(*) FILTER (WHERE is_available = true AND stock_quantity = 0)::int AS out_of_stock,
           COUNT(*) FILTER (WHERE is_available = true AND stock_quantity > 0 AND stock_quantity <= COALESCE(low_stock_threshold, 10))::int AS low_stock
         FROM shop_products
         WHERE shop_id = $1`,
        [shopId]
      )
      return rows[0]
    }

    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE is_active = true)::int AS total,
         COUNT(*) FILTER (WHERE is_active = true AND stock_quantity > COALESCE(low_stock_threshold, 10))::int AS active,
         COUNT(*) FILTER (WHERE is_active = true AND stock_quantity = 0)::int AS out_of_stock,
         COUNT(*) FILTER (WHERE is_active = true AND stock_quantity > 0 AND stock_quantity <= COALESCE(low_stock_threshold, 10))::int AS low_stock
       FROM products`
    )
    return rows[0]
  }

  /**
   * Riders are a shared platform-wide pool, not owned by any one shop
   * (a rider can deliver for any shop) — intentionally NOT shop-scoped.
   */
  async _riderStats() {
    const [totals, onlineKeys] = await Promise.all([
      query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE is_online = true)::int AS online,
           COUNT(*) FILTER (WHERE is_approved = false)::int AS pending
         FROM rider_profiles`
      ),
      // Count riders with active delivery assignments
      query(
        `SELECT COUNT(DISTINCT rider_id)::int AS on_delivery
         FROM delivery_assignments
         WHERE status IN ('ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')`
      ),
    ])
    const t = totals.rows[0]
    return {
      total: t.total,
      online: t.online,
      on_delivery: onlineKeys.rows[0].on_delivery,
      offline: t.total - t.online,
    }
  }

  /** IST-today figures: net sales, orders that stood, COD still to collect, orders delivered today. */
  async _todayStats(shopId = null) {
    return this.overview.today(shopId)
  }
}
