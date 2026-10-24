import { query } from '../../config/database.js'
import { OverviewRepository } from '../admin/dashboard/overview.repository.js'
import { OverviewService, windowOfDays } from '../admin/dashboard/overview.service.js'
import { salesReports } from '../reports-shared/sales-reports.js'

/**
 * The store owner's home screen. Every money number comes from the same sales rules as the Command Center
 * (business-analytics/sales-rules.js): orders that stood, refunds taken off on the day they were paid back, India days.
 * "Pending orders" means orders waiting for the store to accept them (paid/confirmed, not yet being prepared) —
 * the same meaning as "new orders" on the Command Center. Orders still waiting for the customer's payment are not
 * orders yet, so they are shown separately.
 */
export class ShopDashboardService {
  constructor({ overview = new OverviewService({ repo: new OverviewRepository() }), repo = new OverviewRepository(), now = () => new Date() } = {}) {
    this.overview = overview
    this.repo = repo
    this.now = now
  }

  async get(shopId) {
    const month = windowOfDays(30, this.now())
    const [today, live, month30, stock, recent] = await Promise.all([
      this.overview.today(shopId),
      this.repo.live(shopId),
      salesReports.totals({ start: month.start, end: month.end, shopIds: [shopId] }),
      query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE stock_quantity <= low_stock_threshold)::int AS low_stock,
                COUNT(*) FILTER (WHERE stock_quantity <= 0)::int AS out_of_stock
           FROM shop_products WHERE shop_id = $1 AND deleted_at IS NULL`, [shopId]),
      query(
        `SELECT o.id, o.order_number, COALESCE(u.name, 'Customer') AS customer_name, o.total_amount::float8 AS total_amount, o.status, o.created_at
           FROM orders o LEFT JOIN users u ON u.id = o.user_id
          WHERE o.shop_id = $1 AND o.status <> 'PENDING'
          ORDER BY o.created_at DESC LIMIT 10`, [shopId]),
    ])
    const s = stock.rows[0]
    return {
      kpis: {
        today_orders: today.orders,
        today_revenue: today.revenue,
        pending_orders: live.new_orders,
        awaiting_payment: live.awaiting_payment,
        preparing: live.preparing,
        out_for_delivery: live.out_for_delivery,
        low_stock_count: s.low_stock,
        out_of_stock_count: s.out_of_stock,
        avg_order_value: month30.avgOrderValue,
        total_products: s.total,
      },
      recent_orders: recent.rows,
    }
  }
}
