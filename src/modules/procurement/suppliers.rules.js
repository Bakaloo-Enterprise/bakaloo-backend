import { BusinessError } from '../../utils/business-error.js'

/** Supplier details + payables — pure functions, no I/O. Money is handled in integer paise. */

export const TERMS = Object.freeze(['CASH', 'UPI', 'BANK', 'CREDIT'])
export const PAY_METHODS = Object.freeze(['CASH', 'UPI', 'BANK'])
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const UPI = /^[A-Za-z0-9._-]{2,}@[A-Za-z]{2,}$/
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/
const DOC_MIME = Object.freeze({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' })
export const MAX_DOC_BYTES = 5 * 1024 * 1024

const toPaise = (v) => Math.round(Number(v) * 100)
const fromPaise = (p) => p / 100
const bad = (message, field) => new BusinessError(message, 400, 'VALIDATION', { [field]: 'Invalid' })
const text = (v) => { const t = String(v ?? '').trim(); return t === '' ? null : t }

/**
 * Clean the optional supplier details. `undefined` = leave unchanged, '' = clear.
 * A GSTIN is only checked for the right shape — it is NOT verified with the government, and the report says so.
 */
export function cleanVendorProfile(input) {
  const out = {}
  const put = (key, v) => { if (v !== undefined) out[key] = v }
  const opt = (key, label, max, fn) => {
    if (input[key] === undefined) return
    const t = text(input[key])
    if (t !== null && t.length > max) throw bad(`${label} is too long.`, key)
    put(key, t === null ? null : fn ? fn(t) : t)
  }
  opt('tradeName', 'Business name', 160)
  opt('address', 'Address', 300)
  opt('contactPerson', 'Contact person', 120)
  opt('gstin', 'GST number', 15, (t) => { const g = t.toUpperCase().replace(/\s/g, ''); if (!GSTIN.test(g)) throw bad('That GST number does not look right (15 letters and numbers).', 'gstin'); return g })
  opt('upiId', 'UPI ID', 80, (t) => { if (!UPI.test(t)) throw bad('That UPI ID does not look right (like name@bank).', 'upiId'); return t.toLowerCase() })
  opt('bankName', 'Bank name', 80)
  opt('bankAccountNo', 'Account number', 24, (t) => { const d = t.replace(/\s/g, ''); if (!/^\d{6,24}$/.test(d)) throw bad('Account number should be digits only.', 'bankAccountNo'); return d })
  opt('bankIfsc', 'IFSC', 11, (t) => { const c = t.toUpperCase(); if (!IFSC.test(c)) throw bad('That IFSC does not look right.', 'bankIfsc'); return c })
  if (input.paymentTerms !== undefined) {
    if (!TERMS.includes(input.paymentTerms)) throw bad('Choose how we pay this supplier.', 'paymentTerms')
    out.paymentTerms = input.paymentTerms
  }
  if (input.creditDays !== undefined) {
    if (!Number.isInteger(input.creditDays) || input.creditDays < 0 || input.creditDays > 365) throw bad('Credit days must be 0 to 365.', 'creditDays')
    out.creditDays = input.creditDays
  }
  if (out.paymentTerms && out.paymentTerms !== 'CREDIT' && input.creditDays === undefined) out.creditDays = 0
  return out
}

/** Mask all but the last 4 digits. */
export const maskAccount = (n) => (n ? `${'•'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}` : null)

/** Validate an uploaded invoice / slip. Returns the extension to show. */
export function checkDocument({ mime, size, kind }) {
  if (!['INVOICE', 'DELIVERY_SLIP', 'CREDIT_NOTE'].includes(kind)) throw bad('Say what kind of paper this is.', 'kind')
  if (!DOC_MIME[mime]) throw new BusinessError('Only a PDF, JPG or PNG picture is allowed.', 400, 'BAD_FILE_TYPE')
  if (!size) throw new BusinessError('That file is empty.', 400, 'EMPTY_FILE')
  if (size > MAX_DOC_BYTES) throw new BusinessError('That file is bigger than 5 MB.', 400, 'FILE_TOO_LARGE')
  return DOC_MIME[mime]
}

/** Validate a payment against what is owed. */
export function checkPayment({ amount, method, paidOn }, { balance, today }) {
  const paise = toPaise(amount)
  if (!Number.isFinite(paise) || paise <= 0) throw bad('Enter how much you paid.', 'amount')
  if (!PAY_METHODS.includes(method)) throw bad('Choose Cash, UPI or Bank.', 'method')
  const on = paidOn ?? today
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) throw bad('Date must look like 2026-10-17.', 'paidOn')
  if (on > today) throw bad('A payment cannot be dated in the future.', 'paidOn')
  if (paise > toPaise(balance)) throw new BusinessError(`You only owe ₹${balance}. Pay that or less.`, 409, 'OVERPAYMENT', { owed: balance })
  return { amount: fromPaise(paise), method, paidOn: on }
}

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/**
 * Work out, oldest bill first, how much of each bill is paid.
 *   bill = purchase total − credit for goods sent back
 * Payments (not voided) are spent on the oldest bills first. Returns the bills with paid / left / due date /
 * overdue, plus the totals. `today` is the India date.
 */
export function settleBills(bills, paymentsTotal, { creditDays = 0, today }) {
  let pool = toPaise(paymentsTotal)
  let owed = 0
  let overdue = 0
  let nextDue = null
  const rows = [...bills].sort((a, b) => (a.procuredOn < b.procuredOn ? -1 : a.procuredOn > b.procuredOn ? 1 : a.entryNo - b.entryNo)).map((b) => {
    const bill = Math.max(0, toPaise(b.total) - toPaise(b.credit))
    const paid = Math.min(bill, pool)
    pool -= paid
    const left = bill - paid
    const dueOn = addDays(b.procuredOn, creditDays)
    const isOverdue = left > 0 && dueOn < today
    owed += left
    if (isOverdue) overdue += left
    if (left > 0 && (nextDue === null || dueOn < nextDue)) nextDue = dueOn
    return { ...b, bill: fromPaise(bill), credit: fromPaise(toPaise(b.credit)), paid: fromPaise(paid), left: fromPaise(left), dueOn, overdue: isOverdue, status: left === 0 ? 'PAID' : paid > 0 ? 'PART' : 'UNPAID' }
  })
  return { bills: rows, owed: fromPaise(owed), overdue: fromPaise(overdue), advance: fromPaise(pool), nextDue }
}
