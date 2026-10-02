/**
 * Phone helpers for the WhatsApp CRM.
 *
 * Bakaloo stores customers' phones as a normalised 10-digit Indian mobile
 * (users.phone, see middlewares/validatePhone.js). WhatsApp uses the full
 * international number as digits only (wa_id, e.g. 919876543210).
 *
 * Matching is EXACT on the 10-digit number. (The reference project wacrm
 * compares only the last 8 digits; that is fine for a generic template but
 * could merge two different Bakaloo customers, so we deliberately don't.)
 */

const INDIA_CC = '91'
const INDIAN_MOBILE = /^[6-9]\d{9}$/

/**
 * Meta wa_id (digits, with country code) -> Bakaloo 10-digit phone.
 * Returns null for non-Indian or malformed numbers — those contacts simply
 * stay unmatched instead of being guessed.
 *
 * @param {string | null | undefined} waId
 * @returns {string | null}
 */
export function waIdToIndianPhone(waId) {
  if (!waId) return null
  const digits = String(waId).replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith(INDIA_CC)) {
    const national = digits.slice(2)
    return INDIAN_MOBILE.test(national) ? national : null
  }
  return null
}

/**
 * Anything a staff member or a CSV might contain -> the digits-only form Meta
 * wants (country code included, no "+"), or null if it is ambiguous.
 *
 * Accepted:  9876543210 · 09876543210 · 919876543210 · +91 98765-43210
 *            any other international number written with a leading "+"
 * Rejected:  a non-Indian number WITHOUT "+" — "4155551212" is a valid US
 *            national number but would be sent to Switzerland (+41…) if we
 *            guessed, and Meta would accept it silently.
 *
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function toWaId(raw) {
  if (raw == null) return null
  const compact = String(raw).trim().replace(/[\s().-]/g, '')
  if (!compact) return null

  if (compact.startsWith('+')) {
    const digits = compact.slice(1)
    return /^[1-9]\d{7,14}$/.test(digits) ? digits : null
  }
  if (!/^\d+$/.test(compact)) return null

  if (INDIAN_MOBILE.test(compact)) return INDIA_CC + compact
  if (/^0[6-9]\d{9}$/.test(compact)) return INDIA_CC + compact.slice(1)
  if (/^91[6-9]\d{9}$/.test(compact)) return compact
  return null
}

/**
 * True when the value looks like a business-scoped user id such as
 * "IN.13491208655302741918" (never confusable with a phone: it has a
 * two-letter prefix and a dot).
 *
 * @param {unknown} value
 */
export function isBsuid(value) {
  return typeof value === 'string' && /^[A-Za-z]{2}\.(?:ENT\.)?[A-Za-z0-9]{4,}$/.test(value.trim())
}
