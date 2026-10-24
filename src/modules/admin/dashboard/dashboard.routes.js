import { DashboardRepository } from './dashboard.repository.js'
import { DashboardService } from './dashboard.service.js'
import { DashboardController } from './dashboard.controller.js'
import { requireShopScope } from '../../../middlewares/shop-scope.js'
import {
  getStatsSchema, getOverviewSchema, getKpisSchema, getRevenueChartSchema, getOrdersByHourSchema,
  getTopProductsSchema, getLowStockSchema, getPendingActionsSchema,
  getLiveStatsSchema, getCategoryRevenueSchema,
} from './dashboard.schema.js'

/**
 * Admin dashboard routes
 * Prefix: /api/v1/admin/dashboard
 */
export default async function dashboardRoutes(fastify) {
  const repo = new DashboardRepository()
  const service = new DashboardService(repo)
  const ctrl = new DashboardController(service)

  const shopScope = requireShopScope()
  // requireAdmin only checks the legacy base `role === 'ADMIN'` field,
  // which shop staff share too (there is no separate SHOP_STAFF base role
  // — see src/constants/roles.js). Without requireShopScope after it, a
  // single-shop staff member's JWT (role: 'ADMIN', shopId: '<their shop>')
  // could read every shop's dashboard numbers, since none of the queries
  // filtered by shop_id. requireShopScope() resolves request.shopId from
  // that JWT so every query below can filter to it — true HQ users (no
  // shopId claim) keep seeing everything.
  const adminAuth = [fastify.authenticate, fastify.requireAdmin, shopScope]

  fastify.get('/stats', { schema: getStatsSchema, preHandler: adminAuth }, ctrl.getStats.bind(ctrl))
  fastify.get('/overview', { schema: getOverviewSchema, preHandler: adminAuth }, ctrl.getOverview.bind(ctrl))
  fastify.get('/kpis', { schema: getKpisSchema, preHandler: adminAuth }, ctrl.getKpis.bind(ctrl))
  fastify.get('/revenue-chart', { schema: getRevenueChartSchema, preHandler: adminAuth }, ctrl.getRevenueChart.bind(ctrl))
  fastify.get('/orders-by-hour', { schema: getOrdersByHourSchema, preHandler: adminAuth }, ctrl.getOrdersByHour.bind(ctrl))
  fastify.get('/top-products', { schema: getTopProductsSchema, preHandler: adminAuth }, ctrl.getTopProducts.bind(ctrl))
  fastify.get('/low-stock-alerts', { schema: getLowStockSchema, preHandler: adminAuth }, ctrl.getLowStockAlerts.bind(ctrl))
  fastify.get('/pending-actions', { schema: getPendingActionsSchema, preHandler: adminAuth }, ctrl.getPendingActions.bind(ctrl))
  fastify.get('/live-stats', { schema: getLiveStatsSchema, preHandler: adminAuth }, ctrl.getLiveStats.bind(ctrl))
  fastify.get('/category-revenue', { schema: getCategoryRevenueSchema, preHandler: adminAuth }, ctrl.getCategoryRevenue.bind(ctrl))
}
