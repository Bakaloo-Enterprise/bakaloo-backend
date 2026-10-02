import { ShopProductsController } from './shop-products.controller.js'
import { ShopProductsService } from './shop-products.service.js'
import { ShopProductsRepository } from './shop-products.repository.js'
import { ManualCreateService } from './manual-create.service.js'
import { requireShopScope } from '../../middlewares/shop-scope.js'
import { requirePermission } from '../../middlewares/permission-check.js'

/**
 * Shop Products routes plugin.
 * Prefix: /api/v1/shop-products
 *
 * Authorization model:
 *   - All routes require a valid JWT (fastify.authenticate)
 *   - Shop scope is derived by `requireShopScope` (JWT shop_id, or X-Shop-Id
 *     header for platform Super Admins) — exposes `request.shopId`.
 *   - Read endpoints additionally require ANY of: platform ADMIN, or one of
 *     SHOP_ADMIN | SHOP_MANAGER | SHOP_STAFF | SHOP_VIEWER for the shop.
 *   - Write endpoints (POST/PATCH/DELETE/stock) require platform ADMIN or one
 *     of SHOP_ADMIN | SHOP_MANAGER | SHOP_STAFF (Requirement 3.10).
 *
 * Rate limiting (per design.md Security Model):
 *   - Stock updates: 30/min — shields the FOR UPDATE path from abuse.
 *
 * Caching, transactions, and stock-out side effects live in the service.
 */
export default async function shopProductRoutes(fastify) {
  const repository = new ShopProductsRepository()
  const service = new ShopProductsService(repository)
  const controller = new ShopProductsController(service)

  // ── Role guards ──────────────────────────────────────────
  // Defence-in-depth at the routing layer; the service repeats this check.
  const canRead = async function requireShopReadAccess(request, reply) {
    const role = request.user?.role
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (role === 'ADMIN') return
    if (
      shopRole === 'SHOP_ADMIN' ||
      shopRole === 'SHOP_MANAGER' ||
      shopRole === 'SHOP_STAFF' ||
      shopRole === 'SHOP_VIEWER'
    ) {
      return
    }
    return reply.code(403).send({
      success: false,
      message: 'Forbidden — shop staff or Super Admin access required',
      code: 'FORBIDDEN',
    })
  }

  const canWrite = async function requireShopWriteAccess(request, reply) {
    const role = request.user?.role
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (role === 'ADMIN') return
    if (
      shopRole === 'SHOP_ADMIN' ||
      shopRole === 'SHOP_MANAGER' ||
      shopRole === 'SHOP_STAFF'
    ) {
      return
    }
    return reply.code(403).send({
      success: false,
      message:
        'Forbidden — Shop Admin, Manager, Staff, or Super Admin access required',
      code: 'FORBIDDEN',
    })
  }

  const shopScope = requireShopScope({ requireShop: true })

  const readPreHandlers = [fastify.authenticate, shopScope, canRead]
  const writePreHandlers = [fastify.authenticate, shopScope, canWrite]

  // ── POST / — Create a shop product ──────────────────────
  fastify.post(
    '/',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'Create a shop product [Shop Manager+]',
        security: [{ bearerAuth: [] }],
      },
      preHandler: writePreHandlers,
    },
    controller.create.bind(controller)
  )

  // ── GET / — List shop products (paginated, filterable) ──
  fastify.get(
    '/',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'List shop products [Shop Staff+]',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            is_available: { type: 'string', enum: ['true', 'false'] },
            low_stock: { type: 'string', enum: ['true', 'false'] },
            search: { type: 'string', maxLength: 200 },
            include_deleted: { type: 'string', enum: ['true', 'false'] },
          },
        },
      },
      preHandler: readPreHandlers,
    },
    controller.list.bind(controller)
  )

  // ── GET /:id — Get a single shop product ────────────────
  fastify.get(
    '/:id',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'Get shop product by ID [Shop Staff+]',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: readPreHandlers,
    },
    controller.getOne.bind(controller)
  )

  // ── PATCH /:id — Update non-stock fields ────────────────
  fastify.patch(
    '/:id',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'Update shop product (price/availability/etc.) [Shop Manager+]',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: writePreHandlers,
    },
    controller.update.bind(controller)
  )

  // ── PATCH /:id/stock — Stock update with row-level lock ─
  // Rate limited per design.md Security Model — 30/min.
  fastify.patch(
    '/:id/stock',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'Update stock_quantity (FOR UPDATE row lock) [Shop Manager+]',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: writePreHandlers,
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
    },
    controller.updateStock.bind(controller)
  )

  // ── DELETE /:id — Soft delete ───────────────────────────
  fastify.delete(
    '/:id',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'Soft-delete shop product [Shop Manager+]',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: writePreHandlers,
    },
    controller.delete.bind(controller)
  )
}

/**
 * Nested shop-products routes plugin.
 * Prefix: /api/v1/shops/:shopId/products  (and /api/v1/shops/:shopId/stock-movements)
 *
 * These endpoints carry `:shopId` in the URL (canonical Store_Mode URL
 * shape per design §6.4) and route to the same controller as the
 * /api/v1/shop-products mount. requireShopScope still runs because HQ
 * users may also use the X-Shop-Id header; for store staff the JWT
 * shop_id wins (shop-scope.js handles precedence per R17 AC#4).
 *
 * Routes registered:
 *   - POST /:productId/adjust-stock      — perm shop_products.update
 *     (R23.8, R23.9, R23.14 / design §8.1)
 *   - POST /bulk-price-update            — perm shop_products.bulk_update
 *     (R23.12 / design §8.1)
 *
 * Note: GET /api/v1/shops/:shopId/stock-movements is registered by the
 * separate `shopStockMovementsRoutes` plugin (different prefix / no
 * `/products` segment).
 */
export async function shopProductsNestedRoutes(fastify) {
  const repository = new ShopProductsRepository()
  const service = new ShopProductsService(repository)
  const manualCreateService = new ManualCreateService({ repository })
  const controller = new ShopProductsController(service, manualCreateService)
  const shopScope = requireShopScope({ requireShop: true })

  // POST /manual — Manual product creation (R23.15–R23.24)
  // Creates a master Product + Shop_Product + initial stock_movement
  // in a single transaction. HQ_Users can target any shop via
  // X-Shop-Id header or :shopId path param (task 6.4).
  fastify.post(
    '/manual',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'Manually create a new product + shop_product [shop_products.create]',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['shopId'],
          properties: {
            shopId: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [
        fastify.authenticate,
        shopScope,
        requirePermission('shop_products.create'),
      ],
      config: {
        requiredPermission: 'shop_products.create',
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
        },
      },
    },
    controller.manualCreate.bind(controller)
  )

  // POST /:productId/adjust-stock — apply signed delta with FOR UPDATE,
  // insert one stock_movements row, emit `stock_changed` audit. Rate-
  // limited per design.md security model (10/min/IP — manual stock
  // operator surface).
  fastify.post(
    '/:productId/adjust-stock',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'Adjust shop_product stock with movement ledger entry',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['shopId', 'productId'],
          properties: {
            shopId: { type: 'string', format: 'uuid' },
            productId: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [
        fastify.authenticate,
        shopScope,
        requirePermission('shop_products.update'),
      ],
      config: {
        requiredPermission: 'shop_products.update',
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
    },
    controller.adjustStock.bind(controller)
  )

  // POST /bulk-price-update — up to 500 items in one tx, price-only
  // (no stock_movements rows written). Rate-limited to bound the
  // long-lock surface — bulk operations are deliberately throttled
  // tighter than single-item writes.
  fastify.post(
    '/bulk-price-update',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'Bulk price update for up to 500 shop_products',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['shopId'],
          properties: {
            shopId: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [
        fastify.authenticate,
        shopScope,
        requirePermission('shop_products.bulk_update'),
      ],
      config: {
        requiredPermission: 'shop_products.bulk_update',
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    },
    controller.bulkPriceUpdate.bind(controller)
  )
}

/**
 * Stock-movements ledger reader.
 * Prefix: /api/v1/shops/:shopId/stock-movements
 *
 * Read-only paginated GET protected by `shop_products.view` and shop
 * scope. Repository uses `idx_stock_movements_shop_created` and
 * `idx_stock_movements_type` for index-driven scans (R23.5 / design
 * §6.4).
 */
export async function shopStockMovementsRoutes(fastify) {
  const repository = new ShopProductsRepository()
  const service = new ShopProductsService(repository)
  const controller = new ShopProductsController(service)
  const shopScope = requireShopScope({ requireShop: true })

  fastify.get(
    '/',
    {
      schema: {
        tags: ['Shop Products'],
        summary: 'List stock movements for a shop (paginated)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['shopId'],
          properties: {
            shopId: { type: 'string', format: 'uuid' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            product_id: { type: 'string', format: 'uuid' },
            type: {
              type: 'string',
              enum: [
                'MANUAL_ADJUSTMENT',
                'ORDER_DEDUCTION',
                'CANCELLATION_RESTORE',
                'DAMAGED_STOCK',
                'RETURN_STOCK',
                'PROCUREMENT_RECEIPT',
                'PROCUREMENT_REVERSAL',
                'BULK_UPDATE',
              ],
            },
            actor_user_id: { type: 'string', format: 'uuid' },
            from_date: { type: 'string', format: 'date-time' },
            to_date: { type: 'string', format: 'date-time' },
          },
        },
      },
      preHandler: [
        fastify.authenticate,
        shopScope,
        requirePermission('shop_products.view'),
      ],
      config: {
        requiredPermission: 'shop_products.view',
      },
    },
    controller.listStockMovements.bind(controller)
  )
}

/**
 * HQ-only admin shop-products approval routes.
 * Prefix: /api/v1/admin/shop-products
 *
 * Routes registered:
 *   - POST /:id/approve   — perm shop_products.approve
 *     (R23.10 / design §6.4)
 *   - POST /:id/reject    — perm shop_products.approve, reason 10-500
 *     (R23.11 / design §6.4)
 *
 * Both endpoints are gated behind the env feature flag
 * `MULTI_VENDOR_PRODUCT_APPROVAL`. When the flag is OFF the controller
 * replies 503 FEATURE_DISABLED before doing any work; when ON, the
 * permission check (`shop_products.approve`) is the authorization
 * surface (HQ_Roles SUPER_ADMIN / ADMIN / HQ_MANAGER carry it per
 * design §4.2).
 */
export async function shopProductsAdminRoutes(fastify) {
  const repository = new ShopProductsRepository()
  const service = new ShopProductsService(repository)
  const controller = new ShopProductsController(service)

  // POST /:id/approve
  fastify.post(
    '/:id/approve',
    {
      schema: {
        tags: ['Shop Products', 'Admin'],
        summary:
          'Approve a shop_product (HQ-only, gated by MULTI_VENDOR_PRODUCT_APPROVAL)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [
        fastify.authenticate,
        requirePermission('shop_products.approve'),
      ],
      config: {
        requiredPermission: 'shop_products.approve',
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
    },
    controller.approve.bind(controller)
  )

  // POST /:id/reject
  fastify.post(
    '/:id/reject',
    {
      schema: {
        tags: ['Shop Products', 'Admin'],
        summary:
          'Reject a shop_product (HQ-only, gated by MULTI_VENDOR_PRODUCT_APPROVAL)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
      preHandler: [
        fastify.authenticate,
        requirePermission('shop_products.approve'),
      ],
      config: {
        requiredPermission: 'shop_products.approve',
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
    },
    controller.reject.bind(controller)
  )
}
