/**
 * HQ Reports Controller — request/response handling for global reports.
 *
 * No business logic here — delegates to service layer.
 * Applies Redis caching via cachedReport utility.
 * Streams CSV for /export endpoint.
 *
 * @module modules/admin/reports/controller
 */

import { REPORT_TYPES } from './service.js'
import { cachedReport } from '../../../utils/report-cache.js'
import { streamCsvResponse } from '../../../utils/csv-stream.js'

export class AdminReportsController {
  /**
   * @param {import('./service.js').AdminReportsService} service
   */
  constructor(service) {
    this.service = service
  }

  async getGmv(request, reply) {
    const result = await cachedReport({
      endpoint: 'admin-gmv',
      query: request.query,
      shopId: null,
      reply,
      compute: () => this.service.getGmv(request.query),
    })
    return { success: true, ...result }
  }

  async getOrders(request, reply) {
    const result = await cachedReport({
      endpoint: 'admin-orders',
      query: request.query,
      shopId: null,
      reply,
      compute: () => this.service.getOrders(request.query),
    })
    return { success: true, ...result }
  }

  async getRevenue(request, reply) {
    const result = await cachedReport({
      endpoint: 'admin-revenue',
      query: request.query,
      shopId: null,
      reply,
      compute: () => this.service.getRevenue(request.query),
    })
    return { success: true, ...result }
  }

  async getRefunds(request, reply) {
    const result = await cachedReport({
      endpoint: 'admin-refunds',
      query: request.query,
      shopId: null,
      reply,
      compute: () => this.service.getRefunds(request.query),
    })
    return { success: true, ...result }
  }

  async getShopPerformance(request, reply) {
    const result = await cachedReport({
      endpoint: 'admin-shop-performance',
      query: request.query,
      shopId: null,
      reply,
      compute: () => this.service.getShopPerformance(request.query),
    })
    return { success: true, ...result }
  }

  async getTopShops(request, reply) {
    const result = await cachedReport({
      endpoint: 'admin-top-shops',
      query: request.query,
      shopId: null,
      reply,
      compute: () => this.service.getTopShops(request.query),
    })
    return { success: true, ...result }
  }

  async getTopProducts(request, reply) {
    const result = await cachedReport({
      endpoint: 'admin-top-products',
      query: request.query,
      shopId: null,
      reply,
      compute: () => this.service.getTopProducts(request.query),
    })
    return { success: true, ...result }
  }

  async getLowStock(request, reply) {
    const result = await cachedReport({
      endpoint: 'admin-low-stock',
      query: request.query,
      shopId: null,
      reply,
      compute: () => this.service.getLowStock(request.query),
    })
    return { success: true, ...result }
  }

  async getRiderPerformance(request, reply) {
    const result = await cachedReport({
      endpoint: 'admin-rider-performance',
      query: request.query,
      shopId: null,
      reply,
      compute: () => this.service.getRiderPerformance(request.query),
    })
    return { success: true, ...result }
  }

  async getCouponUsage(request, reply) {
    const result = await cachedReport({
      endpoint: 'admin-coupon-usage',
      query: request.query,
      shopId: null,
      reply,
      compute: () => this.service.getCouponUsage(request.query),
    })
    return { success: true, ...result }
  }

  async getPayouts(request, reply) {
    const result = await cachedReport({
      endpoint: 'admin-payouts',
      query: request.query,
      shopId: null,
      reply,
      compute: () => this.service.getPayouts(request.query),
    })
    return { success: true, ...result }
  }

  async getCustomerAcquisition(request, reply) {
    const result = await cachedReport({
      endpoint: 'admin-customer-acquisition',
      query: request.query,
      shopId: null,
      reply,
      compute: () => this.service.getCustomerAcquisition(request.query),
    })
    return { success: true, ...result }
  }

  async exportCsv(request, reply) {
    const { report, ...filters } = request.query
    const data = await this.service.getExportData(report, filters)
    const filename = `bakaloo-${report}-${new Date().toISOString().slice(0, 10)}.csv`
    streamCsvResponse(reply, data, filename)
  }

  /** GET /types — the reports the HQ Reports page offers. */
  async listTypes() {
    return { success: true, data: { reports: REPORT_TYPES } }
  }

  /** GET /generate — run one report on demand (rows as JSON, or a CSV download with format=csv). */
  async generate(request, reply) {
    const { report_type: report, startDate, endDate, shop_id: shopId, format } = request.query
    if (!REPORT_TYPES.some((t) => t.id === report)) {
      return reply.code(400).send({ success: false, message: 'Unknown report type', code: 'VALIDATION_ERROR' })
    }
    const filters = { from: startDate, to: endDate, ...(shopId ? { shop_ids: shopId } : {}) }
    if (format === 'csv') {
      const data = await this.service.getExportData(report, filters)
      return streamCsvResponse(reply, data, `bakaloo-${report}-${new Date().toISOString().slice(0, 10)}.csv`)
    }
    const rows = await this.service.getExportData(report, filters, 500)
    return { success: true, data: { rows } }
  }
}
