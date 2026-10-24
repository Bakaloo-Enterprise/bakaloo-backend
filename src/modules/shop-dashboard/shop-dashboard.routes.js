import { ShopDashboardService } from './shop-dashboard.service.js'
import { requirePermission } from '../../middlewares/permission-check.js'
import { requireShopScope } from '../../middlewares/shop-scope.js'

/**
 * Store home screen. Prefix: /api/v1/shop-dashboard
 * Always pinned to the caller's own store (JWT shop, or X-Shop-Id for HQ users); needs shop_orders.view.
 */
export default async function shopDashboardRoutes(fastify) {
  const service = new ShopDashboardService()
  fastify.get('/', {
    schema: { tags: ['Shop Dashboard'], summary: 'Store home: today, new orders, stock, recent orders', security: [{ bearerAuth: [] }] },
    preHandler: [fastify.authenticate, requireShopScope({ requireShop: true }), requirePermission('shop_orders.view')],
    config: { requiredPermission: 'shop_orders.view' },
  }, async (request, reply) => {
    // HQ users must pick a store (X-Shop-Id); without one there is no "store" to show.
    if (!request.shopId) return reply.code(400).send({ success: false, message: 'Pick a store first (X-Shop-Id).', code: 'SHOP_SCOPE_REQUIRED' })
    return { success: true, data: await service.get(request.shopId) }
  })
}
