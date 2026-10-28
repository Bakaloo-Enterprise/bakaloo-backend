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

  it('a demo viewer request leaves no scope behind for the next request', async () => {
    await get(tok.demo, '/api/v1/admin/orders?limit=5')
    const total = Number((await query(`SELECT count(*) FROM orders WHERE b2b_approval_status IS NULL`)).rows[0].count)
    const orders = await get(tok.admin, '/api/v1/admin/orders?limit=5')
    expect(orders.body.data.pagination.total).toBe(total)
    expect((await query('show search_path')).rows[0].search_path).not.toContain('demo_scope')
  })
})
