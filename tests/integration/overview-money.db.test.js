/**
 * Overview money rules on a real Postgres. Opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/overview-money.db.test.js
 *
 * One hand-worked day, 2026-03-10 (India time), plus the day before. Every expected figure is worked out on paper in
 * the comments — not read back from the code under test. The same day is also read through Business Analytics: the two
 * screens must agree on gross sales, refunds and cancelled value.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const at = (hhmm, day = '2026-03-10') => `${day} ${hhmm}:00+05:30`
const PH = (n) => `9999020${String(n).padStart(3, '0')}`

describe.skipIf(!enabled)('Overview money rules', () => {
  let query, closePool, overview, analytics, A, B, C, c1, c2, biz, admin, rice, oil
  let n = 0

  const mkShop = async (code) => (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active, commission_rate) VALUES ($1,$2,$3,'DB 20','Kolkata','WB','700091',22.5,88.3,true,10) RETURNING id`, [`T20 Shop ${code}`, `t20-shop-${code}`, code])).rows[0].id
  const mkUser = async (i, name, role = 'CUSTOMER') => (await query(`INSERT INTO users (phone,name,email,role) VALUES ($1,$2,$3,$4) RETURNING id`, [PH(i), name, `${PH(i)}@t.local`, role])).rows[0].id
  const mkProduct = async (name, sku, price) => (await query(`INSERT INTO products (name, slug, price, sku, net_quantity) VALUES ($1,$2,$3,$4,'1 unit') RETURNING id`, [name, `t20-${sku}`.toLowerCase(), price, sku])).rows[0].id

  /** items: [productId, qty, unitPrice]; history: [[from, to, time]] */
  async function order({ shop = A, user, status, total, created, method = 'ONLINE', pay = 'PAID', walletUsed = 0, gstin = null, b2b = null, items = [], history = [] }) {
    const id = (await query(
      `INSERT INTO orders (order_number,user_id,shop_id,status,items,subtotal,total_amount,delivery_address,payment_method,payment_status,created_at,delivered_at,buyer_gstin,b2b_approval_status,wallet_amount_used)
       VALUES ($1,$2,$3,$4::order_status,'[]'::jsonb,$5,$5,'{}'::jsonb,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [`T20-${++n}`, user, shop, status, total, method, pay, created, status === 'DELIVERED' || status === 'REFUNDED' ? created : null, gstin, b2b, walletUsed])).rows[0].id
    for (const [pid, q, price] of items) await query(`INSERT INTO order_items (order_id,product_id,name,price,quantity,unit,total,shop_id) VALUES ($1,$2,'x',$3,$4,'1 unit',$5,$6)`, [id, pid, price, q, q * price, shop])
    for (const [from, to, time] of history) await query(`INSERT INTO order_status_history (order_id, from_status, to_status, changed_at) VALUES ($1,$2,$3,$4)`, [id, from, to, time])
    return id
  }
  const refundRequest = (orderId, user, amount, processedAt) =>
    query(`INSERT INTO refund_requests (order_id, user_id, description, status, refund_amount, refund_to, processed_at) VALUES ($1,$2,'t','APPROVED',$3,'wallet',$4)`, [orderId, user, amount, processedAt])

  async function cleanup() {
    await query(`DELETE FROM refund_requests WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'T20-%')`)
    await query(`DELETE FROM orders WHERE order_number LIKE 'T20-%'`)
    await query(`DELETE FROM products WHERE slug LIKE 't20-%'`)
    await query(`DELETE FROM shops WHERE slug LIKE 't20-shop-%'`)
    await query(`DELETE FROM users WHERE phone LIKE '9999020%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { OverviewRepository } = await import('../../src/modules/admin/dashboard/overview.repository.js')
    const { OverviewService } = await import('../../src/modules/admin/dashboard/overview.service.js')
    const { ProcurementRepository } = await import('../../src/modules/procurement/procurement.repository.js')
    const { ProcurementService } = await import('../../src/modules/procurement/procurement.service.js')
    const { BusinessAnalyticsRepository } = await import('../../src/modules/business-analytics/business-analytics.repository.js')
    const { BusinessAnalyticsService } = await import('../../src/modules/business-analytics/business-analytics.service.js')
    await cleanup()
    const now = () => new Date('2026-03-10T21:00:00+05:30')
    overview = new OverviewService({ repo: new OverviewRepository(), now })
    analytics = new BusinessAnalyticsService({ repo: new BusinessAnalyticsRepository(), procurement: new ProcurementService({ repo: new ProcurementRepository() }), now })
    admin = await mkUser(1, 'T20 Admin', 'ADMIN'); c1 = await mkUser(2, 'T20 Asha'); c2 = await mkUser(3, 'T20 Bikram'); biz = await mkUser(4, 'T20 Hotel')
    A = await mkShop('A'); B = await mkShop('B'); C = await mkShop('C')
    rice = await mkProduct('T20 Rice', 'RICE', 50); oil = await mkProduct('T20 Oil', 'OIL', 200)

    // ── the day before (2026-03-09) ──
    // y1: Rs 60 delivered, kept. y2: Rs 120 delivered, refunded IN FULL on 03-10 (refund request, Rs 120).
    await order({ user: c1, status: 'DELIVERED', total: 60, created: at('11:00', '2026-03-09') })
    const y2 = await order({ user: c2, status: 'REFUNDED', total: 120, created: at('12:00', '2026-03-09'), history: [['DELIVERED', 'REFUNDED', at('09:00')]] })
    await refundRequest(y2, c2, 120, at('09:00'))

    // ── 2026-03-10, shop A ──
    // o1: Rs 100 COD delivered (rice x2 @50), 10:00
    await order({ user: c1, status: 'DELIVERED', total: 100, created: at('10:00'), method: 'COD', items: [[rice, 2, 50]] })
    // o2: Rs 200 online delivered (oil x1), 10:30 — PARTLY refunded Rs 50 by an approved request → order flips to REFUNDED
    const o2 = await order({ user: c2, status: 'REFUNDED', total: 200, created: at('10:30'), items: [[oil, 1, 200]], history: [['DELIVERED', 'REFUNDED', at('13:00')]] })
    await refundRequest(o2, c2, 50, at('13:00'))
    // o3: Rs 300 online, refunded in full by an admin wallet refund that left NO amount behind (status only), 11:00; refunded 14:00
    await order({ user: c1, status: 'REFUNDED', total: 300, created: at('11:00'), items: [[rice, 3, 100]], history: [['DELIVERED', 'REFUNDED', at('14:00')]] })
    // o4: Rs 150 confirmed then cancelled
    await order({ user: c2, status: 'CANCELLED', total: 150, created: at('12:00'), history: [[null, 'CONFIRMED', at('12:01')], ['CONFIRMED', 'CANCELLED', at('12:30')]] })
    // o5: Rs 400 confirmed, cancelled, THEN refunded (status ends REFUNDED) — still a cancellation, never a sale
    await order({ user: c1, status: 'REFUNDED', total: 400, created: at('12:10'), history: [[null, 'CONFIRMED', at('12:11')], ['CONFIRMED', 'CANCELLED', at('12:40')], ['CANCELLED', 'REFUNDED', at('15:00')]] })
    // o6: Rs 250 waiting for payment — not a sale yet
    await order({ user: c2, status: 'PENDING', total: 250, created: at('13:00'), pay: 'PENDING' })
    // o7: Rs 500 B2B credit order, delivered, payment still PENDING (credit) — a real sale (rice x5 @100), 18:15
    await order({ user: biz, status: 'DELIVERED', total: 500, created: at('18:15'), method: 'B2B_CREDIT', pay: 'PENDING', gstin: '19ABCDE1234F1Z5', b2b: 'APPROVED', items: [[rice, 5, 100]] })
    // ── shop B ──
    await order({ shop: B, user: c1, status: 'DELIVERED', total: 80, created: at('09:00') })
  })

  afterAll(async () => {
    await cleanup()
    await closePool()
  })

  // Shop A, 03-10.
  //   placed:  o1 100, o2 200, o3 300, o7 500            = 1100 (4 orders)    [o4 o5 cancelled, o6 unpaid → out]
  //   refunds on 03-10 (by refund day, cancelled excluded): o2 50, o3 300 (fallback: paid cash), y2 120 = 470
  //   fully refunded among placed: o3 only (o2 is partial) → net orders = 4 − 1 = 3
  //   net revenue = 1100 − 470 = 630;  AOV = 630 / 3 = 210
  //   cancelled after confirmed: o4 150 + o5 400 = 550 (2 orders)
  describe('shop A, one day', () => {
    let ov
    beforeAll(async () => { ov = await overview.overview({ period: 'today', shopId: A }) })

    it('gross sales ignore cancelled, cancelled-then-refunded and unpaid orders, but include COD and B2B credit', () => {
      expect(ov.money.grossSales).toBe(1100)
      expect(ov.orders.placed).toBe(4)
    })
    it('refunds are counted on the refund day, partial and amount-less admin refunds included, cancelled ones left out', () => {
      expect(ov.money.refunds).toBe(470)
      expect(ov.orders.refundEvents).toBe(3)
    })
    it('net revenue = gross − refunds', () => expect(ov.money.netRevenue).toBe(630))
    it('an order refunded in full is not an order; a partly refunded one still is', () => {
      expect(ov.orders.fullyRefunded).toBe(1)
      expect(ov.orders.net).toBe(3)
      expect(ov.money.avgOrderValue).toBe(210)
    })
    it('cancellations (including cancelled-then-refunded) are reported separately, not as sales', () => {
      expect(ov.orders.cancelled).toBe(2)
      expect(ov.money.cancelledValue).toBe(550)
    })
    it('compares with the previous day on the same rules', () => {
      // 03-09, shop A: y1 60 + y2 120 = 180 gross, no refund that day → 180 net; orders 2 placed − y2 (fully refunded later) = 1
      expect(ov.comparison.netRevenue.previous).toBe(180)
      expect(ov.comparison.netRevenue.changePct).toBe(250) // (630 − 180) / 180
      expect(ov.comparison.orders.previous).toBe(1)
    })
    it('the daily series has one row for the day and nets refunds on their own day', () => {
      expect(ov.series).toHaveLength(1)
      expect(ov.series[0]).toMatchObject({ day: '2026-03-10', placed: 4, orders: 3, gross: 1100, refunds: 470, net: 630, cancelled: 2, cod: 100 })
    })
    it('hours and best sellers leave out the fully refunded order and the cancelled ones', () => {
      expect(ov.hours.find((h) => h.hour === 10).orders).toBe(2) // o1 10:00, o2 10:30
      expect(ov.hours.find((h) => h.hour === 11).orders).toBe(0) // o3 was refunded in full
      expect(ov.hours.find((h) => h.hour === 18).orders).toBe(1) // o7
      const rice7 = ov.topProducts.find((p) => p.name === 'T20 Rice')
      expect(rice7).toMatchObject({ unitsSold: 7, revenue: 600 }) // o1 2 units + o7 5 units; o3's 3 units excluded
      expect(ov.topProducts.find((p) => p.name === 'T20 Oil')).toMatchObject({ unitsSold: 1, revenue: 200 })
    })
    it('categories add up to the best-seller revenue', () => {
      expect(ov.categories.reduce((t, c) => t + c.revenue, 0)).toBe(800)
    })
    it('splits B2B from B2C', () => {
      expect(ov.channels.find((c) => c.channel === 'B2B')).toMatchObject({ orders: 1, gross: 500 })
      expect(ov.channels.find((c) => c.channel === 'B2C')).toMatchObject({ orders: 3, gross: 600 })
    })
    it('counts buyers, new and returning', () => {
      // buyers: c1 (o1,o3), c2 (o2), biz (o7). c1 and c2 also bought on 03-09 → returning; biz is new.
      expect(ov.customers).toMatchObject({ buyers: 3, newBuyers: 1, repeatBuyers: 2 })
    })
  })

  describe('all stores', () => {
    it('adds shop B on top; the shop filter really filters', async () => {
      const hq = await overview.overview({ period: 'today', shopId: null })
      const mine = await overview.overview({ period: 'today', shopId: B })
      // other developer data could exist in this DB for 2026-03-10 only if someone planted it; compare as a difference
      expect(hq.money.grossSales).toBeGreaterThanOrEqual(1180)
      expect(mine.money.grossSales).toBe(80)
      expect(mine.orders.net).toBe(1)
      expect(mine.money.refunds).toBe(0)
    })
  })

  describe('agrees with Business Analytics on the same day', () => {
    it('gross sales, refunds and cancelled value match to the paisa', async () => {
      const ov = await overview.overview({ period: 'today', shopId: A })
      const ba = await analytics.overview({ period: 'custom', from: '2026-03-10', to: '2026-03-10', shopId: A })
      expect(ba.cards.grossSales).toBe(ov.money.grossSales)
      expect(ba.cards.refunds).toBe(ov.money.refunds)
      expect(ba.cards.netRevenue).toBe(ov.money.netRevenue)
      expect(ba.cards.cancelledValue).toBe(ov.money.cancelledValue)
      expect(ba.counts.orders).toBe(ov.orders.placed)
    })
  })

  describe('live counters', () => {
    it('counts new orders, orders on the way and COD still to collect for a store', async () => {
      await order({ shop: C, user: c1, status: 'CONFIRMED', total: 90, created: new Date().toISOString(), method: 'COD', pay: 'PENDING' })
      await order({ shop: C, user: c2, status: 'OUT_FOR_DELIVERY', total: 60, created: new Date().toISOString(), method: 'COD', pay: 'PENDING' })
      await order({ shop: C, user: c2, status: 'PENDING', total: 999, created: new Date().toISOString(), method: 'ONLINE', pay: 'PENDING' })
      const live = (await overview.overview({ period: 'today', shopId: C })).live
      expect(live).toMatchObject({ newOrders: 1, outForDelivery: 1, codToCollect: 150 })
    })
  })

  it('refuses an unknown period', async () => {
    await expect(overview.overview({ period: 'decade' })).rejects.toThrow(/Period must be/)
  })
})
