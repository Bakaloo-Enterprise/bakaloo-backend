/**
 * Boot-time permission audit — walks every registered Fastify route and
 * verifies that each "protected" dashboard route declares a required
 * Permission_String drawn from the canonical 37-value vocabulary defined
 * in `src/utils/permissions.js`.
 *
 * R17 AC#9 mandates:
 *   "THE Platform SHALL document every endpoint's required Permission_String
 *    in the OpenAPI route metadata and SHALL fail the application boot with
 *    a non-zero exit code if any protected route is registered without a
 *    declared required permission or with a Permission_String value not
 *    present in the canonical vocabulary defined in AC#1."
 *
 * Design source: §4.5 of `.kiro/specs/multi-vendor-system/design.md` —
 *   "a small audit pass after `fastify.ready()` walks `fastify.printRoutes()`
 *    and asserts every protected route declares a `requiredPermission` in
 *    route metadata. Failing routes throw at boot, exit code 1."
 *
 * The audit is split into three phases:
 *
 *   1. **Collection** — `installRouteCollector(fastify)` registers an
 *      `onRoute` hook that runs synchronously every time Fastify registers
 *      a route. The hook captures `{ method, url, preHandler, config }`
 *      into a shared array. Must be installed BEFORE any
 *      `app.register(...routes)` call (Fastify only fires onRoute for
 *      routes registered after the hook is attached in the same
 *      encapsulation context).
 *
 *   2. **Classification** — each collected route is classified as one of:
 *        - 'exempt'    — explicitly excluded from the audit (login flow,
 *                        public health checks, public banners/themes,
 *                        webhooks, or `config.publicRoute === true`).
 *        - 'protected' — URL falls under a dashboard scope prefix (HQ
 *                        admin, shop-*, /api/v1/shops/...) and must
 *                        declare a `requiredPermission`.
 *        - 'unscoped'  — customer/rider/public surface that does not draw
 *                        from the canonical vocabulary (cart, addresses,
 *                        customer orders, allocation, notifications, etc.).
 *
 *   3. **Verification** — for every 'protected' route, look for a declared
 *      Permission_String at:
 *        a) `routeOptions.config.requiredPermission` (preferred — emitted
 *            into the OpenAPI metadata per R17 AC#9), OR
 *        b) any preHandler function carrying a `.requiredPermission` own
 *            property (set by the `requirePermission(perm)` factory in
 *            `src/middlewares/permission-check.js`).
 *      A missing declaration or a value outside CANONICAL_PERMISSIONS
 *      produces a violation.
 *
 * Behaviour at boot:
 *   - When `env.STRICT_PERMISSION_AUDIT === true` AND any violations exist,
 *     `runPermissionAudit` returns `{ ok: false, ... }`; the caller in
 *     `src/server.js` logs the violations at error level and calls
 *     `process.exit(1)` per R17 AC#9.
 *   - When `env.STRICT_PERMISSION_AUDIT === false` (the project default
 *     until Phase C wires `requiredPermission` onto every route), violations
 *     are logged at warn level and boot continues. This keeps the existing
 *     application usable while task 2.7 ships the infrastructure ahead of
 *     the route-by-route migration.
 *
 * Requirements: R17.9
 * Design:       §4.5 of .kiro/specs/multi-vendor-system/design.md
 *
 * @module utils/permission-audit
 */

import { CANONICAL_PERMISSIONS } from './permissions.js'

/**
 * URL prefixes whose routes belong to the dashboard surface and therefore
 * MUST declare a `requiredPermission` from the canonical vocabulary. The
 * matching is `route.url === prefix || route.url.startsWith(prefix)` so
 * both the bare prefix and any nested path qualify.
 *
 * The list mirrors the dashboard module map in design §2.2:
 *
 *   - `/api/v1/admin/*`           — HQ dashboard surface (orders, users,
 *                                   settings, analytics, customers, riders,
 *                                   themes, banners, audit logs, finance,
 *                                   reports, coupons, shop-products approval)
 *   - `/api/v1/shops/*`           — shops module + nested staff alias
 *   - `/api/v1/shop-staff/*`      — staff CRUD
 *   - `/api/v1/shop-products/*`   — per-shop inventory, manual create,
 *                                   stock adjust, bulk price update
 *   - `/api/v1/shop-transactions/*` — append-only ledger reads
 *   - `/api/v1/shop-financials/*` — financial periods
 *   - `/api/v1/shop-orders/*`     — store-scoped order operations (Phase C)
 *   - `/api/v1/shop-reports/*`    — store-scoped reports (Phase C)
 *   - `/api/v1/shop-coupons/*`    — store-scoped coupon CRUD (Phase C)
 *   - `/api/v1/shop-audit-logs`   — store-scoped audit reader (Phase C)
 *
 * Note: customer-facing modules (cart, customer orders, addresses,
 * allocation, payments, wallet, wishlist, reviews, notifications, banners,
 * theme, products read, categories read, tip-presets read, payment-offers
 * read, scheduled-orders, bulk-orders) are explicitly EXCLUDED from this
 * list because they authorise on customer JWT identity, not on the
 * canonical Permission_String vocabulary.
 *
 * @type {ReadonlyArray<string>}
 */
const PROTECTED_PREFIXES = Object.freeze([
  '/api/v1/admin/',
  '/api/v1/shops/',
  '/api/v1/shop-staff',
  '/api/v1/shop-products',
  '/api/v1/shop-transactions',
  '/api/v1/shop-financials',
  '/api/v1/shop-orders',
  '/api/v1/shop-dashboard',
  '/api/v1/shop-reports',
  '/api/v1/shop-coupons',
  '/api/v1/shop-audit-logs',
])

/**
 * Exact-match path allowlist of dashboard endpoints that are intentionally
 * exempt from the Permission_String requirement:
 *
 *   - `/api/v1/admin/auth/*` — the login/logout/me/select-shop/password
 *     flow itself. These either authenticate the requester (login) or run
 *     identity-only operations on `request.user` (me, change-password,
 *     logout, select-shop) per design §5.1–§5.5. They do not consume any
 *     of the 37 canonical Permission_Strings.
 *
 * The check is exact — substrings are not enough because a future
 * `/api/v1/admin/auth/users/...` would (correctly) require permissions.
 *
 * @type {ReadonlySet<string>}
 */
const EXEMPT_EXACT_PATHS = Object.freeze(new Set([
  '/api/v1/admin/auth/login',
  '/api/v1/admin/auth/logout',
  '/api/v1/admin/auth/me',
  '/api/v1/admin/auth/password',
  '/api/v1/admin/auth/select-shop',
  '/api/v1/admin/auth/change-password',
]))

/**
 * Internal: classify a route URL into 'exempt' | 'protected' | 'unscoped'.
 *
 * The classifier is intentionally conservative: only routes whose URL
 * unambiguously falls under a `PROTECTED_PREFIXES` entry are marked as
 * 'protected'. Everything else (customer surface, webhooks, health) is
 * 'unscoped' and therefore not subject to R17 AC#9.
 *
 * @param {string} url — the registered route URL (route.url, with any
 *                       Fastify path parameters preserved)
 * @returns {'exempt' | 'protected' | 'unscoped'}
 */
function classifyRoute(url) {
  if (typeof url !== 'string' || url.length === 0) return 'unscoped'
  if (EXEMPT_EXACT_PATHS.has(url)) return 'exempt'
  for (const prefix of PROTECTED_PREFIXES) {
    if (url === prefix || url.startsWith(prefix)) return 'protected'
  }
  return 'unscoped'
}

/**
 * Internal: extract the declared Permission_String from a captured route,
 * looking in two locations in priority order:
 *
 *   1. `route.config.requiredPermission` — preferred surface; route authors
 *      stash the permission here for OpenAPI / Swagger emission per R17 AC#9
 *      ("documented in route metadata").
 *   2. Any preHandler function with a `.requiredPermission` own property —
 *      automatically attached by `requirePermission(perm)` in
 *      `src/middlewares/permission-check.js`. Both single-function and
 *      array-shaped `preHandler` are handled.
 *
 * Returns `null` when no declaration is found at either location.
 *
 * @param {{ preHandler?: unknown, config?: { requiredPermission?: unknown } }} route
 * @returns {string | null}
 */
function extractDeclaredPermission(route) {
  const fromConfig = route.config?.requiredPermission
  if (typeof fromConfig === 'string' && fromConfig.length > 0) {
    return fromConfig
  }
  const ph = route.preHandler
  const handlers = Array.isArray(ph) ? ph : ph ? [ph] : []
  for (const handler of handlers) {
    if (typeof handler === 'function' && typeof handler.requiredPermission === 'string') {
      return handler.requiredPermission
    }
  }
  return null
}

/**
 * Install an `onRoute` hook on the given Fastify instance that captures
 * every subsequently-registered route into a shared array. Must be called
 * BEFORE any `app.register(...routes)` calls — Fastify only invokes
 * `onRoute` for routes registered after the hook is attached within the
 * same encapsulation context (root context in our case).
 *
 * The captured object intentionally contains only the four fields the
 * audit consumes (method, url, preHandler, config). Nothing is held by
 * reference longer than necessary; the array's lifetime equals the
 * Fastify instance's lifetime since both are owned by `buildApp()`.
 *
 * Auto-generated HEAD routes (created by Fastify whenever a GET route is
 * registered) are skipped — they share preHandlers with the originating
 * GET, so auditing them would double-count violations without adding
 * coverage.
 *
 * Requirements: R17.9
 * Design:       §4.5
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @returns {Array<{
 *   method: string | string[],
 *   url: string,
 *   preHandler: unknown,
 *   config: object,
 * }>} the mutable array that grows as routes register
 */
export function installRouteCollector(fastify) {
  const collected = []
  fastify.addHook('onRoute', (routeOptions) => {
    // Skip auto-generated HEAD twins of GET routes — Fastify pairs them
    // automatically and they share the same preHandler chain, so auditing
    // both would emit duplicate violations. The original GET route is
    // always captured.
    if (routeOptions.method === 'HEAD') return
    collected.push({
      method: routeOptions.method,
      url: routeOptions.url,
      preHandler: routeOptions.preHandler,
      config: routeOptions.config ?? {},
    })
  })
  return collected
}

/**
 * Walk the collected routes array and produce an audit summary. Pure
 * function: no I/O, no side effects, deterministic given the same input.
 *
 * Each protected route either contributes a `protected` count or a
 * violation object:
 *
 *   - `kind: 'missing'`  — no Permission_String found at
 *                          config.requiredPermission nor on any
 *                          preHandler.requiredPermission
 *   - `kind: 'invalid'`  — declared value is not in CANONICAL_PERMISSIONS
 *
 * Routes whose `config.publicRoute === true` are always treated as exempt
 * regardless of URL. This lets specific dashboard endpoints opt out of
 * the audit (e.g., a future health-check inside `/api/v1/admin/`) without
 * needing the prefix list to know about them.
 *
 * Requirements: R17.9
 *
 * @param {ReadonlyArray<{
 *   method: string | string[],
 *   url: string,
 *   preHandler: unknown,
 *   config: { requiredPermission?: unknown, publicRoute?: unknown },
 * }>} collectedRoutes
 * @returns {{
 *   violations: Array<{ method: string | string[], url: string, kind: 'missing' | 'invalid', declared?: string }>,
 *   protectedCount: number,
 *   exemptCount: number,
 *   unscopedCount: number,
 *   totalCount: number,
 * }}
 */
export function auditCollectedRoutes(collectedRoutes) {
  const violations = []
  let protectedCount = 0
  let exemptCount = 0
  let unscopedCount = 0

  for (const route of collectedRoutes) {
    if (route.config && route.config.publicRoute === true) {
      exemptCount++
      continue
    }

    const klass = classifyRoute(route.url)
    if (klass === 'exempt') {
      exemptCount++
      continue
    }
    if (klass === 'unscoped') {
      unscopedCount++
      continue
    }

    // klass === 'protected' — must have a canonical Permission_String.
    protectedCount++
    const declared = extractDeclaredPermission(route)
    if (declared === null) {
      violations.push({
        method: route.method,
        url: route.url,
        kind: 'missing',
      })
      continue
    }
    if (!CANONICAL_PERMISSIONS.has(declared)) {
      violations.push({
        method: route.method,
        url: route.url,
        kind: 'invalid',
        declared,
      })
    }
  }

  return {
    violations,
    protectedCount,
    exemptCount,
    unscopedCount,
    totalCount: collectedRoutes.length,
  }
}

/**
 * Run the audit and report the result through the supplied pino logger.
 *
 * Behaviour matrix:
 *
 *   strict | violations | logger call                                   | returns
 *   -------|------------|-----------------------------------------------|-----------
 *   any    | 0          | `info('Permission audit passed')`             | { ok: true,  ... }
 *   true   | >0         | `error('Permission audit failed')`            | { ok: false, ... }
 *   false  | >0         | `warn('Permission audit found violations…')`  | { ok: true,  ... }
 *
 * The caller (`src/server.js`) decides whether to call `process.exit(1)`
 * based on the returned `ok` flag — this function performs no process
 * control of its own so it stays unit-testable.
 *
 * To keep the warn-mode log line bounded when the violation list is large
 * (Phase B → Phase C transition where dozens of routes still lack the
 * declaration), only the first 50 violations are echoed; the full count
 * is always reported in `violationCount`.
 *
 * Requirements: R17.9
 * Design:       §4.5
 *
 * @param {{
 *   collectedRoutes: ReadonlyArray<object>,
 *   strict: boolean,
 *   logger: { info: Function, warn: Function, error: Function },
 * }} options
 * @returns {{
 *   ok: boolean,
 *   violations: Array<object>,
 *   protectedCount: number,
 *   exemptCount: number,
 *   unscopedCount: number,
 *   totalCount: number,
 * }}
 */
export function runPermissionAudit({ collectedRoutes, strict, logger }) {
  const result = auditCollectedRoutes(collectedRoutes)

  if (result.violations.length === 0) {
    logger.info(
      {
        protectedCount: result.protectedCount,
        exemptCount: result.exemptCount,
        unscopedCount: result.unscopedCount,
        totalCount: result.totalCount,
      },
      'Permission audit passed — every protected route declares a canonical Permission_String',
    )
    return { ok: true, ...result }
  }

  if (strict) {
    logger.error(
      {
        violations: result.violations,
        violationCount: result.violations.length,
        protectedCount: result.protectedCount,
        totalCount: result.totalCount,
      },
      'Permission audit failed — boot aborted (R17 AC#9): protected routes missing or carrying non-canonical requiredPermission',
    )
    return { ok: false, ...result }
  }

  // Non-strict mode: log a warning so the misconfiguration is visible in
  // logs and dashboards without blocking the running app. Phase C tasks
  // (3.x – 11.x) progressively wire `requiredPermission` onto every
  // protected route; once that work is complete, set
  // STRICT_PERMISSION_AUDIT=true (and task 23.11 verifies the strict path
  // by intentionally registering a bad route).
  logger.warn(
    {
      violations: result.violations.slice(0, 50),
      violationCount: result.violations.length,
      protectedCount: result.protectedCount,
      totalCount: result.totalCount,
      hint: 'Set STRICT_PERMISSION_AUDIT=true to fail boot on these violations (R17 AC#9).',
    },
    'Permission audit found violations — startup continues in non-strict mode',
  )
  return { ok: true, ...result }
}
