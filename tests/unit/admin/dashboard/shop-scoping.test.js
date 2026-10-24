import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../src/config/database.js', () => ({
  query: vi.fn(),
}))

vi.mock('../../../../src/config/redis.js', () => ({
  redis: {},
}))

import { DashboardRepository } from '../../../../src/modules/admin/dashboard/dashboard.repository.js'
import { query } from '../../../../src/config/database.js'

const SHOP_ID = '11111111-1111-1111-1111-111111111111'

function mockAllQueries(row = {}) {
  query.mockResolvedValue({ rows: [row] })
}

describe('DashboardRepository — shop scoping (R17)', () => {
  let repo

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new DashboardRepository()
  })

  it('getKpis scopes totalShops/activeShops to "this shop only" instead of the platform count', async () => {
    mockAllQueries({
      total_revenue: 0, total_orders: 0, avg_order_value: 0, pending_orders: 0, total_customers: 0,
      total_riders: 0, online_riders: 0,
      total_shops: 1, active_shops: 1,
      revenue: 0, orders: 0, cod_to_collect: 0, delivered: 0,
    })

    const kpis = await repo.getKpis(SHOP_ID)

    const shopCall = query.mock.calls.find(([sql]) => sql.includes('FROM shops'))
    expect(shopCall[0]).toContain('WHERE id = $1')
    expect(shopCall[1]).toEqual([SHOP_ID])
    expect(kpis.totalShops).toBe(1)
  })

  it('getKpis queries the platform-wide shop count when unscoped (shopId=null)', async () => {
    mockAllQueries({
      total_revenue: 0, total_orders: 0, avg_order_value: 0, pending_orders: 0, total_customers: 0,
      total_riders: 0, online_riders: 0,
      total_shops: 42, active_shops: 40,
      revenue: 0, orders: 0, cod_to_collect: 0, delivered: 0,
    })

    const kpis = await repo.getKpis(null)

    const shopCall = query.mock.calls.find(([sql]) => sql.includes('FROM shops'))
    expect(shopCall[0]).not.toContain('WHERE id')
    expect(kpis.totalShops).toBe(42)
  })

  it('getKpis maps every field the dashboard HQDashboardKPI type expects', async () => {
    mockAllQueries({ total_riders: 8, online_riders: 3, total_shops: 1, active_shops: 1 })
    // Order money comes from OverviewService (covered by the real-DB suite); stub it so this only asserts the mapping.
    vi.spyOn(repo.overview, 'allTime').mockResolvedValue({ netRevenue: 1000.5, orders: { net: 10 }, buyers: 5, avgOrderValue: 100.05 })
    vi.spyOn(repo, 'getStats').mockResolvedValue({
      revenue: { current: 200, previous: 100, change_pct: 100, sparkline: [] },
      orders: { current: 2, previous: 1, change_pct: 100, sparkline: [], new_orders: 2 },
      products: {}, customers: {}, riders: {}, today: {},
    })

    const kpis = await repo.getKpis(SHOP_ID)

    expect(kpis).toEqual(
      expect.objectContaining({
        totalRevenue: 1000.5,
        totalOrders: 10,
        totalCustomers: 5,
        totalShops: 1,
        activeShops: 1,
        totalRiders: 8,
        onlineRiders: 3,
        avgOrderValue: 100.05,
        pendingOrders: 2,
        todayRevenue: 200,
        todayOrders: 2,
        revenueChange: 100,
        ordersChange: 100,
      })
    )
  })

  it('_todayStats hands the shop filter to the overview (null = whole platform)', async () => {
    const today = vi.spyOn(repo.overview, 'today').mockResolvedValue({ revenue: 0, orders: 0, cod_to_collect: 0, delivered: 0 })
    await repo._todayStats(null)
    await repo._todayStats(SHOP_ID)
    expect(today.mock.calls).toEqual([[null], [SHOP_ID]])
  })

  it('_productStats reads shop_products (not the global products catalog) when scoped', async () => {
    mockAllQueries({ total: 0, active: 0, out_of_stock: 0, low_stock: 0 })
    await repo._productStats(null, null, null, SHOP_ID)
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('FROM shop_products')
    expect(sql).not.toContain('FROM products')
    expect(params).toEqual([SHOP_ID])
  })

  it('_productStats reads the global products catalog when unscoped', async () => {
    mockAllQueries({ total: 0, active: 0, out_of_stock: 0, low_stock: 0 })
    await repo._productStats(null, null, null, null)
    const [sql] = query.mock.calls[0]
    expect(sql).toContain('FROM products')
    expect(sql).not.toContain('FROM shop_products')
  })

  it('getLowStockAlerts reads shop_products (per-shop stock) when scoped', async () => {
    query.mockResolvedValue({ rows: [] })
    await repo.getLowStockAlerts(10, SHOP_ID)
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('FROM shop_products sp')
    expect(params).toEqual([SHOP_ID, 10])
  })

  it('getPendingActions scopes pending/confirmed orders and low-stock products to the shop', async () => {
    mockAllQueries({ pending_orders: 0, confirmed_orders: 0, pending_riders: 0, low_stock_products: 0, pending_payouts: 0 })
    await repo.getPendingActions(SHOP_ID)
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain("status = 'PENDING' AND shop_id = $1")
    expect(sql).toContain('FROM shop_products WHERE shop_id = $1')
    expect(params).toEqual([SHOP_ID])
  })
})
