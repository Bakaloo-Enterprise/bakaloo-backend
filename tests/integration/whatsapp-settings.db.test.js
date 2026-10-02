/**
 * WhatsApp connection settings, end to end: real database, real HTTP to a local fake of Meta's Graph API.
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/whatsapp-settings.db.test.js
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const GOOD = 'EAAGgoodtoken' + 'a'.repeat(60)
const EXPIRED = 'EAAGexpiredtoken' + 'b'.repeat(60)
const APP_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const PH = (n) => `9999021${String(n).padStart(3, '0')}`

describe.skipIf(!enabled)('WhatsApp settings', () => {
  let restoreFeatures, graph, graphUrl, app, query, closePool, svc, services, tok
  const seen = []                       // what the fake Meta received: { method, path, auth }
  const graphError = (res, status, code, message, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code, message, type: 'OAuthException', fbtrace_id: 'TRACE9', ...extra } })) }
  const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

  beforeAll(async () => {
    graph = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x')
      const auth = (req.headers.authorization ?? '').replace('Bearer ', '')
      seen.push({ method: req.method, path: url.pathname, auth, q: Object.fromEntries(url.searchParams) })
      const p = url.pathname.replace(/^\/v\d+\.\d+/, '')
      if (p === '/debug_token') return json(res, { data: { is_valid: true, expires_at: 0, type: 'SYSTEM_USER', scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'] } })
      if (auth === EXPIRED) return graphError(res, 401, 190, 'Error validating access token: Session has expired', { error_subcode: 463 })
      if (auth !== GOOD) return graphError(res, 400, 190, 'Invalid OAuth access token - Cannot parse access token')
      if (p === '/109876543210987') return json(res, { display_phone_number: '+91 99999 12345', verified_name: 'Bakaloo Test', quality_rating: 'GREEN', code_verification_status: 'VERIFIED', messaging_limit_tier: 'TIER_1K' })
      if (p === '/555000111222333') return graphError(res, 400, 100, "Unsupported get request. Object with ID '555000111222333' does not exist, cannot be loaded due to missing permissions", { error_subcode: 33 })
      if (p === '/555000111222333/phone_numbers') return json(res, { data: [{ id: '109876543210987', display_phone_number: '+91 99999 12345' }] })
      if (p === '/123456789012345') return json(res, { name: 'Bakaloo Retail', currency: 'INR' })
      if (p === '/123456789012345/message_templates') return json(res, { data: [] })
      if (p === '/109876543210987/messages' && req.method === 'POST') return json(res, { messages: [{ id: 'wamid.TEST' }] })
      return graphError(res, 400, 100, `no route ${p}`)
    })
    await new Promise((r) => graph.listen(0, '127.0.0.1', r))
    graphUrl = `http://127.0.0.1:${graph.address().port}`
    process.env.WHATSAPP_API_BASE_URL = graphUrl
    delete process.env.WHATSAPP_ACCESS_TOKEN; delete process.env.WHATSAPP_PHONE_NUMBER_ID; delete process.env.META_APP_SECRET; delete process.env.WHATSAPP_VERIFY_TOKEN
    process.env.WHATSAPP_ENABLED = 'false'

    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { signAccessToken } = await import('../../src/utils/jwt.js')
    const { getWhatsappServices } = await import('../../src/modules/whatsapp-crm/whatsapp.factory.js')
    const { buildApp } = await import('../../src/app.js')
    services = getWhatsappServices(); svc = services.settings
    app = await buildApp(); await app.ready()
    restoreFeatures = await (await import('../helpers/features.js')).releaseFeatures(query)
    await query(`DELETE FROM users WHERE email LIKE '9999021%@t.local'`)
    const mk = async (n, roleName, platform = null) => {
      const rid = roleName ? (await query(`SELECT id FROM roles WHERE name=$1`, [roleName])).rows[0].id : null
      const id = (await query(`INSERT INTO users (phone,name,email,role,role_id,platform_role) VALUES ($1,$2,$3,'ADMIN',$4,$5) RETURNING id`, [PH(n), `T17 ${n}`, `${PH(n)}@t.local`, rid, platform])).rows[0].id
      return { id, token: signAccessToken({ id, phone: PH(n), role: 'ADMIN', platform_role: platform }) }
    }
    tok = { hq: await mk(1, null, 'SUPER_ADMIN'), manager: await mk(2, 'CRM Manager'), agent: await mk(3, 'CRM Agent'), spare: await mk(4, 'CRM Manager') }
  }, 60_000)

  beforeEach(async () => { await query(`DELETE FROM wa_settings`); svc.invalidate(); svc.tests.clear(); seen.length = 0 })
  afterAll(async () => {
    await restoreFeatures?.()
    await query(`DELETE FROM wa_settings`)
    await query(`DELETE FROM audit_logs WHERE target_type='wa_settings'`)
    await query(`DELETE FROM users WHERE email LIKE '9999021%@t.local'`)
    await app?.close(); await closePool(); await new Promise((r) => graph.close(r))
  })

  const call = (method, url, { token, payload } = {}) => app.inject({ method, url: `/api/v1/admin/crm${url}`, payload, headers: token ? { authorization: `Bearer ${token}` } : {} })
  const FULL = { phoneNumberId: '109876543210987', wabaId: '123456789012345', accessToken: GOOD, appSecret: APP_SECRET, appId: '1234567890123', verifyToken: 'my-verify-word-1' }

  describe('saving', () => {
    it('stores secrets ENCRYPTED, shows only masked values, and returns the verify token (not a credential)', async () => {
      await svc.save(FULL, tok.hq.id)
      const raw = (await query(`SELECT * FROM wa_settings`)).rows[0]
      expect(raw.access_token_enc).not.toContain(GOOD)
      expect(raw.app_secret_enc).not.toContain(APP_SECRET)
      expect(raw.access_token_enc.startsWith('v1:')).toBe(true)
      expect(raw.phone_number_id).toBe('109876543210987')
      const v = await svc.view({ origin: 'https://api.example.in', canManage: true })
      expect(v).toMatchObject({ state: 'SAVED', fields: { phoneNumberId: { value: '109876543210987', source: 'dashboard' }, verifyToken: { value: 'my-verify-word-1' } } })
      expect(v.fields.accessToken).toEqual({ configured: true, masked: expect.stringMatching(/^EAAG…aaaa$/), source: 'dashboard' })
      expect(v.webhook.callbackUrl).toBe('https://api.example.in/api/webhook/whatsapp')
      expect(JSON.stringify(v)).not.toContain(GOOD)
      expect(JSON.stringify(v)).not.toContain(APP_SECRET)
    })
    it('an empty secret box keeps the saved secret; a new value replaces it; clearing is explicit', async () => {
      await svc.save(FULL, tok.hq.id)
      await svc.save({ phoneNumberId: '109876543210987', accessToken: '', appSecret: '' }, tok.hq.id)
      expect((await svc.resolved({ fresh: true })).accessToken).toBe(GOOD)
      await svc.save({ accessToken: EXPIRED }, tok.hq.id)
      expect((await svc.resolved({ fresh: true })).accessToken).toBe(EXPIRED)
      await svc.save({ clear: ['appSecret'] }, tok.hq.id)
      expect((await svc.resolved({ fresh: true })).appSecret).toBeNull()
    })
    it('changing a credential resets "connected" until it is tested again; changing only the verify token does not', async () => {
      await svc.save(FULL, tok.hq.id); await svc.test({}, tok.hq.id)
      expect((await svc.view()).state).toBe('CONNECTED')
      await svc.save({ verifyToken: 'another-word-99' }, tok.hq.id)
      expect((await svc.view()).state).toBe('CONNECTED')
      await svc.save({ accessToken: EXPIRED }, tok.hq.id)
      expect((await svc.view()).state).toBe('SAVED')
    })
    it('rejects bad values with a message per field, and an empty save', async () => {
      await expect(svc.save({ phoneNumberId: '+91 98765', accessToken: 'short' }, tok.hq.id)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION', details: { phoneNumberId: expect.any(String), accessToken: expect.any(String) } })
      await expect(svc.save({}, tok.hq.id)).rejects.toMatchObject({ code: 'NOTHING_TO_SAVE' })
    })
    it('can generate a verify token', async () => {
      await svc.save({ generateVerifyToken: true }, tok.hq.id)
      expect((await svc.view({ canManage: true })).fields.verifyToken.value).toMatch(/^bk_/)
      expect((await svc.view()).fields.verifyToken.value).toBe('') // anyone who may not manage never gets the token
    })
    it('survives a key change: secrets that cannot be read are treated as not set (no crash)', async () => {
      await svc.save(FULL, tok.hq.id)
      await query(`UPDATE wa_settings SET access_token_enc = 'v1:AAAA:BBBB:CCCC'`)
      svc.invalidate()
      const v = await svc.view()
      expect(v.state).toBe('NOT_CONFIGURED')
      expect(v.fields.accessToken.configured).toBe(false)
    })
  })

  describe('testing the connection', () => {
    it('a good token → Meta answered 200 → CONNECTED and switched on automatically', async () => {
      await svc.save(FULL, tok.hq.id)
      expect((await svc.resolved()).enabled).toBe(false)
      const r = await svc.test({}, tok.hq.id)
      expect(r).toMatchObject({ ok: true })
      expect(r.checks.find((c) => c.id === 'phone')).toMatchObject({ status: 'pass', details: { number: '+91 99999 12345', name: 'Bakaloo Test' } })
      expect(r.checks.find((c) => c.id === 'token').summary).toMatch(/Permanent token/)
      const v = await svc.view()
      expect(v).toMatchObject({ state: 'CONNECTED', enabled: true })
      expect(v.connectedAt).toBeTruthy()
      expect(v.lastTest.ok).toBe(true)
      expect((await svc.resolved()).enabled).toBe(true)
      // the token went to Meta as a Bearer header, and never in the result
      expect(seen.find((s) => s.path.endsWith('/109876543210987')).auth).toBe(GOOD)
      expect(JSON.stringify(r)).not.toContain(GOOD)
    })
    it('an expired token → NOT connected, the reason in plain words, enabled left alone', async () => {
      await svc.save({ ...FULL, accessToken: EXPIRED }, tok.hq.id)
      const r = await svc.test({}, tok.hq.id)
      expect(r.ok).toBe(false)
      const phone = r.checks.find((c) => c.id === 'phone')
      expect(phone.problem.title).toBe('Your access token has expired')
      expect(phone.problem.technical).toMatchObject({ code: 190, subcode: 463, fbtraceId: 'TRACE9' })
      expect(await svc.view()).toMatchObject({ state: 'FAILED', enabled: false, lastTest: { ok: false } })
    })
    it('a wrong-kind ID is recognised and the right one is suggested', async () => {
      await svc.save({ ...FULL, phoneNumberId: '555000111222333' }, tok.hq.id)
      const r = await svc.test({}, tok.hq.id)
      const p = r.checks.find((c) => c.id === 'phone').problem
      expect(p.title).toMatch(/Business Account ID, not a Phone number ID/)
      expect(p.fixes[0]).toContain('109876543210987')
    })
    it('a previously connected setup that now fails becomes FAILED but stays switched on (no silent outage)', async () => {
      await svc.save(FULL, tok.hq.id); await svc.test({}, tok.hq.id)
      await svc.save({ accessToken: EXPIRED }, tok.hq.id)
      await svc.test({}, tok.hq.id)
      expect(await svc.view()).toMatchObject({ state: 'FAILED', enabled: true })
    })
    it('nothing saved → says what is missing without calling Meta', async () => {
      const r = await svc.test({}, tok.hq.id)
      expect(r.ok).toBe(false)
      expect(r.checks[0].summary).toContain('Access token and Phone number ID')
      expect(seen).toHaveLength(0)
    })
    it('can send the sample message to a number, normalising it, and reports the message id', async () => {
      await svc.save(FULL, tok.hq.id)
      const r = await svc.test({ sendTo: '98765 43210' }, tok.hq.id)
      expect(r.checks.find((c) => c.id === 'message')).toMatchObject({ status: 'pass', details: { wamid: 'wamid.TEST' } })
      expect(seen.find((s) => s.method === 'POST').path).toMatch(/\/109876543210987\/messages$/)
      await expect(svc.test({ sendTo: '12345' }, tok.hq.id)).rejects.toMatchObject({ statusCode: 400 })
    })
    it('is rate-limited per person', async () => {
      await svc.save(FULL, tok.hq.id)
      svc.tests.clear()
      for (let i = 0; i < 8; i++) await svc.test({}, tok.spare.id)
      await expect(svc.test({}, tok.spare.id)).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_TESTS' })
    })
  })

  describe('the rest of WhatsApp CRM uses the saved settings', () => {
    it('the Meta client sends with the SAVED token and picks up a change within a refresh', async () => {
      await svc.save(FULL, tok.hq.id)
      await services.client.listTemplates()
      expect(seen.at(-1)).toMatchObject({ path: expect.stringMatching(/\/123456789012345\/message_templates$/), auth: GOOD })
      await svc.save({ accessToken: EXPIRED }, tok.hq.id)
      await expect(services.client.listTemplates()).rejects.toThrow()
      expect(seen.at(-1).auth).toBe(EXPIRED)
    })
    it('the status screen reads the same configuration', async () => {
      await svc.save(FULL, tok.hq.id); await svc.test({}, tok.hq.id)
      const r = await call('GET', '/status', { token: tok.manager.token })
      expect(r.json().data).toMatchObject({ enabled: true, configured: { phoneNumberId: true, accessToken: true, wabaId: true, verifyToken: true, appSecret: true }, templatesReady: true })
    })
    it('the webhook handshake and signature use the saved verify token and app secret', async () => {
      await svc.save(FULL, tok.hq.id)
      const hs = (t) => app.inject({ method: 'GET', url: `/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=4242` })
      expect((await hs('my-verify-word-1')).body).toBe('4242')
      expect((await hs('wrong-word')).statusCode).toBe(403)
      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'x', changes: [] }] })
      const sign = (secret) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
      const post = (secret) => app.inject({ method: 'POST', url: '/api/webhook/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(secret) } })
      expect((await post(APP_SECRET)).statusCode).toBe(503)  // saved but not switched on yet
      await svc.setEnabled(true, tok.hq.id)
      expect((await post('f'.repeat(32))).statusCode).toBe(401)
      expect((await post(APP_SECRET)).statusCode).toBe(200)
      await query(`DELETE FROM wa_webhook_events WHERE received_at > NOW() - interval '1 minute'`)
    })
    it('disconnecting switches it off; removing the details wipes them', async () => {
      await svc.save(FULL, tok.hq.id); await svc.test({}, tok.hq.id)
      await svc.setEnabled(false, tok.hq.id)
      expect(await svc.view()).toMatchObject({ state: 'DISABLED', enabled: false })
      await svc.clearCredentials(tok.hq.id)
      expect(await svc.view()).toMatchObject({ state: 'NOT_CONFIGURED', lastTest: null })
      expect((await query(`SELECT access_token_enc, app_secret_enc FROM wa_settings`)).rows[0]).toEqual({ access_token_enc: null, app_secret_enc: null })
    })
  })

  describe('over HTTP', () => {
    it('401 without a token; 403 for an agent; allowed for a manager and HQ', async () => {
      // reading is open to every signed-in admin (read-only: no verify token, canManage false); everything that changes it needs the permission
      expect((await call('GET', '/settings')).statusCode).toBe(401)
      const ro = await call('GET', '/settings', { token: tok.agent.token })
      expect(ro.statusCode).toBe(200)
      expect(ro.json().data.canManage).toBe(false)
      expect(ro.json().data.fields.verifyToken.value).toBe('')
      for (const [m, u] of [['PUT', '/settings'], ['POST', '/settings/test'], ['POST', '/settings/enable'], ['POST', '/settings/connect-replies'], ['DELETE', '/settings/credentials']]) {
        expect((await call(m, u)).statusCode, `${m} ${u}`).toBe(401)
        expect((await call(m, u, { token: tok.agent.token, payload: {} })).statusCode, `${m} ${u} agent`).toBe(403)
      }
      expect((await call('GET', '/settings', { token: tok.manager.token })).json().data.canManage).toBe(true)
      expect((await call('GET', '/settings', { token: tok.manager.token })).statusCode).toBe(200)
      expect((await call('GET', '/settings', { token: tok.hq.token })).statusCode).toBe(200)
    })
    it('save → view → test → view works through the API, with 400 per-field errors for bad input', async () => {
      const bad = await call('PUT', '/settings', { token: tok.manager.token, payload: { phoneNumberId: 'abc' } })
      expect(bad.statusCode).toBe(400)
      expect(bad.json().details.phoneNumberId).toMatch(/digits/)
      expect((await call('PUT', '/settings', { token: tok.manager.token, payload: FULL })).statusCode).toBe(200)
      const test = await call('POST', '/settings/test', { token: tok.manager.token, payload: {} })
      expect(test.json().data).toMatchObject({ ok: true, level: expect.stringMatching(/READY|PARTIAL/) })
      const view = (await call('GET', '/settings', { token: tok.manager.token })).json().data
      expect(view).toMatchObject({ state: 'CONNECTED' })
    })
    it('NO response ever contains a secret', async () => {
      const all = []
      all.push((await call('PUT', '/settings', { token: tok.manager.token, payload: FULL })).body)
      all.push((await call('POST', '/settings/test', { token: tok.manager.token, payload: {} })).body)
      all.push((await call('GET', '/settings', { token: tok.manager.token })).body)
      all.push((await call('GET', '/status', { token: tok.manager.token })).body)
      for (const body of all) { expect(body).not.toContain(GOOD); expect(body).not.toContain(APP_SECRET) }
    })
    it('changes are audited by field name, never by value', async () => {
      await call('PUT', '/settings', { token: tok.manager.token, payload: FULL })
      await new Promise((r) => setTimeout(r, 300))
      const rows = (await query(`SELECT action, after FROM audit_logs WHERE target_type='wa_settings' AND action='whatsapp.settings.save' ORDER BY created_at DESC LIMIT 1`)).rows
      expect(rows[0].after.fields).toEqual(expect.arrayContaining(['accessToken', 'phoneNumberId']))
      expect(JSON.stringify(rows)).not.toContain(GOOD)
    })
  })
})
