/**
 * Rule-based bot logic — pure functions, no I/O, no AI. See migration 144.
 */

/**
 * Lower-case, Unicode-normalise and strip everything that is not a letter,
 * number or combining mark (so punctuation and emoji vanish) and collapse
 * spaces. Works for Latin, Devanagari, Bengali… "Hi!!  👋" -> "hi".
 */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
}

/** First standalone 6-digit Indian PIN code (not part of a longer number like a phone). */
export function extractPincode(text) {
  const m = /(?<![\p{N}])[1-9]\d{5}(?![\p{N}])/u.exec(String(text ?? ''))
  return m ? m[0] : null
}

/** true if `phrase` tokens appear as a contiguous run of whole words in `tokens`. */
function containsPhrase(tokens, phrase) {
  const p = phrase.split(' ')
  if (p.length === 0 || p[0] === '') return false
  for (let i = 0; i + p.length <= tokens.length; i++) {
    let ok = true
    for (let j = 0; j < p.length; j++) {
      if (tokens[i + j] !== p[j]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/**
 * Does one rule match this message?
 * @param {{ match_type: string, keywords: string[], exact_keywords?: string[], when_hours: string }} rule
 * @param {string} text raw customer text
 * @param {{ isOpen: boolean, pincode: string|null }} ctx
 */
export function ruleMatches(rule, text, ctx) {
  if (rule.when_hours === 'OPEN' && !ctx.isOpen) return false
  if (rule.when_hours === 'CLOSED' && ctx.isOpen) return false

  const norm = normalize(text)
  if (!norm) return false
  const tokens = norm.split(' ')

  if ((rule.exact_keywords ?? []).some((k) => normalize(k) === norm)) return true

  switch (rule.match_type) {
    case 'PINCODE':
      return Boolean(ctx.pincode)
    case 'EXACT':
      return rule.keywords.some((k) => normalize(k) === norm)
    case 'STARTS_WITH':
      return rule.keywords.some((k) => {
        const n = normalize(k)
        return n !== '' && (norm === n || norm.startsWith(n + ' '))
      })
    case 'CONTAINS':
      return rule.keywords.some((k) => containsPhrase(tokens, normalize(k)))
    default:
      return false
  }
}

/** First active rule (callers pass them ordered by position) that matches, or null. */
export function findMatchingRule(rules, text, ctx) {
  for (const r of rules) {
    if (r.is_active !== false && ruleMatches(r, text, ctx)) return r
  }
  return null
}

/** Replace {{variables}}; unknown or empty variables become an empty string. */
export function renderTemplate(template, vars) {
  return String(template ?? '')
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => (vars[k] != null ? String(vars[k]) : ''))
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .slice(0, 4096)
}

/** First word of a name for a friendly greeting; "there" when unknown. */
export function friendlyName(...names) {
  for (const n of names) {
    const first = String(n ?? '').trim().split(/\s+/)[0]
    if (first && !/^[+\d]/.test(first)) return first
  }
  return 'there'
}

const ORDER_STATUS_TEXT = Object.freeze({
  PENDING: 'waiting for payment confirmation',
  CONFIRMED: 'confirmed',
  PREPARING: 'being prepared',
  PACKED: 'packed and waiting for a delivery partner',
  OUT_FOR_DELIVERY: 'out for delivery',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
})

/** One sentence about the customer's latest order, or an honest "can't find one". */
export function describeLastOrder(order) {
  if (!order) return 'I could not find a recent order on this number.'
  const status = ORDER_STATUS_TEXT[order.status] ?? String(order.status ?? '').toLowerCase().replace(/_/g, ' ')
  return `Your latest order ${order.order_number} is ${status}.`
}

// ─── Business hours wording (IST, same convention as StoreStatusService) ───

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function toMinutes(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h > 23 || min > 59 ? null : h * 60 + min
}

function fmt12(minutes) {
  const h24 = Math.floor(minutes / 60)
  const m = minutes % 60
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`
}

/**
 * Human wording for "when are you open", based on the weekly schedule.
 *  open now / opens later today -> "from 9:00 AM to 10:00 PM today"
 *  closed for the day           -> "from 9:00 AM to 10:00 PM tomorrow" (or the weekday)
 *  no usable schedule           -> "during our regular working hours"
 *
 * @param {Record<string, { open?: string, close?: string, closed?: boolean }>|null} weeklyHours
 * @param {Date} [atUtc]
 */
export function describeHours(weeklyHours, atUtc = new Date()) {
  const fallback = 'during our regular working hours'
  if (!weeklyHours || typeof weeklyHours !== 'object') return fallback
  const ist = new Date(atUtc.getTime() + IST_OFFSET_MS)
  const nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes()
  const today = ist.getUTCDay()

  for (let offset = 0; offset < 7; offset++) {
    const day = (today + offset) % 7
    const cfg = weeklyHours[DAYS[day]]
    if (!cfg || cfg.closed === true) continue
    const open = toMinutes(cfg.open)
    const close = toMinutes(cfg.close)
    if (open === null || close === null) continue
    if (offset === 0 && nowMin >= close) continue // already closed for today
    const when = offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : `on ${DAYS[day][0].toUpperCase()}${DAYS[day].slice(1)}`
    return `from ${fmt12(open)} to ${fmt12(close)} ${when}`
  }
  return fallback
}
