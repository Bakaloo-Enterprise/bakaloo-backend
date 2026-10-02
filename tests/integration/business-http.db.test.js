/**
 * Phase 12 HTTP layer: authentication, permissions, validation and the file upload, through the real app.
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/business-http.db.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PH = (n) => `9999019${String(n).padStart(3, '0')}`

describe.skipIf(!enabled)('Business routes over HTTP', () => {
  let restoreFeatures, app, query, closePool, tok, shop, product
  const call = (method, url, { token, payload, headers } = {}) =>
    app.inject({ method, url: `/api/v1/admin${url}`, payload, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } })

  async function cleanup() {
    await query(`DELETE FROM catalog_bulk_batches WHERE created_by IN (SELECT id FROM users WHERE phone LIKE '9999019%')`)
    await query(`DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE phone LIKE '9999019%')`)
    await query(`DELETE FROM procurement_adjustments WHERE entry_id IN (SELECT id FROM procurement_entries WHERE product_id IN (SELECT id FROM products WHERE slug LIKE 't15-%'))`)
    await query(`DELETE FROM procurement_allocations WHERE entry_id IN (SELECT id FROM procurement_entries WHERE product_id IN (SELECT id FROM products WHERE slug LIKE 't15-%'))`)
    await query(`DELETE FROM procurement_entries WHERE product_id IN (SELECT id FROM products WHERE slug LIKE 't15-%')`)
    await query(`DELETE FROM stock_movements WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't15-shop-%')`)
    await query(`DELETE FROM shop_products WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't15-shop-%')`)
    await query(`DELETE FROM vendors WHERE name LIKE 'T15 %'`)
    await query(`DELETE FROM products WHERE slug LIKE 't15-%'`)
    await query(`DELETE FROM shops WHERE slug LIKE 't15-shop-%'`)
    await query(`DELETE FROM users WHERE phone LIKE '9999019%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { signAccessToken } = await import('../../src/utils/jwt.js')
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    restoreFeatures = await (await import('../helpers/features.js')).releaseFeatures(query)
    await cleanup()
    const role = async (name) => (await query(`SELECT id FROM roles WHERE name = $1`, [name])).rows[0]?.id
    const mk = async (n, name, { r = 'ADMIN', roleName = null, platform = null } = {}) => {
      const id = (await query(`INSERT INTO users (phone,name,email,role,platform_role,role_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [PH(n), name, `${PH(n)}@t.local`, r, platform, roleName ? await role(roleName) : null])).rows[0].id
      return signAccessToken({ id, phone: PH(n), role: r, platform_role: platform })
    }
    tok = {
      hq: await mk(1, 'T15 HQ', { platform: 'SUPER_ADMIN' }), proc: await mk(2, 'T15 Proc', { roleName: 'Procurement Manager' }), agent: await mk(3, 'T15 Agent', { roleName: 'CRM Agent' }),
      customer: await mk(4, 'T15 Customer', { r: 'CUSTOMER' }),
    }
    shop = (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ('T15 Shop','t15-shop-1','T15','DB 12','Kolkata','WB','700091',22.5,88.3,true) RETURNING id`)).rows[0].id
    product = (await query(`INSERT INTO products (name, slug, price, sku, net_quantity) VALUES ('T15 Tomato','t15-tomato',40,'T15-TOM','1 kg') RETURNING id`)).rows[0].id
    await query(`INSERT INTO shop_products (shop_id, product_id, stock_quantity) VALUES ($1,$2,5)`, [shop, product])
  }, 60_000)
  afterAll(async () => { await restoreFeatures?.(); await cleanup(); await app?.close(); await closePool() })

  const FAMILIES = [
    ['GET', '/procurement/entries'], ['GET', '/procurement/vendors'], ['GET', '/procurement/reports/reconciliation'], ['GET', '/catalog-bulk/uploads'], ['GET', '/catalog-bulk/template'],
    ['GET', '/business-analytics/overview'], ['GET', '/business-analytics/products'], ['GET', '/business-analytics/stores'],
  ]

  it('401 without a token — even with a bad body or query', async () => {
    for (const [m, u] of FAMILIES) expect((await call(m, u)).statusCode, `${m} ${u}`).toBe(401)
    expect((await call('POST', '/procurement/entries', { payload: { nope: 1 } })).statusCode).toBe(401)
    expect((await call('GET', '/business-analytics/overview?channel=ZZ')).statusCode).toBe(401)
  })
  it('403 for a customer and for an admin role without the permission', async () => {
    for (const t of [tok.customer, tok.agent]) for (const [m, u] of FAMILIES) expect((await call(m, u, { token: t })).statusCode, `${t === tok.agent ? 'agent' : 'customer'} ${u}`).toBe(403)
    expect((await call('POST', '/procurement/entries', { token: tok.agent, payload: {} })).statusCode).toBe(403)
  })
  it('the Procurement Manager role and HQ can open every screen', async () => {
    for (const t of [tok.proc, tok.hq]) for (const [m, u] of FAMILIES.filter(([, u]) => u !== '/catalog-bulk/template')) expect((await call(m, u, { token: t })).statusCode, u).toBe(200)
  })

  it('/me tells each person which screens they may use (and still needs a sign-in)', async () => {
    expect((await call('GET', '/procurement/me')).statusCode).toBe(401)
    expect((await call('GET', '/procurement/me', { token: tok.customer })).statusCode).toBe(403)
    expect((await call('GET', '/procurement/me', { token: tok.proc })).json().data).toEqual({ procurementView: true, procurementManage: true, catalogBulk: true, analyticsBusiness: true })
    expect((await call('GET', '/procurement/me', { token: tok.agent })).json().data).toEqual({ procurementView: false, procurementManage: false, catalogBulk: false, analyticsBusiness: false })
    expect((await call('GET', '/procurement/me', { token: tok.hq })).json().data.analyticsBusiness).toBe(true)
  })

  describe('procurement', () => {
    let entryId
    it('validates bodies (400) before doing anything', async () => {
      expect((await call('POST', '/procurement/entries', { token: tok.proc, payload: { productId: product } })).statusCode).toBe(400) // no price
      expect((await call('POST', '/procurement/entries', { token: tok.proc, payload: { productId: 'nope', unitPrice: 1 } })).statusCode).toBe(400)
      const noVendor = await call('POST', '/procurement/entries', { token: tok.proc, payload: { productId: product, unitPrice: 28, expectedQty: 10 } })
      expect(noVendor.statusCode).toBe(400)
      expect(noVendor.json().code).toBe('VALIDATION')
    })
    it('records a purchase, splits it, refuses an over-split with 409, and reads it back', async () => {
      const made = await call('POST', '/procurement/entries', { token: tok.proc, payload: { productId: product, vendorName: 'T15 Vendor', expectedQty: 10, unitPrice: 28 } })
      expect(made.statusCode).toBe(200)
      entryId = made.json().data.id
      expect(made.json().data).toMatchObject({ purchaseTotal: 280, available: 10 })
      const over = await call('POST', `/procurement/entries/${entryId}/allocations`, { token: tok.proc, payload: { allocations: [{ shopId: shop, quantity: 11 }] } })
      expect(over.statusCode).toBe(409)
      expect(over.json().code).toBe('OVER_ALLOCATION')
      const ok = await call('POST', `/procurement/entries/${entryId}/allocations`, { token: tok.proc, payload: { allocations: [{ shopId: shop, quantity: 4 }] } })
      expect(ok.json().data).toMatchObject({ allocated: 4, available: 6 })
      expect(Number((await query(`SELECT stock_quantity FROM shop_products WHERE shop_id=$1 AND product_id=$2`, [shop, product])).rows[0].stock_quantity)).toBe(9)
      expect((await call('GET', `/procurement/entries/${entryId}`, { token: tok.proc })).json().data.allocations).toHaveLength(1)
      expect((await call('GET', '/procurement/entries?search=T15', { token: tok.proc })).json().data.total).toBeGreaterThanOrEqual(1)
    })
    it('404 for a missing purchase; unknown query values are rejected', async () => {
      expect((await call('GET', '/procurement/entries/00000000-0000-4000-8000-000000000000', { token: tok.proc })).statusCode).toBe(404)
      expect((await call('GET', '/procurement/entries/not-a-uuid', { token: tok.proc })).statusCode).toBe(400)
      expect((await call('GET', '/procurement/reports/vendors?period=forever', { token: tok.proc })).statusCode).toBe(400)
    })
    it('adjustment needs a reason', async () => {
      expect((await call('POST', `/procurement/entries/${entryId}/adjustments`, { token: tok.proc, payload: { kind: 'DAMAGE', quantity: 1 } })).statusCode).toBe(400)
      expect((await call('POST', `/procurement/entries/${entryId}/adjustments`, { token: tok.proc, payload: { kind: 'DAMAGE', quantity: 1, reason: 'dropped' } })).json().data.available).toBe(5)
    })
  })

  describe('bulk catalog', () => {
    const multipart = (name, content) => {
      const b = '----t15boundary'
      return {
        headers: { 'content-type': `multipart/form-data; boundary=${b}` },
        payload: `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/csv\r\n\r\n${content}\r\n--${b}--\r\n`,
      }
    }
    let batchId
    it('serves the template as an Excel file', async () => {
      const r = await call('GET', '/catalog-bulk/template', { token: tok.proc })
      expect(r.statusCode).toBe(200)
      expect(r.headers['content-type']).toMatch(/spreadsheetml/)
      expect(r.rawPayload.subarray(0, 2).toString()).toBe('PK')
    })
    it('upload makes a preview and changes nothing; a bad sheet is a clear 400', async () => {
      const up = await call('POST', '/catalog-bulk/uploads', { token: tok.proc, ...multipart('s.csv', 'SKU,Branch Code,Stock,Retail Price\nT15-TOM,T15,20,45\nT15-NOPE,T15,1,\n') })
      expect(up.statusCode).toBe(200)
      batchId = up.json().data.id
      expect(up.json().data.totals).toMatchObject({ rows: 2, valid: 1, errors: 1 })
      expect(Number((await query(`SELECT stock_quantity FROM shop_products WHERE shop_id=$1 AND product_id=$2`, [shop, product])).rows[0].stock_quantity)).toBe(9)
      const bad = await call('POST', '/catalog-bulk/uploads', { token: tok.proc, ...multipart('s.csv', 'Name,Colour\na,b\n') })
      expect(bad.statusCode).toBe(400)
      expect(bad.json().code).toBe('MISSING_PRODUCT_COLUMN')
      const none = await call('POST', '/catalog-bulk/uploads', { token: tok.proc, headers: { 'content-type': 'application/json' }, payload: '{}' })
      expect(none.statusCode).toBeGreaterThanOrEqual(400)
    })
    it('lists the rows with their problems', async () => {
      const rows = await call('GET', `/catalog-bulk/uploads/${batchId}/rows?status=ERROR`, { token: tok.proc })
      expect(rows.json().data.items[0].errors[0]).toMatch(/No product found/)
    })
    it('applying needs an explicit confirm, and errors need an explicit skip', async () => {
      expect((await call('POST', `/catalog-bulk/uploads/${batchId}/apply`, { token: tok.proc, payload: {} })).json().code).toBe('CONFIRM_REQUIRED')
      const blocked = await call('POST', `/catalog-bulk/uploads/${batchId}/apply`, { token: tok.proc, payload: { confirm: true } })
      expect(blocked.statusCode).toBe(409)
      expect(blocked.json().code).toBe('HAS_ERRORS')
      const done = await call('POST', `/catalog-bulk/uploads/${batchId}/apply`, { token: tok.proc, payload: { confirm: true, skipErrors: true } })
      expect(done.statusCode).toBe(200)
      expect(done.json().data.result).toMatchObject({ appliedRows: 1, skippedRows: 1 })
      const row = (await query(`SELECT stock_quantity, price FROM shop_products WHERE shop_id=$1 AND product_id=$2`, [shop, product])).rows[0]
      expect([row.stock_quantity, Number(row.price)]).toEqual([20, 45])
    })
    it('bulk availability validates and previews', async () => {
      expect((await call('POST', '/catalog-bulk/availability', { token: tok.proc, payload: { action: 'DISABLE', productIds: [], shopIds: [shop] } })).statusCode).toBe(400)
      const dry = await call('POST', '/catalog-bulk/availability', { token: tok.proc, payload: { action: 'DISABLE', productIds: [product], shopIds: [shop] } })
      expect(dry.json().data).toMatchObject({ dryRun: true, willChange: 1, applied: 0 })
    })
  })

  describe('business analytics', () => {
    it('validates filters', async () => {
      expect((await call('GET', '/business-analytics/overview?channel=ZZ', { token: tok.proc })).statusCode).toBe(400)
      expect((await call('GET', '/business-analytics/overview?period=custom&from=2026-03-10', { token: tok.proc })).statusCode).toBe(400)
      expect((await call('GET', '/business-analytics/products?sort=best', { token: tok.proc })).statusCode).toBe(400)
      expect((await call('GET', '/business-analytics/overview?shopId=abc', { token: tok.proc })).statusCode).toBe(400)
    })
    it('returns the cards and the definitions', async () => {
      const r = await call('GET', '/business-analytics/overview?period=30d', { token: tok.proc })
      expect(Object.keys(r.json().data.cards)).toEqual(['grossSales', 'netRevenue', 'procurementCost', 'commissionEarned', 'refunds', 'returns', 'cancelledValue', 'trackedLoss'])
      expect(r.json().data.definitions.grossSales).toBeTruthy()
    })
  })
})
