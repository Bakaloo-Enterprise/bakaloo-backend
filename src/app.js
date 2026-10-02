import { installFeatureGate } from './modules/features/feature-access.js'
import Fastify from 'fastify'
import { env } from './config/env.js'
import { query } from './config/database.js'
import { redis } from './config/redis.js'
import { sanitize } from './middlewares/sanitize.js'
import { installRouteCollector } from './utils/permission-audit.js'

/**
 * Build and configure the Fastify application
 * Registers plugins, hooks, and routes in the correct order
 */
export const buildApp = async () => {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.LOG_PRETTY && {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }),
    },
    trustProxy: true,
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        useDefaults: true,
        coerceTypes: 'array',
      },
    },
  })

  // ─── PLUGINS (order matters) ────────────────────────────
  await app.register(import('./plugins/errorHandler.plugin.js'))
  await app.register(import('./plugins/requestContext.plugin.js'))
  await app.register(import('./plugins/cors.plugin.js'))
  await app.register(import('./plugins/helmet.plugin.js'))
  await app.register(import('./plugins/rateLimit.plugin.js'))
  await app.register(import('./plugins/auth.plugin.js'))
  await app.register(import('./plugins/swagger.plugin.js'))
  await app.register(import('./plugins/multipart.plugin.js'))
  await app.register(import('./plugins/compress.plugin.js'))
  await app.register(import('./plugins/socketio.plugin.js'))
  // Registered at root scope (not inside payments.routes.js) so it covers
  // BOTH Razorpay webhook routes — /api/v1/payments/webhook and
  // /api/webhook/razorpay — which are sibling plugins off this same `app`,
  // not nested under each other. global:false means it only captures the
  // raw body for routes that opt in via `config: { rawBody: true }` (both
  // webhook routes already declare this — it was set up for exactly this
  // plugin but the plugin itself was never installed, so it was inert).
  await app.register(import('fastify-raw-body'), {
    field: 'rawBody',
    global: false,
    runFirst: true,
  })

  // ─── GLOBAL HOOKS ──────────────────────────────────────
  app.addHook('onRequest', sanitize)

  // `removeAdditional: 'all'` above deletes every query param a route's
  // querystring schema doesn't declare — before the handler ever runs.
  // priceMode is read by products/cart/orders/categories/themes handlers,
  // so any route that declared a querystring schema but forgot priceMode
  // silently served RETAIL to approved B2B customers, while routes with no
  // querystring schema (nothing to strip against) served wholesale. That
  // split is exactly how the cart could show a wholesale price while the
  // category and search screens showed retail for the same product.
  // onRequest runs before validation, so capture the caller's intent here
  // and let resolveEffectivePriceMode() fall back to it. Declaring the
  // param per-route is still correct (and done); this makes forgetting it
  // on a future route non-fatal instead of a silent pricing bug.
  app.addHook('onRequest', (request, _reply, done) => {
    if (request.query?.priceMode === 'wholesale') {
      request.priceModeHint = 'wholesale'
    }
    done()
  })

  // PHASE 7 FIX (mobile-network stale-UI bug):
  // Never allow an intermediary (Cloudflare, a mobile-carrier transparent
  // proxy, or an on-device HTTP cache) to serve a stale copy of a
  // *user-scoped* API response. Any request that resolved an authenticated
  // user (request.user populated by the JWT preHandler / optionalAuth) is
  // marked no-store. This is the server-side guarantee that complements the
  // Flutter AppCacheManager: a logged-in user's cart / wallet / orders /
  // shop-scoped catalog can never be cached and replayed to a different
  // network or a different user.
  //
  // Anonymous public responses (master catalog, theme, banners) are left
  // untouched so their existing ETag/Cache-Control behaviour and
  // Cloudflare edge caching keep working.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.user && request.user.id) {
      reply.header(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, private'
      )
      reply.header('Pragma', 'no-cache')
      reply.header('Expires', '0')
    }
    return payload
  })

  // ─── PERMISSION AUDIT ROUTE COLLECTOR (R17 AC#9, design §4.5) ────
  // Install BEFORE any module routes register so the `onRoute` hook fires
  // for every dashboard endpoint. The collected array is exposed via
  // `app.permissionAuditRoutes` so `src/server.js` can run the audit
  // after `app.ready()` and decide whether to abort boot per task 2.7.
  app.decorate('permissionAuditRoutes', installRouteCollector(app))

  // ─── FEATURE LOCKS (migration 154) ───────────────────────────
  // Features still in development (WhatsApp CRM, team chat, procurement, catalog bulk, POS, business analytics) are
  // usable only by Developer Super Admins until a developer releases them. One global gate, installed before the
  // module routes so it covers their prefixes without editing those modules.
  installFeatureGate(app)

  // ─── MODULE ROUTES ─────────────────────────────────────

  // Auth — fully implemented
  await app.register(import('./modules/auth/auth.routes.js'), {
    prefix: '/api/v1/auth',
  })

  // Users — fully implemented
  await app.register(import('./modules/users/users.routes.js'), {
    prefix: '/api/v1/users',
  })

  // Categories — fully implemented
  await app.register(import('./modules/categories/categories.routes.js'), {
    prefix: '/api/v1/categories',
  })

  // Products — fully implemented
  await app.register(import('./modules/products/products.routes.js'), {
    prefix: '/api/v1/products',
  })
  // URL alias fix — Flutter mobile app has a doubled /api/v1/ prefix bug
  // where it constructs product URLs as /api/v1/api/v1/products/:id instead
  // of /api/v1/products/:id. This alias transparently handles those requests
  // so products load correctly without requiring a mobile app release.
  await app.register(import('./modules/products/products.routes.js'), {
    prefix: '/api/v1/api/v1/products',
  })

  // Uploads — fully implemented
  await app.register(import('./modules/uploads/uploads.routes.js'), {
    prefix: '/api/v1/uploads',
  })

  // Cart — fully implemented
  await app.register(import('./modules/cart/cart.routes.js'), {
    prefix: '/api/v1/cart',
  })

  // Orders — fully implemented
  await app.register(import('./modules/orders/orders.routes.js'), {
    prefix: '/api/v1/orders',
  })

  // Payments — fully implemented
  await app.register(import('./modules/payments/payments.routes.js'), {
    prefix: '/api/v1/payments',
  })

  // Wallet — fully implemented
  await app.register(import('./modules/wallet/wallet.routes.js'), {
    prefix: '/api/v1/wallet',
  })

  // Coupons — fully implemented
  await app.register(import('./modules/coupons/coupons.routes.js'), {
    prefix: '/api/v1/coupons',
  })

  // First-Time Offers — Phase 2 of the customer-segment marketing system
  await app.register(import('./modules/first-time-offers/first-time-offers.routes.js'), {
    prefix: '/api/v1/first-time-offers',
  })

  // Cart Milestones — Phase 3 of the customer-segment marketing system
  await app.register(import('./modules/cart-milestones/cart-milestones.routes.js'), {
    prefix: '/api/v1/cart-milestones',
  })

  // Purchase Limits — admin-configured per-category/per-product order and
  // rolling-window purchase caps (anti-abuse, independent of coupons)
  await app.register(import('./modules/purchase-limits/purchase-limits.routes.js'), {
    prefix: '/api/v1/purchase-limits',
  })

  // Spin & Win — prize wheel gamification (server-resolved odds, daily/
  // milestone/admin-granted spin credits, reward issuance via the same
  // coupon/wallet primitives cart-milestones/first-time-offers use)
  await app.register(import('./modules/spin-wheel/spin-wheel.routes.js'), {
    prefix: '/api/v1/spin-wheel',
  })

  // Scratch Card — GPay/PhonePe-style scratch-to-reveal sibling to Spin &
  // Win, same server-authoritative odds/credit/reward mechanics, fully
  // independent credit pool (see src/modules/scratch-card).
  await app.register(import('./modules/scratch-card/scratch-card.routes.js'), {
    prefix: '/api/v1/scratch-card',
  })

  // Addresses — fully implemented
  await app.register(import('./modules/addresses/addresses.routes.js'), {
    prefix: '/api/v1/addresses',
  })

  // Ola Maps — Beta/test module, proxies maps.olakrutrim.com so the API
  // key stays server-side (see src/modules/ola-maps)
  await app.register(import('./modules/ola-maps/ola-maps.routes.js'), {
    prefix: '/api/v1/maps/ola',
  })

  // Ola Maps settings [ADMIN] — dashboard-managed key (paste, test, save),
  // source of truth for the module above (see src/modules/ola-maps-settings)
  await app.register(import('./modules/ola-maps-settings/ola-maps-settings.routes.js'), {
    prefix: '/api/v1/admin/ola-maps-settings',
  })

  // Admin — fully implemented
  await app.register(import('./modules/admin/admin.routes.js'), {
    prefix: '/api/v1/admin',
  })

  // Banners (public) — active banners for mobile/web
  await app.register(import('./modules/banners/banners.routes.js'), {
    prefix: '/api/v1/banners',
  })

  // Nav buttons (public) — the resolved 5th bottom-nav slot for mobile
  await app.register(import('./modules/nav-buttons/nav-buttons.routes.js'), {
    prefix: '/api/v1/nav-buttons',
  })

  // Webview (public) — identity handoff for a nav-button WEBVIEW destination
  await app.register(import('./modules/webview/webview.routes.js'), {
    prefix: '/api/v1/webview',
  })


  // Tutorials (public) — active in-app tutorial videos for mobile/web
  await app.register(import('./modules/tutorials/tutorials.routes.js'), {
    prefix: '/api/v1/tutorials',
  })

  // Theme (public) — active theme for mobile/web app
  await app.register(import('./modules/themes/public.routes.js'), {
    prefix: '/api/v1/theme',
  })

  // Legal Pages (public) — Terms, Privacy, About; dashboard-editable
  // (see src/modules/admin/legal-pages/), fetched by the website and,
  // via its in-app WebView, the mobile apps.
  await app.register(import('./modules/legal-pages/legal-pages.routes.js'), {
    prefix: '/api/v1/legal-pages',
  })

  // Branding (public) — dashboard-editable splash image + logo, with the
  // Flutter app falling back to its bundled defaults when unset.
  await app.register(import('./modules/branding/public.routes.js'), {
    prefix: '/api/v1/branding',
  })

  // Wishlist — fully implemented
  await app.register(import('./modules/wishlist/wishlist.routes.js'), {
    prefix: '/api/v1/wishlist',
  })

  // Reviews — fully implemented
  await app.register(import('./modules/reviews/reviews.routes.js'), {
    prefix: '/api/v1/reviews',
  })

  // Refund Requests — structured post-delivery refund flow
  await app.register(import('./modules/refund-requests/refund-requests.routes.js'), {
    prefix: '/api/v1/refund-requests',
  })

  // Delivery — fully implemented
  await app.register(import('./modules/delivery/delivery.routes.js'), {
    prefix: '/api/v1/delivery',
  })

  // Delivery Slots — admin-managed calendar (replaces the old hardcoded
  // orders/delivery-slots.routes.js generator, same path/response shape).
  const { publicDeliveryCalendarRoutes } = await import('./modules/delivery-calendar/delivery-calendar.routes.js')
  await app.register(publicDeliveryCalendarRoutes, {
    prefix: '/api/v1/delivery',
  })

  // Store Status (public) — is the storefront currently open
  const { publicStoreStatusRoutes } = await import('./modules/store-status/store-status.routes.js')
  await app.register(publicStoreStatusRoutes, {
    prefix: '/api/v1/store',
  })

  // App Version (public) — force/soft update check, no auth (runs before login)
  const { publicAppVersionRoutes } = await import('./modules/app-version/app-version.routes.js')
  await app.register(publicAppVersionRoutes, {
    prefix: '/api/v1/app',
  })

  // Shops — multi-vendor system
  await app.register(import('./modules/shops/shops.routes.js'), {
    prefix: '/api/v1/shops',
  })

  // Shop Staff — role-based access management
  await app.register(import('./modules/shop-staff/shop-staff.routes.js'), {
    prefix: '/api/v1/shop-staff',
  })

  // Alias mount at /shops/:shopId/staff so the dashboard's canonical URL
  // pattern (see bakaloo-dashboard/src/services/shop-staff.service.ts and
  // design.md §6 "Shop_Staff_UI") resolves without a separate URL rewrite
  // layer. The controller's resolveShopId() prefers `request.params.shopId`
  // when present, so all role-check + scope semantics stay identical to the
  // /shop-staff prefix; this is a pure URL alias, not a behavioural fork.
  await app.register(import('./modules/shop-staff/shop-staff.routes.js'), {
    prefix: '/api/v1/shops/:shopId/staff',
  })

  // Shop Products — per-shop inventory and pricing
  await app.register(import('./modules/shop-products/shop-products.routes.js'), {
    prefix: '/api/v1/shop-products',
  })

  // Shop Products — nested per-shop write surface (R23.8, R23.12)
  // adjust-stock + bulk-price-update mounted at /api/v1/shops/:shopId/products
  // so the dashboard's canonical Store_Mode URL pattern resolves without a
  // separate URL rewrite layer (design §6.4). Same controller and service
  // as the /api/v1/shop-products mount; permission gating lives on each
  // route via requirePermission().
  {
    const { shopProductsNestedRoutes, shopStockMovementsRoutes, shopProductsAdminRoutes } =
      await import('./modules/shop-products/shop-products.routes.js')
    await app.register(shopProductsNestedRoutes, {
      prefix: '/api/v1/shops/:shopId/products',
    })
    // Stock-movements ledger reader (R23.5)
    await app.register(shopStockMovementsRoutes, {
      prefix: '/api/v1/shops/:shopId/stock-movements',
    })
    // HQ-only admin approve/reject (R23.10, R23.11) — feature-flagged
    await app.register(shopProductsAdminRoutes, {
      prefix: '/api/v1/admin/shop-products',
    })
  }

  // Shop Orders — store-scoped order operations (multi-vendor R22)
  await app.register(import('./modules/shop-orders/routes.js'), {
    prefix: '/api/v1/shop-orders',
  })
  await app.register(import('./modules/pos/pos.routes.js'), { prefix: '/api/v1/pos' })

  // Shop Transactions — read-only append-only ledger
  // (write side is exposed as LedgerWriteService for orders/refunds/payouts)
  await app.register(
    import('./modules/shop-transactions/shop-transactions.routes.js'),
    {
      prefix: '/api/v1/shop-transactions',
    }
  )

  // Product Families — option grouping for multi-option products
  await app.register(import('./modules/product-families/product-families.routes.js'), {
    prefix: '/api/v1/admin/product-families',
  })

  // Allocation — user-shop allocation (pincode + haversine)
  await app.register(import('./modules/allocation/allocation.routes.js'), {
    prefix: '/api/v1/allocation',
  })

  // Shop Financials — read-only paginated financials per period
  await app.register(
    import('./modules/shop-financials/shop-financials.routes.js'),
    {
      prefix: '/api/v1/shop-financials',
    }
  )

  // Shop Finance — store-scoped finance endpoints (task 8.8)
  await app.register(
    import('./modules/shop-finance/routes.js'),
    {
      prefix: '/api/v1/shop-finance',
    }
  )

  // Admin Finance — HQ-scoped finance endpoints (task 8.9)
  await app.register(
    import('./modules/admin/finance/routes.js'),
    {
      prefix: '/api/v1/admin/finance',
    }
  )

  // Admin GSTR-1 — B2CS + HSN Summary reporting, business-wide GSTIN
  await app.register(
    import('./modules/admin/gstr1/gstr1.routes.js'),
    {
      prefix: '/api/v1/admin/gstr1',
    }
  )

  // Bulk Orders — large multi-vendor scheduled-delivery orders
  // (registered after shop-financials; scheduled-orders comes online in 10.2)
  await app.register(import('./modules/bulk-orders/bulk-orders.routes.js'), {
    prefix: '/api/v1/bulk-orders',
  })

  // Business Accounts — customer-facing B2B application/status/toggle
  // (admin approve/reject lives under /api/v1/admin/business-accounts)
  await app.register(import('./modules/business-accounts/business-accounts.routes.js'), {
    prefix: '/api/v1/business-accounts',
  })

  // Ledger — customer-facing B2B credit-line balance/transactions
  // (admin setup/limits/status lives under /api/v1/admin/ledger)
  await app.register(import('./modules/ledger/ledger.routes.js'), {
    prefix: '/api/v1/ledger',
  })

  // Scheduled Orders — customer-side future / recurring orders (task 10.2)
  // (Worker that fires the orders at scheduled_for lives in task 10.3.)
  await app.register(
    import('./modules/scheduled-orders/scheduled-orders.routes.js'),
    {
      prefix: '/api/v1/scheduled-orders',
    }
  )

  // Audit Logs — read-only endpoints (tasks 10.2, 10.3)
  {
    const { adminAuditLogsRoutes, shopAuditLogsRoutes } =
      await import('./modules/audit-logs/audit-logs.routes.js')
    // HQ-only reader (task 10.2)
    await app.register(adminAuditLogsRoutes, {
      prefix: '/api/v1/admin/audit-logs',
    })
    // Shop-scoped reader (task 10.3)
    await app.register(shopAuditLogsRoutes, {
      prefix: '/api/v1/shop-audit-logs',
    })
  }

  // Admin Reports — HQ-scoped global reports (task 11.1)
  await app.register(
    import('./modules/admin/reports/routes.js'),
    {
      prefix: '/api/v1/admin/reports',
    }
  )

  // Shop Reports — shop-scoped reports (task 11.2)
  await app.register(
    import('./modules/shop-reports/routes.js'),
    {
      prefix: '/api/v1/shop-reports',
    }
  )

  // Notifications — fully implemented
  await app.register(import('./modules/notifications/notifications.routes.js'), {
    prefix: '/api/v1/notifications',
  })

  // ─── CART ENHANCEMENT MODULES ──────────────────────────

  // Tip Presets (public)
  await app.register(import('./modules/tip-presets/tip-presets.routes.js'), {
    prefix: '/api/v1/tip-presets',
  })

  // Payment Offers (public)
  await app.register(import('./modules/payment-offers/payment-offers.routes.js'), {
    prefix: '/api/v1/payment-offers',
  })

  // NOTE: the legacy row-per-type "Fee Config" admin API (/api/v1/admin/fee-config,
  // module at src/modules/fee-config/) has been retired (2026-07-02). It was never
  // read by any order/cart calculation — TotalsEngine reads exclusively from
  // `fee_settings` below — so saves against it silently had zero effect. The
  // module files are kept for reference but intentionally no longer registered.
  // See migration 065_cleanup_dead_settings_and_cod_fix.sql.

  // Fee Settings (admin) — canonical dynamic fee + distance-based delivery engine
  await app.register(import('./modules/fee-settings/fee-settings.routes.js'), {
    prefix: '/api/v1/admin/fee-settings',
  })

  // Pincode Mappings (admin) — curated pincode -> city/area/state overrides,
  // consumed by /api/v1/addresses/validate-pincode
  await app.register(import('./modules/pincode-mappings/pincode-mappings.routes.js'), {
    prefix: '/api/v1/admin/pincode-mappings',
  })

  // Coverage Map (admin) — per-shop customer coverage: store pin, pincode
  // boundary shapes, and every covered customer's pin
  await app.register(import('./modules/coverage-map/coverage-map.routes.js'), {
    prefix: '/api/v1/admin/coverage-map',
  })

  // Store Status (admin) — manual open/closed override + weekly hours
  const { adminStoreStatusRoutes } = await import('./modules/store-status/store-status.routes.js')
  await app.register(adminStoreStatusRoutes, {
    prefix: '/api/v1/admin/store-status',
  })

  // App Version (admin) — set min/latest supported build per platform
  const { adminAppVersionRoutes } = await import('./modules/app-version/app-version.routes.js')
  await app.register(adminAppVersionRoutes, {
    prefix: '/api/v1/admin/app-versions',
  })

  // Delivery Calendar (admin) — weekly template + per-date overrides
  const { adminDeliveryCalendarRoutes } = await import('./modules/delivery-calendar/delivery-calendar.routes.js')
  await app.register(adminDeliveryCalendarRoutes, {
    prefix: '/api/v1/admin/delivery-calendar',
  })

  // Wallet Settings (admin) — max wallet balance + transfer amount limits
  await app.register(import('./modules/wallet-settings/wallet-settings.routes.js'), {
    prefix: '/api/v1/admin/wallet-settings',
  })

  // Product Suggestions (admin) — category-to-category "Pair With" mapping
  await app.register(import('./modules/product-suggestions/product-suggestions.routes.js'), {
    prefix: '/api/v1/admin/product-suggestions',
  })

  // Tip Presets (admin)
  const { adminTipPresetsRoutes } = await import('./modules/tip-presets/tip-presets.routes.js')
  await app.register(adminTipPresetsRoutes, {
    prefix: '/api/v1/admin/tip-presets',
  })

  // Payment Offers (admin)
  const { adminPaymentOffersRoutes } = await import('./modules/payment-offers/payment-offers.routes.js')
  await app.register(adminPaymentOffersRoutes, {
    prefix: '/api/v1/admin/payment-offers',
  })

  // ─── RAZORPAY WEBHOOK (outside /api/v1 — no auth, no rate-limit) ──
  await app.register(async function razorpayWebhook(fastify) {
    // Lazy-load payments dependencies only for this route
    const { PaymentsRepository } = await import('./modules/payments/payments.repository.js')
    const { PaymentsService } = await import('./modules/payments/payments.service.js')
    const { PaymentsController } = await import('./modules/payments/payments.controller.js')

    const repo = new PaymentsRepository()
    // `fastify` must be passed here (it wasn't before) — without it,
    // PaymentsService.completeVerifiedPayment()'s optional-chained
    // this.fastify?.emitDashboardNewOrder?.(...)/emitOrderUpdate?.(...)
    // calls silently no-op, so a payment confirmed through THIS route
    // never pinged the live admin dashboard or the customer's socket —
    // specifically for async-confirmed payments, which is exactly the
    // population this whole fix grows.
    const service = new PaymentsService(repo, fastify)
    const controller = new PaymentsController(service)

    fastify.post('/razorpay', {
      schema: {
        tags: ['Payments'],
        summary: 'Razorpay webhook handler',
      },
      config: {
        rawBody: true,
        rateLimit: false,   // Razorpay retries failed webhooks — don't rate-limit
      },
    }, controller.webhook.bind(controller))
  }, { prefix: '/api/webhook' })

  // ─── WHATSAPP WEBHOOK (no user auth — verified by Meta's HMAC signature) ──
  await app.register(import('./modules/whatsapp-crm/webhook.routes.js'), {
    prefix: '/api/webhook',
  })

  // ─── HEALTH CHECKS ─────────────────────────────────────
  app.get('/', {
    schema: {
      tags: ['Health'],
      summary: 'Root status endpoint',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            service: { type: 'string' },
            timestamp: { type: 'string' },
            uptime: { type: 'number' },
            health: { type: 'string' },
          },
        },
      },
    },
    config: {
      rateLimit: false,
    },
  }, async () => ({
    status: 'OK',
    service: 'bakaloo-backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    health: '/health/ready',
  }))

  app.get('/health', {
    schema: {
      tags: ['Health'],
      summary: 'Liveness health check',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
            uptime: { type: 'number' },
          },
        },
      },
    },
  }, async () => ({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }))

  app.get('/health/ready', {
    schema: {
      tags: ['Health'],
      summary: 'Readiness health check',
    },
  }, async (request, reply) => {
    const [postgresResult, redisResult] = await Promise.allSettled([
      query('SELECT 1'),
      redis.ping(),
    ])

    const dependencies = {
      postgres: postgresResult.status === 'fulfilled'
        ? { status: 'up' }
        : {
            status: 'down',
            error: postgresResult.reason?.message || 'Unknown PostgreSQL error',
          },
      redis: redisResult.status === 'fulfilled'
        ? { status: 'up' }
        : {
            status: 'down',
            error: redisResult.reason?.message || 'Unknown Redis error',
          },
    }

    const ready = Object.values(dependencies).every(
      (dependency) => dependency.status === 'up'
    )

    if (!ready) {
      request.log.error({ dependencies }, 'Readiness check failed')
      return reply.code(503).send({
        status: 'NOT_READY',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        dependencies,
      })
    }

    return {
      status: 'READY',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      dependencies,
    }
  })

  return app
}
