/**
 * Analytics page (admin analytics) on the shared sales rules. Real Postgres, opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/analytics-sales.db.test.js
 * One hand-worked day (2026-03-10, India time) plus the day before. Every expected number is worked out in the comments.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const at = (hhmm, day = '2026-03-10') => `${day} ${hhmm}:00+05:30`
const PH = (n) => `9999027${String(n).padStart(3, '0')}`
const DAY = 86_400_000

describe.skipIf(!enabled)('Analytics uses the sales rules', () => {
  let query, closePool, repo, A, B, c1, c2, biz, rider, rice, oil, dusty
  let n = 0

  async function order({ shop = A, user = c1, status, total, created, pay = 'PAID', method = 'ONLINE', gstin = null, items = [], history = [], coupon = null, discount = 0, fee = 0, tax = 0, tip = 0, handling = 0, city = null }) {
    const id = (await query(
      `INSERT INTO orders (order_number,user_id,shop_id,status,items,subtotal,total_amount,delivery_address,payment_method,payment_status,created_at,buyer_gstin,b2b_approval_status,coupon_code,discount_amount,delivery_fee,tax_amount,tip_amount,handling_fee)
       VALUES ($1,$2,$3,$4::order_status,'[]'::jsonb,$5,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [`T27-${++n}`, user, shop, status, total, JSON.stringify(city ? { city } : {}), method, pay, created, gstin, gstin ? 'APPROVED' : null, coupon, discount, fee, tax, tip, handling])).rows[0].id
    for (const [pid, q, price] of items) await query(`INSERT INTO order_items (order_id,product_id,name,price,quantity,unit,total,shop_id) VALUES ($1,$2,'x',$3,$4,'1 unit',$5,$6)`, [id, pid, price, q, q * price, shop])
    for (const [from, to, time] of history) await query(`INSERT INTO order_status_history (order_id, from_status, to_status, changed_at) VALUES ($1,$2,$3,$4)`, [id, from, to, time])
    return id
  }
  const refundReq = (id, user, amount, when) => query(`INSERT INTO refund_requests (order_id, user_id, description, status, refund_amount, refund_to, processed_at) VALUES ($1,$2,'t','APPROVED',$3,'wallet',$4)`, [id, user, amount, when])
  const delivered = (orderId, time, minutes) => query(`INSERT INTO delivery_assignments (order_id, rider_id, status, delivered_at, delivery_time_minutes, distance_km, tip_amount) VALUES ($1,$2,'DELIVERED',$3,$4,2.5,0)`, [orderId, rider, time, minutes])

  async function cleanup() {
    await query(`DELETE FROM delivery_assignments WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'T27-%')`)
    await query(`DELETE FROM refund_requests WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'T27-%')`)
    await query(`DELETE FROM orders WHERE order_number LIKE 'T27-%'`)
    await query(`DELETE FROM shop_products WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't27-shop-%')`)
    await query(`DELETE FROM products WHERE slug LIKE 't27-%'`)
    await query(`DELETE FROM shops WHERE slug LIKE 't27-shop-%'`)
    await query(`DELETE FROM users WHERE phone LIKE '9999027%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { AdminAnalyticsRepository } = await import('../../src/modules/admin/analytics/analytics.repository.js')
    await cleanup()
    repo = new AdminAnalyticsRepository()
    const mkUser = async (i, name, created, role = 'CUSTOMER') => (await query(`INSERT INTO users (phone,name,email,role,created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [PH(i), name, `${PH(i)}@t.local`, role, created])).rows[0].id
    c1 = await mkUser(1, 'T27 Asha', at('10:00', '2026-02-15')); c2 = await mkUser(2, 'T27 Bikram', at('10:00', '2026-03-01')); biz = await mkUser(3, 'T27 Hotel', at('10:00', '2026-03-02')); rider = await mkUser(4, 'T27 Rider', at('10:00', '2026-01-01'), 'RIDER')
    const mkShop = async (c) => (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ($1,$2,$3,'DB 27','Kolkata','WB','700091',22.5,88.3,true) RETURNING id`, [`T27 Shop ${c}`, `t27-shop-${c}`, `T27${c}`])).rows[0].id
    A = await mkShop('A'); B = await mkShop('B')
    const mkP = async (name, slug) => (await query(`INSERT INTO products (name, slug, price, net_quantity) VALUES ($1,$2,50,'1 unit') RETURNING id`, [name, slug])).rows[0].id
    rice = await mkP('T27 Rice', 't27-rice'); oil = await mkP('T27 Oil', 't27-oil'); dusty = await mkP('T27 Dusty Tin', 't27-dusty')

    // ── the day before (03-09) ──
    await order({ status: 'DELIVERED', total: 60, created: at('11:00', '2026-03-09') })                                                         // y1  (c1)
    const y2 = await order({ user: c2, status: 'REFUNDED', total: 120, created: at('12:00', '2026-03-09'), history: [['DELIVERED', 'REFUNDED', at('09:00')]] })
    await refundReq(y2, c2, 120, at('09:00'))                                                                                                    // y2 refunded in full on 03-10
    await order({ status: 'DELIVERED', total: 30, created: at('23:50', '2026-03-09') })                                                         // y3  23:50 IST = still 03-09
    // ── 2026-03-10 ──
    const o1 = await order({ status: 'DELIVERED', total: 100, created: at('10:00'), items: [[rice, 2, 50]], coupon: 'T27CODE', discount: 10, fee: 25, tax: 5, tip: 5, city: 'Kolkata' })
    const o2 = await order({ user: c2, status: 'REFUNDED', total: 200, created: at('10:30'), items: [[oil, 1, 200]], handling: 3, tax: 10, city: 'Kolkata', history: [['DELIVERED', 'REFUNDED', at('13:00')]] })
    await refundReq(o2, c2, 50, at('13:00'))                                                                                                      // part refund 50
    await order({ status: 'REFUNDED', total: 300, created: at('11:00'), items: [[rice, 3, 100]], coupon: 'T27CODE', discount: 30, tax: 30, tip: 20, history: [['DELIVERED', 'REFUNDED', at('14:00')]] }) // o3 refunded in full, no amount recorded
    await order({ user: c2, status: 'CANCELLED', total: 150, created: at('12:00'), coupon: 'T27CODE', discount: 15, history: [[null, 'CONFIRMED', at('12:01')], ['CONFIRMED', 'CANCELLED', at('12:30')]] }) // o4
    await order({ status: 'REFUNDED', total: 400, created: at('12:10'), history: [[null, 'CONFIRMED', at('12:11')], ['CONFIRMED', 'CANCELLED', at('12:40')], ['CANCELLED', 'REFUNDED', at('15:00')]] }) // o5 cancelled THEN refunded
    await order({ user: c2, status: 'PENDING', total: 250, created: at('13:00'), pay: 'PENDING' })                                              // o6 unpaid
    await order({ user: biz, status: 'DELIVERED', total: 500, created: at('18:15'), pay: 'PENDING', method: 'B2B_CREDIT', gstin: '19ABCDE1234F1Z5', items: [[rice, 5, 100]], city: 'Howrah' }) // o7
    await order({ status: 'DELIVERED', total: 40, created: at('00:20'), city: 'Kolkata' })                                                      // o8  00:20 IST = already 03-10
    await order({ user: c1, status: 'CONFIRMED', total: 70, created: at('15:00'), fee: 10, tip: 5 })                                           // o9  still being prepared — a sale already
    await order({ shop: B, status: 'DELIVERED', total: 80, created: at('09:00') })                                                              // b1
    // deliveries: one just after midnight, one at 23:50 (both on 03-10), one the next morning (outside the day)
    const d1 = await order({ status: 'DELIVERED', total: 10, created: at('00:05') }); await delivered(d1, at('00:30'), 25)
    const d2 = await order({ status: 'DELIVERED', total: 10, created: at('23:00') }); await delivered(d2, at('23:50'), 35)
    const d3 = await order({ status: 'DELIVERED', total: 10, created: at('23:30') }); await delivered(d3, at('00:10', '2026-03-11'), 20)
  })
  afterAll(async () => { await cleanup(); await closePool() })

  // The three small delivery orders (10 each, delivered by d1 d2 d3) also stood on 03-10, so the day is:
  //   placed 03-10: o1 100, o2 200, o3 300, o7 500, o8 40, o9 70, b1 80, d1 10, d2 10, d3 10 = 1,320 (10 orders)
  //   refunds on 03-10: o2 50, o3 300 (admin refund with no amount → what the customer paid), y2 120 = 470
  //   o3 refunded in full → not an order. Orders that stood = 10 − 1 = 9. Kept = 1,320 − 470 = 850. Per order 850 / 9 = 94.44
  //   buyers of orders that stood: c1 (o1 o8 o9 b1 d1 d2 d3), c2 (o2), biz (o7) = 3. Coupon money on those orders: o1 10 (o3's 30 is refunded away, o4 is cancelled).
  const ONE = { startDate: '2026-03-10', endDate: '2026-03-10' }

  describe('sales', () => {
    it('counts orders still in progress and the whole end day, with refunds taken off', async () => {
      const r = await repo.getSalesAnalytics(ONE)
      expect(r.summary).toEqual({ total_revenue: 850, total_orders: 9, avg_order_value: 94.44, unique_customers: 3, total_discounts: 10, gross_sales: 1320, total_refunds: 470 })
    })
    it('one row per India day, refunds dated the day they were paid back', async () => {
      const r = await repo.getSalesAnalytics({ startDate: '2026-03-09', endDate: '2026-03-10' })
      expect(r.timeSeries.map((x) => [x.period, x.gross_sales, x.refunds, x.revenue, x.orders])).toEqual([
        ['2026-03-09', 210, 0, 210, 2],     // y1 60 + y2 120 + y3 30; y2 was later refunded in full, so 2 orders stood
        ['2026-03-10', 1320, 470, 850, 9],
      ])
    })
    it('groups by week and month in India time', async () => {
      const w = await repo.getSalesAnalytics({ startDate: '2026-03-09', endDate: '2026-03-10', groupBy: 'week' })
      expect(w.timeSeries).toHaveLength(1) // 9 March 2026 is a Monday: both days are one week
      expect(w.timeSeries[0]).toMatchObject({ period: '2026-03-09', gross_sales: 1530, refunds: 470, revenue: 1060, orders: 11 })
      const m = await repo.getSalesAnalytics({ startDate: '2026-03-09', endDate: '2026-03-10', groupBy: 'month' })
      expect(m.timeSeries[0].period).toBe('2026-03-01')
    })
    it('a store sees only its own sales', async () => {
      const r = await repo.getSalesAnalytics({ ...ONE, shopId: B })
      expect(r.summary).toMatchObject({ total_revenue: 80, total_orders: 1, gross_sales: 80, total_refunds: 0 })
    })
  })

  describe('financial report', () => {
    // billed (gross) 1,320; discounts 10 (already taken off, never subtracted again); refunds 470; net 850.
    // delivery fees on orders that stood: o1 25 + o9 10 = 35 (o3's has no fee). GST on orders that stood: o1 5 + o2 10 = 15 (o3's 30 left with the refund).
    it('net = billed − refunds, and discounts are not subtracted twice', async () => {
      const f = await repo.getFinancialReport(ONE)
      expect(f.revenue).toEqual({ gross: 1320, discounts: 10, delivery_fees: 35, refunds: 470, net: 850, order_count: 9 })
    })
    it('payment methods and GST come from orders that stood', async () => {
      const f = await repo.getFinancialReport(ONE)
      expect(Object.fromEntries(f.byPaymentMethod.map((x) => [x.payment_method, x.revenue]))).toEqual({ B2B_CREDIT: 500, ONLINE: 520 }) // stood total 1,020 (o3's 300 out): ONLINE 520, B2B 500
      expect(f.gstBreakdown[0]).toMatchObject({ gst_amount: 15, taxable_amount: 1005 }) // 1,020 − 15
    })
  })

  describe('one store only', () => {
    // store B has one 80 order; nothing else may leak in
    it('financial report, comparison and best sellers stay inside the store', async () => {
      const f = await repo.getFinancialReport({ ...ONE, shopId: B })
      expect(f.revenue).toMatchObject({ gross: 80, refunds: 0, net: 80, order_count: 1 })
      expect(f.gstBreakdown).toEqual([{ gst_rate: expect.any(Number), taxable_amount: 80, gst_amount: 0 }])
      const c = await repo.getComparisonStats('2026-03-10', '2026-03-10', '2026-03-09', '2026-03-09', B)
      expect(c.current).toMatchObject({ revenue: 80, orders: 1 })
      expect(c.previous).toMatchObject({ revenue: 0, orders: 0 })
      const p = await repo.getProductPerformance({ ...ONE, limit: 5, shopId: B })
      expect(p.filter((x) => x.name.startsWith('T27'))).toEqual([])
    })
    it('no orders in the period gives an empty tax breakdown', async () => {
      const f = await repo.getFinancialReport({ startDate: '2026-03-20', endDate: '2026-03-21', shopId: B })
      expect(f.gstBreakdown).toEqual([])
      expect(f.revenue.order_count).toBe(0)
    })
  })

  describe('tips and fees', () => {
    it('only from orders that stood: o1 5 + o9 5 = 10 in tips; o3 tip 20 was refunded away', async () => {
      const c = await repo.getCartEnhancementAnalytics(ONE)
      expect(c.tipAnalytics).toEqual({ totalTips: 10, averageTip: 5, mostPopularAmount: 5, tippedOrders: 2 })
      expect(c.feeRevenue).toEqual({ totalDeliveryFees: 35, totalHandlingFees: 3, totalLateNightFees: 0 })
    })
  })

  describe('products', () => {
    it('best sellers from orders that stood (cancelled and fully refunded ones left out)', async () => {
      const r = await repo.getProductPerformance({ ...ONE, limit: 5 })
      const mine = r.filter((x) => x.name.startsWith('T27'))
      // rice: o1 2 units (100) + o7 5 units (500); o3's 3 units were refunded in full. oil: o2, part-refunded, still a sale.
      expect(mine.map((x) => [x.name, x.units_sold, x.revenue, x.unique_buyers])).toEqual([['T27 Rice', 7, 600, 2], ['T27 Oil', 1, 200, 1]])
    })
  })

  describe('customers', () => {
    it('cohorts count orders that stood, in India months', async () => {
      const r = await repo.getCustomerCohorts({})
      const mine = r.filter((x) => ['2026-02-01', '2026-03-01'].includes(x.cohort_month) && x.order_month === '2026-03-01')
      const by = Object.fromEntries(mine.map((x) => [x.cohort_month, x.active_users]))
      expect(by['2026-02-01']).toBeGreaterThanOrEqual(1) // c1 signed up in February and ordered in March
      expect(by['2026-03-01']).toBeGreaterThanOrEqual(2) // c2 and the hotel signed up in March and ordered in March
    })
  })

  describe('comparison', () => {
    it('two periods on the same rules, both end days included', async () => {
      const r = await repo.getComparisonStats('2026-03-10', '2026-03-10', '2026-03-09', '2026-03-09')
      expect(r.current).toMatchObject({ revenue: 850, orders: 9, customers: 3 })
      expect(r.previous).toMatchObject({ revenue: 210, orders: 2, customers: 1 }) // y2 was refunded in full, so only c1 bought
      expect(r.changes).toMatchObject({ revenue: 305, orders: 350 }) // (850−210)/210 = 304.8 → 305 · (9−2)/2 = 350
    })
  })

  describe('areas', () => {
    it('by city, each order net of its own refund; a refunded-in-full order is not an order', async () => {
      const r = await repo.getGeographicAnalytics({ ...ONE, shopId: A })
      const by = Object.fromEntries(r.map((x) => [x.area, x]))
      expect(by.Howrah).toMatchObject({ orders: 1, revenue: 500, customers: 1 })
      expect(by.Kolkata).toMatchObject({ orders: 3, revenue: 290 }) // o1 100 + o2 (200 − 50) + o8 40
      expect(by.Unknown).toMatchObject({ orders: 4 }) // o9 70 + d1 d2 d3 (10 each); o3 (refunded in full) adds nothing
      expect(by.Unknown.revenue).toBe(100)
    })
  })

  describe('deliveries', () => {
    it('counts deliveries on the India day, including the one at 23:50, not the one after midnight', async () => {
      const r = await repo.getDeliveryAnalytics({ ...ONE, shopId: A })
      expect(r.summary.total_deliveries).toBe(2)
      expect(r.summary.avg_delivery_time).toBe('30.0') // (25 + 35) / 2
      expect(r.byHour.map((h) => h.hour)).toEqual([0, 23])
    })
  })

  describe('dead stock', () => {
    const recent = new Date(Date.now() - 5 * DAY).toISOString()
    const old = new Date(Date.now() - 90 * DAY).toISOString()
    beforeAll(async () => {
      await query(`INSERT INTO shop_products (shop_id, product_id, stock_quantity, price) VALUES ($1,$3,10,50),($2,$3,5,50),($1,$4,4,50)`, [A, B, rice, dusty])
      // rice sold in store A five days ago (and stood); dusty tin last sold in store A 90 days ago; nothing was ever sold from store B
      await order({ status: 'DELIVERED', total: 50, created: recent, items: [[rice, 1, 50]] })
      await order({ status: 'DELIVERED', total: 50, created: old, items: [[dusty, 1, 50]] })
    })
    it("one store's sales no longer hide another store's dead stock", async () => {
      const b = (await repo.getDeadStockProducts({ shopId: B, limit: 50 })).filter((x) => x.name.startsWith('T27'))
      expect(b.map((x) => [x.name, x.stock_quantity, x.last_sold_at])).toEqual([['T27 Rice', 5, null]]) // sold in A, never in B
      const a = (await repo.getDeadStockProducts({ shopId: A, limit: 50 })).filter((x) => x.name.startsWith('T27'))
      expect(a.map((x) => x.name)).toEqual(['T27 Dusty Tin']) // rice sold recently in A
      expect(a[0].days_since_sold).toBeGreaterThanOrEqual(89)
    })
    it('across all stores, stock is added up and sold-anywhere counts as sold', async () => {
      const all = (await repo.getDeadStockProducts({ limit: 100 })).filter((x) => x.name.startsWith('T27'))
      expect(all.map((x) => x.name)).toEqual(['T27 Dusty Tin'])
    })
  })

  it('a date that does not exist is a clear 400', async () => {
    await expect(repo.getSalesAnalytics({ startDate: '2026-02-30', endDate: '2026-03-01' })).rejects.toMatchObject({ statusCode: 400 })
  })
})
