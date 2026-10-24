/**
 * The dashboard endpoints end to end (auth, validation, every legacy route still answering in its old shape).
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/overview-http.db.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'

describe.skipIf(!enabled)('Dashboard overview over HTTP', () => {
  let app, query, closePool, hq, customer, dev, restoreErp, store, storeShop, otherShop
  const call = (url, token) => app.inject({ method: 'GET', url: `/api/v1/admin/dashboard${url}`, headers: token ? { authorization: `Bearer ${token}` } : {} })
  const cleanup = async () => { await query(`DELETE FROM shops WHERE slug LIKE 't21-shop-%'`); await query(`DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE phone LIKE '9999021%')`); await query(`DELETE FROM users WHERE phone LIKE '9999021%'`) }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { signAccessToken } = await import('../../src/utils/jwt.js')
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    await cleanup()
    const mk = async (n, role, platform = null) => {
      const phone = `9999021${String(n).padStart(3, '0')}`
      const id = (await query(`INSERT INTO users (phone,name,email,role,platform_role) VALUES ($1,'T21',$2,$3,$4) RETURNING id`, [phone, `${phone}@t.local`, role, platform])).rows[0].id
      return signAccessToken({ id, phone, role, platform_role: platform })
    }
    hq = await mk(1, 'ADMIN', 'SUPER_ADMIN')
    customer = await mk(2, 'CUSTOMER')
    dev = await mk(3, 'ADMIN', 'SUPER_ADMIN')
    await query(`UPDATE users SET is_developer = true WHERE phone = '9999021003'`)
    // a store-level user: holds a role with the business permissions, but their token is pinned to ONE store
    const role = (await query(`SELECT id FROM roles WHERE name = 'Procurement Manager'`)).rows[0]?.id
    storeShop = (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ('T21 Store','t21-shop-a','T21A','DB 21','Kolkata','WB','700091',22.5,88.3,true) RETURNING id`)).rows[0].id
    otherShop = (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ('T21 Other','t21-shop-b','T21B','DB 21','Kolkata','WB','700091',22.5,88.3,true) RETURNING id`)).rows[0].id
    const sid = (await query(`INSERT INTO users (phone,name,email,role,role_id) VALUES ('9999021004','T21 Store','9999021004@t.local','ADMIN',$1) RETURNING id`, [role])).rows[0].id
    store = signAccessToken({ id: sid, phone: '9999021004', role: 'ADMIN', shopId: storeShop })
    // the 'erp' feature must start locked; remember its state so the test leaves it as it found it
    const was = (await query(`SELECT released FROM feature_flags WHERE key = 'erp'`)).rows[0]
    await query(`UPDATE feature_flags SET released = true WHERE key = 'erp'`) // released, so what is tested here is the permission and store rules
    restoreErp = () => query(`UPDATE feature_flags SET released = $1 WHERE key = 'erp'`, [was?.released ?? false])
  }, 60_000)
  afterAll(async () => { await restoreErp?.(); await cleanup(); await app?.close(); await closePool() })

  it('401 without a token, 403 for a customer', async () => {
    expect((await call('/overview')).statusCode).toBe(401)
    expect([401, 403]).toContain((await call('/overview', customer)).statusCode)
  })

  it('answers for every period and rejects an unknown one', async () => {
    for (const p of ['today', 'week', 'month', 'year']) {
      const r = await call(`/overview?period=${p}`, hq)
      expect(r.statusCode, p).toBe(200)
      const d = r.json().data
      expect(d.money).toEqual(expect.objectContaining({ grossSales: expect.any(Number), refunds: expect.any(Number), netRevenue: expect.any(Number) }))
      expect(d.series.length).toBe(d.days)
      expect(d.hours).toHaveLength(24)
      expect(Math.round((d.money.grossSales - d.money.refunds) * 100)).toBe(Math.round(d.money.netRevenue * 100))
    }
    expect((await call('/overview?period=decade', hq)).statusCode).toBe(400)
  })

  it('every older endpoint still answers (the dashboard pages that call them keep working)', async () => {
    for (const u of ['/stats?period=year', '/stats?period=today', '/kpis', '/revenue-chart?days=30', '/orders-by-hour', '/top-products?limit=5', '/category-revenue', '/live-stats', '/pending-actions', '/low-stock-alerts']) {
      const r = await call(u, hq)
      expect(r.statusCode, `${u}: ${r.body}`).toBe(200)
    }
    const stats = (await call('/stats?period=week', hq)).json().data
    expect(stats.revenue).toEqual(expect.objectContaining({ current: expect.any(Number), previous: expect.any(Number), sparkline: expect.any(Array) }))
    expect(stats.orders.sparkline.length).toBe(7)
  })

  describe('Operations ERP routes', () => {
    const erp = (url, token, method = 'GET', payload) => app.inject({ method, url: `/api/v1/admin/erp${url}`, payload, headers: token ? { authorization: `Bearer ${token}` } : {} })
    it('401 without a token', async () => {
      expect((await erp('/ops/day-close')).statusCode).toBe(401)
    })
    it('is locked ("in development") until a developer releases it', async () => {
      await query(`UPDATE feature_flags SET released = false WHERE key = 'erp'`)
      const r = await erp('/ops/forecast', hq)
      await query(`UPDATE feature_flags SET released = true WHERE key = 'erp'`)
      expect(r.statusCode).toBe(403)
      expect(r.json().code).toBe('FEATURE_LOCKED')
    })
    it('opens for a developer: day close, wastage and forecast answer', async () => {
      for (const u of ['/ops/day-close', '/ops/day-close?date=2026-03-10', '/ops/wastage', '/ops/wastage?period=7d', '/ops/forecast', '/ops/forecast?horizon=3&cover=2']) {
        const r = await erp(u, dev)
        expect(r.statusCode, `${u}: ${r.body}`).toBe(200)
      }
      expect((await erp('/ops/day-close?date=2026-13-45', dev)).statusCode).toBe(400)
      expect((await erp('/ops/forecast?horizon=99', dev)).statusCode).toBe(400)
    })
    it('rejects an invalid target and unknown product', async () => {
      expect((await erp('/ops/products/11111111-1111-1111-1111-111111111111/targets', dev, 'PATCH', { marginPct: 10 })).statusCode).toBe(404)
      expect((await erp('/ops/products/11111111-1111-1111-1111-111111111111/targets', dev, 'PATCH', { marginPct: 120 })).statusCode).toBe(400)
    })
  })

  describe('a store-level user', () => {
    const erp = (url, token, method = 'GET', payload) => app.inject({ method, url: `/api/v1/admin/erp${url}`, payload, headers: { authorization: `Bearer ${token}` } })
    it('is pinned to their own store even when they ask for another', async () => {
      const r = await erp(`/ops/day-close?shopId=${otherShop}`, store)
      expect(r.statusCode).toBe(200)
      expect(r.json().data.shopId).toBe(storeShop)
      expect((await erp(`/ops/forecast?shopId=${otherShop}`, store)).json().data.shopId).toBe(storeShop)
      expect((await erp(`/explorer/orders?shopId=${otherShop}`, store)).statusCode).toBe(200)
    })
    it('cannot open the whole-business screens', async () => {
      for (const u of ['/accounting/summary', '/accounting/journal', '/accounting/expenses', '/accounting/cash-entries', '/founder', '/explorer/expenses', '/explorer/expenses/export']) {
        const r = await erp(u, store)
        expect(r.statusCode, u).toBe(403)
        expect(r.json().code, u).toBe('HQ_ONLY')
      }
    })
    it('cannot record money or change catalogue-wide targets, nor write off stock in another store', async () => {
      const exp = await erp('/accounting/expenses', store, 'POST', { spentOn: '2026-03-01', category: 'RENT', amount: 10, paidVia: 'CASH' })
      expect(exp.statusCode).toBe(403)
      const tgt = await erp('/ops/products/11111111-1111-1111-1111-111111111111/targets', store, 'PATCH', { marginPct: 10 })
      expect(tgt.statusCode).toBe(403)
      const w = await erp('/ops/wastage', store, 'POST', { shopId: otherShop, productId: '11111111-1111-1111-1111-111111111111', quantity: 1, reason: 'Other' })
      expect(w.statusCode).toBe(403)
      expect(w.json().code).toBe('CROSS_SHOP_ACCESS_DENIED')
    })
    it('a head-office user still sees everything', async () => {
      for (const u of ['/accounting/summary?month=2026-03', '/founder?month=2026-03']) expect((await erp(u, hq)).statusCode, u).toBe(200)
    })
  })

  describe('Reports endpoints', () => {
    const rep = (url) => app.inject({ method: 'GET', url: `/api/v1/admin/reports${url}`, headers: { authorization: `Bearer ${hq}` } })
    it('every sales report answers for the head office', async () => {
      for (const t of ['gmv', 'orders', 'revenue', 'refunds', 'shop-performance', 'top-shops', 'top-products', 'rider-performance', 'coupon-usage']) {
        const r = await rep(`/${t}?from=2026-01-01&to=2026-03-31`)
        expect(r.statusCode, `${t}: ${r.body.slice(0, 200)}`).toBe(200)
        expect(Array.isArray(r.json().data), t).toBe(true)
      }
    })
    it('a date that does not exist is a 400, not a server error', async () => {
      expect((await rep('/revenue?from=2026-02-30')).statusCode).toBe(400)
    })
  })
})
