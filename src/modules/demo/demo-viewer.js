import { pool } from '../../config/database.js'

/**
 * Demo viewer response masking (migration 171).
 *
 * The data itself is already limited to demo customers by the demo_scope views (config/database.js). This is the second
 * layer: phone numbers and e-mails that do not belong to a demo customer — riders, staff, vendors, shop contacts —
 * leave the server blurred ("98••••••12"), and inside WhatsApp CRM / team chat NO number is shown at all, demo
 * customers' included. The dashboard blurs those dots visually; the real value never reaches the browser.
 */

const MAX_BODY = 8 * 1024 * 1024
const CRM_PREFIXES = ['/api/v1/admin/crm', '/api/v1/admin/chat']
const BULLET = '•'

const CONTACT_KEY = /(phone|mobile|msisdn|whatsapp|wa_id|e_?mail)/
const NOT_A_VALUE_KEY = /(verified|enabled|count|template|status|sent|opted|consent)/
const PERSON_NAME_KEY = /((vendor|supplier|rider|driver|delivery_partner).*name|contact_person|^contact_name$)/
// Indian mobiles (with optional +91 / 91) and any +<country code> number, not glued to other digits, letters or dashes.
const NUMBER_IN_TEXT = /(?<![\w-])(?:\+?91[\s-]?)?[6-9]\d{9}(?![\w-])|(?<![\w-])\+\d{10,14}(?![\w-])/g

let allowed = { at: 0, values: new Set() }

/** Phones and e-mails of the demo customers — the only contact details a demo viewer may see outside the CRM. */
async function demoContactValues() {
  if (Date.now() - allowed.at < 30_000) return allowed.values
  const { rows } = await pool.query(`SELECT phone, email FROM users WHERE is_demo_customer`)
  const values = new Set()
  for (const r of rows) {
    if (r.phone) values.add(String(r.phone))
    if (r.email) values.add(String(r.email).toLowerCase())
  }
  allowed = { at: Date.now(), values }
  return values
}

export const resetDemoContactCache = () => { allowed = { at: 0, values: new Set() } }

export function maskContact(value) {
  const s = String(value)
  if (s.includes('@')) {
    const [name, domain = ''] = s.split('@')
    const dot = domain.lastIndexOf('.')
    return `${name.slice(0, 1)}${BULLET.repeat(3)}@${BULLET.repeat(4)}${dot >= 0 ? domain.slice(dot) : ''}`
  }
  if (s.length <= 4) return BULLET.repeat(Math.max(s.length, 4))
  return `${s.slice(0, 2)}${BULLET.repeat(Math.max(s.length - 4, 4))}${s.slice(-2)}`
}

const maskText = (s) => s.replace(NUMBER_IN_TEXT, (m) => maskContact(m))
const snake = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

const PERSON_NAME = /^(name|full_name|first_name|last_name|customer_name|user_name|display_name|profile_name)$/
const PICTURE = /^(avatar_url|avatar|profile_picture|photo_url)$/

/** Does this object carry a phone / e-mail that is not a demo customer's (so the person's name must be blurred too)? */
function isForeignPerson(obj, ctx) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string' || v === '') continue
    const key = snake(k)
    if (CONTACT_KEY.test(key) && !NOT_A_VALUE_KEY.test(key)) {
      if (ctx.crm || !(ctx.allowed.has(v) || ctx.allowed.has(v.toLowerCase()))) return true
    }
  }
  return false
}

export function maskPayload(node, ctx, key = '') {
  if (Array.isArray(node)) return node.map((v) => maskPayload(v, ctx, key))
  if (node && typeof node === 'object') {
    const out = {}
    const foreign = isForeignPerson(node, ctx)
    for (const [k, v] of Object.entries(node)) {
      const nk = snake(k)
      if (foreign && typeof v === 'string' && v !== '' && PERSON_NAME.test(nk)) out[k] = maskContact(v)
      else if (foreign && PICTURE.test(nk) && v) out[k] = null
      else out[k] = maskPayload(v, ctx, k)
    }
    return out
  }
  if (typeof node !== 'string' && typeof node !== 'number') return node
  const k = snake(key)
  if (typeof node === 'string' && CONTACT_KEY.test(k) && !NOT_A_VALUE_KEY.test(k) && node !== '') {
    if (ctx.crm) return maskContact(node)
    return ctx.allowed.has(node) || ctx.allowed.has(node.toLowerCase()) ? node : maskContact(node)
  }
  if (typeof node === 'string' && (PERSON_NAME_KEY.test(k) || (ctx.vendors && (k === 'name' || k === 'gstin')))) {
    return node === '' ? node : maskContact(node)
  }
  if (typeof node === 'string' && ctx.crm) return maskText(node)
  return node
}

/** Installs the onSend hook. Only responses to requests authenticated as a demo viewer are touched. */
export function installDemoViewerMasking(app) {
  app.addHook('onSend', async (request, reply, payload) => {
    if (!request.auth?.demoViewer) return payload
    if (typeof payload !== 'string' || payload.length > MAX_BODY) return payload
    if (!String(reply.getHeader('content-type') || '').includes('application/json')) return payload
    let body
    try {
      body = JSON.parse(payload)
    } catch {
      return payload
    }
    const path = String(request.raw.url || '').split('?')[0]
    if (path.startsWith('/api/v1/admin/auth/') || path.startsWith('/api/v1/auth/')) return payload // the viewer's own profile
    const ctx = {
      crm: CRM_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)),
      vendors: path.includes('/vendors'),
      allowed: await demoContactValues(),
    }
    return JSON.stringify(maskPayload(body, ctx))
  })
}

/**
 * Read-only gate. A demo viewer can look at everything but change nothing: every POST / PUT / PATCH / DELETE is refused
 * before the route runs — saving a product or theme, deleting, blocking a customer, wallet credit / debit / refund,
 * WhatsApp or chat messages, notifications and campaigns, uploads. One global hook, so it covers every module (and new
 * ones) without per-route code. Sign-in / sign-out and pure "preview" calls stay open.
 */
export const DEMO_READ_ONLY_MESSAGE = 'Submit is not eligible for this account. This is a view-only demo account, so nothing can be changed or sent.'

const READ_ONLY_OK = new Set([
  '/api/v1/admin/auth/login',
  '/api/v1/admin/auth/logout',
  '/api/v1/admin/auth/select-shop',
  '/api/v1/auth/logout',
  '/api/v1/admin/fee-settings/preview', // calculates a fee, saves nothing
])
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const flagCache = new Map() // userId -> { at, demo }
export const resetDemoViewerFlagCache = () => flagCache.clear()

async function isDemoViewer(userId) {
  const hit = flagCache.get(userId)
  if (hit && Date.now() - hit.at < 15_000) return hit.demo
  const { rows } = await pool.query(`SELECT is_demo_viewer FROM users WHERE id = $1`, [userId])
  const demo = rows[0]?.is_demo_viewer === true
  flagCache.set(userId, { at: Date.now(), demo })
  return demo
}

export function installDemoReadOnlyGate(app) {
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return
    const path = String(request.raw.url || '').split('?')[0]
    if (!path.startsWith('/api/v1/') || READ_ONLY_OK.has(path)) return
    if (!request.headers.authorization && !request.cookies?.accessToken) return // webhooks, public sign-ups: not a signed-in user
    try {
      await request.jwtVerify()
    } catch {
      return // bad or expired token: the route's own auth answers 401 as usual
    }
    if (request.user?.id && (await isDemoViewer(request.user.id))) {
      return reply.code(403).send({ success: false, message: DEMO_READ_ONLY_MESSAGE, code: 'DEMO_READ_ONLY' })
    }
  })
}

/**
 * What a demo viewer sees on the WhatsApp Settings page instead of the real connection: obviously fake sample values.
 * The real phone number ID, business / app IDs, access token, app secret and webhook verify token never leave the
 * server for this account, and the page is read-only (all writes are refused by the gate above).
 */
export function demoWhatsappSettingsView(origin = '') {
  const now = Date.now()
  return {
    // true only so the form (with the sample values) is shown; every save / test / toggle is refused by the read-only gate
    canManage: true,
    state: 'CONNECTED',
    enabled: true,
    enabledSource: 'dashboard',
    connectedAt: new Date(now - 14 * 86_400_000).toISOString(),
    lastTestedAt: new Date(now - 2 * 86_400_000).toISOString(),
    lastTest: null,
    apiVersion: 'v21.0',
    fields: {
      phoneNumberId: { value: 'DEMO-100000000000000', source: 'dashboard' },
      wabaId: { value: 'DEMO-200000000000000', source: 'dashboard' },
      appId: { value: 'DEMO-300000000000000', source: 'dashboard' },
      accessToken: { configured: true, masked: 'DEMO••••••••••••sample', source: 'dashboard' },
      appSecret: { configured: true, masked: '••••demo', source: 'dashboard' },
      verifyToken: { configured: true, value: 'demo-verify-token-not-real', source: 'dashboard' },
    },
    webhook: { callbackUrl: `${origin || 'https://demo.example.com'}/api/webhook/whatsapp`.replace(/^https?:\/\/[^/]+/, 'https://demo.example.com'), lastReceivedAt: new Date(now - 3_600_000).toISOString(), last7d: 128 },
  }
}
