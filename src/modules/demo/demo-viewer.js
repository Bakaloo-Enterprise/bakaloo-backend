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
