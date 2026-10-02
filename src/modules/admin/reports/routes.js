/**
 * HQ Reports routes — global report endpoints for admin dashboard.
 * Prefix: /api/v1/admin/reports
 *
 * All routes require:
 *   - Valid JWT (fastify.authenticate)
 *   - reports.global_view permission
 *
 * Access control (task 11.5):
 *   - Store-user (shop staff) access is rejected with 403 PERMISSION_DENIED
 *     via requirePermission('reports.global_view')
 *
 * @module modules/admin/reports/routes
 */

import { AdminReportsController } from './controller.js'
import { AdminReportsService } from './service.js'
import { AdminReportsRepository } from './repository.js'
import { requirePermission } from '../../../middlewares/permission-check.js'
import {
  gmvSchema,
  ordersSchema,
  revenueSchema,
  refundsSchema,
  shopPerformanceSchema,
  topShopsSchema,
  topProductsSchema,
  lowStockSchema,
  riderPerformanceSchema,
  couponUsageSchema,
  payoutsSchema,
  customerAcquisitionSchema,
  exportSchema,
} from './schema.js'

export default async function adminReportsRoutes(fastify) {
  const repository = new AdminReportsRepository()
  const service = new AdminReportsService(repository)
  const controller = new AdminReportsController(service)

  // All routes require authentication + reports.global_view permission
  const preHandler = [fastify.authenticate, requirePermission('reports.global_view')]

  // GET /gmv
  fastify.get('/gmv', {
    schema: gmvSchema,
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.getGmv.bind(controller))

  // GET /orders
  fastify.get('/orders', {
    schema: ordersSchema,
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.getOrders.bind(controller))

  // GET /revenue
  fastify.get('/revenue', {
    schema: revenueSchema,
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.getRevenue.bind(controller))

  // GET /refunds
  fastify.get('/refunds', {
    schema: refundsSchema,
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.getRefunds.bind(controller))

  // GET /shop-performance
  fastify.get('/shop-performance', {
    schema: shopPerformanceSchema,
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.getShopPerformance.bind(controller))

  // GET /top-shops
  fastify.get('/top-shops', {
    schema: topShopsSchema,
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.getTopShops.bind(controller))

  // GET /top-products
  fastify.get('/top-products', {
    schema: topProductsSchema,
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.getTopProducts.bind(controller))

  // GET /low-stock
  fastify.get('/low-stock', {
    schema: lowStockSchema,
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.getLowStock.bind(controller))

  // GET /rider-performance
  fastify.get('/rider-performance', {
    schema: riderPerformanceSchema,
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.getRiderPerformance.bind(controller))

  // GET /coupon-usage
  fastify.get('/coupon-usage', {
    schema: couponUsageSchema,
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.getCouponUsage.bind(controller))

  // GET /payouts
  fastify.get('/payouts', {
    schema: payoutsSchema,
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.getPayouts.bind(controller))

  // GET /customer-acquisition
  fastify.get('/customer-acquisition', {
    schema: customerAcquisitionSchema,
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.getCustomerAcquisition.bind(controller))

  // GET /types — report catalogue for the HQ Reports page
  fastify.get('/types', {
    schema: { tags: ['Admin Reports'], summary: 'List available reports [reports.global_view]', security: [{ bearerAuth: [] }] },
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.listTypes.bind(controller))

  // GET /generate — run a report on demand (JSON rows, or CSV with format=csv)
  fastify.get('/generate', {
    schema: {
      tags: ['Admin Reports'],
      summary: 'Generate a report [reports.global_view]',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['report_type'],
        properties: {
          report_type: { type: 'string' },
          startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          endDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          shop_id: { type: 'string' },
          format: { type: 'string', enum: ['json', 'csv'] },
        },
      },
    },
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.generate.bind(controller))

  // GET /export — CSV export (max 10000 rows)
  fastify.get('/export', {
    schema: exportSchema,
    preHandler,
    config: { requiredPermission: 'reports.global_view' },
  }, controller.exportCsv.bind(controller))
}
