import { cacheGet, cacheSet, cacheDeletePattern } from '../../utils/cache.js'
import { simpleSlug } from '../../utils/slugify.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { logger } from '../../config/logger.js'
import { normalizeMediaDeliveryUrl } from '../../config/media.js'
import { AllocationService } from '../allocation/allocation.service.js'
import { AllocationRepository } from '../allocation/allocation.repository.js'

const CACHE_KEY_ALL = 'categories:all'
const CACHE_TTL = 1800 // 30 minutes
const CACHE_VERSION = 'v2'

/**
 * Categories service — business logic with Redis caching
 */
export class CategoriesService {
  constructor(repository, deps = {}) {
    this.repo = repository
    this.allocationService =
      deps.allocationService ||
      new AllocationService(new AllocationRepository())
  }

  /**
   * Resolve the customer's allocated shop_ids for product visibility.
   *
   * A customer request must never fall back to the master catalog. Empty or
   * failed allocation lookup is deliberately fail-closed.
   *
   * @param {{ userId?: string }|null|undefined} customerContext
   * @returns {Promise<string[]|null>}
   */
  async _resolveAllocatedShopIds(customerContext) {
    if (!customerContext || !customerContext.userId) return null
    try {
      const ids = await this.allocationService.getShopIdsForUser(
        customerContext.userId
      )
      if (Array.isArray(ids) && ids.length === 0) {
        logger.debug(
          { customerId: customerContext.userId, action: 'categories.allocation_empty' },
          'Customer has no allocated shops — returning no storefront products'
        )
        return []
      }
      return Array.isArray(ids) ? ids : null
    } catch (err) {
      logger.error(
        {
          customerId: customerContext.userId,
          err: err.message,
          action: 'categories.resolve_allocations',
        },
        'Failed to resolve customer allocations; returning no storefront products'
      )
      return []
    }
  }

  /**
   * Get all categories — cached for 30 min
   */
  async listAll() {
    const cached = await cacheGet(`${CACHE_KEY_ALL}:${CACHE_VERSION}`)
    if (cached) return cached

    const categories = this._normalizeCategories(await this.repo.findAll())
    await cacheSet(`${CACHE_KEY_ALL}:${CACHE_VERSION}`, categories, CACHE_TTL)
    return categories
  }

  /**
   * Get all categories for the admin dashboard — includes inactive (but
   * not deleted) categories, unlike listAll() which is customer-facing.
   * Separate cache key/entry so the public and admin views never collide,
   * but same `categories:` prefix so cacheDeletePattern('categories:*')
   * still sweeps it on every create/update/delete/membership change.
   */
  async listAllAdmin() {
    const cacheKey = `categories:all:admin:${CACHE_VERSION}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const categories = this._normalizeCategories(await this.repo.findAllAdmin())
    await cacheSet(cacheKey, categories, CACHE_TTL)
    return categories
  }

  /**
   * Get single category by ID
   */
  async getById(id) {
    const cacheKey = `categories:${CACHE_VERSION}:${id}`
    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const category = this._normalizeCategory(await this.repo.findById(id))
    if (category) {
      await cacheSet(cacheKey, category, CACHE_TTL)
    }
    return category
  }

  /**
   * Get products in a category (paginated).
   *
   * @param {string} categoryId
   * @param {object} filters - page/limit/sort/inStock/groupOptions
   * @param {{ userId?: string }|null} [customerContext] - When present the
   *   product list is scoped to the customer's allocated shops.
   */
  async getProducts(categoryId, filters, customerContext = null, priceMode = 'retail') {
    // Verify category exists
    const category = this._normalizeCategory(await this.repo.findById(categoryId))
    if (!category) return null

    const { offset, limit } = getOffsetLimit(filters)

    const allocatedShopIds = await this._resolveAllocatedShopIds(customerContext)
    // Customer with zero allocations sees an empty (but valid) page.
    if (Array.isArray(allocatedShopIds) && allocatedShopIds.length === 0) {
      return {
        data: [],
        pagination: buildPagination({
          page: filters.page || 1,
          limit,
          total: 0,
        }),
      }
    }

    const result = await this.repo.findProducts(categoryId, {
      limit,
      offset,
      sort: filters.sort,
      inStock: filters.inStock,
      groupOptions: filters.groupOptions === true || filters.groupOptions === 'true',
      allocatedShopIds,
      priceMode,
      categoryType: category.category_type,
    })

    return {
      data: this._normalizeProducts(result.data),
      pagination: buildPagination({
        page: filters.page || 1,
        limit,
        total: result.total,
      }),
    }
  }

  /**
   * Create a new category [ADMIN]
   */
  async create(data) {
    const slug = simpleSlug(data.name)

    // Check slug uniqueness
    const existing = await this.repo.findBySlug(slug)
    if (existing) {
      return { success: false, message: 'A category with this name already exists' }
    }

    if (data.parent_id) {
      const depthError = await this._checkParentDepth(data.parent_id)
      if (depthError) return depthError
    }

    const category = await this.repo.create({ ...data, slug })

    // Invalidate cache
    await cacheDeletePattern('categories:*')
    logger.info({ categoryId: category.id }, 'Category created')

    return { success: true, category: this._normalizeCategory(category) }
  }

  /**
   * Update a category [ADMIN]
   */
  async update(id, data) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Category not found' }

    // If name changed, regenerate slug
    if (data.name && data.name !== existing.name) {
      data.slug = simpleSlug(data.name)
      const slugExists = await this.repo.findBySlug(data.slug)
      if (slugExists && slugExists.id !== id) {
        return { success: false, message: 'A category with this name already exists' }
      }
    }

    if (data.parent_id && data.parent_id !== existing.parent_id) {
      if (data.parent_id === id) {
        return { success: false, message: 'A category cannot be its own parent' }
      }
      const depthError = await this._checkParentDepth(data.parent_id)
      if (depthError) return depthError
      // The category being edited may itself have children (it's a
      // top-level category) — re-parenting it under another category
      // would make it a subcategory while still having its own
      // children, producing the same 3-level nesting we're preventing.
      const children = await this.repo.findChildren(id)
      if (children.length > 0) {
        return {
          success: false,
          message: 'This category has its own subcategories — move or delete them first',
        }
      }
    }

    const category = await this.repo.update(id, data)

    await cacheDeletePattern('categories:*')
    logger.info({ categoryId: id }, 'Category updated')

    return { success: true, category: this._normalizeCategory(category) }
  }

  /**
   * Categories are limited to two levels: a top-level category and its
   * direct subcategories. Returns an error object if `parentId` is
   * itself a subcategory (i.e. already has a parent), otherwise null.
   */
  async _checkParentDepth(parentId) {
    const parent = await this.repo.findById(parentId)
    if (!parent) return { success: false, message: 'Parent category not found' }
    if (parent.parent_id) {
      return {
        success: false,
        message: 'Subcategories cannot have their own subcategories — choose a top-level category as the parent',
      }
    }
    return null
  }

  /**
   * Delete (deactivate) a category [ADMIN]
   */
  async delete(id) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'Category not found' }

    const children = await this.repo.findChildren(id)
    if (children.length > 0) {
      return {
        success: false,
        message: 'Delete or move this category\'s subcategories first',
      }
    }

    await this.repo.delete(id)

    await cacheDeletePattern('categories:*')
    logger.info({ categoryId: id }, 'Category deleted')

    return { success: true }
  }

  /**
   * List all BUNDLE-type categories [ADMIN] — powers the dashboard's
   * "Bundles" tab.
   */
  async listBundles(productId = null) {
    return this._normalizeCategories(await this.repo.findBundles(productId))
  }

  /**
   * Every category a product could be cross-listed into (its own primary
   * category excluded), each flagged `is_member` [ADMIN] — powers the
   * product edit form's "also show in other categories" multi-select. This
   * is the multi-category feature: a product keeps its one real category
   * (set on the product itself) and can additionally appear under any
   * number of other categories or bundles via category_products, without
   * duplicating the product.
   */
  async listCategoriesForProduct(productId) {
    const [product] = await this.repo.findProductsByIds([productId])
    if (!product) return { success: false, message: 'Product not found' }
    const categories = await this.repo.findCategoriesForProduct(productId)
    return { success: true, categories: this._normalizeCategories(categories) }
  }

  /**
   * Add/remove a single product from a category [ADMIN] — used by the
   * product edit form's "also show in other categories" toggle. Works for
   * both STANDARD categories (multi-category cross-listing) and BUNDLE
   * categories; the product's real category_id is never touched.
   */
  async toggleCategoryMembership(categoryId, productId, isMember) {
    const category = await this.repo.findById(categoryId)
    if (!category) return { success: false, message: 'Category not found' }

    const [product] = await this.repo.findProductsByIds([productId])
    if (!product || !product.is_active) {
      return { success: false, message: 'Product not found' }
    }

    await this.repo.toggleCategoryMembership(categoryId, productId, isMember)
    await cacheDeletePattern('categories:*')
    await this._invalidateHomeSectionCaches()

    return { success: true }
  }

  /**
   * Get a category's current product ranking [ADMIN] — powers the
   * dashboard's product-ranking panel before the admin drags to reorder.
   */
  async getCategoryProductRanks(categoryId) {
    const category = await this.repo.findById(categoryId)
    if (!category) return { success: false, message: 'Category not found' }
    const ranks = await this.repo.getCategoryProductRanks(categoryId)
    return { success: true, products: this._normalizeProducts(ranks) }
  }

  /**
   * Set a category's product membership/order [ADMIN].
   *
   * Sending the full ordered id list both defines membership (a bundle's
   * member products, or a standard category's cross-listed extras) and
   * "replaces"/"shuffles" the ranking in one call — the array index
   * becomes each product's rank.
   *
   * Any active product may be added regardless of category type or the
   * product's own real category_id — that's the whole point of the
   * multi-category feature (e.g. Baby Potato keeps its real category
   * "Fresh Vegetables" and can also be ranked into "Exotic Vegetables"
   * here). Products that don't exist or are inactive are silently dropped
   * rather than erroring, so a stale id in an in-flight admin edit can't
   * 500 the whole reorder.
   */
  async setCategoryProducts(categoryId, productIds) {
    const category = await this.repo.findById(categoryId)
    if (!category) return { success: false, message: 'Category not found' }

    const ids = Array.isArray(productIds) ? [...new Set(productIds)] : []
    const found = await this.repo.findProductsByIds(ids)
    const foundById = new Map(found.map((p) => [p.id, p]))

    const validIds = ids.filter((id) => {
      const product = foundById.get(id)
      return !!product && product.is_active
    })

    const ranks = await this.repo.setCategoryProducts(categoryId, validIds)

    await cacheDeletePattern('categories:*')
    await this._invalidateHomeSectionCaches()
    logger.info(
      { categoryId, categoryType: category.category_type, productCount: validIds.length },
      'Category product ranking updated'
    )

    return { success: true, products: this._normalizeProducts(ranks) }
  }

  /**
   * Category-membership edits change what a category-bound home
   * section/widget should show, but the theme module caches its resolved
   * output separately (bakaloo:sections:*, bakaloo:tab_home:*,
   * bakaloo:tab_manifest:* — see sections.service.js#invalidateSectionCaches)
   * with its own 5-minute TTL. Without this, a cross-listing/ranking change
   * here wouldn't reach home sections until that TTL expired.
   */
  async _invalidateHomeSectionCaches() {
    await cacheDeletePattern('bakaloo:sections:*')
    await cacheDeletePattern('bakaloo:tab_home:*')
    await cacheDeletePattern('bakaloo:tab_manifest:*')
  }

  _normalizeCategories(categories = []) {
    return categories.map((category) => this._normalizeCategory(category))
  }

  _normalizeCategory(category) {
    if (!category) return category

    return {
      ...category,
      image_url: normalizeMediaDeliveryUrl(category.image_url, 'w320'),
    }
  }

  _normalizeProducts(products = []) {
    return products.map((product) => ({
      ...product,
      thumbnail_url: normalizeMediaDeliveryUrl(product.thumbnail_url, 'w640'),
    }))
  }
}
