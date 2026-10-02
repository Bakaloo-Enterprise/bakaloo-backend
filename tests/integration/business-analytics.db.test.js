/**
 * Business Analytics (Phase 12). Real Postgres, opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/business-analytics.db.test.js
 *
 * ONE hand-worked day (2026-03-10, India time). Every expected number below is worked out on paper in the comments,
 * not read back from the code under test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const DAY = { period: 'custom', from: '2026-03-10', to: '2026-03-10' }
const at = (hhmm, day = '2026-03-10') => `${day} ${hhmm}:00+05:30`
const PH = (n) => `9999018${String(n).padStart(3, '0')}`

describe.skipIf(!enabled)('Business analytics', () => {
  let query, closePool, analytics, procurement, mgr, A, B, c1, c2, biz, rice, oil, spARice, spBOil

  const mkShop = async (code, rate) => (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active, commission_rate) VALUES ($1,$2,$3,'DB 12','Kolkata','WB','700091',22.5,88.3,true,$4) RETURNING id`, [`T14 Shop ${code}`, `t14-shop-${code}`, code, rate])).rows[0].id
  const mkUser = async (n, name, role = 'CUSTOMER') => (await query(`INSERT INTO users (phone,name,email,role) VALUES ($1,$2,$3,$4) RETURNING id`, [PH(n), name, `${PH(n)}@t.local`, role])).rows[0].id
  const mkProduct = async (name, sku, price) => (await query(`INSERT INTO products (name, slug, price, sku, net_quantity) VALUES ($1,$2,$3,$4,'1 unit') RETURNING id`, [name, `t14-${sku}`.toLowerCase(), price, sku])).rows[0].id
  let n = 0
  /** items: [productId, qty, unitPrice]. history: [[from, to, time]] */
  async function order({ shop, user, status, subtotal, total, created, delivered = null, gstin = null, items = [], history = [] }) {
    const id = (await query(
      `INSERT INTO orders (order_number,user_id,shop_id,status,items,subtotal,total_amount,delivery_address,payment_method,payment_status,created_at,delivered_at,buyer_gstin)
       VALUES ($1,$2,$3,$4::order_status,'[]'::jsonb,$5,$6,'{}'::jsonb,'COD','PAID',$7,$8,$9) RETURNING id`,
      [`T14-${++n}`, user, shop, status, subtotal, total, created, delivered, gstin])).rows[0].id
    for (const [pid, q, price] of items) await query(`INSERT INTO order_items (order_id,product_id,name,price,quantity,unit,total,shop_id) VALUES ($1,$2,'x',$3,$4,'1 unit',$5,$6)`, [id, pid, price, q, q * price, shop])
    for (const [from, to, time] of history) await query(`INSERT INTO order_status_history (order_id, from_status, to_status, changed_at) VALUES ($1,$2::order_status,$3::order_status,$4)`, [id, from, to, time])
    return id
  }

  async function cleanup() {
    await query(`DELETE FROM stock_movements WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't14-shop-%')`)
    await query(`DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'T14-%')`)
    await query(`DELETE FROM refund_requests WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'T14-%')`)
    await query(`DELETE FROM orders WHERE order_number LIKE 'T14-%'`)
    await query(`DELETE FROM audit_logs WHERE target_type='procurement_entry' AND actor_user_id IN (SELECT id FROM users WHERE phone LIKE '9999018%')`)
    await query(`DELETE FROM procurement_adjustments WHERE entry_id IN (SELECT id FROM procurement_entries WHERE product_id IN (SELECT id FROM products WHERE slug LIKE 't14-%'))`)
    await query(`DELETE FROM procurement_allocations WHERE entry_id IN (SELECT id FROM procurement_entries WHERE product_id IN (SELECT id FROM products WHERE slug LIKE 't14-%'))`)
    await query(`DELETE FROM procurement_entries WHERE product_id IN (SELECT id FROM products WHERE slug LIKE 't14-%')`)
    await query(`DELETE FROM shop_products WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't14-shop-%')`)
    await query(`DELETE FROM vendors WHERE name LIKE 'T14 %'`)
    await query(`DELETE FROM products WHERE slug LIKE 't14-%'`)
    await query(`DELETE FROM shops WHERE slug LIKE 't14-shop-%'`)
    await query(`DELETE FROM users WHERE phone LIKE '9999018%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { ProcurementRepository } = await import('../../src/modules/procurement/procurement.repository.js')
    const { ProcurementService } = await import('../../src/modules/procurement/procurement.service.js')
    const { BusinessAnalyticsRepository } = await import('../../src/modules/business-analytics/business-analytics.repository.js')
    const { BusinessAnalyticsService } = await import('../../src/modules/business-analytics/business-analytics.service.js')
    await cleanup()
    procurement = new ProcurementService({ repo: new ProcurementRepository() })
    analytics = new BusinessAnalyticsService({ repo: new BusinessAnalyticsRepository(), procurement, now: () => new Date('2026-03-10T12:00:00+05:30') })
    mgr = await mkUser(1, 'T14 Manager', 'ADMIN'); c1 = await mkUser(2, 'T14 Asha'); c2 = await mkUser(3, 'T14 Bikram'); biz = await mkUser(4, 'T14 Hotel Owner')
    A = await mkShop('A', 10); B = await mkShop('B', 20)
    rice = await mkProduct('T14 Rice', 'T14-RICE', 40); oil = await mkProduct('T14 Oil', 'T14-OIL', 20)

    // ── orders on the day ──
    const O1 = await order({ shop: A, user: c1, status: 'DELIVERED', subtotal: 100, total: 110, created: at('10:00'), delivered: at('10:30'), items: [[rice, 2, 40], [oil, 1, 20]] })
    await order({ shop: A, user: c2, status: 'CONFIRMED', subtotal: 200, total: 210, created: at('11:00'), items: [[rice, 4, 40], [oil, 2, 20]] })
    const O3 = await order({ shop: B, user: c1, status: 'DELIVERED', subtotal: 300, total: 320, created: at('12:00'), delivered: at('13:00'), items: [[oil, 15, 20]] })
    await order({ shop: A, user: biz, status: 'DELIVERED', subtotal: 1000, total: 1000, created: at('09:00'), delivered: at('10:30'), gstin: '19ABCDE1234F1Z5', items: [[rice, 25, 40]] })
    const O5 = await order({ shop: A, user: c2, status: 'CANCELLED', subtotal: 480, total: 500, created: at('09:30'), items: [[rice, 12, 40]], history: [['PENDING', 'CONFIRMED', at('09:31')], ['CONFIRMED', 'CANCELLED', at('15:00')]] })
    await order({ shop: A, user: c1, status: 'PENDING', subtotal: 900, total: 999, created: at('14:00'), items: [[rice, 1, 40]] })
    await order({ shop: A, user: c1, status: 'CANCELLED', subtotal: 70, total: 77, created: at('14:10'), items: [[oil, 1, 20]], history: [['PENDING', 'CANCELLED', at('14:40')]] }) // expired unpaid: not leakage
    await order({ shop: A, user: c1, status: 'DELIVERED', subtotal: 180, total: 180, created: at('10:00', '2026-03-09'), delivered: at('11:00', '2026-03-09'), items: [[oil, 9, 20]] }) // the day before
    await order({ shop: A, user: c2, status: 'DELIVERED', subtotal: 50, total: 50, created: at('10:00', '2026-03-11'), delivered: at('11:00', '2026-03-11'), items: [[oil, 1, 20]] }) // the day after

    // ── refunds: approved request on O1 (30), a request on the cancelled order (ignored), a gateway refund on O3 with no request (50) ──
    await query(`INSERT INTO refund_requests (order_id,user_id,description,status,refund_amount,processed_at) VALUES ($1,$2,'x','APPROVED',30,$3)`, [O1, c1, at('16:00')])
    await query(`INSERT INTO refund_requests (order_id,user_id,description,status,refund_amount,processed_at) VALUES ($1,$2,'x','APPROVED',200,$3)`, [O5, c2, at('16:00')])
    await query(`INSERT INTO refund_requests (order_id,user_id,description,status,refund_amount,processed_at) VALUES ($1,$2,'x','PENDING',999,$3)`, [O1, c1, at('16:00')])
    await query(`INSERT INTO payments (order_id,user_id,amount,refund_amount,updated_at) VALUES ($1,$2,320,50,$3)`, [O3, c1, at('17:00')])

    // ── store stock: rice at A (cost 30) with a return of 2 (O1 paid 40 each) and 4 damaged outside procurement ──
    spARice = (await query(`INSERT INTO shop_products (shop_id, product_id, stock_quantity, cost_price) VALUES ($1,$2,50,30) RETURNING id`, [A, rice])).rows[0].id
    spBOil = (await query(`INSERT INTO shop_products (shop_id, product_id, stock_quantity) VALUES ($1,$2,50) RETURNING id`, [B, oil])).rows[0].id
    const mv = (spid, shop, pid, type, delta, orderId = null, meta = {}) => query(
      `INSERT INTO stock_movements (shop_id, shop_product_id, product_id, type, quantity_delta, quantity_before, quantity_after, order_id, source, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,50,GREATEST(50+$5,0),$6,'DASHBOARD',$7,$8)`, [shop, spid, pid, type, delta, orderId, JSON.stringify(meta), at('18:00')])
    await mv(spARice, A, rice, 'RETURN_STOCK', 2, O1)
    await mv(spARice, A, rice, 'DAMAGED_STOCK', -4)
    await mv(spARice, A, rice, 'ORDER_DEDUCTION', -31)

    // ── procurement on the day: 100 rice @ 30 (2 damaged at the door), 3 wasted centrally, 5 returned to vendor; 40 sent to A.  10 oil @ 10 reserved for B2B ──
    const buy = (o) => procurement.createEntry({ vendorName: 'T14 Vendor', procuredOn: '2026-03-10', ...o }, { userId: mgr })
    const e1 = await buy({ productId: rice, expectedQty: 100, receivedQty: 100, damagedQty: 2, unitPrice: 30 })
    await procurement.allocate(e1.id, { allocations: [{ shopId: A, quantity: 40 }] }, { userId: mgr })
    await procurement.adjust(e1.id, { kind: 'WASTAGE', quantity: 3, reason: 'spoiled' }, { userId: mgr })
    await procurement.adjust(e1.id, { kind: 'VENDOR_RETURN', quantity: 5, reason: 'wrong grade' }, { userId: mgr })
    await buy({ productId: oil, expectedQty: 10, unitPrice: 10, purpose: 'B2B_RESERVED', reservationNote: 'Hotel' })
    // the procurement code stamped "now"; move those records onto the test day
    await query(`UPDATE procurement_adjustments SET created_at = $1 WHERE entry_id = $2`, [at('18:30'), e1.id])
    await query(`UPDATE stock_movements SET created_at = $1 WHERE shop_id = $2 AND type = 'PROCUREMENT_RECEIPT'`, [at('18:45'), A])
  })
  afterAll(async () => { await cleanup(); await closePool() })

  describe('overview — all stores, all customers', () => {
    let o
    beforeAll(async () => { o = await analytics.overview(DAY) })
    it('gross sales = placed orders only: 110 + 210 + 320 + 1000 = 1640 (pending, cancelled and other days left out)', () => {
      expect(o.cards.grossSales).toBe(1640)
      expect(o.counts).toMatchObject({ orders: 4, customers: 3 })
      expect(o.avgOrderValue).toBe(410)
    })
    it('refunds = 30 (request) + 50 (gateway, no request) = 80; the pending request and the cancelled order’s refund are not counted', () => {
      expect(o.cards.refunds).toBe(80)
      expect(o.counts.refundedOrders).toBe(2)
      expect(o.cards.netRevenue).toBe(1560)
    })
    it('cancelled value = only the order cancelled AFTER confirmation (500), not the expired unpaid one (77)', () => {
      expect(o.cards.cancelledValue).toBe(500)
      expect(o.counts.cancelledOrders).toBe(1)
    })
    it('commission on delivered orders = 100×10% + 300×20% + 1000×10% = 10 + 60 + 100 = 170', () => {
      expect(o.cards.commissionEarned).toBe(170)
      expect(o.counts.deliveredOrders).toBe(3)
    })
    it('returns = 2 units at the Rs 40 the customer paid = 80', () => {
      expect(o.cards.returns).toBe(80)
    })
    it('procurement cost = 100 × 30 + 10 × 10 = 3100', () => {
      expect(o.cards.procurementCost).toBe(3100)
    })
    it('tracked loss = 2 damaged at the door × 30 (60) + 3 wasted × 30 (90) + 4 damaged at store A × cost 30 (120) = 270; the vendor return is not a loss', () => {
      expect(o.cards.trackedLoss).toBe(270)
      expect(o.lossBreakdown).toMatchObject({ damagedAtReceiving: 60, procurementAdjustments: 90, storeDamage: 120 })
    })
    it('the daily series has the one day', () => {
      expect(o.series).toEqual([{ day: '2026-03-10', orders: 4, gross: 1640 }])
    })
    it('carries the definitions for the screen', () => {
      expect(o.definitions.trackedLoss).toMatch(/Vendor returns/)
    })
  })

  describe('filters', () => {
    it('B2B only: the one GST-snapshot order (1000), commission 100, the B2B-reserved purchase (100), no loss', async () => {
      const o = await analytics.overview({ ...DAY, channel: 'B2B' })
      expect(o.cards).toMatchObject({ grossSales: 1000, commissionEarned: 100, procurementCost: 100, trackedLoss: 0, refunds: 0, cancelledValue: 0 })
    })
    it('B2C only: gross 640, refunds 80, procurement 3000, loss 270', async () => {
      const o = await analytics.overview({ ...DAY, channel: 'B2C' })
      expect(o.cards).toMatchObject({ grossSales: 640, refunds: 80, commissionEarned: 70, procurementCost: 3000, trackedLoss: 270, cancelledValue: 500 })
    })
    it('store A: gross 110 + 210 + 1000 = 1320, refunds 30, commission 110, cost = the 40 units sent to A × 30 = 1200, loss = store damage 120', async () => {
      const o = await analytics.overview({ ...DAY, shopId: A })
      expect(o.cards).toMatchObject({ grossSales: 1320, refunds: 30, commissionEarned: 110, procurementCost: 1200, trackedLoss: 120, returns: 80, cancelledValue: 500 })
    })
    it('store B: gross 320, refunds 50, commission 60, nothing sent there', async () => {
      const o = await analytics.overview({ ...DAY, shopId: B })
      expect(o.cards).toMatchObject({ grossSales: 320, refunds: 50, commissionEarned: 60, procurementCost: 0, trackedLoss: 0 })
      expect(o.warnings[0]).toMatch(/No purchase was sent to this store/)
    })
    it('a quiet day is all zeros, not an error', async () => {
      const o = await analytics.overview({ period: 'custom', from: '2026-01-01', to: '2026-01-02' })
      expect(Object.values(o.cards).every((v) => v === 0)).toBe(true)
      expect(o.avgOrderValue).toBeNull()
    })
    it('refuses bad periods and channels', async () => {
      await expect(analytics.overview({ period: 'custom', from: '2026-03-10' })).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(analytics.overview({ period: 'custom', from: '2026-03-11', to: '2026-03-10' })).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(analytics.overview({ period: 'custom', from: '2024-01-01', to: '2026-03-10' })).rejects.toMatchObject({ code: 'RANGE_TOO_LONG' })
      await expect(analytics.overview({ ...DAY, channel: 'X' })).rejects.toMatchObject({ code: 'VALIDATION' })
    })
    it('the quick filters resolve to India days ending today', async () => {
      const o = await analytics.overview({ period: '7d' })
      expect(o).toMatchObject({ from: '2026-03-04', to: '2026-03-10', days: 7 })
      expect((await analytics.overview({ period: 'today' })).days).toBe(1)
    })
  })

  describe('products', () => {
    it('rice leads on revenue: 2 + 4 + 25 = 31 units, 80 + 160 + 1000 = 1240', async () => {
      const p = await analytics.products(DAY)
      expect(p.items[0]).toMatchObject({ name: 'T14 Rice', units: 31, revenue: 1240, orders: 3, buyers: 3 })
      expect(p.items[1]).toMatchObject({ name: 'T14 Oil', units: 18, revenue: 360 })
    })
    it('trending: oil sold 9 the day before and 18 today = +100%; rice is new', async () => {
      const p = await analytics.products({ ...DAY, sort: 'trending' })
      expect(p.items[0]).toMatchObject({ name: 'T14 Rice', isNew: true })
      expect(p.items.find((i) => i.name === 'T14 Oil')).toMatchObject({ previousUnits: 9, growthPct: 100, isNew: false })
    })
    it('can be narrowed to B2B', async () => {
      const p = await analytics.products({ ...DAY, channel: 'B2B' })
      expect(p.items).toHaveLength(1)
      expect(p.items[0]).toMatchObject({ name: 'T14 Rice', units: 25 })
    })
  })

  describe('customers', () => {
    it('top by spend: hotel 1000, Asha 110 + 320 = 430, Bikram 210; repeat = Asha (ordered the day before too) → 1 of 3', async () => {
      const c = await analytics.customers(DAY)
      expect(c.items.map((i) => [i.name, i.spend])).toEqual([['T14 Hotel Owner', 1000], ['T14 Asha', 430], ['T14 Bikram', 210]])
      expect(c.items.find((i) => i.name === 'T14 Asha')).toMatchObject({ orders: 2, isRepeat: true, avgOrderValue: 215 })
      expect(c.items[0].channel).toBe('B2B')
      expect(c.summary).toEqual({ customers: 3, repeatCustomers: 1, repeatRatePct: 33.3 })
    })
    it('B2B and B2C are separate views', async () => {
      expect((await analytics.customers({ ...DAY, channel: 'B2B' })).items).toHaveLength(1)
      expect((await analytics.customers({ ...DAY, channel: 'B2C' })).items).toHaveLength(2)
    })
  })

  describe('stores', () => {
    it('A: 3 orders, 1320 sales, 20+ units, refunds 30, returns 80, 1 cancellation (500), fulfilment avg of 30 and 90 min = 60', async () => {
      const s = await analytics.stores(DAY)
      const a = s.items.find((x) => x.shopId === A)
      expect(a).toMatchObject({ orders: 3, sales: 1320, avgOrderValue: 440, unitsSold: 2 + 1 + 4 + 2 + 25, refunds: 30, returns: 80, cancelledOrders: 1, cancelledValue: 500, avgFulfillmentMinutes: 60 })
      expect(a.stock).toEqual({ receivedUnits: 40, soldUnits: 31, damagedUnits: 4 })
      const b = s.items.find((x) => x.shopId === B)
      expect(b).toMatchObject({ orders: 1, sales: 320, refunds: 50, avgFulfillmentMinutes: 60 })
    })
    it('can be filtered to one store', async () => {
      expect((await analytics.stores({ ...DAY, shopId: B })).items.map((x) => x.shopId)).toEqual([B])
    })
  })

  describe('B2B vs B2C', () => {
    it('compares orders, sales, order value, customer value and top products', async () => {
      const c = await analytics.channels(DAY)
      expect(c.B2B).toMatchObject({ orders: 1, sales: 1000, customers: 1, avgOrderValue: 1000, valuePerCustomer: 1000 })
      expect(c.B2C).toMatchObject({ orders: 3, sales: 640, customers: 2 })
      expect(c.B2C.avgOrderValue).toBeCloseTo(213.33, 2)
      expect(c.b2bSharePct).toBe(61)
      expect(c.B2B.topProducts[0]).toMatchObject({ name: 'T14 Rice', units: 25 })
    })
  })

  describe('vendors and reconciliation reuse procurement', () => {
    it('vendor view', async () => {
      const v = await analytics.vendors(DAY)
      expect(v.totalValue).toBe(3100)
      expect(v.vendors[0]).toMatchObject({ name: 'T14 Vendor', entries: 2, purchaseValue: 3100 })
    })
    it('reconciliation: received 100 = 2 damaged + 8 central adjustments (3 + 5) + 40 sent + 50 still central', async () => {
      const r = await analytics.reconciliation({ ...DAY, productId: rice })
      const p = r.products[0]
      expect(p).toMatchObject({ received: 100, damagedAtDoor: 2, centralAdjusted: 8, allocated: 40, availableCentral: 50, purchaseCost: 3000, soldQty: 31, salesValue: 1240 })
      expect(p.received).toBe(p.damagedAtDoor + p.centralAdjusted + p.allocated + p.availableCentral)
    })
  })
})
