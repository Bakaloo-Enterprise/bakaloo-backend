import { logger } from '../../config/logger.js'
import { AllocationService } from '../allocation/allocation.service.js'
import { AllocationRepository } from '../allocation/allocation.repository.js'

/**
 * Wishlist service — business logic for wishlist
 */
export class WishlistService {
  constructor(repository, deps = {}) {
    this.repository = repository
    this.allocationService =
      deps.allocationService || new AllocationService(new AllocationRepository())
  }

  /**
   * Resolve the customer's allocated shop_ids so the wishlist can show
   * the same shop-scoped price/stock as every other customer-facing
   * surface (search/detail/home/category) — mirrors
   * ProductsService#_resolveAllocatedShopIds exactly, including the
   * fail-closed behavior on an allocation-service error.
   */
  async _resolveAllocatedShopIds(userId) {
    try {
      const ids = await this.allocationService.getShopIdsForUser(userId)
      return Array.isArray(ids) ? ids : []
    } catch (err) {
      logger.error(
        { userId, err: err.message, action: 'wishlist.resolve_allocations' },
        'Failed to resolve customer allocations for wishlist; showing no shop pricing'
      )
      return []
    }
  }

  async getWishlist(userId) {
    const allocatedShopIds = await this._resolveAllocatedShopIds(userId)
    return await this.repository.getWishlist(userId, allocatedShopIds)
  }

  async addItem(userId, productId) {
    // Check if product exists and is available
    const product = await this.repository.getProduct(productId)
    if (!product) {
      throw new Error('Product not found')
    }
    if (!product.is_available) {
      throw new Error('Product is not available')
    }

    // Check if already in wishlist
    const exists = await this.repository.checkWishlistItem(userId, productId)
    if (exists) {
      throw new Error('Product already in wishlist')
    }

    return await this.repository.addItem(userId, productId)
  }

  async removeItem(userId, productId) {
    return await this.repository.removeItem(userId, productId)
  }

  async clearWishlist(userId) {
    return await this.repository.clearWishlist(userId)
  }

  async moveToCart(userId) {
    // Same shop-scoped stock/availability getWishlist() now uses — without
    // this, moveToCart's `stock_quantity <= 0` skip-check below would
    // still be evaluating the master catalog's stock, not the shop's.
    const allocatedShopIds = await this._resolveAllocatedShopIds(userId)
    const wishlistItems = await this.repository.getWishlist(userId, allocatedShopIds)

    if (wishlistItems.items.length === 0) {
      return { movedCount: 0 }
    }

    const movedCount = await this.repository.moveToCart(userId, wishlistItems.items)
    await this.repository.clearWishlist(userId)

    return { movedCount }
  }
}
