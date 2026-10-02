import { describe, expect, it } from 'vitest'
import { runConnectionTest } from '../../../src/modules/whatsapp-crm/connection-test.js'

const graphErr = (httpStatus, code, message, extra = {}) => ({ response: { status: httpStatus, data: { error: { code, message, fbtrace_id: 'TRACE1', ...extra } } } })
const NOW = new Date('2026-10-02T10:00:00Z')
const cfg = (o = {}) => ({ phoneNumberId: '109876543210987', wabaId: '123456789012345', accessToken: 'EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', appId: null, appSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', verifyToken: 'verify_me_123', ...o })

/** A fake Graph API. routes: "GET /path" → value or a function; a thrown graphErr simulates Meta refusing. */
function fakeHttp(routes) {
  const calls = []
  const run = async (method, path, opts) => {
    calls.push(`${method} ${path}`)
    const hit = routes[`${method} ${path}`]
    if (hit === undefined) throw graphErr(400, 100, `no route ${method} ${path}`)
    const v = typeof hit === 'function' ? hit(opts) : hit
    if (v instanceof Error || v?.response) throw v
    return { data: v }
  }
  return { calls, get: (p, o) => run('GET', p, o), post: (p, d) => run('POST', p, d) }
}
const GOOD = (o = {}) => ({
  'GET /109876543210987': (opts) => (opts.params.fields.startsWith('display_phone_number') ? { display_phone_number: '+91 99999 12345', verified_name: 'Bakaloo', quality_rating: 'GREEN' } : { code_verification_status: 'VERIFIED', name_status: 'APPROVED', messaging_limit_tier: 'TIER_1K', platform_type: 'CLOUD_API' }),
  'GET /123456789012345': { name: 'Bakaloo Retail', currency: 'INR' },
  'GET /123456789012345/message_templates': { data: [] },
  ...o,
})
const run = (config, http, extra = {}) => runConnectionTest({ config, http, now: () => NOW, webhook: { lastReceivedAt: new Date('2026-10-02T09:55:00Z'), last7d: 12 }, ...extra })
const by = (r, id) => r.checks.find((c) => c.id === id)

describe('connection test', () => {
  it('everything works → connected (READY), and says what Meta confirmed', async () => {
    const r = await run(cfg(), fakeHttp(GOOD()))
    expect(r).toMatchObject({ ok: true, level: 'READY' }) // an unchecked token lifetime (no App ID) is "skipped", not a problem
    expect(by(r, 'token').status).toBe('skip')
    expect(by(r, 'phone')).toMatchObject({ status: 'pass', details: { number: '+91 99999 12345', name: 'Bakaloo', verification: 'VERIFIED', limitTier: 'TIER_1K' } })
    expect(by(r, 'waba').status).toBe('pass')
    expect(by(r, 'templates').status).toBe('pass')
    expect(by(r, 'webhook')).toMatchObject({ status: 'pass', summary: expect.stringContaining('5 min ago') })
  })
  it('a permanent, correctly-scoped token → READY', async () => {
    const http = fakeHttp(GOOD({ 'GET /debug_token': { data: { is_valid: true, expires_at: 0, type: 'SYSTEM_USER', scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'] } } }))
    const r = await run(cfg({ appId: '1234567890123' }), http)
    expect(r).toMatchObject({ ok: true, level: 'READY', headline: expect.stringContaining('Connected') })
    expect(by(r, 'token').summary).toMatch(/Permanent token/)
  })
  it('never leaks the token or the secret in its result', async () => {
    const r = await run(cfg({ appId: '1234567890123' }), fakeHttp(GOOD({ 'GET /debug_token': { data: { is_valid: true, expires_at: 0, scopes: [] } } })))
    expect(JSON.stringify(r)).not.toContain('EAAxxxx')
    expect(JSON.stringify(r)).not.toContain('a1b2c3d4e5f60718293a4b5c6d7e8f90')
  })
  it('a 24-hour temporary token is flagged with how to fix it', async () => {
    const soon = Math.floor(NOW.getTime() / 1000) + 5 * 3600
    const r = await run(cfg({ appId: '1234567890123' }), fakeHttp(GOOD({ 'GET /debug_token': { data: { is_valid: true, expires_at: soon, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'] } } })))
    expect(r).toMatchObject({ ok: true, level: 'PARTIAL' })
    expect(by(r, 'token')).toMatchObject({ status: 'warn', summary: expect.stringContaining('in 5 hours') })
    expect(by(r, 'token').problem.fixes.join(' ')).toMatch(/permanent token/)
  })
  it('a token missing a permission is a warning naming the permission', async () => {
    const r = await run(cfg({ appId: '1234567890123' }), fakeHttp(GOOD({ 'GET /debug_token': { data: { is_valid: true, expires_at: 0, scopes: ['whatsapp_business_messaging'] } } })))
    expect(by(r, 'token').summary).toMatch(/whatsapp_business_management/)
  })
  it('a wrong App Secret does not fail the connection — it is an optional check', async () => {
    const http = fakeHttp(GOOD({ 'GET /debug_token': graphErr(400, 190, 'Invalid OAuth access token signature') }))
    const r = await run(cfg({ appId: '1234567890123' }), http)
    expect(r.ok).toBe(true)
    expect(by(r, 'token')).toMatchObject({ status: 'warn' })
    expect(by(r, 'token').problem.title).toMatch(/App ID or App Secret/)
  })

  describe('when Meta says no', () => {
    it('expired token → NOT connected, with the fix, and the other checks are skipped', async () => {
      const r = await run(cfg(), fakeHttp({ 'GET /109876543210987': graphErr(401, 190, 'Session has expired', { error_subcode: 463 }) }))
      expect(r).toMatchObject({ ok: false, level: 'FAILED' })
      expect(by(r, 'phone').problem.title).toMatch(/expired/)
      expect(by(r, 'phone').problem.technical).toMatchObject({ code: 190, subcode: 463, fbtraceId: 'TRACE1' })
      expect(by(r, 'waba').status).toBe('skip')
      expect(by(r, 'templates').status).toBe('skip')
    })
    it('the Business Account ID pasted as the Phone number ID is recognised, and the real IDs are listed', async () => {
      const http = fakeHttp({
        'GET /109876543210987': graphErr(400, 100, "Unsupported get request. Object with ID '109876543210987' does not exist", { error_subcode: 33 }),
        'GET /109876543210987/phone_numbers': { data: [{ id: '777000111222333', display_phone_number: '+91 99999 12345' }] },
      })
      const r = await run(cfg(), http)
      const p = by(r, 'phone').problem
      expect(r.ok).toBe(false)
      expect(p.title).toMatch(/Business Account ID, not a Phone number ID/)
      expect(p.fixes[0]).toContain('777000111222333')
      expect(p.fixes[0]).toContain('+91 99999 12345')
    })
    it('a plainly wrong Phone number ID gets the generic "cannot find" help', async () => {
      const http = fakeHttp({ 'GET /109876543210987': graphErr(400, 100, "Object with ID '1' does not exist, cannot be loaded due to missing permissions", { error_subcode: 33 }) })
      const r = await run(cfg(), http)
      expect(by(r, 'phone').problem.title).toMatch(/cannot find this Phone number ID/)
    })
    it('the server cannot reach Meta → a network explanation, not a confusing Meta one', async () => {
      const http = { get: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }, post: async () => { throw new Error('unused') } }
      const r = await run(cfg(), http)
      expect(r.ok).toBe(false)
      expect(by(r, 'phone').problem.title).toMatch(/find Meta/)
    })
    it('missing details are reported before Meta is even asked', async () => {
      const http = fakeHttp({})
      const r = await run(cfg({ accessToken: null, phoneNumberId: null }), http)
      expect(r).toMatchObject({ ok: false, level: 'FAILED' })
      expect(by(r, 'credentials').summary).toContain('Access token and Phone number ID')
      expect(http.calls).toEqual([])
    })
  })

  describe('business account and templates', () => {
    it('no Business Account ID → connected, but warned that templates will not work', async () => {
      const r = await run(cfg({ wabaId: null }), fakeHttp(GOOD()))
      expect(r.ok).toBe(true)
      expect(by(r, 'waba')).toMatchObject({ status: 'warn' })
      expect(by(r, 'templates').status).toBe('skip')
    })
    it('a wrong Business Account ID is a failed check but sending still counts as connected', async () => {
      const r = await run(cfg(), fakeHttp(GOOD({ 'GET /123456789012345': graphErr(400, 100, "Object with ID '123456789012345' does not exist", { error_subcode: 33 }) })))
      expect(r.ok).toBe(true)
      expect(by(r, 'waba')).toMatchObject({ status: 'fail' })
      expect(by(r, 'waba').problem.title).toMatch(/Business Account ID/)
      expect(by(r, 'templates').status).toBe('skip')
    })
    it('templates blocked by a missing permission', async () => {
      const r = await run(cfg(), fakeHttp(GOOD({ 'GET /123456789012345/message_templates': graphErr(403, 200, '(#200) Requires whatsapp_business_management permission') })))
      expect(by(r, 'templates')).toMatchObject({ status: 'fail' })
      expect(by(r, 'templates').problem.fixes.join(' ')).toMatch(/whatsapp_business_management/)
    })
  })

  describe('webhook check', () => {
    it('no verify token / app secret → tells you what to add', async () => {
      const r = await run(cfg({ verifyToken: null }), fakeHttp(GOOD()))
      expect(by(r, 'webhook')).toMatchObject({ status: 'warn', summary: expect.stringContaining('a Verify token') })
    })
    it('configured but nothing received yet → step-by-step', async () => {
      const r = await run(cfg(), fakeHttp(GOOD()), { webhook: { lastReceivedAt: null, last7d: 0 } })
      expect(by(r, 'webhook')).toMatchObject({ status: 'warn', summary: 'Nothing has arrived from Meta yet.' })
      expect(by(r, 'webhook').problem.fixes.join(' ')).toMatch(/Verify and save/)
    })
  })

  describe('optional test message', () => {
    const ROUTES = { 'POST /109876543210987/messages': (body) => ({ messages: [{ id: 'wamid.ABC' }], echo: body }) }
    it('sends the hello_world template to the number given and reports the message id', async () => {
      const http = fakeHttp(GOOD(ROUTES))
      const r = await run(cfg(), http, { sendTo: '919999912345' })
      expect(by(r, 'message')).toMatchObject({ status: 'pass', details: { wamid: 'wamid.ABC' } })
      expect(http.calls).toContain('POST /109876543210987/messages')
    })
    it('sends nothing unless a number was given', async () => {
      const http = fakeHttp(GOOD(ROUTES))
      await run(cfg(), http)
      expect(http.calls.some((c) => c.startsWith('POST'))).toBe(false)
    })
    it('a number outside the test list explains how to add it', async () => {
      const r = await run(cfg(), fakeHttp(GOOD({ 'POST /109876543210987/messages': graphErr(400, 131030, 'Recipient phone number not in allowed list') })), { sendTo: '919999912345' })
      expect(by(r, 'message')).toMatchObject({ status: 'fail' })
      expect(by(r, 'message').problem.title).toMatch(/test list/)
      expect(r.ok).toBe(true) // the connection itself is fine
    })
  })
})
