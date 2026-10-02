/**
 * Feature locks + Developer Super Admin (migration 154), through the real app.
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/feature-locks.db.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PH = (n) => `9999031${String(n).padStart(3, '0')}`

describe.skipIf(!enabled)('Feature locks and Developer Super Admin', () => {
  let app, query, closePool, tok, ids, savedFlags
  const call = (method, url, { token, payload } = {}) =>
    app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} })

  const LOCKED = [
    '/api/v1/admin/crm/conversations',
    '/api/v1/admin/crm/templates',
    '/api/v1/admin/chat/channels',
    '/api/v1/admin/procurement/vendors',
    '/api/v1/admin/catalog-bulk/uploads',
    '/api/v1/admin/business-analytics/overview',
    '/api/v1/pos/me',
  ]
  const setReleased = (key, released) => query(`UPDATE feature_flags SET released = $2 WHERE key = $1`, [key, released])

  async function cleanup() {
    await query(`DELETE FROM feature_grants WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '9999031%')`)
    await query(`DELETE FROM admin_activity_log WHERE admin_id IN (SELECT id FROM users WHERE phone LIKE '9999031%')`)
    await query(`DELETE FROM users WHERE phone LIKE '9999031%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { signAccessToken } = await import('../../src/utils/jwt.js')
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    await cleanup()
    savedFlags = (await query(`SELECT key, released FROM feature_flags`)).rows
    await query(`UPDATE feature_flags SET released = false`)
    const mk = async (n, name, { platform, dev = false }) => {
      const id = (await query(
        `INSERT INTO users (phone,name,email,role,platform_role,is_developer) VALUES ($1,$2,$3,'ADMIN',$4,$5) RETURNING id`,
        [PH(n), name, `${PH(n)}@t.local`, platform, dev],
      )).rows[0].id
      return { id, token: signAccessToken({ id, phone: PH(n), role: 'ADMIN', platform_role: platform }) }
    }
    const u = {
      admin: await mk(1, 'T Admin', { platform: 'ADMIN' }),
      superAdmin: await mk(2, 'T Super', { platform: 'SUPER_ADMIN' }),
      dev: await mk(3, 'T Dev', { platform: 'SUPER_ADMIN', dev: true }),
      dev2: await mk(4, 'T Dev Two', { platform: 'ADMIN', dev: true }),
      support: await mk(5, 'T Support', { platform: 'HQ_SUPPORT' }),
    }
    tok = Object.fromEntries(Object.entries(u).map(([k, v]) => [k, v.token]))
    ids = Object.fromEntries(Object.entries(u).map(([k, v]) => [k, v.id]))
  }, 60_000)

  afterAll(async () => {
    for (const r of savedFlags || []) await setReleased(r.key, r.released)
    await cleanup()
    await app?.close()
    await closePool()
  })

  it('a locked feature is FEATURE_LOCKED for Admin AND Super Admin, on every locked prefix', async () => {
    for (const url of LOCKED) {
      for (const who of ['admin', 'superAdmin', 'support']) {
        const r = await call('GET', url, { token: tok[who] })
        expect(r.statusCode, `${who} ${url}`).toBe(403)
        expect(r.json().code, `${who} ${url}`).toBe('FEATURE_LOCKED')
      }
    }
  })

  it('writes are locked too, not just reads', async () => {
    const r = await call('POST', '/api/v1/admin/chat/channels', { token: tok.admin, payload: { name: 'x', type: 'GROUP' } })
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('FEATURE_LOCKED')
  })

  it('an unauthenticated caller still gets a plain 401, not a lock message', async () => {
    for (const url of LOCKED) expect((await call('GET', url)).statusCode, url).toBe(401)
  })

  it('a Developer Super Admin passes every lock', async () => {
    for (const url of LOCKED.filter((u) => !u.startsWith('/api/v1/pos'))) {
      for (const who of ['dev', 'dev2']) {
        const r = await call('GET', url, { token: tok[who] })
        expect(r.json().code, `${who} ${url}`).not.toBe('FEATURE_LOCKED')
        expect(r.statusCode, `${who} ${url}`).toBeLessThan(500)
      }
    }
    expect((await call('GET', '/api/v1/admin/crm/conversations', { token: tok.dev })).statusCode).toBe(200)
  })

  it('everything that is not a locked feature is untouched for ordinary admins', async () => {
    for (const url of ['/api/v1/admin/orders', '/api/v1/admin/customers', '/api/v1/admin/settings']) {
      const r = await call('GET', url, { token: tok.admin })
      expect(r.statusCode, url).toBe(200)
    }
  })

  it('/admin/features tells each person what is locked for them', async () => {
    const a = (await call('GET', '/api/v1/admin/features', { token: tok.admin })).json().data
    expect(a.isDeveloper).toBe(false)
    expect(a.features.whatsapp_crm).toMatchObject({ released: false, canAccess: false })
    const d = (await call('GET', '/api/v1/admin/features', { token: tok.dev })).json().data
    expect(d.isDeveloper).toBe(true)
    expect(d.features.whatsapp_crm).toMatchObject({ released: false, canAccess: true })
    expect((await call('GET', '/api/v1/admin/features')).statusCode).toBe(401)
  })

  it('only a developer can use the developer endpoints', async () => {
    for (const who of ['admin', 'superAdmin']) {
      for (const [m, u, p] of [
        ['GET', '/api/v1/admin/developer/overview'],
        ['GET', '/api/v1/admin/developer/users'],
        ['PUT', '/api/v1/admin/developer/features/team_chat', { released: true }],
        ['PUT', `/api/v1/admin/developer/features/team_chat/grants/${ids.admin}`],
        ['PUT', `/api/v1/admin/developer/users/${ids.admin}/developer`, { isDeveloper: true }],
      ]) {
        const r = await call(m, u, { token: tok[who], payload: p })
        expect(r.statusCode, `${who} ${m} ${u}`).toBe(403)
        expect(r.json().code).toBe('DEVELOPER_ONLY')
      }
    }
    // …and the failed attempts changed nothing.
    expect((await query(`SELECT released FROM feature_flags WHERE key='team_chat'`)).rows[0].released).toBe(false)
    expect((await query(`SELECT is_developer FROM users WHERE id=$1`, [ids.admin])).rows[0].is_developer).toBe(false)
    expect((await call('GET', '/api/v1/admin/developer/overview')).statusCode).toBe(401)
  })

  it('granting one person early access opens just that feature for just that person; revoking locks it again', async () => {
    const put = await call('PUT', `/api/v1/admin/developer/features/team_chat/grants/${ids.admin}`, { token: tok.dev })
    expect(put.statusCode).toBe(200)
    expect((await call('GET', '/api/v1/admin/chat/channels', { token: tok.admin })).json().code).not.toBe('FEATURE_LOCKED')
    expect((await call('GET', '/api/v1/admin/crm/conversations', { token: tok.admin })).json().code).toBe('FEATURE_LOCKED')
    expect((await call('GET', '/api/v1/admin/chat/channels', { token: tok.superAdmin })).json().code).toBe('FEATURE_LOCKED')
    await call('DELETE', `/api/v1/admin/developer/features/team_chat/grants/${ids.admin}`, { token: tok.dev })
    expect((await call('GET', '/api/v1/admin/chat/channels', { token: tok.admin })).json().code).toBe('FEATURE_LOCKED')
  })

  it('releasing a feature opens it to everyone who already has permission, and locking it again closes it', async () => {
    const rel = await call('PUT', '/api/v1/admin/developer/features/whatsapp_crm', { token: tok.dev, payload: { released: true } })
    expect(rel.statusCode).toBe(200)
    // Admin / Super Admin pass the lock (and their normal permission check) …
    for (const who of ['admin', 'superAdmin']) {
      expect((await call('GET', '/api/v1/admin/crm/conversations', { token: tok[who] })).statusCode, who).toBe(200)
    }
    // …but the release is per feature and does not widen normal permissions: a Support user has no crm.* permission.
    const support = await call('GET', '/api/v1/admin/crm/conversations', { token: tok.support })
    expect(support.statusCode).toBe(403)
    expect(support.json().code).toBe('PERMISSION_DENIED')
    // Other features stay locked.
    expect((await call('GET', '/api/v1/admin/chat/channels', { token: tok.admin })).json().code).toBe('FEATURE_LOCKED')
    await call('PUT', '/api/v1/admin/developer/features/whatsapp_crm', { token: tok.dev, payload: { released: false } })
    expect((await call('GET', '/api/v1/admin/crm/conversations', { token: tok.admin })).json().code).toBe('FEATURE_LOCKED')
  })

  it('developer page data: features with their grants, and the developer list', async () => {
    await call('PUT', `/api/v1/admin/developer/features/procurement/grants/${ids.superAdmin}`, { token: tok.dev })
    const o = (await call('GET', '/api/v1/admin/developer/overview', { token: tok.dev })).json().data
    expect(o.features.map((f) => f.key).sort()).toEqual(['business_analytics', 'catalog_bulk', 'procurement', 'store_pos', 'team_chat', 'whatsapp_crm'])
    expect(o.features.find((f) => f.key === 'procurement').grants.map((g) => g.userId)).toContain(ids.superAdmin)
    expect(o.developers.map((d) => d.id)).toEqual(expect.arrayContaining([ids.dev, ids.dev2]))
    expect((await call('GET', '/api/v1/admin/developer/users?search=T%20Super', { token: tok.dev })).json().data.map((x) => x.id)).toContain(ids.superAdmin)
  })

  it('unknown feature and unknown / ineligible user are clear 404s', async () => {
    expect((await call('PUT', '/api/v1/admin/developer/features/nope', { token: tok.dev, payload: { released: true } })).statusCode).toBe(404)
    expect((await call('PUT', `/api/v1/admin/developer/features/nope/grants/${ids.admin}`, { token: tok.dev })).json().data?.new).not.toBe(true)
    expect((await call('PUT', `/api/v1/admin/developer/features/team_chat/grants/00000000-0000-4000-8000-000000000000`, { token: tok.dev })).statusCode).toBe(404)
    expect((await call('PUT', `/api/v1/admin/developer/users/${ids.support}/developer`, { token: tok.dev, payload: { isDeveloper: true } })).statusCode).toBe(404)
  })

  it('a developer can make another developer; a developer cannot remove their own access', async () => {
    const made = await call('PUT', `/api/v1/admin/developer/users/${ids.admin}/developer`, { token: tok.dev, payload: { isDeveloper: true } })
    expect(made.statusCode).toBe(200)
    expect((await call('GET', '/api/v1/admin/crm/conversations', { token: tok.admin })).statusCode).toBe(200) // now passes every lock
    expect((await call('PUT', `/api/v1/admin/developer/users/${ids.dev}/developer`, { token: tok.dev, payload: { isDeveloper: false } })).json().code).toBe('SELF_DEMOTE')
    expect((await call('PUT', `/api/v1/admin/developer/users/${ids.admin}/developer`, { token: tok.dev, payload: { isDeveloper: false } })).statusCode).toBe(200)
    expect((await call('GET', '/api/v1/admin/crm/conversations', { token: tok.admin })).json().code).toBe('FEATURE_LOCKED')
  })

  it('a removed developer loses the bypass immediately (checked live, not from the token)', async () => {
    await query(`UPDATE users SET is_developer = true, is_active = true WHERE id = $1`, [ids.dev])
    expect((await call('GET', '/api/v1/admin/crm/conversations', { token: tok.dev })).statusCode).toBe(200)
    await query(`UPDATE users SET is_developer = false WHERE id = $1`, [ids.dev])
    expect((await call('GET', '/api/v1/admin/crm/conversations', { token: tok.dev })).json().code).toBe('FEATURE_LOCKED')
  })

  it('a developer account cannot be changed, removed or password-reset by anyone who is not a developer', async () => {
    await query(`UPDATE users SET is_developer = true WHERE id = $1`, [ids.dev])
    const role = (await query(`INSERT INTO roles (name, permissions) VALUES ($1, '["team.manage","team.view"]'::jsonb) RETURNING id`, [`t-team-mgr-${Date.now()}`])).rows[0].id
    await query(`UPDATE users SET role_id = $1 WHERE id = $2`, [role, ids.superAdmin])
    const base = `/api/v1/admin/team/${ids.dev}`
    for (const [m, u, p] of [['PATCH', base, { is_active: false }], ['DELETE', base], ['POST', `${base}/reset-password`]]) {
      const r = await call(m, u, { token: tok.superAdmin, payload: p })
      expect(r.statusCode, `${m} ${u}`).toBe(403)
      expect(r.json().code ?? r.json().message).toMatch(/DEVELOPER_PROTECTED|Developer Super Admin/)
    }
    expect((await query(`SELECT is_active FROM users WHERE id = $1`, [ids.dev])).rows[0].is_active).toBe(true)
    await query(`UPDATE users SET role_id = NULL WHERE id = $1`, [ids.superAdmin])
    await query(`DELETE FROM roles WHERE id = $1`, [role])
  })

  it('releasing ONE feature opens that screen end to end for a normal admin, and leaves the others locked', async () => {
    const asAdmin = (url) => call('GET', url, { token: tok.admin })
    await query(`UPDATE feature_flags SET released = (key = 'business_analytics')`)
    // the permission probe the page uses lives under /procurement, which is still locked: it must still answer
    const me = await asAdmin('/api/v1/admin/procurement/me')
    expect(me.statusCode).toBe(200)
    expect(me.json().data.analyticsBusiness).toBe(true)
    expect((await asAdmin('/api/v1/admin/business-analytics/overview')).json().code).not.toBe('FEATURE_LOCKED')
    expect((await asAdmin('/api/v1/admin/procurement/vendors')).json().code).toBe('FEATURE_LOCKED')
    expect((await asAdmin('/api/v1/admin/catalog-bulk/template')).json().code).toBe('FEATURE_LOCKED')
    // locking it again closes it straight away
    await query(`UPDATE feature_flags SET released = false`)
    expect((await asAdmin('/api/v1/admin/business-analytics/overview')).json().code).toBe('FEATURE_LOCKED')
  })

  it('WhatsApp Settings works while the CRM is locked: managers get everything, others a read-only view, the rest of the CRM stays locked', async () => {
    const U = '/api/v1/admin/crm/settings'
    // admin / super admin (no custom role) and the developer manage it; HQ_SUPPORT has no settings permission
    for (const who of ['admin', 'superAdmin', 'dev']) {
      const r = await call('GET', U, { token: tok[who] })
      expect(r.statusCode, who).toBe(200)
      expect(r.json().data.canManage, who).toBe(true)
    }
    const ro = await call('GET', U, { token: tok.support })
    expect(ro.statusCode).toBe(200)
    expect(ro.json().data.canManage).toBe(false)
    expect(ro.json().data.fields.verifyToken.value).toBe('') // verify token only for managers
    expect(JSON.stringify(ro.json().data)).not.toMatch(/access_token_enc|app_secret_enc/)
    // signed-out is still a plain 401
    expect((await call('GET', U)).statusCode).toBe(401)
    // the four actions are not held back by the lock, but still need the permission: a non-manager is refused for that reason
    for (const [m, u] of [['PUT', U], ['POST', `${U}/test`], ['POST', `${U}/enable`], ['DELETE', `${U}/credentials`]]) {
      const r = await call(m, u, { token: tok.support, payload: m === 'DELETE' ? undefined : {} })
      expect(r.statusCode, `${m} ${u}`).toBe(403)
      expect(r.json().code, `${m} ${u}`).toBe('PERMISSION_DENIED')
    }
    // everything else in the CRM stays locked, even for a super admin
    for (const u of ['/api/v1/admin/crm/conversations', '/api/v1/admin/crm/me', '/api/v1/admin/crm/templates']) {
      const r = await call('GET', u, { token: tok.superAdmin })
      expect(r.json().code, u).toBe('FEATURE_LOCKED')
    }
  })
})
