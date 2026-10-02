import { describe, expect, it } from 'vitest'
import { runConnectionTest } from '../../../src/modules/whatsapp-crm/connection-test.js'
import { WhatsappSettingsService } from '../../../src/modules/whatsapp-crm/settings.service.js'

const NOW = new Date('2026-10-02T10:00:00Z')
const graphErr = (status, code, message) => ({ response: { status, data: { error: { code, message, fbtrace_id: 'T1' } } } })
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const CALLBACK = 'https://api.bakaloo.in/api/webhook/whatsapp'

/** A fake Graph API: "GET /path" → value | Error | function(opts). Records every call. */
function fakeHttp(routes) {
  const calls = []
  const run = async (method, path, a, b) => {
    calls.push({ method, path, a, b })
    const hit = routes[`${method} ${path}`]
    if (hit === undefined) throw graphErr(400, 100, `no route ${method} ${path}`)
    const v = typeof hit === 'function' ? hit(a, b) : hit
    if (v instanceof Error || v?.response) throw v
    return { data: v }
  }
  return { calls, get: (p, o) => run('GET', p, o), post: (p, d, o) => run('POST', p, d, o) }
}

const config = (o = {}) => ({ phoneNumberId: '109876543210987', wabaId: '123456789012345', accessToken: 'EAA' + 'x'.repeat(40), appId: '987654321098765', appSecret: SECRET, verifyToken: 'bk_verify', ...o })
const BASE = {
  'GET /109876543210987': (o) => (String(o.params.fields).startsWith('display_phone_number') ? { display_phone_number: '+1 555 158 7511', verified_name: 'Test Number', quality_rating: 'GREEN' } : {}),
  'GET /123456789012345': { name: 'Test WABA', currency: 'USD' },
  'GET /123456789012345/message_templates': { data: [] },
  'GET /debug_token': { data: { is_valid: true, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], expires_at: 0 } },
}
const test = (cfg, http, webhook = { lastReceivedAt: null, last7d: 0 }) => runConnectionTest({ config: cfg, http, webhook, callbackUrl: CALLBACK, now: () => NOW })
const webhookOf = (r) => r.checks.find((c) => c.id === 'webhook')

describe('connection test — "are customer replies really wired up?"', () => {
  it('no App Secret: says replies are blocked and why (every event would be rejected)', async () => {
    const r = await test(config({ appSecret: null }), fakeHttp(BASE))
    expect(webhookOf(r).status).toBe('warn')
    expect(webhookOf(r).summary).toMatch(/App Secret/)
    expect(webhookOf(r).problem.title).toMatch(/blocked until the App Secret/i)
    expect(webhookOf(r).problem.cause).toMatch(/refuse anything we cannot check/)
  })

  it('Business Account not subscribed to the app: names that exact cause and the fix', async () => {
    const r = await test(config(), fakeHttp({ ...BASE, 'GET /123456789012345/subscribed_apps': { data: [] } }))
    expect(webhookOf(r).status).toBe('warn')
    expect(webhookOf(r).problem.title).toMatch(/not subscribed to your app/)
    expect(webhookOf(r).problem.fixes.join(' ')).toMatch(/Connect replies automatically/)
  })

  it('webhook saved in Meta but "messages" is not ticked: says so', async () => {
    const http = fakeHttp({
      ...BASE,
      'GET /123456789012345/subscribed_apps': { data: [{ whatsapp_business_api_data: { id: '987654321098765' } }] },
      'GET /987654321098765/subscriptions': { data: [{ object: 'whatsapp_business_account', callback_url: CALLBACK, active: true, fields: [{ name: 'message_template_status_update' }] }] },
    })
    const r = await test(config(), http)
    expect(webhookOf(r).problem.title).toMatch(/not subscribed to “messages”/)
  })

  it('Meta points at a different address: shows both', async () => {
    const http = fakeHttp({
      ...BASE,
      'GET /123456789012345/subscribed_apps': { data: [{ whatsapp_business_api_data: { id: '987654321098765' } }] },
      'GET /987654321098765/subscriptions': { data: [{ object: 'whatsapp_business_account', callback_url: 'https://old.example.com/hook', active: true, fields: [{ name: 'messages' }] }] },
    })
    const w = webhookOf(await test(config(), http))
    expect(w.summary).toMatch(/different address/)
    expect(w.details).toMatchObject({ metaCallbackUrl: 'https://old.example.com/hook', expected: CALLBACK })
  })

  it('everything set up and a message has arrived: pass; set up but silent: warns to send a test message', async () => {
    const ok = {
      ...BASE,
      'GET /123456789012345/subscribed_apps': { data: [{ whatsapp_business_api_data: { id: '987654321098765' } }] },
      'GET /987654321098765/subscriptions': { data: [{ object: 'whatsapp_business_account', callback_url: CALLBACK, active: true, fields: [{ name: 'messages' }] }] },
    }
    expect(webhookOf(await test(config(), fakeHttp(ok), { lastReceivedAt: new Date('2026-10-02T09:58:00Z'), last7d: 3 })).status).toBe('pass')
    const quiet = webhookOf(await test(config(), fakeHttp(ok)))
    expect(quiet.status).toBe('warn')
    expect(quiet.summary).toMatch(/Set up in Meta — nothing has arrived yet/)
  })
})

describe('connectReplies — one click tells Meta where to send replies', () => {
  const env = { WHATSAPP_PHONE_NUMBER_ID: '109876543210987', WHATSAPP_WABA_ID: '123456789012345', WHATSAPP_ACCESS_TOKEN: 'EAA' + 'x'.repeat(40), META_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: 'bk_verify_token', WHATSAPP_API_VERSION: 'v25.0' }
  const make = ({ row = { app_id: '987654321098765' }, e = env, http } = {}) => {
    const updates = []
    const repo = { get: async () => row, update: async (p) => updates.push(p), webhookInfo: async () => ({ lastReceivedAt: null, last7d: 0 }) }
    let slept = 0
    const svc = new WhatsappSettingsService({ repo, env: e, makeHttp: () => http, sleep: async (ms) => { slept += ms }, now: () => NOW })
    return { svc, updates, slept: () => slept }
  }
  const OK = { 'POST /987654321098765/subscriptions': { success: true }, 'POST /123456789012345/subscribed_apps': { success: true } }

  it('sets the app webhook (callback, verify token, messages) with the APP token, then subscribes the Business Account', async () => {
    const http = fakeHttp(OK)
    const { svc } = make({ http })
    const r = await svc.connectReplies({ origin: 'https://api.bakaloo.in' }, 'u1')
    expect(r).toMatchObject({ ok: true, callbackUrl: CALLBACK })
    expect(r.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['app:pass', 'waba:pass'])

    const form = new URLSearchParams(http.calls[0].a)
    expect(form.get('object')).toBe('whatsapp_business_account')
    expect(form.get('callback_url')).toBe(CALLBACK)
    expect(form.get('verify_token')).toBe('bk_verify_token')
    expect(form.get('fields')).toBe('messages,message_template_status_update')
    expect(form.get('access_token')).toBe(`987654321098765|${SECRET}`) // the APP token, not the user token
    expect(http.calls[0].b.headers.Authorization).toBe(false) // the user token must not be sent with the app token
    expect(http.calls[1]).toMatchObject({ method: 'POST', path: '/123456789012345/subscribed_apps' })
    expect(JSON.stringify(r)).not.toContain(SECRET) // never echoes a secret
  })

  it('refuses early, in plain words, when details are missing or the address is not public https', async () => {
    const noSecret = make({ http: fakeHttp(OK), e: { ...env, META_APP_SECRET: undefined }, row: { app_id: '987654321098765' } })
    await expect(noSecret.svc.connectReplies({ origin: 'https://api.bakaloo.in' }, 'u1')).rejects.toMatchObject({ code: 'MISSING_DETAILS', message: expect.stringContaining('App Secret') })
    const noApp = make({ http: fakeHttp(OK), row: {} })
    await expect(noApp.svc.connectReplies({ origin: 'https://api.bakaloo.in' }, 'u1')).rejects.toMatchObject({ code: 'MISSING_DETAILS', message: expect.stringContaining('App ID') })
    const local = make({ http: fakeHttp(OK) })
    await expect(local.svc.connectReplies({ origin: 'http://localhost:4500' }, 'u1')).rejects.toMatchObject({ code: 'NEEDS_PUBLIC_URL' })
  })

  it('a refusal from Meta is reported per step, with an explanation, and the other step still runs', async () => {
    const http = fakeHttp({ 'POST /987654321098765/subscriptions': graphErr(400, 100, 'Callback verification failed'), 'POST /123456789012345/subscribed_apps': { success: true } })
    const r = await make({ http }).svc.connectReplies({ origin: 'https://api.bakaloo.in' }, 'u1')
    expect(r.ok).toBe(false)
    expect(r.steps[0]).toMatchObject({ id: 'app', status: 'fail' })
    expect(r.steps[0].problem.title).toBeTruthy()
    expect(r.steps[1]).toMatchObject({ id: 'waba', status: 'pass' })
  })

  it('makes a verify token when there is none, saves it encrypted, and waits for the other process to see it', async () => {
    const http = fakeHttp(OK)
    const { svc, updates, slept } = make({ http, e: { ...env, WHATSAPP_VERIFY_TOKEN: undefined } })
    const r = await svc.connectReplies({ origin: 'https://api.bakaloo.in' }, 'u1')
    expect(r.ok).toBe(true)
    expect(updates).toHaveLength(1)
    expect(updates[0].verify_token_enc).toMatch(/^enc:|^v\d|./) // stored encrypted, not as typed
    expect(updates[0].verify_token_enc).not.toBe(new URLSearchParams(http.calls[0].a).get('verify_token'))
    expect(slept()).toBeGreaterThanOrEqual(10_000)
  })
})
