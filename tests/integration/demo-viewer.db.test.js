/**
 * Demo viewer (migration 171) through the real app: it limits ONLY the demo viewer; every other account is untouched.
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/demo-viewer.db.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PH = (n) => `9999041${String(n).padStart(3, '0')}`

describe.skipIf(!enabled)('Demo viewer account', () => {
  let app, query, closePool, tok, demoCustomerIds
  const get = async (token, url) => {
    const r = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
    return { status: r.statusCode, body: r.json() }
  }
  const cleanup = () => query(`DELETE FROM users WHERE phone LIKE '9999041%'`)

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { signAccessToken } = await import('../../src/utils/jwt.js')
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    await cleanup()
    const mk = async (n, name, { platform, dev = false, demo = false }) => {
      const { rows } = await query(
        `INSERT INTO users (phone,name,email,role,platform_role,is_developer,is_demo_viewer)
         VALUES ($1,$2,$3,'ADMIN',$4,$5,$6) RETURNING id, session_version`,
        [PH(n), name, `${PH(n)}@t.local`, platform, dev, demo],
      )
      return signAccessToken({ id: rows[0].id, phone: PH(n), role: 'ADMIN', platform_role: platform, session_version: rows[0].session_version })
    }
    tok = {
      admin: await mk(1, 'T Admin', { platform: 'ADMIN' }),
      superAdmin: await mk(2, 'T Super', { platform: 'SUPER_ADMIN' }),
      developer: await mk(3, 'T Dev', { platform: 'SUPER_ADMIN', dev: true }),
      demo: await mk(4, 'T Demo', { platform: 'ADMIN', demo: true }),
    }
    // two demo customers (re-marked afterwards) so the demo viewer has something to see
    const { rows } = await query(`SELECT id FROM users WHERE role = 'CUSTOMER' AND NOT is_demo_customer AND id IN (SELECT user_id FROM orders) LIMIT 2`)
    demoCustomerIds = rows.map((r) => r.id)
    await query(`UPDATE users SET is_demo_customer = true WHERE id = ANY($1)`, [demoCustomerIds])
  }, 60_000)

  afterAll(async () => {
    if (demoCustomerIds) await query(`UPDATE users SET is_demo_customer = false WHERE id = ANY($1)`, [demoCustomerIds])
    await cleanup()
    await app.close()
    await closePool()
  })

  it('normal admin, super admin and developer are never scoped, masked or locked', async () => {
    const total = Number((await query(`SELECT count(*) FROM orders WHERE b2b_approval_status IS NULL`)).rows[0].count)
    const customers = Number((await query(`SELECT count(*) FROM users WHERE role = 'CUSTOMER'`)).rows[0].count)
    for (const who of ['admin', 'superAdmin', 'developer']) {
      const list = await get(tok[who], '/api/v1/admin/customers?limit=5')
      expect(list.status, who).toBe(200)
      expect(list.body.data.pagination.total, who).toBe(customers)
      for (const c of list.body.data.customers) {
        expect(c.phone, who).not.toContain('•')
        expect(c.name || '', who).not.toContain('•')
      }
      const orders = await get(tok[who], '/api/v1/admin/orders?limit=5')
      expect(orders.body.data.pagination.total, who).toBe(total)
      const feat = await get(tok[who], '/api/v1/admin/features')
      expect(feat.body.data.isDemoViewer, who).toBe(false)
    }
  })

  it('locked features stay locked for a normal admin and open for a developer (demo viewers are not a back door)', async () => {
    const url = '/api/v1/admin/crm/conversations'
    const rel = (await query(`SELECT released FROM feature_flags WHERE key = 'whatsapp_crm'`)).rows[0].released
    await query(`UPDATE feature_flags SET released = false WHERE key = 'whatsapp_crm'`)
    try {
      expect((await get(tok.admin, url)).status).toBe(403)
      expect((await get(tok.superAdmin, url)).status).toBe(403)
      expect((await get(tok.developer, url)).status).toBe(200)
      expect((await get(tok.demo, url)).status).toBe(200)
    } finally {
      await query(`UPDATE feature_flags SET released = $1 WHERE key = 'whatsapp_crm'`, [rel])
    }
  })

  it('the demo viewer sees only demo customers\' orders, and blurred strangers in the customer list', async () => {
    // every demo customer in the database (the test's own two plus any marked earlier), not only the test's
    const allDemo = (await query(`SELECT id FROM users WHERE is_demo_customer`)).rows.map((r) => r.id)
    const demoOrders = Number((await query(`SELECT count(*) FROM orders WHERE b2b_approval_status IS NULL AND user_id = ANY($1)`, [allDemo])).rows[0].count)
    const orders = await get(tok.demo, '/api/v1/admin/orders?limit=100')
    expect(orders.body.data.pagination.total).toBe(demoOrders)
    expect(orders.body.data.orders.every((o) => allDemo.includes(o.user_id))).toBe(true)

    const list = await get(tok.demo, '/api/v1/admin/customers?limit=50')
    const foreign = list.body.data.customers.filter((c) => !allDemo.includes(c.id))
    expect(foreign.length).toBeGreaterThan(0)
    for (const c of foreign) expect(c.phone).toContain('•')
  })

  it('the demo viewer can look but not change or send anything; everyone else can still write', async () => {
    const any = (await query(`SELECT id FROM users WHERE role = 'CUSTOMER' LIMIT 1`)).rows[0].id
    const send = (method, url, token, payload = {}) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } })
    const attempts = [
      ['PUT', `/api/v1/admin/customers/${any}/block`],
      ['POST', `/api/v1/admin/customers/${any}/credit-wallet`],
      ['POST', `/api/v1/admin/customers/${any}/debit-wallet`],
      ['POST', `/api/v1/admin/customers/${any}/notify`],
      ['POST', '/api/v1/admin/notifications/send-bulk'],
      ['POST', '/api/v1/admin/crm/conversations/00000000-0000-0000-0000-000000000000/messages'],
      ['DELETE', '/api/v1/admin/products/00000000-0000-0000-0000-000000000000'],
      ['PUT', '/api/v1/admin/themes/00000000-0000-0000-0000-000000000000'],
      ['POST', '/api/v1/admin/orders/00000000-0000-0000-0000-000000000000/refund'],
      ['POST', '/api/v1/wallet/admin/00000000-0000-0000-0000-000000000000/credit'],
    ]
    for (const [m, u] of attempts) {
      const demo = await send(m, u, tok.demo)
      expect(demo.statusCode, `${m} ${u}`).toBe(403)
      expect(demo.json().code, `${m} ${u}`).toBe('DEMO_READ_ONLY')
      expect(demo.json().message).toContain('Submit is not eligible')
      // the same call from a normal admin is never stopped by the demo gate (it may fail validation / not-found for its own reasons)
      const admin = await send(m, u, tok.admin)
      expect(admin.json()?.code, `admin ${m} ${u}`).not.toBe('DEMO_READ_ONLY')
    }
    // signing in is still possible for the demo account
    const login = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: { email: 'nobody@t.local', password: 'x' } })
    expect(login.json()?.code).not.toBe('DEMO_READ_ONLY')
  })

  it('WhatsApp settings: the demo viewer gets fake sample values, never the real connection', async () => {
    const real = await get(tok.admin, '/api/v1/admin/crm/settings')
    const demo = await get(tok.demo, '/api/v1/admin/crm/settings')
    expect(demo.status).toBe(200)
    expect(demo.body.data.canManage).toBe(true) // form is shown with sample values; saving is refused below
    const f = demo.body.data.fields
    expect(f.phoneNumberId.value).toMatch(/^DEMO-/)
    expect(f.accessToken.masked).toMatch(/^DEMO/)
    expect(f.verifyToken.value).toBe('demo-verify-token-not-real')
    // nothing from the real configuration appears anywhere in the demo response
    const text = JSON.stringify(demo.body)
    const realF = real.body.data?.fields || {}
    for (const v of [realF.phoneNumberId?.value, realF.wabaId?.value, realF.appId?.value, realF.verifyToken?.value, realF.accessToken?.masked]) {
      if (v && String(v).length > 5) expect(text).not.toContain(String(v))
    }
    expect(JSON.stringify(demo.body.data.webhook.callbackUrl)).toContain('demo.example.com')
    const save = await app.inject({ method: 'PUT', url: '/api/v1/admin/crm/settings', payload: { phoneNumberId: '1' }, headers: { authorization: `Bearer ${tok.demo}` } })
    expect(save.json().code).toBe('DEMO_READ_ONLY')
  })

  it('every WhatsApp settings button is refused for the demo viewer and the saved connection is left untouched', async () => {
    const before = JSON.stringify((await query(`SELECT * FROM wa_settings`)).rows)
    const press = (method, url, payload = {}) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${tok.demo}` } })
    const buttons = [
      ['DELETE', '/api/v1/admin/crm/settings/credentials'], // "Remove saved details" -> "Yes, remove"
      ['PUT', '/api/v1/admin/crm/settings'],                // "Save only" / "Save & test connection" / "Generate a secure token"
      ['POST', '/api/v1/admin/crm/settings/test'],          // "Test connection" / "Send test message"
      ['POST', '/api/v1/admin/crm/settings/enable'],        // "Switch WhatsApp off"
      ['POST', '/api/v1/admin/crm/settings/connect-replies'],
    ]
    for (const [m, u] of buttons) {
      const r = await press(m, u, m === 'POST' && u.endsWith('enable') ? { enabled: false } : m === 'PUT' ? { phoneNumberId: 'X' } : {})
      expect(r.statusCode, `${m} ${u}`).toBe(403)
      expect(r.json().code, `${m} ${u}`).toBe('DEMO_READ_ONLY')
    }
    expect(JSON.stringify((await query(`SELECT * FROM wa_settings`)).rows)).toBe(before)
  })

  it('a demo viewer request leaves no scope behind for the next request', async () => {
    await get(tok.demo, '/api/v1/admin/orders?limit=5')
    const total = Number((await query(`SELECT count(*) FROM orders WHERE b2b_approval_status IS NULL`)).rows[0].count)
    const orders = await get(tok.admin, '/api/v1/admin/orders?limit=5')
    expect(orders.body.data.pagination.total).toBe(total)
    expect((await query('show search_path')).rows[0].search_path).not.toContain('demo_scope')
  })
})
