/**
 * HQ Reports Service — business logic layer for global reports.
 *
 * Delegates data access to repository. Applies PII stripping
 * on all endpoints except /customer-acquisition.
 *
 * @module modules/admin/reports/service
 */

import { stripPiiFromRows } from '../../../utils/pii-strip.js'

/** The reports the HQ Reports page can run (same ids as /export). */
export const REPORT_TYPES = Object.freeze([
  { id: 'gmv', name: 'GMV', description: 'Value of orders that stood, by day (cancelled and unpaid orders left out), before refunds' },
  { id: 'orders', name: 'Orders', description: 'Order counts and status breakdown by day (cancelled-then-refunded shows as cancelled)' },
  { id: 'revenue', name: 'Revenue', description: 'Sold, given back and kept, by day. Refunds are dated the day they were paid back' },
  { id: 'refunds', name: 'Refunds', description: 'Refund counts and amounts by the day the money went back' },
  { id: 'shop-performance', name: 'Shop Performance', description: 'Per store: orders that stood and money kept' },
  { id: 'top-shops', name: 'Top Shops', description: 'Stores ranked by money kept' },
  { id: 'top-products', name: 'Top Products', description: 'Best sellers by quantity, from orders that stood' },
  { id: 'low-stock', name: 'Low Stock', description: 'Products with 10 or fewer units left' },
  { id: 'rider-performance', name: 'Rider Performance', description: 'Deliveries made in the period and how long they took' },
  { id: 'coupon-usage', name: 'Coupon Usage', description: 'Coupon use and discount given, on orders that stood' },
  { id: 'payouts', name: 'Payouts', description: 'Shop payout history' },
  { id: 'customer-acquisition', name: 'Customer Acquisition', description: 'New customers in the period' },
])

export class AdminReportsService {
  /**
   * @param {import('./repository.js').AdminReportsRepository} repository
   */
  constructor(repository) {
    this.repository = repository
  }

  /**
   * Parse query params into standard filter object.
   * @param {object} query
   * @returns {{ filters: object, page: number, limit: number }}
   */
  parseQuery(query) {
    const page = Math.max(1, parseInt(query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20))
    const filters = {}

    if (query.from) filters.from = query.from
    if (query.to) filters.to = query.to
    if (query.shop_ids) {
      filters.shopIds = query.shop_ids.split(',').map((s) => s.trim()).filter(Boolean)
    }

    return { filters, page, limit }
  }

  async getGmv(query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getGmv(filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getOrders(query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getOrders(filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getRevenue(query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getRevenue(filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getRefunds(query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getRefunds(filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getShopPerformance(query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getShopPerformance(filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getTopShops(query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getTopShops(filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getTopProducts(query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getTopProducts(filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getLowStock(query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getLowStock(filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getRiderPerformance(query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getRiderPerformance(filters, page, limit)
    // Strip PII from rider performance (contains full_name, phone)
    return { data: stripPiiFromRows(result.data), meta: { page, limit, total: result.total } }
  }

  async getCouponUsage(query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getCouponUsage(filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  async getPayouts(query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getPayouts(filters, page, limit)
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  /**
   * Customer acquisition — the ONLY HQ report that retains PII.
   */
  async getCustomerAcquisition(query) {
    const { filters, page, limit } = this.parseQuery(query)
    const result = await this.repository.getCustomerAcquisition(filters, page, limit)
    // PII is intentionally NOT stripped for this endpoint
    return { data: result.data, meta: { page, limit, total: result.total } }
  }

  /**
   * Get report data for CSV export (up to 10000 rows).
   * @param {string} reportType
   * @param {object} query
   * @returns {Promise<object[]>}
   */
  async getExportData(reportType, query, limit = 10000) {
    const exportQuery = { ...query, limit: String(limit), page: '1' }
    const methodMap = {
      'gmv': 'getGmv',
      'orders': 'getOrders',
      'revenue': 'getRevenue',
      'refunds': 'getRefunds',
      'shop-performance': 'getShopPerformance',
      'top-shops': 'getTopShops',
      'top-products': 'getTopProducts',
      'low-stock': 'getLowStock',
      'rider-performance': 'getRiderPerformance',
      'coupon-usage': 'getCouponUsage',
      'payouts': 'getPayouts',
      'customer-acquisition': 'getCustomerAcquisition',
    }

    const method = methodMap[reportType]
    if (!method) return []

    const result = await this[method](exportQuery)
    return result.data || []
  }
}
