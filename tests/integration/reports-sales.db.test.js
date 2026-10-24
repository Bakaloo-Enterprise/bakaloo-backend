/**
 * HQ and store Reports on the shared sales rules. Real Postgres, opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/reports-sales.db.test.js
 * One hand-worked day (2026-03-10, India time) plus the days around it. Every expected number is worked out in the comments.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const at = (hhmm, day = '2026-03-10') => `${day} ${hhmm}:00+05:30`
const PH = (n) => `9999026${String(n).padStart(3, '0')}`

describe.skipIf(!enabled)('Reports use the sales rules', () => {
  let query, closePool, admin, shopReports, A, B, c1, c2, biz, r1, r2, rice, oil
  let n = 0
  const day = { from: '2026-03-10', to: '2026-03-10' }

  async function order({ shop = A, user = c1, status, total, created, pay = 'PAID', gstin = null, items = [], history = [], coupon = null, discount = 0 }) {
    const id = (await query(
      `INSERT INTO orders (order_number,user_id,shop_id,status,items,subtotal,total_amount,delivery_address,payment_method,payment_status,created_at,buyer_gstin,b2b_approval_status,coupon_code,discount_amount)
       VALUES ($1,$2,$3,$4::order_status,'[]'::jsonb,$5,$5,'{}'::jsonb,'ONLINE',$6,$7,$8,$9,$10,$11) RETURNING id`,
      [`T26-${++n}`, user, shop, status, total, pay, created, gstin, gstin ? 'APPROVED' : null, coupon, discount])).rows[0].id
    for (const [pid, q, price] of items) await query(`INSERT INTO order_items (order_id,product_id,name,price,quantity,unit,total,shop_id) VALUES ($1,$2,'x',$3,$4,'1 unit',$5,$6)`, [id, pid, price, q, q * price, shop])
    for (const [from, to, time] of history) await query(`INSERT INTO order_status_history (order_id, from_status, to_status, changed_at) VALUES ($1,$2,$3,$4)`, [id, from, to, time])
    return id
  }
  const deliveredBy = (id, rider, deliveredAt) => query(`UPDATE orders SET rider_id = $2, delivered_at = $3, assigned_at = $3::timestamptz - interval '30 minutes' WHERE id = $1`, [id, rider, deliveredAt])
  const refundReq = (id, user, amount, when) => query(`INSERT INTO refund_requests (order_id, user_id, description, status, refund_amount, refund_to, processed_at) VALUES ($1,$2,'t','APPROVED',$3,'wallet',$4)`, [id, user, amount, when])

  async function cleanup() {
    await query(`DELETE FROM refund_requests WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'T26-%')`)
    await query(`DELETE FROM orders WHERE order_number LIKE 'T26-%'`)
    await query(`DELETE FROM products WHERE slug LIKE 't26-%'`)
    await query(`DELETE FROM shops WHERE slug LIKE 't26-shop-%'`)
    await query(`DELETE FROM users WHERE phone LIKE '9999026%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { AdminReportsRepository } = await import('../../src/modules/admin/reports/repository.js')
    const { AdminReportsService } = await import('../../src/modules/admin/reports/service.js')
    const { ShopReportsRepository } = await import('../../src/modules/shop-reports/repository.js')
    const { ShopReportsService } = await import('../../src/modules/shop-reports/service.js')
    await cleanup()
    admin = new AdminReportsService(new AdminReportsRepository())
    shopReports = new ShopReportsService(new ShopReportsRepository())
    const mkUser = async (i, name, role = 'CUSTOMER') => (await query(`INSERT INTO users (phone,name,email,role) VALUES ($1,$2,$3,$4) RETURNING id`, [PH(i), name, `${PH(i)}@t.local`, role])).rows[0].id
    c1 = await mkUser(1, 'T26 Asha'); c2 = await mkUser(2, 'T26 Bikram'); biz = await mkUser(3, 'T26 Hotel'); r1 = await mkUser(4, 'T26 Rider One', 'RIDER'); r2 = await mkUser(5, 'T26 Rider Two', 'RIDER')
    const mkShop = async (c) => (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ($1,$2,$3,'DB 26','Kolkata','WB','700091',22.5,88.3,true) RETURNING id`, [`T26 Shop ${c}`, `t26-shop-${c}`, `T26${c}`])).rows[0].id
    A = await mkShop('A'); B = await mkShop('B')
    const mkP = async (name, slug) => (await query(`INSERT INTO products (name, slug, price, net_quantity) VALUES ($1,$2,50,'1 unit') RETURNING id`, [name, slug])).rows[0].id
    rice = await mkP('T26 Rice', 't26-rice'); oil = await mkP('T26 Oil', 't26-oil')

    // ── the day before (03-09) and the edge of midnight ──
    await order({ status: 'DELIVERED', total: 60, created: at('11:00', '2026-03-09') })                                             // y1
    const y2 = await order({ user: c2, status: 'REFUNDED', total: 120, created: at('12:00', '2026-03-09'), history: [['DELIVERED', 'REFUNDED', at('09:00')]] })
    await refundReq(y2, c2, 120, at('09:00'))                                                                                        // y2: refunded IN FULL on 03-10
    await order({ status: 'DELIVERED', total: 30, created: at('23:50', '2026-03-09') })                                             // y3: 23:50 IST = still 03-09
    // ── 2026-03-10, store A ──
    const o1 = await order({ status: 'DELIVERED', total: 100, created: at('10:00'), items: [[rice, 2, 50]], coupon: 'T26CODE', discount: 10 })
    const o2 = await order({ user: c2, status: 'REFUNDED', total: 200, created: at('10:30'), items: [[oil, 1, 200]], history: [['DELIVERED', 'REFUNDED', at('13:00')]] })
    await refundReq(o2, c2, 50, at('13:00'))                                                                                         // part refund 50
    const o3 = await order({ status: 'REFUNDED', total: 300, created: at('11:00'), items: [[rice, 3, 100]], coupon: 'T26CODE', discount: 30, history: [['DELIVERED', 'REFUNDED', at('14:00')]] }) // refunded in full, no amount recorded
    await order({ user: c2, status: 'CANCELLED', total: 150, created: at('12:00'), coupon: 'T26CODE', discount: 15, history: [[null, 'CONFIRMED', at('12:01')], ['CONFIRMED', 'CANCELLED', at('12:30')]] }) // o4
    await order({ status: 'REFUNDED', total: 400, created: at('12:10'), history: [[null, 'CONFIRMED', at('12:11')], ['CONFIRMED', 'CANCELLED', at('12:40')], ['CANCELLED', 'REFUNDED', at('15:00')]] }) // o5 cancelled THEN refunded
    await order({ user: c2, status: 'PENDING', total: 250, created: at('13:00'), pay: 'PENDING' })                                  // o6 unpaid
    const o7 = await order({ user: biz, status: 'DELIVERED', total: 500, created: at('18:15'), pay: 'PENDING', gstin: '19ABCDE1234F1Z5', items: [[rice, 5, 100]] })
    await order({ status: 'DELIVERED', total: 40, created: at('00:20') })                                                           // o8: 00:20 IST = already 03-10
    // ── store B ──
    await order({ shop: B, status: 'DELIVERED', total: 80, created: at('09:00') })                                                 // b1
    // riders: o1, o3 (delivered, later refunded) and o7 by rider one; o2 by rider two; the cancelled o4 had a rider but never delivered
    await deliveredBy(o1, r1, at('10:40')); await deliveredBy(o3, r1, at('11:40')); await deliveredBy(o7, r1, at('18:45')); await deliveredBy(o2, r2, at('11:10'))
    await query(`UPDATE orders SET rider_id = $1 WHERE order_number = 'T26-8'`, [r1])
  })
  afterAll(async () => { await cleanup(); await closePool() })

  const ids = () => ({ ...day, shop_ids: `${A},${B}` })

  // 03-10, stores A + B: orders that stood = o1 100, o2 200, o3 300, o7 500, o8 40 (A: 1,140 in 5) + b1 80 = 1,220 in 6.
  // o4 cancelled, o5 cancelled-then-refunded, o6 unpaid → out. y3 (23:50 on 03-09) is yesterday, o8 (00:20) is today.
  describe('gmv and orders', () => {
    it('counts only orders that stood, on India days', async () => {
      const r = await admin.getGmv(ids())
      expect(r.data).toEqual([{ date: '2026-03-10', gmv: 1220, order_count: 6 }])
    })
    it('the status breakdown shows a cancelled-then-refunded order as cancelled', async () => {
      const r = await admin.getOrders(ids())
      const by = Object.fromEntries(r.data.map((x) => [x.status, x.count]))
      expect(by).toEqual({ DELIVERED: 4, REFUNDED: 2, CANCELLED: 2, PENDING: 1 }) // delivered o1 o7 o8 b1 · refunded o2 o3 · cancelled o4 o5 · pending o6
      expect(r.meta.total).toBe(4) // four day/status groups
    })
  })

  // Refunds dated the day the money went back: o2 50 + o3 300 (admin refund with no amount → what the customer paid) + y2 120 = 470.
  describe('revenue and refunds', () => {
    it('sold − given back = kept, with refunds on their own day', async () => {
      const r = await admin.getRevenue({ from: '2026-03-09', to: '2026-03-10', shop_ids: `${A},${B}` })
      expect(r.data).toEqual([
        { date: '2026-03-10', gross_revenue: 1220, refunded: 470, net_revenue: 750, orders: 5 }, // stood 6 − o3 refunded in full
        { date: '2026-03-09', gross_revenue: 210, refunded: 0, net_revenue: 210, orders: 2 },   // y1 60 + y2 120 + y3 30; y2 later refunded in full
      ])
    })
    it('lists refunds by the day paid back and how many were whole orders', async () => {
      const r = await admin.getRefunds(ids())
      expect(r.data).toEqual([{ date: '2026-03-10', refund_count: 3, full_refunds: 2, refund_amount: 470 }]) // o3 and y2 whole, o2 part; the cancelled o5 is not a refund
    })
  })

  describe('stores', () => {
    it('store A: 4 orders stood, 3 after the one refunded in full, 1,140 − 470 = 670 kept', async () => {
      const r = await admin.getShopPerformance(ids())
      const a = r.data.find((x) => x.shop_id === A)
      expect(a).toMatchObject({ shop_name: 'T26 Shop A', order_count: 4, revenue: 670, avg_order_value: 167.5 }) // 670 / 4 (o1 o2 o7 o8)
      expect(r.data.find((x) => x.shop_id === B)).toMatchObject({ order_count: 1, revenue: 80 })
    })
    it('top shops ranks by money kept', async () => {
      const r = await admin.getTopShops(ids())
      expect(r.data.map((x) => [x.shop_name, x.total_revenue, x.total_orders])).toEqual([['T26 Shop A', 670, 4], ['T26 Shop B', 80, 1]])
    })
  })

  describe('products and coupons', () => {
    it('best sellers leave out cancelled and fully refunded orders', async () => {
      const r = await admin.getTopProducts(ids())
      // rice: o1 2 units (100) + o7 5 units (500) = 7 / 600; o3's 3 units were refunded in full. oil: o2 1 unit (200), part-refunded, still a sale.
      expect(r.data.map((x) => [x.product_name, x.total_quantity, x.total_revenue])).toEqual([['T26 Rice', 7, 600], ['T26 Oil', 1, 200]])
    })
    it('coupons count only orders that stood', async () => {
      const r = await admin.getCouponUsage(ids())
      expect(r.data).toEqual([expect.objectContaining({ coupon_code: 'T26CODE', usage_count: 1, total_discount: 10 })]) // o3 (refunded in full) and the cancelled o4 are out
    })
  })

  describe('riders', () => {
    it('counts deliveries made, not cancelled assignments', async () => {
      const r = await admin.getRiderPerformance(ids())
      expect(r.data.map((x) => x.deliveries).sort()).toEqual([1, 3]) // rider one: o1, o3, o7 · rider two: o2 · the cancelled o4 is not a delivery
      expect(Number(r.data[0].avg_delivery_seconds)).toBe(1800)
    })
  })

  describe('a store sees only itself', () => {
    it('store B revenue and store A refunds are separate', async () => {
      expect((await shopReports.getGmv(B, day)).data).toEqual([{ date: '2026-03-10', gmv: 80, order_count: 1 }])
      const a = await shopReports.getRevenue(A, day)
      expect(a.data).toEqual([{ date: '2026-03-10', gross_revenue: 1140, refunded: 470, net_revenue: 670, orders: 4 }])
      expect((await shopReports.getRefunds(B, day)).data).toEqual([])
    })
    it('a store cannot widen itself with a shop_ids filter', async () => {
      const r = await shopReports.getGmv(B, { ...day, shop_ids: `${A}` })
      expect(r.data).toEqual([{ date: '2026-03-10', gmv: 80, order_count: 1 }])
    })
  })

  describe('agrees with the Command Center', () => {
    it('sold, given back, kept and orders match the Overview for the same day', async () => {
      const { OverviewRepository } = await import('../../src/modules/admin/dashboard/overview.repository.js')
      const { OverviewService } = await import('../../src/modules/admin/dashboard/overview.service.js')
      const ov = await new OverviewService({ repo: new OverviewRepository(), now: () => new Date('2026-03-10T21:00:00+05:30') }).overview({ period: 'today', shopId: A })
      const r = (await shopReports.getRevenue(A, day)).data[0]
      expect([r.gross_revenue, r.refunded, r.net_revenue, r.orders]).toEqual([ov.money.grossSales, ov.money.refunds, ov.money.netRevenue, ov.orders.net])
    })
  })

  describe('bad input', () => {
    it('a date that does not exist is a clear 400, not a database error', async () => {
      await expect(admin.getGmv({ from: '2026-02-30' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/real date/) })
      await expect(admin.getGmv({ from: '2026-03-11', to: '2026-03-10' })).rejects.toMatchObject({ statusCode: 400 })
    })
    it('paging walks through the days without losing any', async () => {
      const wide = { from: '2026-03-09', to: '2026-03-10', shop_ids: `${A},${B}` }
      const p1 = await admin.getRevenue({ ...wide, page: '1', limit: '1' })
      const p2 = await admin.getRevenue({ ...wide, page: '2', limit: '1' })
      expect([p1.data[0].date, p2.data[0].date]).toEqual(['2026-03-10', '2026-03-09'])
      expect(p1.meta.total).toBe(2)
    })
  })
})
