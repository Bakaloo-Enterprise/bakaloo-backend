import { createHash } from 'crypto'
import { query } from '../../config/database.js'
import { redis } from '../../config/redis.js'
import { success, error } from '../../utils/apiResponse.js'
import { logger } from '../../config/logger.js'
import {
  getActiveThemeCacheKey,
  getSectionPublicCacheKey,
  getTabHomeCacheKey,
  getTabManifestCacheKey,
} from './theme-cache.js'
import { STORE_KEYS } from '../theme-tabs/theme-tabs.shared.js'
import { FeeSettingsService } from '../fee-settings/fee-settings.service.js'
import { resolveEffectiveAudience, resolveEffectivePriceMode } from '../../utils/price-mode.js'
import { AllocationService } from '../allocation/allocation.service.js'
import { AllocationRepository } from '../allocation/allocation.repository.js'
import { resolveCustomerContext } from '../products/products.controller.js'
import { hashShopIds } from '../products/products.service.js'
import {
  buildShopPriceJoin,
  buildCustomerVisibilitySnippet,
} from '../products/products.repository.js'

const CACHE_TTL = 300

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5B: Safe mobile home payload caps.
//
// These constants define the maximum product count returned by each section
// type in the public mobile home endpoint. Dashboard admins can still
// configure higher limits via merch_config, but the mobile API always clamps
// to these values regardless.
//
// Rationale: Flutter home screen renders at most 12 products per carousel
// and 8 per category rail. Sending more is wasted JSON decode/network work.
// The caps are intentionally generous (not minimal) to ensure sections look
// full on screen.
// ─────────────────────────────────────────────────────────────────────────────
const HOME_CAPS = {
  featured:         12, // horizontal carousel — 12 fills 3 visible + scrollable
  deals:            12, // same
  trending:         12, // same
  seasonal:          8, // mosaic hero+4 pattern
  categoryRail:      8, // 3-column grid shows 6; 8 gives one extra row
  defaultRailItems:  8, // getDefaultCategorySections per-rail limit
  defaultRailCount:  4, // max category rails in fallback
}

// Section-level product count cap applied to every section type from the
// manifest (productCarousel, categoryProductGrid, archedShowcase, etc.).
// The dashboard product-limit slider (ProductSourceConfig, MOBILE_HOME_LIMIT_MAX) tops out at the same
// value; keep them in lock-step. The cap only exists so mis-configured records stay safe.
const HOME_MANIFEST_SECTION_CAP = 200

export class PublicThemeController {
  constructor() {
    this.feeSettingsService = new FeeSettingsService()
    this.allocationService = new AllocationService(new AllocationRepository())
  }

  /**
   * Resolve which shop_products rows this request's product offers must
   * come from — same contract and logic as
   * ProductsService#_resolveAllocatedShopIds. Duplicated here (rather than
   * calling into ProductsService) only because this part needs its own
   * `this.allocationService` instance; resolveCustomerContext/hashShopIds
   * above ARE imported and shared, not duplicated. Matches this codebase's
   * existing per-module convention for the stateful half of this pattern
   * (see the identical private copy in cart.service.js/categories.service.js).
   *
   * Deliberately preserves the "no allocation yet → unscoped/anonymous
   * (null)" fallback rather than failing closed: a customer who hasn't set
   * a delivery address yet still gets a browsable (master-priced) home
   * screen instead of an empty one, exactly like every other product
   * endpoint already behaves. Once they set an address and allocation
   * resolves, the next request scopes to their real shop(s).
   *
   * @param {{ userId?: string }|null} customerContext
   * @returns {Promise<string[]|null>}
   */
  async _resolveAllocatedShopIds(customerContext) {
    if (!customerContext || !customerContext.userId) return null
    try {
      const ids = await this.allocationService.getShopIdsForUser(customerContext.userId)
      if (Array.isArray(ids) && ids.length === 0) {
        logger.debug(
          { customerId: customerContext.userId, action: 'public_theme.allocation_fallback' },
          'Customer has no allocated shops — falling back to anonymous (unscoped) home content'
        )
        return null
      }
      return Array.isArray(ids) ? ids : null
    } catch (err) {
      logger.error(
        { customerId: customerContext.userId, err: err.message, action: 'public_theme.resolve_allocations_failed' },
        'Failed to resolve customer allocations for home content; falling back to anonymous visibility'
      )
      return null
    }
  }

  /**
   * @param {object} request
   * @returns {'wholesale'|'retail'}
   */
  _resolvePriceMode(request) {
    return resolveEffectivePriceMode(request, request?.query?.priceMode === 'wholesale')
  }

  /**
   * @param {string[]|null} allocatedShopIds
   * @returns {string}
   */
  _scopeKey(allocatedShopIds) {
    if (!Array.isArray(allocatedShopIds)) return 'anon'
    return `c:${hashShopIds(allocatedShopIds)}`
  }

  async getActiveTheme(request, reply) {
    const audience = resolveEffectiveAudience(request)
    const cacheKey = getActiveThemeCacheKey(audience)
    const cached = await redis.get(cacheKey)
    if (cached) {
      return success(JSON.parse(cached), 'Active theme')
    }

    // Same B2C fallback reasoning as getTabManifestRows() below.
    const { rows } = await query(
      `SELECT theme_data FROM app_themes
        WHERE is_active = true AND audience IN ($1, 'B2C')
        ORDER BY (audience = $1) DESC
        LIMIT 1`,
      [audience]
    )

    const themeData = rows[0]?.theme_data ?? null

    if (themeData) {
      await redis.set(cacheKey, JSON.stringify(themeData), 'EX', CACHE_TTL)
    }

    return success(themeData, 'Active theme')
  }

  async getTabThemes(request, reply) {
    const storeKey = normalizeStoreKey(request.query?.store_key)
    const audience = resolveEffectiveAudience(request)
    const clientETag = request.headers['if-none-match']
    const cacheKey = getTabManifestCacheKey(storeKey, audience)

    const cached = await redis.get(cacheKey)
    if (cached) {
      const parsed = JSON.parse(cached)
      const etag = parsed._etag

      if (clientETag && clientETag === etag) {
        reply.code(304)
        return
      }

      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=60')
      return success(parsed.data, 'Tab themes')
    }

    const rows = await getTabManifestRows(storeKey, audience)
    const responseData = buildTabManifestResponse(storeKey, rows)

    // Admin-configurable delivery-time display badge (e.g. "45 mins
    // delivery") shown on the app's home header — a plain manually-set
    // number, not a computed ETA. Reuses fee_settings.delivery_eta_minutes
    // (already existed, "display only" per migration 055) rather than a
    // new column; this is a GLOBAL value so it's a top-level sibling of
    // store_key/tabs, not nested per-tab.
    const feeSettings = await this.feeSettingsService.getGlobal()
    responseData.delivery_eta_minutes = feeSettings.delivery_eta_minutes ?? null

    const etag = createHash('md5').update(JSON.stringify(responseData)).digest('hex')

    await redis.set(
      cacheKey,
      JSON.stringify({ _etag: etag, data: responseData }),
      'EX',
      CACHE_TTL
    )

    if (clientETag && clientETag === etag) {
      reply.code(304)
      return
    }

    reply.header('ETag', etag)
    reply.header('Cache-Control', 'private, max-age=60')
    return success(responseData, 'Tab themes')
  }

  async getTabHomeContent(request, reply) {
    const storeKey = normalizeStoreKey(request.query?.store_key)
    const tabKey = `${request.params.key || ''}`.trim()

    if (!tabKey) {
      reply.code(400)
      return error('Tab key is required', 'BAD_REQUEST')
    }

    const audience = resolveEffectiveAudience(request)
    // Every product offer on this page must come from the customer's own
    // selected/allocated shop(s) at their own current price mode — same
    // resolution every other product-serving endpoint (products.controller.js)
    // already does. Previously this entire handler skipped it: the home
    // screen's featured/deals/trending/category rails always queried
    // `products.price`/`products.stock_quantity` directly, so it never
    // reflected a shop's own price, a wholesale price, or bulk-order limits
    // — regardless of any fix made to the regular product endpoints.
    const customerContext = resolveCustomerContext(request)
    const allocatedShopIds = await this._resolveAllocatedShopIds(customerContext)
    const priceMode = this._resolvePriceMode(request)
    const scope = this._scopeKey(allocatedShopIds)

    const cacheKey = getTabHomeCacheKey(storeKey, tabKey, audience, scope, priceMode)
    const cached = await redis.get(cacheKey)
    if (cached) {
      return success(JSON.parse(cached), 'Tab home content')
    }

    const tab = await getTabDefinition(storeKey, tabKey, audience)
    if (!tab) {
      reply.code(404)
      return error('Tab not found', 'NOT_FOUND')
    }

    const merchConfig = tab.merch_config || {}

    // PHASE 5B: Each resolveSectionProducts call gets the dashboard-configured
    // limit clamped to HOME_CAPS.* — regardless of what the dashboard stored.
    // These 5 sections are mutually independent (each only depends on
    // allocatedShopIds/priceMode/merchConfig, never on another section's
    // result), so they run concurrently instead of one-after-another —
    // on a cache miss this was ~7 serial Postgres round-trips in a row.
    const [
      featuredProducts,
      dealProducts,
      trendingProducts,
      seasonalProducts,
      categorySections,
    ] = await Promise.all([
      resolveSectionProducts(
        merchConfig.featured,
        () => getFeaturedProducts(HOME_CAPS.featured, allocatedShopIds, priceMode),
        HOME_CAPS.featured
      ),
      resolveSectionProducts(
        merchConfig.deals,
        () => getDealProducts(HOME_CAPS.deals, allocatedShopIds, priceMode),
        HOME_CAPS.deals
      ),
      resolveSectionProducts(
        merchConfig.trending,
        () => getTrendingProducts(HOME_CAPS.trending, allocatedShopIds, priceMode),
        HOME_CAPS.trending
      ),
      resolveSectionProducts(
        merchConfig.seasonal_mosaic,
        async () => {
          const [deals, featured, trending] = await Promise.all([
            getDealProducts(HOME_CAPS.seasonal, allocatedShopIds, priceMode),
            getFeaturedProducts(HOME_CAPS.seasonal, allocatedShopIds, priceMode),
            getTrendingProducts(HOME_CAPS.seasonal, allocatedShopIds, priceMode),
          ])
          return mergeUniqueProducts([deals, featured, trending]).slice(0, HOME_CAPS.seasonal)
        },
        HOME_CAPS.seasonal
      ),
      resolveCategorySections(
        merchConfig.category_rails,
        async () => getDefaultCategorySections(
          HOME_CAPS.defaultRailCount,
          HOME_CAPS.defaultRailItems,
          allocatedShopIds,
          priceMode
        ),
        HOME_CAPS.categoryRail,
        allocatedShopIds,
        priceMode
      ),
    ])

    const responseData = {
      store_key: storeKey,
      tab_key: tab.key,
      seasonal_products: seasonalProducts,
      featured_products: featuredProducts,
      deal_products: dealProducts,
      trending_products: trendingProducts,
      category_sections: categorySections,
      // PHASE 5E: Future-safe pagination hints.
      // Clients can check has_more to know a "Load more" path is available.
      // The actual load-more endpoint (GET /api/v1/home/sections/:id/items?cursor=)
      // is documented but not yet built — this flag prepares the schema so
      // Flutter can conditionally show load-more controls without a breaking
      // API change later.
      _meta: {
        effective_limits: {
          featured: HOME_CAPS.featured,
          deals: HOME_CAPS.deals,
          trending: HOME_CAPS.trending,
          seasonal: HOME_CAPS.seasonal,
          category_rail: HOME_CAPS.categoryRail,
        },
        has_more: {
          featured: featuredProducts.length >= HOME_CAPS.featured,
          deals: dealProducts.length >= HOME_CAPS.deals,
          trending: trendingProducts.length >= HOME_CAPS.trending,
        },
      },
    }

    // PHASE 5F: Lightweight payload logging for QA/staging.
    // Only logs at debug level — production log level (info/warn) is unaffected.
    _logHomePayload(storeKey, tabKey, responseData)

    await redis.set(cacheKey, JSON.stringify(responseData), 'EX', CACHE_TTL)
    return success(responseData, 'Tab home content')
  }

  async recordAnalytics(request, reply) {
    const events = request.body?.events
    if (!Array.isArray(events) || events.length === 0) {
      return success(null, 'No events')
    }

    const batch = events.slice(0, 50)
    const values = []
    const params = []
    let idx = 1

    for (const event of batch) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`)
      params.push(
        event.theme_id || null,
        event.tab_key || 'unknown',
        event.event_type || 'impression',
        event.user_id || null,
        event.session_id || null,
        normalizeStoreKey(event.store_key),
        event.section_key || null
      )
    }

    await query(
      `INSERT INTO theme_analytics (
         theme_id,
         tab_key,
         event_type,
         user_id,
         session_id,
         store_key,
         section_key
       )
       VALUES ${values.join(', ')}`,
      params
    )

    return success(null, 'Analytics recorded')
  }

  async getSectionManifest(request, reply) {
    const storeKey = normalizeStoreKey(request.query?.store_key)
    const tabKey = `${request.params.tabKey || ''}`.trim()

    if (!tabKey) {
      reply.code(400)
      return error('Tab key is required', 'BAD_REQUEST')
    }

    const audience = resolveEffectiveAudience(request)
    const clientETag = request.headers['if-none-match']
    // Same reasoning as getTabHomeContent above — section manifest products
    // (pinned or category-filled) must come from the customer's own shop
    // allocation at their own price mode, not the master catalog.
    const customerContext = resolveCustomerContext(request)
    const allocatedShopIds = await this._resolveAllocatedShopIds(customerContext)
    const priceMode = this._resolvePriceMode(request)
    const scope = this._scopeKey(allocatedShopIds)
    const cacheKey = getSectionPublicCacheKey(storeKey, tabKey, audience, scope, priceMode)

    const cached = await redis.get(cacheKey)
    if (cached) {
      const parsed = JSON.parse(cached)
      const etag = parsed._etag

      if (clientETag && clientETag === etag) {
        reply.code(304)
        return
      }

      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=60')
      return success(parsed.data, 'Section manifest')
    }

    const tab = await getTabDefinition(storeKey, tabKey, audience)
    if (!tab) {
      reply.code(404)
      return error('Tab not found', 'NOT_FOUND')
    }

    // A B2B viewer sees that tab's B2B-specific section list when one
    // exists; otherwise falls back to the tab's B2C sections (same
    // reasoning as getActiveTheme/getTabManifestRows above — a B2B viewer
    // must never see a blank home screen just because an admin hasn't
    // built B2B-specific content for this tab yet).
    const rows = await fetchSectionRows(tab.id, audience)

    // Resolve products for sections that have product_ids or category_ids in merch_binding.
    // Without this step the mobile receives only IDs and renders nothing.
    const resolvedSections = await Promise.all(
      rows.map(async (section) => {
        const binding = section.merch_binding || {}
        const productIds = Array.isArray(binding.product_ids) ? binding.product_ids : []
        const categoryIds = Array.isArray(binding.category_ids) ? binding.category_ids : []
        const limit = normalizeLimit(binding.limit, HOME_MANIFEST_SECTION_CAP, HOME_MANIFEST_SECTION_CAP)

        // No IDs configured — section uses its own rendering logic (banners, spacers, etc.)
        if (productIds.length === 0 && categoryIds.length === 0) {
          return section
        }

        // Fetch manually pinned products first, preserving dashboard order
        const manualProducts = productIds.length > 0
          ? await getProductsByIds(productIds, allocatedShopIds, priceMode)
          : []
        const seenIds = manualProducts.map((p) => p.id)

        // Fill remaining slots from category if needed
        let products = manualProducts
        if (products.length < limit && categoryIds.length > 0) {
          const fillProducts = await getProductsByCategoryIds(
            categoryIds,
            limit - products.length,
            seenIds,
            allocatedShopIds,
            priceMode
          )
          products = [...manualProducts, ...fillProducts]
        }

        return {
          ...section,
          products: products.slice(0, limit),
        }
      })
    )

    const responseData = {
      tab_key: tabKey,
      store_key: storeKey,
      sections: resolvedSections,
    }
    const etag = createHash('md5').update(JSON.stringify(responseData)).digest('hex')

    await redis.set(
      cacheKey,
      JSON.stringify({ _etag: etag, data: responseData }),
      'EX',
      CACHE_TTL
    )

    if (clientETag && clientETag === etag) {
      reply.code(304)
      return
    }

    reply.header('ETag', etag)
    reply.header('Cache-Control', 'private, max-age=60')
    return success(responseData, 'Section manifest')
  }
}

function normalizeStoreKey(storeKey) {
  const normalized = `${storeKey || 'zepto'}`.trim()
  return STORE_KEYS.includes(normalized) ? normalized : 'zepto'
}

async function getTabManifestRows(storeKey, audience = 'B2C') {
  // The tab bar itself is fully independent per audience (each audience
  // owns its own theme_tabs rows — see migration 126) — no cross-audience
  // fallback here, unlike the theme-content join below. A B2B viewer must
  // only ever see B2B's own tab list, never B2C's tabs bleeding through.
  //
  // The per-tab THEME SKIN still prefers a theme flagged for the requested
  // audience, but falls back to the B2C one when no B2B-specific theme has
  // been configured for this tab+variant yet — a newly-approved B2B
  // customer must never see a blank/missing theme just because an admin
  // hasn't built B2B theming for every tab. `audience IN ($2, 'B2C')` is a
  // no-op filter for a B2C viewer (collapses to `= 'B2C'`); for a B2B
  // viewer it matches both, and `ORDER BY (audience = $2) DESC` prefers
  // the exact-audience row when both exist.
  const { rows } = await query(
    `SELECT
       tab.id AS tab_id,
       tab.store_key,
       tab.key AS tab_key,
       tab.label AS tab_label,
       tab.image_url AS tab_icon_url,
       tab.text_color AS tab_text_color,
       tab.sort_order AS tab_order,
       tab.is_default AS is_default,
       theme_a.id AS theme_id,
       theme_a.ab_variant,
       theme_a.theme_data,
       theme_b.theme_data AS variant_b_theme_data,
       theme_b.ab_split_percent AS variant_b_split
     FROM theme_tabs tab
     LEFT JOIN LATERAL (
       SELECT id, ab_variant, theme_data
       FROM app_themes
       WHERE tab_id = tab.id
         AND status = 'active'
         AND ab_variant = 'A'
         AND audience IN ($2, 'B2C')
       ORDER BY (audience = $2) DESC, updated_at DESC, created_at DESC
       LIMIT 1
     ) theme_a ON true
     LEFT JOIN LATERAL (
       SELECT theme_data, ab_split_percent
       FROM app_themes
       WHERE tab_id = tab.id
         AND status = 'active'
         AND ab_variant = 'B'
         AND audience IN ($2, 'B2C')
       ORDER BY (audience = $2) DESC, updated_at DESC, created_at DESC
       LIMIT 1
     ) theme_b ON true
     WHERE tab.store_key = $1
       AND tab.status = 'active'
       AND tab.audience = $2
     ORDER BY tab.sort_order ASC, tab.label ASC`,
    [storeKey, audience]
  )

  return rows
}

function buildTabManifestResponse(storeKey, rows) {
  const fallbackTheme =
    rows.find((row) => row.tab_key === 'all' && row.theme_data)?.theme_data ?? null

  const tabs = rows.map((row) => {
    const themeData = mergeThemeData(fallbackTheme, row.theme_data)
    const variantBThemeData = mergeThemeData(fallbackTheme, row.variant_b_theme_data)

    return {
      tab_id: row.tab_id,
      store_key: storeKey,
      theme_id: row.theme_id,
      tab_key: row.tab_key,
      tab_label: row.tab_label,
      tab_icon_url: row.tab_icon_url,
      tab_text_color: row.tab_text_color,
      tab_order: row.tab_order,
      is_default: !!row.is_default,
      variant: row.ab_variant || 'A',
      theme_data: themeData,
      ...(variantBThemeData
        ? {
            ab_test: {
              variant_b_data: variantBThemeData,
              split_percent: row.variant_b_split || 0,
            },
          }
        : {}),
    }
  })

  return {
    store_key: storeKey,
    tabs,
  }
}

function mergeThemeData(baseValue, overrideValue) {
  if (overrideValue == null) {
    return baseValue ?? null
  }

  if (Array.isArray(overrideValue)) {
    return overrideValue
  }

  if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
    const merged = { ...baseValue }
    for (const [key, value] of Object.entries(overrideValue)) {
      merged[key] = mergeThemeData(baseValue[key], value)
    }
    return merged
  }

  return overrideValue
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function getTabDefinition(storeKey, tabKey, audience = 'B2C') {
  const { rows: [tab] } = await query(
    `SELECT id, store_key, key, merch_config
     FROM theme_tabs
     WHERE store_key = $1
       AND key = $2
       AND status = 'active'
       AND audience = $3
     LIMIT 1`,
    [storeKey, tabKey, audience]
  )
  return tab || null
}

const SECTION_ROW_SELECT = `
  id,
  section_type AS type,
  sort_order AS "order",
  visible,
  config,
  merch_binding
`

/**
 * Whole-set B2C fallback for a tab's section list — unlike the
 * single-row `audience IN ($n,'B2C') ORDER BY (audience=$n) DESC LIMIT 1`
 * pattern used for app_themes (one active row to pick), a tab's section
 * list is many ordered rows, so falling back has to be all-or-nothing:
 * if the tab has ANY B2B-specific sections, use exactly those; otherwise
 * use the whole B2C list. Never mix rows from both audiences into one
 * response.
 */
async function fetchSectionRows(tabId, audience) {
  if (audience === 'B2B') {
    const { rows } = await query(
      `SELECT ${SECTION_ROW_SELECT}
       FROM section_manifests
       WHERE tab_id = $1 AND audience = 'B2B' AND visible = true
       ORDER BY sort_order ASC`,
      [tabId]
    )
    if (rows.length > 0) return rows
  }

  const { rows } = await query(
    `SELECT ${SECTION_ROW_SELECT}
     FROM section_manifests
     WHERE tab_id = $1 AND audience = 'B2C' AND visible = true
     ORDER BY sort_order ASC`,
    [tabId]
  )
  return rows
}

async function resolveSectionProducts(config, fallbackResolver, cap, allocatedShopIds = null, priceMode = 'retail') {
  const productIds = Array.isArray(config?.product_ids) ? config.product_ids : []
  const categoryIds = Array.isArray(config?.category_ids) ? config.category_ids : []
  // PHASE 5B: normalizeLimit honours dashboard config but clamps to cap.
  const limit = normalizeLimit(config?.limit, cap ?? HOME_CAPS.featured, cap)

  if (productIds.length === 0 && categoryIds.length === 0) {
    return (await fallbackResolver()).slice(0, limit)
  }

  const manualProducts = await getProductsByIds(productIds, allocatedShopIds, priceMode)
  const seenIds = new Set(manualProducts.map((product) => product.id))

  if (manualProducts.length >= limit || categoryIds.length === 0) {
    return manualProducts.slice(0, limit)
  }

  const fillProducts = await getProductsByCategoryIds(
    categoryIds,
    limit - manualProducts.length,
    [...seenIds],
    allocatedShopIds,
    priceMode
  )

  return [...manualProducts, ...fillProducts].slice(0, limit)
}

async function resolveCategorySections(rails, fallbackResolver, railCap, allocatedShopIds = null, priceMode = 'retail') {
  if (!Array.isArray(rails) || rails.length === 0) {
    return fallbackResolver()
  }

  const sections = []

  for (const rail of rails) {
    if (!rail?.category_id) continue

    // PHASE 5B: each rail limit clamped to railCap.
    const limit = normalizeLimit(rail.limit, HOME_CAPS.categoryRail, railCap)
    const manualProducts = await getProductsByIds(
      Array.isArray(rail.product_ids) ? rail.product_ids : [],
      allocatedShopIds,
      priceMode
    )
    const seenIds = manualProducts.map((product) => product.id)
    const fillProducts =
      manualProducts.length < limit
        ? await getProductsByCategoryIds(
            [rail.category_id],
            limit - manualProducts.length,
            seenIds,
            allocatedShopIds,
            priceMode
          )
        : []

    const products = [...manualProducts, ...fillProducts].slice(0, limit)
    if (products.length === 0) continue

    const title = rail.title || (await getCategoryName(rail.category_id))
    sections.push({
      category_id: rail.category_id,
      title,
      products,
    })
  }

  return sections.length > 0 ? sections : fallbackResolver()
}

/**
 * @param {string[]} productIds
 * @param {string[]|null} [allocatedShopIds] - Same shop-price join every
 * customer-facing products.repository.js read path uses. Previously this
 * queried p.price/p.stock_quantity directly with no shop_products join at
 * all — the direct cause of dashboard-pinned home/section products never
 * reflecting a shop's own price, a wholesale price, or bulk-order limits.
 * A pinned product unavailable at the customer's shop is now dropped
 * (via the same visibility EXISTS every other endpoint applies) rather
 * than falling back to a master price nobody would actually charge.
 * @param {'retail'|'wholesale'} [priceMode='retail']
 */
async function getProductsByIds(productIds, allocatedShopIds = null, priceMode = 'retail') {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return []
  }

  const params = [productIds]
  const visibility = buildCustomerVisibilitySnippet(allocatedShopIds, params, params.length + 1)
  const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)

  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.slug,
       ${shopPrice.priceExpr} AS price,
       ${shopPrice.salePriceExpr} AS sale_price,
       ${shopPrice.stockExpr} AS stock_quantity,
       p.unit,
       p.thumbnail_url,
       p.category_id,
       c.name AS category_name,
       COALESCE(p.images, '[]'::jsonb) AS images,
       COALESCE(p.tags, ARRAY[]::text[]) AS tags,
       p.is_active,
       p.is_featured,
       p.total_sold,
       p.description,
       p.ingredients,
       p.nutrition_info,
       p.storage_instructions,
       p.product_family_id,
       pf.name AS family_name,
       p.option_label,
       p.option_sort_order,
       p.is_default_option,
       p.food_type,
       p.origin_tag,
       p.custom_badges,
       p.display_delivery_minutes,
       p.net_quantity,
       p.brand,
       p.brand_logo_url,
       p.avg_rating,
       p.rating_count,
       ${shopPrice.bulkMinQuantityExpr} AS bulk_min_quantity,
       ${shopPrice.bulkMaxQuantityExpr} AS bulk_max_quantity,
       ${shopPrice.bulkOrderEligibleExpr} AS bulk_order_eligible,
       COALESCE(
         (SELECT COUNT(*)::int FROM products ps
          WHERE ps.product_family_id = p.product_family_id
            AND ps.is_active = true AND ps.stock_quantity > 0),
         1
       ) AS option_count
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_families pf ON pf.id = p.product_family_id
     ${shopPrice.joinSql}
     WHERE p.is_active = true
       AND ${shopPrice.stockExpr} > 0
       AND p.id = ANY($1::uuid[])
       ${visibility.sql}
     ORDER BY array_position($1::uuid[], p.id)`,
    params
  )

  return rows
}

/**
 * Products belonging to any of the given categories — either as a
 * product's real/primary category (products.category_id) OR via
 * cross-listing through category_products (the multi-category feature: a
 * product can additionally appear under a category that isn't its primary
 * one, e.g. "Exotic Vegetables" cross-listing a product whose real
 * category is "Fresh Vegetables"). Missing this half of the union was the
 * root cause of cross-listed products never showing up in category-bound
 * home sections/widgets even though they correctly appear on the regular
 * category browse page (which already unions both — see
 * categories.repository.js#findProducts).
 *
 * When multiple categoryIds are given, results are interleaved fairly
 * across categories (every category's #1 pick before any category's #2
 * pick, etc.) via a per-category ROW_NUMBER, rather than one global
 * ORDER BY/LIMIT — otherwise a single large/high-selling category could
 * crowd out every product from the other requested categories.
 */
/**
 * @param {string[]} categoryIds
 * @param {number} limit
 * @param {string[]} [excludeIds]
 * @param {string[]|null} [allocatedShopIds] - Same shop-price join every
 * customer-facing products.repository.js read path uses (see
 * getProductsByIds' docstring for why). Applied to both the `matches` CTE
 * (so a product unavailable at the customer's shop never enters the
 * fairness ranking in the first place) and `ranked` (so the actually
 * displayed price/stock/bulk fields are the shop's own row).
 * @param {'retail'|'wholesale'} [priceMode='retail']
 */
export async function getProductsByCategoryIds(categoryIds, limit, excludeIds = [], allocatedShopIds = null, priceMode = 'retail') {
  if (!Array.isArray(categoryIds) || categoryIds.length === 0 || limit <= 0) {
    return []
  }

  const params = [categoryIds, limit]
  let excludeClause = ''
  if (excludeIds.length > 0) {
    params.push(excludeIds)
    excludeClause = ` AND NOT (p.id = ANY($${params.length}::uuid[]))`
  }

  const visibility = buildCustomerVisibilitySnippet(allocatedShopIds, params, params.length + 1)
  const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)

  const { rows } = await query(
    `WITH matches AS (
       SELECT p.id AS product_id, cat.id AS matched_category_id, cat.ord
       FROM unnest($1::uuid[]) WITH ORDINALITY AS cat(id, ord)
       JOIN products p ON (
         p.category_id = cat.id
         OR EXISTS (
           SELECT 1 FROM category_products cp
           WHERE cp.product_id = p.id AND cp.category_id = cat.id
         )
       )
       ${shopPrice.joinSql}
       WHERE p.is_active = true AND ${shopPrice.stockExpr} > 0 ${excludeClause} ${visibility.sql}
     ),
     best_match AS (
       -- A product reachable via more than one of the requested categories
       -- (e.g. cross-listed into two of them) keeps only its first match,
       -- by input order, so it's never returned twice.
       SELECT DISTINCT ON (product_id) product_id, matched_category_id
       FROM matches
       ORDER BY product_id, ord ASC
     ),
     ranked AS (
       SELECT
         p.id,
         p.name,
         p.slug,
         ${shopPrice.priceExpr} AS price,
         ${shopPrice.salePriceExpr} AS sale_price,
         ${shopPrice.stockExpr} AS stock_quantity,
         p.unit,
         p.thumbnail_url,
         p.category_id,
         c.name AS category_name,
         COALESCE(p.images, '[]'::jsonb) AS images,
         COALESCE(p.tags, ARRAY[]::text[]) AS tags,
         p.is_active,
         p.is_featured,
         p.total_sold,
         p.created_at,
         p.description,
         p.ingredients,
         p.nutrition_info,
         p.storage_instructions,
         p.product_family_id,
         pf.name AS family_name,
         p.option_label,
         p.option_sort_order,
         p.is_default_option,
         p.food_type,
         p.origin_tag,
         p.custom_badges,
         p.display_delivery_minutes,
         p.net_quantity,
         p.brand,
         p.brand_logo_url,
         p.avg_rating,
         p.rating_count,
         ${shopPrice.bulkMinQuantityExpr} AS bulk_min_quantity,
         ${shopPrice.bulkMaxQuantityExpr} AS bulk_max_quantity,
         ${shopPrice.bulkOrderEligibleExpr} AS bulk_order_eligible,
         COALESCE(
           (SELECT COUNT(*)::int FROM products ps
            WHERE ps.product_family_id = p.product_family_id
              AND ps.is_active = true AND ps.stock_quantity > 0),
           1
         ) AS option_count,
         ROW_NUMBER() OVER (
           PARTITION BY bm.matched_category_id
           ORDER BY p.is_featured DESC, p.total_sold DESC, p.created_at DESC
         ) AS local_rank
       FROM best_match bm
       JOIN products p ON p.id = bm.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN product_families pf ON pf.id = p.product_family_id
       ${shopPrice.joinSql}
     )
     SELECT
       id, name, slug, price, sale_price, stock_quantity, unit, thumbnail_url,
       category_id, category_name, images, tags, is_active, is_featured,
       total_sold, description, ingredients, nutrition_info, storage_instructions,
       product_family_id, family_name, option_label, option_sort_order,
       is_default_option, food_type, origin_tag, custom_badges,
       display_delivery_minutes, net_quantity, brand, brand_logo_url,
       avg_rating, rating_count, bulk_min_quantity, bulk_max_quantity,
       bulk_order_eligible, option_count
     FROM ranked
     ORDER BY local_rank ASC, is_featured DESC, total_sold DESC, created_at DESC
     LIMIT $2`,
    params
  )

  return rows
}

/**
 * @param {number} limit
 * @param {string[]|null} [allocatedShopIds] - See getProductsByIds' docstring.
 * @param {'retail'|'wholesale'} [priceMode='retail']
 */
async function getFeaturedProducts(limit, allocatedShopIds = null, priceMode = 'retail') {
  const params = [limit]
  const visibility = buildCustomerVisibilitySnippet(allocatedShopIds, params, params.length + 1)
  const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)

  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.slug,
       ${shopPrice.priceExpr} AS price,
       ${shopPrice.salePriceExpr} AS sale_price,
       ${shopPrice.stockExpr} AS stock_quantity,
       p.unit,
       p.thumbnail_url,
       p.category_id,
       c.name AS category_name,
       COALESCE(p.images, '[]'::jsonb) AS images,
       COALESCE(p.tags, ARRAY[]::text[]) AS tags,
       p.is_active,
       p.is_featured,
       p.total_sold,
       p.description,
       p.ingredients,
       p.nutrition_info,
       p.storage_instructions,
       p.product_family_id,
       pf.name AS family_name,
       p.option_label,
       p.option_sort_order,
       p.is_default_option,
       p.food_type,
       p.origin_tag,
       p.custom_badges,
       p.display_delivery_minutes,
       p.net_quantity,
       p.brand,
       p.brand_logo_url,
       p.avg_rating,
       p.rating_count,
       ${shopPrice.bulkMinQuantityExpr} AS bulk_min_quantity,
       ${shopPrice.bulkMaxQuantityExpr} AS bulk_max_quantity,
       ${shopPrice.bulkOrderEligibleExpr} AS bulk_order_eligible,
       COALESCE(
         (SELECT COUNT(*)::int FROM products ps
          WHERE ps.product_family_id = p.product_family_id
            AND ps.is_active = true AND ps.stock_quantity > 0),
         1
       ) AS option_count
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_families pf ON pf.id = p.product_family_id
     ${shopPrice.joinSql}
     WHERE p.is_active = true
       AND ${shopPrice.stockExpr} > 0
       AND p.is_featured = true
       ${visibility.sql}
     ORDER BY p.total_sold DESC, p.created_at DESC
     LIMIT $1`,
    params
  )

  return rows
}

/**
 * @param {number} limit
 * @param {string[]|null} [allocatedShopIds] - See getProductsByIds' docstring.
 * @param {'retail'|'wholesale'} [priceMode='retail']
 */
async function getDealProducts(limit, allocatedShopIds = null, priceMode = 'retail') {
  const params = [limit]
  const visibility = buildCustomerVisibilitySnippet(allocatedShopIds, params, params.length + 1)
  const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)

  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.slug,
       ${shopPrice.priceExpr} AS price,
       ${shopPrice.salePriceExpr} AS sale_price,
       ${shopPrice.stockExpr} AS stock_quantity,
       p.unit,
       p.thumbnail_url,
       p.category_id,
       c.name AS category_name,
       COALESCE(p.images, '[]'::jsonb) AS images,
       COALESCE(p.tags, ARRAY[]::text[]) AS tags,
       p.is_active,
       p.is_featured,
       p.total_sold,
       p.description,
       p.ingredients,
       p.nutrition_info,
       p.storage_instructions,
       p.product_family_id,
       pf.name AS family_name,
       p.option_label,
       p.option_sort_order,
       p.is_default_option,
       p.food_type,
       p.origin_tag,
       p.custom_badges,
       p.display_delivery_minutes,
       p.net_quantity,
       p.brand,
       p.brand_logo_url,
       p.avg_rating,
       p.rating_count,
       ${shopPrice.bulkMinQuantityExpr} AS bulk_min_quantity,
       ${shopPrice.bulkMaxQuantityExpr} AS bulk_max_quantity,
       ${shopPrice.bulkOrderEligibleExpr} AS bulk_order_eligible,
       COALESCE(
         (SELECT COUNT(*)::int FROM products ps
          WHERE ps.product_family_id = p.product_family_id
            AND ps.is_active = true AND ps.stock_quantity > 0),
         1
       ) AS option_count
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_families pf ON pf.id = p.product_family_id
     ${shopPrice.joinSql}
     WHERE p.is_active = true
       AND ${shopPrice.stockExpr} > 0
       AND ${shopPrice.salePriceExpr} IS NOT NULL
       AND ${shopPrice.salePriceExpr} < ${shopPrice.priceExpr}
       ${visibility.sql}
     ORDER BY p.total_sold DESC, p.created_at DESC
     LIMIT $1`,
    params
  )

  return rows
}

/**
 * @param {number} limit
 * @param {string[]|null} [allocatedShopIds] - See getProductsByIds' docstring.
 * @param {'retail'|'wholesale'} [priceMode='retail']
 */
async function getTrendingProducts(limit, allocatedShopIds = null, priceMode = 'retail') {
  const params = [limit]
  const visibility = buildCustomerVisibilitySnippet(allocatedShopIds, params, params.length + 1)
  const shopPrice = buildShopPriceJoin(allocatedShopIds, params, visibility.nextIdx, priceMode)

  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.slug,
       ${shopPrice.priceExpr} AS price,
       ${shopPrice.salePriceExpr} AS sale_price,
       ${shopPrice.stockExpr} AS stock_quantity,
       p.unit,
       p.thumbnail_url,
       p.category_id,
       c.name AS category_name,
       COALESCE(p.images, '[]'::jsonb) AS images,
       COALESCE(p.tags, ARRAY[]::text[]) AS tags,
       p.is_active,
       p.is_featured,
       p.total_sold,
       p.description,
       p.ingredients,
       p.nutrition_info,
       p.storage_instructions,
       p.product_family_id,
       pf.name AS family_name,
       p.option_label,
       p.option_sort_order,
       p.is_default_option,
       p.food_type,
       p.origin_tag,
       p.custom_badges,
       p.display_delivery_minutes,
       p.net_quantity,
       p.brand,
       p.brand_logo_url,
       p.avg_rating,
       p.rating_count,
       ${shopPrice.bulkMinQuantityExpr} AS bulk_min_quantity,
       ${shopPrice.bulkMaxQuantityExpr} AS bulk_max_quantity,
       ${shopPrice.bulkOrderEligibleExpr} AS bulk_order_eligible,
       COALESCE(
         (SELECT COUNT(*)::int FROM products ps
          WHERE ps.product_family_id = p.product_family_id
            AND ps.is_active = true AND ps.stock_quantity > 0),
         1
       ) AS option_count
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_families pf ON pf.id = p.product_family_id
     ${shopPrice.joinSql}
     WHERE p.is_active = true
       AND ${shopPrice.stockExpr} > 0
       ${visibility.sql}
     ORDER BY p.total_sold DESC, p.created_at DESC
     LIMIT $1`,
    params
  )

  return rows
}

/**
 * @param {number} limitSections
 * @param {number} itemsPerSection
 * @param {string[]|null} [allocatedShopIds] - Threaded through to the
 * per-category product fetch below so each rail's items are shop/price-mode
 * scoped. The "which categories even get a rail" EXISTS check just above
 * stays master-catalog-based (deciding whether to render a rail at all,
 * not a displayed price) — a category that turns out to have nothing
 * available at this customer's shop simply yields an empty rail, already
 * skipped by the `if (products.length === 0) continue` below.
 * @param {'retail'|'wholesale'} [priceMode='retail']
 */
async function getDefaultCategorySections(limitSections, itemsPerSection, allocatedShopIds = null, priceMode = 'retail') {
  const { rows: categories } = await query(
    `SELECT
       c.id,
       c.name
     FROM categories c
     WHERE c.is_active = true
       AND c.parent_id IS NULL
       AND EXISTS (
         SELECT 1
         FROM products p
         WHERE p.category_id = c.id
           AND p.is_active = true
           AND p.stock_quantity > 0
       )
     ORDER BY c.sort_order ASC, c.name ASC
     LIMIT $1`,
    [limitSections ?? HOME_CAPS.defaultRailCount]
  )

  const perRail = itemsPerSection ?? HOME_CAPS.defaultRailItems
  // Each category's own `perRail` products, fetched concurrently instead of
  // one-after-another — these queries don't depend on each other. (Not
  // merged into a single multi-category call: that query's LIMIT applies
  // across the combined result, not per category, which would shrink each
  // rail instead of just fetching them in parallel.)
  const rows = await Promise.all(
    categories.map((category) =>
      getProductsByCategoryIds([category.id], perRail, [], allocatedShopIds, priceMode)
    )
  )

  const sections = []
  categories.forEach((category, index) => {
    const products = rows[index]
    if (products.length === 0) return
    sections.push({
      category_id: category.id,
      title: category.name,
      products,
    })
  })

  return sections
}

async function getCategoryName(categoryId) {
  const { rows: [category] } = await query(
    'SELECT name FROM categories WHERE id = $1 LIMIT 1',
    [categoryId]
  )
  return category?.name || 'Category'
}

function mergeUniqueProducts(groups) {
  const seen = new Set()
  const merged = []

  for (const group of groups) {
    for (const product of group) {
      if (!seen.has(product.id)) {
        seen.add(product.id)
        merged.push(product)
      }
    }
  }

  return merged
}

/**
 * PHASE 5B: normalizeLimit — parse dashboard limit, apply safe mobile cap.
 *
 * @param {any}    value    - raw dashboard config value
 * @param {number} fallback - default when value is absent/invalid
 * @param {number} [cap]    - optional hard ceiling (overrides max=50 for mobile home)
 */
function normalizeLimit(value, fallback, cap) {
  const parsed = Number(value)
  const resolved = (!Number.isFinite(parsed) || parsed <= 0) ? fallback : Math.trunc(parsed)
  // If a per-context cap is provided, honour it; otherwise keep the legacy 50 ceiling
  // so non-home endpoints (admin, full category pages) are unchanged.
  const ceiling = (typeof cap === 'number' && cap > 0) ? cap : 50
  return Math.min(Math.max(resolved, 1), ceiling)
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5F: Lightweight home payload debug logging.
// Only fires at Pino 'debug' level — production deployments set LOG_LEVEL=info
// so this is zero-cost in prod. Staging/QA can set LOG_LEVEL=debug to see it.
// ─────────────────────────────────────────────────────────────────────────────
function _logHomePayload(storeKey, tabKey, data) {
  if (!logger.isLevelEnabled?.('debug') && logger.level !== 'debug') return

  const totalProducts =
    (data.featured_products?.length ?? 0) +
    (data.deal_products?.length ?? 0) +
    (data.trending_products?.length ?? 0) +
    (data.seasonal_products?.length ?? 0) +
    (data.category_sections ?? []).reduce((sum, s) => sum + (s.products?.length ?? 0), 0)

  const approxBytes = JSON.stringify(data).length

  logger.debug(
    {
      storeKey,
      tabKey,
      counts: {
        featured: data.featured_products?.length ?? 0,
        deals: data.deal_products?.length ?? 0,
        trending: data.trending_products?.length ?? 0,
        seasonal: data.seasonal_products?.length ?? 0,
        categorySections: data.category_sections?.length ?? 0,
        categoryRailProducts: (data.category_sections ?? []).map(s => s.products?.length ?? 0),
      },
      totalProducts,
      approxBytes,
      action: 'tab_home_content.payload',
    },
    `[home-payload] ${tabKey}@${storeKey}: ${totalProducts} products, ~${Math.round(approxBytes / 1024)}KB`
  )
}
