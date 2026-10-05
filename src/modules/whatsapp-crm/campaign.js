import { validateImageSource } from './header-image.js'
import { META_CODE } from './meta-client.js'
import { summarizeComponents } from './template.js'

/**
 * Pure rules for campaigns and workflows (Phase 7). No database, no network —
 * everything here is unit-tested directly.
 */

// ─── Consent ─────────────────────────────────────────────────────────

/**
 * May this contact receive this kind of message?
 *
 *  - suppressed contacts and OPTED_OUT contacts never receive anything automated
 *  - OPTED_IN may receive any category
 *  - a contact whose consent is UNKNOWN may receive a UTILITY message (order updates) only if
 *    they have already messaged us — they started the relationship. Never MARKETING.
 *
 * @param {{ category: string, consent: string, suppressed?: boolean, hasMessagedUs?: boolean,
 *           hasAddress: boolean }} f
 * @returns {{ ok: boolean, reason?: 'SUPPRESSED'|'OPTED_OUT'|'NO_CONSENT'|'NO_ADDRESS' }}
 */
export function consentDecision({ category, consent, suppressed = false, hasMessagedUs = false, hasAddress }) {
  if (!hasAddress) return { ok: false, reason: 'NO_ADDRESS' }
  if (suppressed) return { ok: false, reason: 'SUPPRESSED' }
  if (consent === 'OPTED_OUT') return { ok: false, reason: 'OPTED_OUT' }
  if (consent === 'OPTED_IN') return { ok: true }
  if (category === 'UTILITY' && hasMessagedUs) return { ok: true }
  return { ok: false, reason: 'NO_CONSENT' }
}

export const SKIP_REASON_TEXT = Object.freeze({
  SUPPRESSED: 'On the do-not-contact list',
  OPTED_OUT: 'Opted out of messages',
  NO_CONSENT: 'No recorded opt-in',
  NO_ADDRESS: 'No WhatsApp number',
  TEMPLATE_NOT_SENDABLE: 'Template not approved',
  MISSING_VALUES: 'A template value could not be filled',
})

// ─── Quiet hours ─────────────────────────────────────────────────────

const IST_OFFSET_MIN = 330
export const QUIET_START_HOUR = 21 // 9 pm IST
export const QUIET_END_HOUR = 9 // 9 am IST

/** Marketing messages are not sent between 9 pm and 9 am India time. */
export function isQuietHoursIST(at = new Date()) {
  const ist = new Date(at.getTime() + IST_OFFSET_MIN * 60_000)
  const h = ist.getUTCHours()
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR
}

// ─── Template values ─────────────────────────────────────────────────

/** Replace {{token}} in a staff-written value with what we know about the customer/order/cart. */
export function interpolate(text, tokens) {
  return String(text ?? '').replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (_, k) => (tokens?.[k] != null ? String(tokens[k]) : ''))
}

/**
 * Final value for every variable a template uses. A value the staff typed (possibly containing
 * {{tokens}}) wins; otherwise a token of the same name fills it automatically.
 *
 * @param {{ components: any[], parameter_format: string }} template
 * @param {Record<string,string>} spec
 * @param {Record<string,string|number>} tokens
 * @returns {{ values: Record<string,string>, missing: string[] }}
 */
export function resolveTemplateValues(template, spec, tokens) {
  const keys = summarizeComponents(template.components, template.parameter_format).variables.map((v) => v.key)
  const values = {}
  const missing = []
  for (const k of keys) {
    const typed = spec?.[k] != null ? interpolate(spec[k], tokens).trim() : ''
    const v = typed || (tokens?.[k] != null ? String(tokens[k]).trim() : '')
    if (v) values[k] = v
    else missing.push(k)
  }
  return { values, missing }
}

/** Variable keys a template needs that neither the staff value nor a known token can fill. */
export function unfillableKeys(template, spec, knownTokenNames) {
  const keys = summarizeComponents(template.components, template.parameter_format).variables.map((v) => v.key)
  return keys.filter((k) => !(spec?.[k] != null && String(spec[k]).trim() !== '') && !knownTokenNames.includes(k))
}

// ─── Send outcome ────────────────────────────────────────────────────

/**
 * What to do with a recipient after Meta refused (or failed) a send.
 * `retry` = put back in the queue; otherwise the recipient ends FAILED / SKIPPED with this note.
 */
export function classifySendError(meta, attempts, maxAttempts = 3) {
  if (meta.retryable && attempts < maxAttempts) return { retry: true }
  switch (meta.code) {
    case META_CODE.USER_OPTED_OUT_MARKETING:
      return { retry: false, status: 'SKIPPED', reason: 'OPTED_OUT', setConsent: 'OPTED_OUT' }
    case META_CODE.PER_USER_MARKETING_LIMIT:
      return { retry: false, status: 'SKIPPED', reason: 'MARKETING_CAP' }
    case META_CODE.NOT_A_WHATSAPP_USER:
      return { retry: false, status: 'SKIPPED', reason: 'NOT_ON_WHATSAPP' }
    case META_CODE.USER_BLOCKED_BUSINESS:
      return { retry: false, status: 'SKIPPED', reason: 'BLOCKED_BY_USER' }
    case META_CODE.TEMPLATE_PAUSED:
    case META_CODE.TEMPLATE_DISABLED:
    case META_CODE.TEMPLATE_NOT_FOUND_OR_UNAPPROVED:
      return { retry: false, status: 'FAILED', reason: 'TEMPLATE_PROBLEM', pauseCampaign: true }
    default:
      return { retry: false, status: 'FAILED', reason: 'SEND_FAILED' }
  }
}

// ─── Validation ──────────────────────────────────────────────────────

export const AUDIENCE_TYPES = Object.freeze(['SEGMENT', 'LABEL', 'STAGE', 'IMPORT', 'ALL_OPTED_IN'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @returns {{ errors: Record<string,string>, value?: object }} */
export function validateCampaignInput(i, { partial = false } = {}) {
  const errors = {}
  const out = {}

  if (!partial || i.name !== undefined) {
    const name = String(i.name ?? '').trim()
    if (!name) errors.name = 'Give the campaign a name.'
    else if (name.length > 120) errors.name = 'Name can be at most 120 characters.'
    out.name = name
  }
  if (!partial || i.templateId !== undefined) {
    if (!UUID.test(String(i.templateId ?? ''))) errors.templateId = 'Choose a template.'
    out.templateId = i.templateId
  }
  if (!partial || i.audience !== undefined) {
    const a = i.audience
    if (!a || !AUDIENCE_TYPES.includes(a.type)) errors.audience = 'Choose who receives this campaign.'
    else if (a.type !== 'ALL_OPTED_IN') {
      const ids = Array.isArray(a.ids) ? a.ids : []
      if (!ids.length) errors.audience = 'Pick at least one segment, label, stage or prospect list.'
      else if (ids.length > 20) errors.audience = 'Pick at most 20.'
      else if (!ids.every((x) => UUID.test(String(x)))) errors.audience = 'Invalid selection.'
    }
    out.audience = a?.type === 'ALL_OPTED_IN' ? { type: 'ALL_OPTED_IN', ids: [] } : { type: a?.type, ids: a?.ids ?? [] }
  }
  if (i.templateValues !== undefined) {
    const tv = i.templateValues
    if (!tv || typeof tv !== 'object' || Array.isArray(tv)) errors.templateValues = 'Template values must be an object.'
    else out.templateValues = Object.fromEntries(Object.entries(tv).map(([k, v]) => [k, String(v ?? '').slice(0, 500)]))
  }
  if (i.headerImageSource !== undefined) {
    const r = validateImageSource(i.headerImageSource)
    if (r.error) errors.headerImageSource = r.error
    else out.headerImageSource = r.value
  }
  if (i.headerMediaUrl !== undefined) {
    const u = String(i.headerMediaUrl ?? '').trim()
    if (u && !/^https:\/\/\S+$/.test(u)) errors.headerMediaUrl = 'Must be an https:// link.'
    out.headerMediaUrl = u || null
  }
  if (i.ratePerMinute !== undefined) {
    const r = Number(i.ratePerMinute)
    if (!Number.isInteger(r) || r < 1 || r > 600) errors.ratePerMinute = 'Rate must be between 1 and 600 messages per minute.'
    out.ratePerMinute = r
  }
  return { errors, value: Object.keys(errors).length ? undefined : out }
}

// ─── Workflows ───────────────────────────────────────────────────────

export const TRIGGERS = Object.freeze({
  CART_ABANDONED: {
    label: 'Cart abandoned',
    fields: ['cart_value', 'item_count', 'order_count'],
    tokens: ['customer_name', 'cart_value', 'item_count', 'cart_items', 'cart_link', 'cart_ref', 'coupon_code'],
  },
  ORDER_STATUS: {
    label: 'Order status changed',
    fields: ['order_total', 'order_count', 'payment_method'],
    tokens: ['customer_name', 'order_number', 'order_total', 'order_status'],
  },
})

/** Order statuses a workflow may react to (the customer-facing steps of the agreement §40). */
export const ORDER_TRIGGER_STATUSES = Object.freeze(['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'])
export const OPS = Object.freeze(['gt', 'gte', 'lt', 'lte', 'eq', 'neq'])
export const ACTION_TYPES = Object.freeze(['SEND_TEMPLATE', 'ADD_LABEL'])
export const MAX_CART_DELAY_MINUTES = 24 * 60

export function validateWorkflowInput(i, { partial = false } = {}) {
  const errors = {}
  const out = {}

  if (!partial || i.name !== undefined) {
    const name = String(i.name ?? '').trim()
    if (!name) errors.name = 'Give the workflow a name.'
    else if (name.length > 120) errors.name = 'Name can be at most 120 characters.'
    out.name = name
  }
  if (i.description !== undefined) out.description = String(i.description ?? '').trim().slice(0, 300) || null

  const trigger = i.triggerType
  if (!partial || trigger !== undefined) {
    if (!TRIGGERS[trigger]) errors.triggerType = 'Choose what starts this workflow.'
    out.triggerType = trigger
  }
  if (!partial || i.triggerConfig !== undefined) {
    const cfg = i.triggerConfig ?? {}
    if (trigger === 'CART_ABANDONED') {
      const d = cfg.delayMinutes ?? 5
      if (!Number.isInteger(d) || d < 1 || d > MAX_CART_DELAY_MINUTES) errors.triggerConfig = 'Wait time must be between 1 minute and 24 hours.'
      out.triggerConfig = { delay_minutes: d }
    } else if (trigger === 'ORDER_STATUS') {
      if (!ORDER_TRIGGER_STATUSES.includes(cfg.status)) errors.triggerConfig = `Choose an order status: ${ORDER_TRIGGER_STATUSES.join(', ')}.`
      out.triggerConfig = { status: cfg.status }
    }
  }
  if (i.conditions !== undefined) {
    const conds = Array.isArray(i.conditions) ? i.conditions : null
    const allowed = TRIGGERS[trigger]?.fields ?? []
    if (!conds || conds.length > 5) errors.conditions = 'At most 5 conditions.'
    else {
      const bad = conds.find((c) => !allowed.includes(c?.field) || !OPS.includes(c?.op) || c?.value == null || String(c.value).length > 40)
      if (bad) errors.conditions = 'Each condition needs a field, a comparison and a value.'
      else out.conditions = conds.map((c) => ({ field: c.field, op: c.op, value: c.value }))
    }
  }
  if (!partial || i.actions !== undefined) {
    const acts = Array.isArray(i.actions) ? i.actions : []
    if (!acts.length) errors.actions = 'Add at least one action.'
    else if (acts.length > 3) errors.actions = 'At most 3 actions.'
    else {
      for (const a of acts) {
        if (!ACTION_TYPES.includes(a?.type)) { errors.actions = 'Unknown action.'; break }
        if (a.type === 'SEND_TEMPLATE' && !UUID.test(String(a.templateId ?? ''))) { errors.actions = 'Choose a template for the message.'; break }
        if (a.type === 'ADD_LABEL' && !UUID.test(String(a.labelId ?? ''))) { errors.actions = 'Choose a label.'; break }
        if (a.type === 'SEND_TEMPLATE' && a.imageSource != null) {
          const r = validateImageSource(a.imageSource, { allowCart: trigger === 'CART_ABANDONED' })
          if (r.error) { errors.actions = r.error; break }
        }
        if (a.couponId && (trigger !== 'CART_ABANDONED' || !UUID.test(String(a.couponId)))) { errors.actions = 'A coupon can only be attached to a cart reminder.'; break }
      }
      if (!errors.actions) {
        out.actions = acts.map((a) =>
          a.type === 'SEND_TEMPLATE'
            ? { type: 'SEND_TEMPLATE', templateId: a.templateId, values: Object.fromEntries(Object.entries(a.values ?? {}).map(([k, v]) => [k, String(v ?? '').slice(0, 500)])), ...(a.couponId ? { couponId: a.couponId } : {}), ...(a.imageSource ? { imageSource: validateImageSource(a.imageSource, { allowCart: trigger === 'CART_ABANDONED' }).value } : {}) }
            : { type: 'ADD_LABEL', labelId: a.labelId },
        )
      }
    }
  }
  return { errors, value: Object.keys(errors).length ? undefined : out }
}

/** All conditions must hold. An unknown fact fails the condition (never sends on a guess). */
export function evaluateConditions(conditions, facts) {
  return (conditions ?? []).every((c) => {
    const have = facts?.[c.field]
    if (have == null) return false
    const numeric = typeof have === 'number'
    const a = numeric ? have : String(have).toUpperCase()
    const b = numeric ? Number(c.value) : String(c.value).toUpperCase()
    if (numeric && Number.isNaN(b)) return false
    switch (c.op) {
      case 'gt': return a > b
      case 'gte': return a >= b
      case 'lt': return a < b
      case 'lte': return a <= b
      case 'eq': return a === b
      case 'neq': return a !== b
      default: return false
    }
  })
}

/** Is the cart reminder still worth sending? (older than 2 h past its due time = skip) */
export const STALE_EVENT_MINUTES = 120
/** Order-status messages older than this are not sent (a "packed" message two days late is wrong). */
export const ORDER_EVENT_MAX_AGE_MINUTES = 30

/** Short code that attributes a purchase to a WhatsApp cart reminder. */
export function cartRef(cartId) {
  return String(cartId).replace(/-/g, '').slice(0, 10)
}
