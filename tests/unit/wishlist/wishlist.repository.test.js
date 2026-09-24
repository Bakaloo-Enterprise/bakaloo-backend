// Feature: multi-vendor-system, task 13.2
// Validates: Requirements 3.4, 11.6 (supporting query for wishlist fan-out)
//
// Unit tests for WishlistRepository.findUsersByWishlistedProduct — the
// paginated lookup used by the stock-notifications worker. Drives the
// repository against a stubbed `query` so we can assert exact SQL
// parameter binding and cursor behaviour without touching Postgres.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

import { query } from '../../../src/config/database.js'
import { WishlistRepository } from '../../../src/modules/wishlist/wishlist.repository.js'

const PRODUCT_ID = '11111111-1111-1111-1111-111111111111'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('WishlistRepository.findUsersByWishlistedProduct', () => {
  it('queries with parameterized product_id and default limit when no cursor', async () => {
    query.mockResolvedValueOnce({
      rows: [{ user_id: 'u1' }, { user_id: 'u2' }],
    })

    const repo = new WishlistRepository()
    const rows = await repo.findUsersByWishlistedProduct(PRODUCT_ID)

    expect(rows).toEqual([{ user_id: 'u1' }, { user_id: 'u2' }])
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0]
    // Parameterized: product_id = $1, limit = $2
    expect(sql).toContain('WHERE w.product_id = $1')
    expect(sql).toContain('ORDER BY w.user_id ASC')
    expect(sql).toContain('LIMIT $2')
    expect(params).toEqual([PRODUCT_ID, 200]) // default batch size 200
  })

  it('appends keyset cursor when afterUserId is provided', async () => {
    query.mockResolvedValueOnce({ rows: [] })

    const repo = new WishlistRepository()
    await repo.findUsersByWishlistedProduct(PRODUCT_ID, {
      afterUserId: 'u-cursor',
      limit: 50,
    })

    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('w.user_id > $2')
    expect(sql).toContain('LIMIT $3')
    expect(params).toEqual([PRODUCT_ID, 'u-cursor', 50])
  })

  it('clamps limit to [1, 1000]', async () => {
    query.mockResolvedValue({ rows: [] })
    const repo = new WishlistRepository()

    await repo.findUsersByWishlistedProduct(PRODUCT_ID, { limit: 0 })
    expect(query.mock.calls[0][1]).toEqual([PRODUCT_ID, 1])

    await repo.findUsersByWishlistedProduct(PRODUCT_ID, { limit: 99999 })
    expect(query.mock.calls[1][1]).toEqual([PRODUCT_ID, 1000])

    await repo.findUsersByWishlistedProduct(PRODUCT_ID, { limit: -5 })
    expect(query.mock.calls[2][1]).toEqual([PRODUCT_ID, 1])
  })

  it('falls back to default limit when limit is not a number', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const repo = new WishlistRepository()

    await repo.findUsersByWishlistedProduct(PRODUCT_ID, { limit: 'abc' })

    expect(query.mock.calls[0][1]).toEqual([PRODUCT_ID, 200])
  })

  it('returns an empty array when no rows match', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const repo = new WishlistRepository()

    const rows = await repo.findUsersByWishlistedProduct(PRODUCT_ID)

    expect(rows).toEqual([])
  })
})

describe('WishlistRepository.getWishlist — shop-scoped price/stock (regression for master-catalog fallback bug)', () => {
  const USER_ID = 'u-1'
  const SHOP_ID = 'shop-1'

  it('with no allocatedShopIds (legacy/anonymous), falls back to master catalog price/stock (negative)', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: 'w-1', product_id: PRODUCT_ID, created_at: '2026-01-01',
        name: 'Milk', slug: 'milk', description: null,
        price: 50, sale_price: null, category_id: 'c-1',
        stock_quantity: 20, unit: '1L', net_quantity: null,
        option_label: null, thumbnail_url: null, images: [], tags: [],
        is_active: true, is_featured: false, total_sold: 0, max_order_qty: 10,
        ingredients: null, allergen_info: null, shelf_life: null,
        storage_instructions: null, certifications: null, nutrition_info: null,
        product_created_at: '2026-01-01', shop_product_id: null, shop_id: null,
        category_name: 'Dairy',
      }],
    })
    const repo = new WishlistRepository()
    const result = await repo.getWishlist(USER_ID)

    const [sql] = query.mock.calls[0]
    expect(sql).toContain('p.price')
    expect(sql).not.toContain('LEFT JOIN LATERAL')
    expect(result.items[0].price).toBe(50)
    expect(result.items[0].stock_quantity).toBe(20)
    expect(result.items[0].is_available_at_shop).toBeNull()
  })

  it('with allocatedShopIds, resolves price/stock from shop_products via the shared shop-price join (positive)', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: 'w-1', product_id: PRODUCT_ID, created_at: '2026-01-01',
        name: 'Milk', slug: 'milk', description: null,
        price: 45, sale_price: null, category_id: 'c-1',
        stock_quantity: 0, unit: '1L', net_quantity: null,
        option_label: null, thumbnail_url: null, images: [], tags: [],
        is_active: true, is_featured: false, total_sold: 0, max_order_qty: 10,
        ingredients: null, allergen_info: null, shelf_life: null,
        storage_instructions: null, certifications: null, nutrition_info: null,
        product_created_at: '2026-01-01', shop_product_id: 'sp-1', shop_id: SHOP_ID,
        category_name: 'Dairy',
      }],
    })
    const repo = new WishlistRepository()
    const result = await repo.getWishlist(USER_ID, [SHOP_ID])

    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('LEFT JOIN LATERAL')
    expect(sql).toContain('shop_price.sp_price')
    expect(sql).toContain('shop_price.sp_stock_quantity')
    expect(params).toEqual([USER_ID, [SHOP_ID]])
    expect(result.items[0].price).toBe(45)
    expect(result.items[0].stock_quantity).toBe(0)
    expect(result.items[0].shop_product_id).toBe('sp-1')
    expect(result.items[0].is_available_at_shop).toBe(true)
  })

  it('with allocatedShopIds but no matching shop_products row, price/stock come back null and is_available_at_shop is false (negative)', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: 'w-1', product_id: PRODUCT_ID, created_at: '2026-01-01',
        name: 'Milk', slug: 'milk', description: null,
        price: null, sale_price: null, category_id: 'c-1',
        stock_quantity: null, unit: '1L', net_quantity: null,
        option_label: null, thumbnail_url: null, images: [], tags: [],
        is_active: true, is_featured: false, total_sold: 0, max_order_qty: 10,
        ingredients: null, allergen_info: null, shelf_life: null,
        storage_instructions: null, certifications: null, nutrition_info: null,
        product_created_at: '2026-01-01', shop_product_id: null, shop_id: null,
        category_name: 'Dairy',
      }],
    })
    const repo = new WishlistRepository()
    const result = await repo.getWishlist(USER_ID, [SHOP_ID])

    expect(result.items[0].price).toBeNull()
    expect(result.items[0].stock_quantity).toBeNull()
    expect(result.items[0].is_available_at_shop).toBe(false)
  })
})
