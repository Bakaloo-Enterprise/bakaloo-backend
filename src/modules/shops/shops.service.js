import { cacheGet, cacheSet, cacheDel, cacheDeletePattern } from '../../utils/cache.js'
import { logger } from '../../config/logger.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { allocationQueue } from '../../config/bullmq.js'

const CACHE_PREFIX = 'bakaloo:shops:v1'
const CACHE_TTL = 300 // 300 seconds

/**
 * Persisted shop columns used for the before/after diff that gates
 * `shop_updated` audit emission. `updated_at` is intentionally excluded
 * because the repository bumps it on every write — including it would
 * cause the audit to fire even when no caller-supplied field actually
 * changed (per design §12.2: "when any field besides `updated_at`
 * changes"). `bank_account_number` is included so a real change still
 * triggers the audit; the value itself is stripped from before/after
 * snapshots by `audit-log.js` `redact()` (R28 AC#5) so the secret never
 * reaches the audit row.
 */
const SHOP_AUDIT_COMPARE_FIELDS = Object.freeze([
  'lat',
  'lng',
  'serviceable_pincodes',
  'delivery_radius_km',
  'pincode_only',
  'name',
  'slug',
  'description',
  'logo_url',
  'banner_url',
  'phone',
  'email',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'pincode',
  'is_active',
  'is_verified',
  'operating_hours',
  'commission_rate',
  'bank_account_number',
  'bank_ifsc',
  'bank_name',
  'bank_holder_name',
  'gst_number',
  'pan_number',
])

/**
 * Project a shop row to only the persisted columns we audit on, in a
 * stable key order, so JSON.stringify comparison is deterministic
 * regardless of how the underlying repository orders columns.
 *
 * @param {object} row
 * @returns {Record<string, unknown>}
 */
function projectShopForAudit(row) {
  const out = {}
  for (const key of SHOP_AUDIT_COMPARE_FIELDS) {
    out[key] = row?.[key] ?? null
  }
  return out
}

/**
 * Returns true when at least one persisted column on `before` differs
 * from `after` (JSON-stable comparison over the audit-relevant subset).
 *
 * @param {object} before
 * @param {object} after
 * @returns {boolean}
 */
function shopFieldsChanged(before, after) {
  return (
    JSON.stringify(projectShopForAudit(before)) !==
    JSON.stringify(projectShopForAudit(after))
  )
}

/**
 * Shops service — business logic with Redis caching
 * Handles slug generation, branch code generation, cache invalidation
 */
export class ShopsService {
  constructor(repository) {
    this.repo = repository
  }

  /**
   * Create a new shop
   * Generates unique slug and branch_code
   * @param {object} data - Validated shop data
   * @param {string} userId - Creator's user ID
   * @returns {Promise<object>}
   */
  async create(data, userId) {
    const slug = await this.generateUniqueSlug(data.name)
    const branchCode = await this.generateBranchCode(data.city)

    const shop = await this.repo.create({
      ...data,
      slug,
      branch_code: branchCode,
      created_by: userId,
    })

    // Invalidate active shops list cache
    await cacheDeletePattern('bakaloo:shops:active:*')

    logger.info({ userId, shopId: shop.id, action: 'shop_created' }, 'Shop created')

    return shop
  }

  /**
   * Get shop by ID (cached)
   * @param {string} id - Shop UUID
   * @returns {Promise<object|null>}
   */
  async getById(id) {
    const cacheKey = `${CACHE_PREFIX}:${id}`
    const cached = await cacheGet(cacheKey)
    if (cached) return (await this.#withSales([cached]))[0]

    const shop = await this.repo.findById(id)
    if (shop) {
      await cacheSet(cacheKey, shop, CACHE_TTL)
    }
    return shop ? (await this.#withSales([shop]))[0] : shop
  }

  /** Overlay live lifetime sales (the stored counters are never updated). Skipped when the repo cannot provide them. */
  async #withSales(shops) {
    if (typeof this.repo.salesTotals !== 'function' || shops.length === 0) return shops
    const totals = await this.repo.salesTotals(shops.map((s) => s.id))
    return shops.map((s) => ({ ...s, total_orders: totals.get(s.id)?.total_orders ?? 0, total_revenue: totals.get(s.id)?.total_revenue ?? 0 }))
  }

  /**
   * List shops with filters and pagination
   * @param {object} filters - Query filters
   * @returns {Promise<object>}
   */
  async list(filters) {
    const { shops, total } = await this.repo.findMany(filters)
    return {
      shops: await this.#withSales(shops),
      total,
      page: filters.page,
      limit: filters.limit,
    }
  }

  /**
   * Update shop by ID
   *
   * Regenerates slug if name changes. After persisting, emits a
   * `shop_updated` audit row whenever any persisted column on the
   * `shops` row actually changed (R28 AC#9 / R28.9 / design §10 /
   * design §12.2 — "when any field besides `updated_at` changes").
   * Emission is fire-and-forget via `audit-log.js` `emit()` so request
   * latency is unaffected; the helper redacts `bank_account_number`
   * from the before/after JSON snapshots (R28 AC#5).
   *
   * @param {string} id - Shop UUID
   * @param {object} data - Fields to update
   * @param {string} userId - Updater's user ID
   * @param {object} [ctx] - Request context for the audit row
   * @param {string|null} [ctx.ip] - Source IP from request.ip
   * @param {string|null} [ctx.userAgent] - User-agent header
   * @param {string|null} [ctx.actorRole] - Resolved HQ_Role or Shop_Role
   * @returns {Promise<{success: boolean, shop?: object, message?: string}>}
   */
  async update(id, data, userId, { ip = null, userAgent = null, actorRole = null } = {}) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Shop not found', code: 'SHOP_NOT_FOUND' }
    }

    const updateData = { ...data }

    // Regenerate slug if name changed
    if (updateData.name && updateData.name !== existing.name) {
      updateData.slug = await this.generateUniqueSlug(updateData.name)
    }

    const shop = await this.repo.update(id, updateData)
    if (!shop) {
      return { success: false, message: 'Shop not found', code: 'SHOP_NOT_FOUND' }
    }

    // Invalidate caches
    await cacheDel(`${CACHE_PREFIX}:${id}`)
    await cacheDeletePattern('bakaloo:shops:active:*')

    // Task 13.3: Trigger allocation recompute when serviceable_pincodes,
    // delivery_radius_km, or pincode_only changes (Requirements 4.8, 4.9).
    // Fire-and-forget — allocation recompute is a background job.
    const pincodesChanged =
      data.serviceable_pincodes !== undefined &&
      JSON.stringify(data.serviceable_pincodes) !==
        JSON.stringify(existing.serviceable_pincodes)
    const radiusChanged =
      data.delivery_radius_km !== undefined &&
      data.delivery_radius_km !== existing.delivery_radius_km
    // Toggling pincode_only alone (no pincode/radius edit) must also
    // recompute — turning it on drops any existing radius-only-matched
    // allocations for this shop; turning it off can newly add some.
    const pincodeOnlyChanged =
      data.pincode_only !== undefined &&
      data.pincode_only !== existing.pincode_only

    if (pincodesChanged || radiusChanged || pincodeOnlyChanged) {
      try {
        await allocationQueue.add(
          'recompute-by-shop',
          { type: 'recompute-by-shop', shopId: id },
          { jobId: `recompute-by-shop:${id}` }
        )
        logger.info(
          { shopId: id, pincodesChanged, radiusChanged, pincodeOnlyChanged, action: 'allocation_recompute_enqueued' },
          'Allocation recompute enqueued for shop area change'
        )
      } catch (err) {
        logger.error(
          { shopId: id, err: err.message, action: 'allocation_recompute_enqueue_failed' },
          'Failed to enqueue allocation recompute'
        )
      }
    }

    // R28 AC#9 / design §10 / §12.2: emit `shop_updated` only when at
    // least one persisted column actually changed. Skipping no-op
    // updates keeps the audit trail signal-rich and avoids noisy rows
    // for requests that submit identical values (e.g. idempotent
    // dashboard saves). The redaction of `bank_account_number` from
    // both snapshots happens inside `emitAudit`.
    if (shopFieldsChanged(existing, shop)) {
      emitAudit('shop_updated', {
        actor_user_id: userId,
        actor_role: actorRole,
        actor_shop_id: id,
        target_type: 'shop',
        target_id: id,
        before: existing,
        after: shop,
        ip_address: ip,
        user_agent: userAgent,
      })
    }

    logger.info({ userId, shopId: id, action: 'shop_updated' }, 'Shop updated')

    return { success: true, shop }
  }

  /**
   * Soft-delete shop by ID
   * @param {string} id - Shop UUID
   * @param {string} userId - Deleter's user ID
   * @returns {Promise<{success: boolean, message?: string}>}
   */
  async delete(id, userId) {
    const existing = await this.repo.findById(id)
    if (!existing) {
      return { success: false, message: 'Shop not found', code: 'SHOP_NOT_FOUND' }
    }

    const deleted = await this.repo.softDelete(id)
    if (!deleted) {
      return { success: false, message: 'Shop not found', code: 'SHOP_NOT_FOUND' }
    }

    // Invalidate caches
    await cacheDel(`${CACHE_PREFIX}:${id}`)
    await cacheDeletePattern('bakaloo:shops:active:*')

    logger.info({ userId, shopId: id, action: 'shop_deleted' }, 'Shop soft-deleted')

    return { success: true }
  }

  /**
   * Generate a unique slug from shop name
   * 1. Lowercase the name
   * 2. Replace spaces and special characters with hyphens
   * 3. Remove consecutive hyphens
   * 4. If slug exists, append -1, -2, etc. until unique
   * @param {string} name - Shop name
   * @returns {Promise<string>}
   */
  async generateUniqueSlug(name) {
    const baseSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/[\s]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')

    // Check for existing slugs with same base
    const existingSlugs = await this.repo.findSlugsLike(baseSlug)

    if (existingSlugs.length === 0) {
      return baseSlug
    }

    // Find the highest numeric suffix
    let maxSuffix = 0
    for (const slug of existingSlugs) {
      if (slug === baseSlug) {
        maxSuffix = Math.max(maxSuffix, 0)
        continue
      }
      const match = slug.match(new RegExp(`^${baseSlug}-(\\d+)$`))
      if (match) {
        maxSuffix = Math.max(maxSuffix, parseInt(match[1], 10))
      }
    }

    return `${baseSlug}-${maxSuffix + 1}`
  }

  /**
   * Generate a unique branch code
   * Format: CITY_PREFIX + sequential number (e.g., MUM001, DEL002)
   * @param {string} city - City name
   * @returns {Promise<string>}
   */
  async generateBranchCode(city) {
    const prefix = city
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, 3)
      .padEnd(3, 'X')

    // Find highest existing branch code with this prefix
    let code
    let counter = 1
    const maxAttempts = 100

    while (counter <= maxAttempts) {
      code = `${prefix}${String(counter).padStart(3, '0')}`
      const existing = await this.repo.findByBranchCode(code)
      if (!existing) break
      counter++
    }

    return code
  }
}
