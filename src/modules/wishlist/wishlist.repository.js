import { query, getClient } from '../../config/database.js'
import { CartService } from '../cart/cart.service.js'
import { CartRepository } from '../cart/cart.repository.js'
import { buildShopPriceJoin } from '../products/products.repository.js'

/**
 * Wishlist repository — database access for wishlist
 */
export class WishlistRepository {
  /**
   * @param {string} userId
   * @param {string[]|null} [allocatedShopIds] - Customer shop scoping, same
   *   contract as ProductsRepository — when set, price/sale_price/
   *   stock_quantity/is_available come from the customer's own shop
   *   listing (shop_products), never the master catalog, mirroring every
   *   other customer-facing product surface (search/detail/home/category).
   *   A wishlisted product not currently carried by any allocated shop
   *   simply resolves to null price/0 stock (LEFT JOIN LATERAL) rather
   *   than disappearing — the customer still sees it, just correctly
   *   marked unavailable instead of showing a stale master-catalog price.
   *   `null` (no customer context) preserves the legacy master-catalog
   *   fallback.
   */
  async getWishlist(userId, allocatedShopIds = null) {
    const params = [userId]
    const shopPrice = buildShopPriceJoin(allocatedShopIds, params, params.length + 1)

    const { rows } = await query(
      `SELECT w.id, w.product_id, w.created_at,
              p.name, p.slug, p.description,
              ${shopPrice.priceExpr} AS price, ${shopPrice.salePriceExpr} AS sale_price,
              p.category_id, ${shopPrice.stockExpr} AS stock_quantity, p.unit, p.net_quantity,
              p.option_label, p.thumbnail_url,
              p.images, p.tags, p.is_active, p.is_featured, p.total_sold,
              p.max_order_qty, p.ingredients, p.allergen_info, p.shelf_life,
              p.storage_instructions, p.certifications, p.nutrition_info,
              p.created_at AS product_created_at,
              ${shopPrice.shopProductIdExpr} AS shop_product_id,
              ${shopPrice.shopIdExpr} AS shop_id,
              c.name AS category_name
       FROM wishlist w
       JOIN products p ON w.product_id = p.id
       LEFT JOIN categories c ON c.id = p.category_id
       ${shopPrice.joinSql}
       WHERE w.user_id = $1
       ORDER BY w.created_at DESC`,
      params
    )

    return {
      items: rows.map(row => ({
        id: row.product_id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        price: row.price,
        sale_price: row.sale_price,
        category_id: row.category_id,
        category_name: row.category_name,
        stock_quantity: row.stock_quantity,
        // Shop-scoped callers (allocatedShopIds set) only ever have a valid
        // price/stock when a matching shop_products row was found — no
        // match means "not carried by any of this customer's shops right
        // now", same as everywhere else in the app.
        is_available_at_shop: Array.isArray(allocatedShopIds)
          ? row.shop_product_id != null
          : null,
        unit: row.unit,
        net_quantity: row.net_quantity,
        option_label: row.option_label,
        thumbnail_url: row.thumbnail_url || row.images?.[0] || null,
        images: row.images || [],
        tags: row.tags || [],
        is_featured: row.is_featured,
        total_sold: row.total_sold || 0,
        max_order_qty: row.max_order_qty,
        ingredients: row.ingredients,
        allergen_info: row.allergen_info,
        shelf_life: row.shelf_life,
        storage_instructions: row.storage_instructions,
        certifications: row.certifications,
        nutrition_info: row.nutrition_info,
        is_active: row.is_active,
        shop_product_id: row.shop_product_id,
        shop_id: row.shop_id,
        created_at: row.product_created_at,
        wishlist_entry_id: row.id,
        wishlist_added_at: row.created_at,
      })),
      total: rows.length,
    }
  }

  async getProduct(productId) {
    const { rows } = await query(
      'SELECT id, is_active FROM products WHERE id = $1',
      [productId]
    )
    return rows[0] ? { ...rows[0], is_available: rows[0].is_active } : null
  }

  async checkWishlistItem(userId, productId) {
    const { rows } = await query(
      'SELECT id FROM wishlist WHERE user_id = $1 AND product_id = $2',
      [userId, productId]
    )
    return rows.length > 0
  }

  async addItem(userId, productId) {
    const { rows } = await query(
      'INSERT INTO wishlist (user_id, product_id) VALUES ($1, $2) RETURNING id, product_id, created_at',
      [userId, productId]
    )
    return rows[0]
  }

  async removeItem(userId, productId) {
    await query(
      'DELETE FROM wishlist WHERE user_id = $1 AND product_id = $2',
      [userId, productId]
    )
  }

  async clearWishlist(userId) {
    await query('DELETE FROM wishlist WHERE user_id = $1', [userId])
  }

  /**
   * Page through users who have wishlisted a specific product. Used by the
   * stock-notifications BullMQ worker (task 13.2) to fan out restock push
   * notifications to interested customers (Requirements 3.4, 11.6).
   *
   * Keyset cursor on `user_id` keeps memory bounded on the 2-core/4GB
   * target box and avoids OFFSET scans on large wishlists. The caller
   * drives the loop until fewer than `limit` rows come back.
   *
   * Index note: the unique index `idx_wishlist_user_product (user_id,
   * product_id)` covers the (user_id) ordering; Postgres falls back to a
   * bitmap/sequential scan for the product_id predicate. Acceptable for
   * the restock-notification path which fires only on stock 0→positive
   * transitions (low frequency, small per-product wishlist sizes).
   *
   * @param {string} productId
   * @param {object} [opts]
   * @param {string|null} [opts.afterUserId] - Keyset cursor; pass the
   *   `user_id` of the last row from the previous batch (or null/undefined
   *   to start from the beginning).
   * @param {number} [opts.limit=200] - Page size; clamped to [1, 1000].
   * @returns {Promise<Array<{user_id: string}>>}
   */
  async findUsersByWishlistedProduct(productId, { afterUserId, limit } = {}) {
    // Resolve limit: invalid (NaN / non-numeric) → default 200, otherwise
    // clamp into [1, 1000] so callers can't accidentally request 0 /
    // negative / huge pages.
    const rawLimit = Number(limit)
    const resolvedLimit = Number.isFinite(rawLimit) ? rawLimit : 200
    const safeLimit = Math.max(1, Math.min(1000, resolvedLimit))
    const params = [productId]
    let where = 'WHERE w.product_id = $1'

    if (afterUserId) {
      params.push(afterUserId)
      where += ` AND w.user_id > $${params.length}`
    }

    params.push(safeLimit)
    const { rows } = await query(
      `SELECT w.user_id
       FROM wishlist w
       ${where}
       ORDER BY w.user_id ASC
       LIMIT $${params.length}`,
      params
    )

    return rows
  }

  /**
   * Move all wishlist items to the Redis-backed cart via CartService.
   *
   * The old implementation queried a `cart_items` SQL table that does not
   * exist — the cart lives entirely in Redis (CartRepository / CartService).
   * This version calls CartService.addItem() for each in-stock wishlist
   * product, which handles allocation-scoped shop resolution, stock checks,
   * and Redis persistence correctly.
   *
   * @param {string} userId
   * @param {Array<{id: string, is_active: boolean, stock_quantity: number}>} items
   * @returns {Promise<number>} number of items successfully added
   */
  async moveToCart(userId, items) {
    const cartService = new CartService(new CartRepository())
    let movedCount = 0

    for (const item of items) {
      if (!item.is_active || Number(item.stock_quantity) <= 0) {
        continue
      }
      try {
        const result = await cartService.addItem(userId, {
          productId: item.id,
          quantity: 1,
        })
        if (result.success) {
          movedCount++
        }
      } catch {
        // Skip items that fail (e.g. shop not available for this user).
        // Other items should still be processed.
      }
    }

    return movedCount
  }
}
