/**
 * Team & Roles end to end, through the real app: roles, invites, login, permissions, sessions, escalation.
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/team-roles.db.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const TAG = 'trtest'
const PH = (n) => `9999032${String(n).padStart(3, '0')}`

describe.skipIf(!enabled)('Team & Roles', () => {
  let app, query, closePool, devToken, devId, managerId, managerToken
  const call = (method, url, { token, payload } = {}) =>
    app.inject({ method, url: `/api/v1/admin${url}`, payload: payload ?? (method === 'GET' || method === 'DELETE' ? undefined : {}), headers: token ? { authorization: `Bearer ${token}` } : {} })

  async function cleanup() {
    await query(`DELETE FROM admin_activity_log WHERE admin_id IN (SELECT id FROM users WHERE email LIKE '%@${TAG}.test' OR phone LIKE '9999032%')`)
    await query(`DELETE FROM admin_activity_log WHERE admin_id IN (SELECT id FROM users WHERE email LIKE '%@${TAG}.test' OR phone LIKE '9999032%')`)
    await query(`DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE '%@${TAG}.test' OR phone LIKE '9999032%')`)
    await query(`UPDATE users SET role_id = NULL WHERE email LIKE '%@${TAG}.test' OR phone LIKE '9999032%'`)
    await query(`DELETE FROM users WHERE email LIKE '%@${TAG}.test' OR phone LIKE '9999032%'`)
    await query(`DELETE FROM roles WHERE name LIKE '${TAG} %'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { signAccessToken } = await import('../../src/utils/jwt.js')
    const { buildApp } = await import('../../src/app.js')
    app = await buildApp()
    await app.ready()
    await cleanup()
    const mk = async (n, { platform, dev = false, perms = null }) => {
      let roleId = null
      if (perms) roleId = (await query(`INSERT INTO roles (name, permissions) VALUES ($1, $2::jsonb) RETURNING id`, [`${TAG} holder ${n}`, JSON.stringify(perms)])).rows[0].id
      const id = (await query(
        `INSERT INTO users (phone,name,email,role,platform_role,is_developer,role_id) VALUES ($1,$2,$3,'ADMIN',$4,$5,$6) RETURNING id`,
        [PH(n), `T ${n}`, `u${n}@${TAG}.test`, platform, dev, roleId],
      )).rows[0].id
      return { id, token: signAccessToken({ id, phone: PH(n), role: 'ADMIN', platform_role: platform }) }
    }
    const dev = await mk(1, { platform: 'SUPER_ADMIN', dev: true })
    const mgr = await mk(2, { platform: 'ADMIN', perms: ['team.view', 'team.manage', 'orders.view'] })
    devToken = dev.token; devId = dev.id; managerToken = mgr.token; managerId = mgr.id
  }, 60_000)

  afterAll(async () => {
    await cleanup()
    await app?.close()
    await closePool()
  })

  it('roles: names are trimmed, must be unique (any case) and cannot be blank', async () => {
    expect((await call('POST', '/roles', { token: devToken, payload: { name: `${TAG} A`, permissions: ['orders.view'] } })).statusCode).toBe(201)
    const dupe = await call('POST', '/roles', { token: devToken, payload: { name: `  ${TAG} a `, permissions: [] } })
    expect(dupe.statusCode).toBe(409)
    expect(dupe.json().message).toMatch(/already exists/)
    expect((await call('POST', '/roles', { token: devToken, payload: { name: '   ', permissions: [] } })).statusCode).toBe(400)
  })

  it('invite: works without a phone, signs the person in, and makes them change the password', async () => {
    const roleId = (await query(`SELECT id FROM roles WHERE name = $1`, [`${TAG} A`])).rows[0].id
    const res = await call('POST', '/team/invite', { token: devToken, payload: { name: 'New Person', email: `New.Person@${TAG}.test`, role_id: roleId, password: 'Initial#12345' } })
    expect(res.statusCode).toBe(201)
    const row = (await query(`SELECT email, phone, platform_role, force_password_change FROM users WHERE id = $1`, [res.json().data.id])).rows[0]
    expect(row.email).toBe(`new.person@${TAG}.test`) // stored in lower case
    expect(row.phone).toMatch(/^TM-/) // a placeholder, never a dialable number
    expect(row.platform_role).toBe('ADMIN') // custom roles sign in as ADMIN (the only dashboard level besides Super Admin)
    expect(row.force_password_change).toBe(true)

    const login = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: { email: `NEW.PERSON@${TAG}.test`, password: 'Initial#12345' } })
    expect(login.statusCode).toBe(200) // used to be 403 "No active shop assignments"
  })

  it('invite: duplicate email (any case), duplicate phone, unknown role and short password are all clean errors', async () => {
    const roleId = (await query(`SELECT id FROM roles WHERE name = $1`, [`${TAG} A`])).rows[0].id
    const base = { name: 'X', role_id: roleId, password: 'Initial#12345' }
    expect((await call('POST', '/team/invite', { token: devToken, payload: { ...base, email: `NEW.PERSON@${TAG}.test` } })).statusCode).toBe(409)
    expect((await call('POST', '/team/invite', { token: devToken, payload: { ...base, email: `p1@${TAG}.test`, phone: '9999032500' } })).statusCode).toBe(201)
    expect((await call('POST', '/team/invite', { token: devToken, payload: { ...base, email: `p2@${TAG}.test`, phone: '9999032500' } })).statusCode).toBe(409)
    const noRole = await call('POST', '/team/invite', { token: devToken, payload: { ...base, email: `p3@${TAG}.test`, role_id: '00000000-0000-4000-8000-000000000000' } })
    expect(noRole.statusCode).toBe(400)
    expect(noRole.json().message).toBe('That role does not exist.')
    expect((await call('POST', '/team/invite', { token: devToken, payload: { ...base, email: `p4@${TAG}.test`, password: 'short' } })).statusCode).toBe(400)
  })

  it('a team manager cannot grant more power than they hold (escalation)', async () => {
    const tooMuch = await call('POST', '/roles', { token: managerToken, payload: { name: `${TAG} B`, permissions: ['orders.view', 'crm.settings.manage'] } })
    expect(tooMuch.statusCode).toBe(403)
    expect(tooMuch.json().code).toBe('ESCALATION_BLOCKED')
    expect((await call('POST', '/roles', { token: managerToken, payload: { name: `${TAG} C`, permissions: ['orders.view'] } })).statusCode).toBe(201)

    const superRole = (await query(`SELECT id FROM roles WHERE name = 'SUPER_ADMIN'`)).rows[0]
    const self = await call('PATCH', `/team/${managerId}`, { token: managerToken, payload: { role_id: superRole.id } })
    expect(self.statusCode).toBe(403)
    const ownRole = (await query(`SELECT role_id FROM users WHERE id = $1`, [managerId])).rows[0].role_id
    expect((await call('PATCH', `/roles/${ownRole}`, { token: managerToken, payload: { permissions: ['team.view', 'team.manage', 'crm.settings.manage'] } })).statusCode).toBe(403)
  })

  it('team and role lists need team.view (developers and platform Super Admins always may)', async () => {
    const { signAccessToken } = await import('../../src/utils/jwt.js')
    const plainId = (await query(`INSERT INTO users (phone,name,email,role,platform_role) VALUES ($1,'Plain',$2,'ADMIN','ADMIN') RETURNING id`, [PH(9), `plain@${TAG}.test`])).rows[0].id
    const plain = signAccessToken({ id: plainId, phone: PH(9), role: 'ADMIN', platform_role: 'ADMIN' })
    expect((await call('GET', '/team', { token: plain })).statusCode).toBe(403) // platform ADMIN alone is not enough: every team member is one
    const { signAccessToken: sign } = await import('../../src/utils/jwt.js')
    const noRoleId = (await query(`INSERT INTO users (phone,name,email,role,platform_role,role_id) VALUES ($1,'NoPerm',$2,'ADMIN','HQ_FINANCE',(SELECT id FROM roles WHERE name = $3)) RETURNING id`, [PH(8), `noperm@${TAG}.test`, `${TAG} A`])).rows[0].id
    const noPerm = sign({ id: noRoleId, phone: PH(8), role: 'ADMIN', platform_role: 'HQ_FINANCE' })
    expect((await call('GET', '/team', { token: noPerm })).statusCode).toBe(403) // role has no team.view
    expect((await call('GET', '/roles', { token: noPerm })).statusCode).toBe(403)
    expect((await call('GET', '/team', { token: managerToken })).statusCode).toBe(200)
    expect((await call('GET', '/roles', { token: devToken })).statusCode).toBe(200)
  })

  it('built-in roles that cannot sign in to the dashboard are refused, Admin / Super Admin are accepted', async () => {
    const refused = await call('POST', '/team/invite', { token: devToken, payload: { name: 'F', email: `f@${TAG}.test`, role_id: (await query(`SELECT id FROM roles WHERE name = 'HQ_FINANCE'`)).rows[0].id, password: 'Initial#12345' } })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().message).toMatch(/cannot sign in/)
    const ok = await call('POST', '/team/invite', { token: devToken, payload: { name: 'S', email: `s@${TAG}.test`, role_id: (await query(`SELECT id FROM roles WHERE name = 'SUPER_ADMIN'`)).rows[0].id, password: 'Initial#12345' } })
    expect(ok.statusCode).toBe(201)
    expect((await query(`SELECT platform_role FROM users WHERE email = $1`, [`s@${TAG}.test`])).rows[0].platform_role).toBe('SUPER_ADMIN')
  })

  it('a role that people still use cannot be deleted; an unused one can', async () => {
    const roleId = (await query(`SELECT id FROM roles WHERE name = $1`, [`${TAG} A`])).rows[0].id
    const refused = await call('DELETE', `/roles/${roleId}`, { token: devToken })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().message).toMatch(/still use/)
    const unused = (await query(`SELECT id FROM roles WHERE name = $1`, [`${TAG} C`])).rows[0].id
    expect((await call('DELETE', `/roles/${unused}`, { token: devToken })).statusCode).toBe(200)
  })

  it('role change, deactivation and password reset all end the member\'s old session at once', async () => {
    const { signAccessToken } = await import('../../src/utils/jwt.js')
    const me = (await query(`SELECT id, phone, session_version FROM users WHERE email = $1`, [`new.person@${TAG}.test`])).rows[0]
    const tokenFor = (v) => signAccessToken({ id: me.id, phone: me.phone, role: 'ADMIN', platform_role: 'ADMIN', session_version: v })
    const alive = async (token) => (await call('GET', '/features', { token })).statusCode === 200
    expect(await alive(tokenFor(me.session_version))).toBe(true)

    const other = (await query(`SELECT id FROM roles WHERE name = $1`, [`${TAG} holder 2`])).rows[0].id
    expect((await call('PATCH', `/team/${me.id}`, { token: devToken, payload: { role_id: other } })).statusCode).toBe(200)
    expect(await alive(tokenFor(me.session_version))).toBe(false) // role change -> sign in again

    const v2 = (await query(`SELECT session_version FROM users WHERE id = $1`, [me.id])).rows[0].session_version
    await call('PATCH', `/team/${me.id}`, { token: devToken, payload: { is_active: false } })
    expect(await alive(tokenFor(v2))).toBe(false)
    await call('PATCH', `/team/${me.id}`, { token: devToken, payload: { is_active: true } })
    expect(await alive(tokenFor(v2))).toBe(false) // switching someone back on does not revive the old login either
    const v3 = (await query(`SELECT session_version FROM users WHERE id = $1`, [me.id])).rows[0].session_version
    expect(await alive(tokenFor(v3))).toBe(true)

    const reset = await call('POST', `/team/${me.id}/reset-password`, { token: devToken })
    expect(reset.json().data.temp_password).toBeTruthy()
    expect(await alive(tokenFor(v3))).toBe(false)
    expect((await query(`SELECT force_password_change FROM users WHERE id = $1`, [me.id])).rows[0].force_password_change).toBe(true)
  })

  it('a member with a custom role is governed by that role on the newer modules (even though they sign in as ADMIN)', async () => {
    const { signAccessToken } = await import('../../src/utils/jwt.js')
    await query(`UPDATE feature_flags SET released = true`)
    try {
      const roleId = (await query(`INSERT INTO roles (name, permissions) VALUES ($1, '["orders.view"]'::jsonb) RETURNING id`, [`${TAG} narrow`])).rows[0].id
      const id = (await query(`INSERT INTO users (phone,name,email,role,platform_role,role_id) VALUES ($1,'Narrow',$2,'ADMIN','ADMIN',$3) RETURNING id`, [PH(7), `narrow@${TAG}.test`, roleId])).rows[0].id
      const token = signAccessToken({ id, phone: PH(7), role: 'ADMIN', platform_role: 'ADMIN' })
      const me = (await call('GET', '/procurement/me', { token })).json().data
      expect(me).toMatchObject({ procurementView: false, catalogBulk: false, analyticsBusiness: false })
      expect((await call('GET', '/business-analytics/overview', { token })).statusCode).toBe(403)
      expect((await call('GET', '/crm/conversations', { token })).statusCode).toBe(403)
      await query(`UPDATE roles SET permissions = '["orders.view","analytics.business","crm.inbox.view"]'::jsonb WHERE id = $1`, [roleId])
      expect((await call('GET', '/business-analytics/overview', { token })).statusCode).toBe(200)
      expect((await call('GET', '/crm/conversations', { token })).statusCode).toBe(200)
      // ...while an ADMIN with no custom role keeps full access, as before
      const plainId = (await query(`INSERT INTO users (phone,name,email,role,platform_role) VALUES ($1,'Plain2',$2,'ADMIN','ADMIN') RETURNING id`, [PH(6), `plain2@${TAG}.test`])).rows[0].id
      expect((await call('GET', '/business-analytics/overview', { token: signAccessToken({ id: plainId, phone: PH(6), role: 'ADMIN', platform_role: 'ADMIN' }) })).statusCode).toBe(200)
    } finally {
      await query(`UPDATE feature_flags SET released = false`)
    }
  })

  it('a Developer Super Admin needs no role attached to manage the team', async () => {
    expect((await query(`SELECT role_id FROM users WHERE id = $1`, [devId])).rows[0].role_id).toBeNull()
    const res = await call('POST', '/roles', { token: devToken, payload: { name: `${TAG} D`, permissions: ['team.manage'] } })
    expect(res.statusCode).toBe(201)
  })
})
