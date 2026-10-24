/**
 * Store dashboard, HQ dashboard strip, shop totals and the sidebar "new orders" count on the shared sales rules.
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/store-dashboard.db.test.js
 * All orders are placed "now" (India today) except one three days back, so the numbers are worked by hand:
 *
 *   Store A  a1 delivered 100 · a2 confirmed 60 (waiting to be accepted) · a3 refunded in full 200 · a4 cancelled 150
 *            a5 unpaid 80 (waiting for payment) · a6 delivered 100 three days ago, 40 refunded today
 *   Store B  b1 delivered 500
 *
 *   Store A today   placed a1 a2 a3 = 360 · refunds today a3 200 + a6 40 = 240 · kept 120 · orders that stood a1 a2 = 2
 *   Store A 30 days placed a1 a2 a3 a6 = 460 · refunds 240 · kept 220 · orders that stood a1 a2 a6 = 3 · average 73.33
 *   Store A lifetime orders 3, money kept 220 · Store B lifetime orders 1, money kept 500
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'

describe.skipIf(!enabled)('Store and HQ dashboards use the sales rules', () => {
  let app, query, closePool, hq, staffA, staffB, A, B, cust, p1, p2, p3, p4
  let n = 0
  const PERMS = ['shop_orders.view', 'shop_products.view']
  const get = (url, token, headers = {}) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}`, ...headers } })

  async function order({ shop, status, total, pay = 'PAID', ago = '0 days', expires = null }) {
    return (await query(
      `INSERT INTO orders (order_number,user_id,shop_id,status,items,subtotal,total_amount,delivery_address,payment_method,payment_status,created_at,payment_expires_at)
       VALUES ($1,$2,$3,$4::order_status,'[]'::jsonb,$5,$5,'{}'::jsonb,'ONLINE',$6, NOW() - $7::interval, $8) RETURNING id`,
      [`T28-${++n}`, cust, shop, status, total, pay, ago, expires])).rows[0].id
  }

  async function cleanup() {
    await query(`DELETE FROM refund_requests WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'T28-%')`)
    await query(`DELETE FROM orders WHERE order_number LIKE 'T28-%'`)
    await query(`DELETE FROM shop_products WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't28-shop-%')`)
    await query(`DELETE FROM products WHERE slug LIKE 't28-%'`)
    await query(`DELETE FROM shop_staff WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't28-shop-%')`)
    await query(`DELETE FROM audit_logs WHERE actor_shop_id IN (SELECT id FROM shops WHERE slug LIKE 't28-shop-%') OR actor_user_id IN (SELECT id FROM users WHERE phone LIKE '9999028%')`)
    await query(`DELETE FROM shops WHERE slug LIKE 't28-shop-%'`)
    await query(`DELETE FROM users WHERE phone LIKE '9999028%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { signAccessToken } = await import('../../src/utils/jwt.js')
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    await cleanup()
    const mkUser = async (i, role, platform = null) => {
      const phone = `9999028${String(i).padStart(3, '0')}`
      const id = (await query(`INSERT INTO users (phone,name,email,role,platform_role) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [phone, `T28 ${i}`, `${phone}@t.local`, role, platform])).rows[0].id
      return { id, phone }
    }
    const mkShop = async (c) => (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ($1,$2,$3,'DB 28','Kolkata','WB','700091',22.5,88.3,true) RETURNING id`, [`T28 Shop ${c}`, `t28-shop-${c.toLowerCase()}`, `T28${c}`])).rows[0].id
    A = await mkShop('A'); B = await mkShop('B')
    cust = (await mkUser(1, 'CUSTOMER')).id
    const h = await mkUser(2, 'ADMIN', 'SUPER_ADMIN')
    hq = signAccessToken({ id: h.id, phone: h.phone, role: 'ADMIN', platform_role: 'SUPER_ADMIN' })
    const sA = await mkUser(3, 'CUSTOMER'); const sB = await mkUser(4, 'CUSTOMER')
    await query(`INSERT INTO shop_staff (user_id, shop_id, role) VALUES ($1,$2,'SHOP_MANAGER'),($3,$4,'SHOP_MANAGER')`, [sA.id, A, sB.id, B])
    staffA = signAccessToken({ id: sA.id, phone: sA.phone, role: 'CUSTOMER', shopId: A, shopRole: 'SHOP_MANAGER', permissions: PERMS })
    staffB = signAccessToken({ id: sB.id, phone: sB.phone, role: 'CUSTOMER', shopId: B, shopRole: 'SHOP_MANAGER', permissions: PERMS })

    await order({ shop: A, status: 'DELIVERED', total: 100 })                                                                  // a1
    await order({ shop: A, status: 'CONFIRMED', total: 60 })                                                                   // a2
    const a3 = await order({ shop: A, status: 'REFUNDED', total: 200 })
    await query(`INSERT INTO refund_requests (order_id, user_id, description, status, refund_amount, refund_to, processed_at) VALUES ($1,$2,'t','APPROVED',200,'wallet',NOW())`, [a3, cust])
    await order({ shop: A, status: 'CANCELLED', total: 150 })                                                                  // a4
    await order({ shop: A, status: 'PENDING', total: 80, pay: 'PENDING', expires: new Date(Date.now() + 3600_000) })           // a5
    const a6 = await order({ shop: A, status: 'DELIVERED', total: 100, ago: '3 days' })
    await query(`INSERT INTO refund_requests (order_id, user_id, description, status, refund_amount, refund_to, processed_at) VALUES ($1,$2,'t','APPROVED',40,'wallet',NOW())`, [a6, cust])
    await order({ shop: B, status: 'DELIVERED', total: 500 })                                                                  // b1

    const mkP = async (slug) => (await query(`INSERT INTO products (name, slug, price, net_quantity) VALUES ($1,$2,50,'1 unit') RETURNING id`, [`T28 ${slug}`, `t28-${slug}`])).rows[0].id
    p1 = await mkP('low'); p2 = await mkP('out'); p3 = await mkP('fine'); p4 = await mkP('gone')
    const sp = (pid, stock, deleted = false) => query(`INSERT INTO shop_products (shop_id, product_id, stock_quantity, low_stock_threshold, price, deleted_at) VALUES ($1,$2,$3,5,50,${deleted ? 'NOW()' : 'NULL'})`, [A, pid, stock])
    await sp(p1, 2); await sp(p2, 0); await sp(p3, 50); await sp(p4, 1, true)
  }, 60_000)
  afterAll(async () => { await cleanup(); await app?.close(); await closePool() })

  describe('store dashboard  GET /shop-dashboard', () => {
    it("shows today's orders and money kept on the sales rules", async () => {
      const r = await get('/api/v1/shop-dashboard', staffA)
      expect(r.statusCode, r.body).toBe(200)
      const k = r.json().data.kpis
      expect(k).toMatchObject({ today_orders: 2, today_revenue: 120, pending_orders: 1, awaiting_payment: 1, avg_order_value: 73.33 })
    })
    it('counts stock: 3 live products, 2 low, 1 out; deleted ones are left out', async () => {
      const k = (await get('/api/v1/shop-dashboard', staffA)).json().data.kpis
      expect(k).toMatchObject({ total_products: 3, low_stock_count: 2, out_of_stock_count: 1 })
    })
    it('recent orders are the store\'s own placed or cancelled orders (not unpaid ones, not another store)', async () => {
      const rows = (await get('/api/v1/shop-dashboard', staffA)).json().data.recent_orders
      expect(rows).toHaveLength(5) // a1 a2 a3 a4 a6
      expect(rows.every((x) => x.order_number.startsWith('T28-'))).toBe(true)
      expect(rows.map((x) => x.status)).not.toContain('PENDING')
      expect(rows.map((x) => x.total_amount).sort((a, b) => a - b)).toEqual([60, 100, 100, 150, 200])
    })
    it('another store sees only its own numbers', async () => {
      const k = (await get('/api/v1/shop-dashboard', staffB)).json().data.kpis
      expect(k).toMatchObject({ today_orders: 1, today_revenue: 500, pending_orders: 0, total_products: 0, low_stock_count: 0 })
    })
    it('HQ pins a store with X-Shop-Id, and is refused without one; no token is refused', async () => {
      const ok = await get('/api/v1/shop-dashboard', hq, { 'x-shop-id': A })
      expect(ok.json().data.kpis.today_revenue).toBe(120)
      expect((await get('/api/v1/shop-dashboard', hq)).statusCode).toBe(400)
      expect((await app.inject({ method: 'GET', url: '/api/v1/shop-dashboard' })).statusCode).toBe(401)
    })
  })

  it('low stock badge: GET /shop-products/low-stock-count answers with the same number', async () => {
    const r = await get('/api/v1/shop-products/low-stock-count', staffA)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().data.count).toBe(2)
    expect((await get('/api/v1/shop-products/low-stock-count', staffB)).json().data.count).toBe(0)
  })

  describe('sidebar and pending actions', () => {
    it('"pending orders" = orders waiting to be accepted; unpaid ones are separate', async () => {
      const r = await get('/api/v1/admin/dashboard/pending-actions', hq, { 'x-shop-id': A })
      expect(r.statusCode, r.body).toBe(200)
      expect(r.json().data).toMatchObject({ pending_orders: 1, confirmed_orders: 1, awaiting_payment: 1 })
    })
  })

  describe('shops list and detail: lifetime orders and money kept', () => {
    it('detail shows the live numbers, not the never-updated stored counters', async () => {
      const r = await get(`/api/v1/shops/${A}`, hq)
      expect(r.statusCode, r.body).toBe(200)
      const s = r.json().data.shop ?? r.json().data
      expect(Number(s.total_orders)).toBe(3)
      expect(Number(s.total_revenue)).toBe(220)
    })
    it('list shows them per shop (a shop with no sales shows 0)', async () => {
      const r = await get('/api/v1/shops?search=T28%20Shop&limit=20', hq)
      expect(r.statusCode, r.body).toBe(200)
      const body = r.json()
      const list = body.data.shops ?? body.data
      const by = Object.fromEntries(list.map((s) => [s.name, s]))
      expect([Number(by['T28 Shop A'].total_orders), Number(by['T28 Shop A'].total_revenue)]).toEqual([3, 220])
      expect([Number(by['T28 Shop B'].total_orders), Number(by['T28 Shop B'].total_revenue)]).toEqual([1, 500])
    })
  })

  describe('HQ dashboard strip  GET /admin/dashboard/kpis', () => {
    it('for one store: lifetime money kept, orders that stood, buyers, today and new orders', async () => {
      const r = await get('/api/v1/admin/dashboard/kpis', hq, { 'x-shop-id': A })
      expect(r.statusCode, r.body).toBe(200)
      expect(r.json().data).toMatchObject({ totalRevenue: 220, totalOrders: 3, totalCustomers: 1, todayRevenue: 120, todayOrders: 2, pendingOrders: 1, totalShops: 1 })
      expect(r.json().data.avgOrderValue).toBeCloseTo(73.33, 2)
    })
  })
})
