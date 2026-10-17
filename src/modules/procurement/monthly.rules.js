import { BusinessError } from '../../utils/business-error.js'
import { istDate, istDayStart } from '../../utils/business-period.js'

/** Month-end report rules — pure functions, no I/O. */

/** "2026-10" → India-time window. `end` is exclusive; `asOf` is the last calendar day (the date balances are struck on). */
export function monthWindow(month, now = new Date()) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month ?? ''))
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new BusinessError('Month must look like 2026-10.', 400, 'VALIDATION', { month: 'Invalid' })
  const y = Number(m[1])
  const mo = Number(m[2])
  if (y < 2020) throw new BusinessError('That month is too far back.', 400, 'VALIDATION', { month: 'Too old' })
  const from = `${m[1]}-${m[2]}-01`
  if (from > istDate(now)) throw new BusinessError('That month has not started yet.', 400, 'VALIDATION', { month: 'In the future' })
  const nextY = mo === 12 ? y + 1 : y
  const nextM = mo === 12 ? 1 : mo + 1
  const next = `${nextY}-${String(nextM).padStart(2, '0')}-01`
  const start = istDayStart(from)
  const end = istDayStart(next)
  const lastDay = istDate(new Date(end.getTime() - 1))
  // A month that is still running is struck on today, so "late" means late today, not late on the 31st.
  const asOf = istDate(now) < lastDay ? istDate(now) : lastDay
  const dayBefore = istDate(new Date(start.getTime() - 1))
  const inProgress = istDate(now) < lastDay
    return { month: `${m[1]}-${m[2]}`, from, to: lastDay, start, end, asOf, dayBefore, inProgress, label: new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }
}

/** How late is a payment, in the buckets people think in. */
export function ageBucket(daysLate) {
  if (daysLate <= 0) return 'Not due yet'
  if (daysLate <= 7) return '1–7 days late'
  if (daysLate <= 30) return '8–30 days late'
  return 'Over 30 days late'
}
export const AGE_BUCKETS = Object.freeze(['Not due yet', '1–7 days late', '8–30 days late', 'Over 30 days late'])

export const daysBetween = (fromYmd, toYmd) => Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000)

const paise = (v) => Math.round(Number(v) * 100)
export const sumMoney = (rows, pick) => rows.reduce((n, r) => n + paise(pick(r)), 0) / 100

/**
 * Things a person should look at before closing the month. Each has a plain sentence and the rows behind it.
 * `d` is the report data (see monthly.service.js).
 */
export function findExceptions(d) {
  const out = []
  const add = (code, level, text, rows) => { if (rows.length > 0) out.push({ code, level, text: text(rows.length), rows }) }
  add('NO_INVOICE', 'warn', (n) => `${n} purchase${n === 1 ? '' : 's'} received this month with no invoice attached.`, d.purchases.filter((p) => p.status === 'ACTIVE' && p.invoices === 0).map((p) => ({ ref: `#${p.entryNo}`, who: p.vendor, detail: `${p.product} · ₹${p.total}` })))
  add('STILL_ORDERED', 'warn', (n) => `${n} order${n === 1 ? ' is' : 's are'} still “on the way” after more than 7 days.`, d.purchases.filter((p) => p.status === 'ORDERED' && daysBetween(p.date, d.window.asOf) > 7).map((p) => ({ ref: `#${p.entryNo}`, who: p.vendor, detail: `${p.product} · ordered ${p.date}` })))
  add('SUPPLIER_OWES_GOODS', 'info', (n) => `${n} supplier${n === 1 ? '' : 's'} still owe${n === 1 ? 's' : ''} goods (short delivery or replacement).`, d.purchases.filter((p) => p.owedQty > 0).map((p) => ({ ref: `#${p.entryNo}`, who: p.vendor, detail: `${p.product} · ${p.owedQty} still to come` })))
  add('SUPPLIER_OVERDUE', 'bad', (n) => `${n} supplier${n === 1 ? ' is' : 's are'} paid late at month end.`, d.payables.filter((v) => v.overdue > 0).map((v) => ({ ref: v.vendor, who: v.vendor, detail: `₹${v.overdue} late of ₹${v.closing} owed` })))
  add('SUPPLIER_ADVANCE', 'info', (n) => `${n} supplier${n === 1 ? ' was' : 's were'} paid more than the bills so far (advance).`, d.payables.filter((v) => v.advance > 0).map((v) => ({ ref: v.vendor, who: v.vendor, detail: `₹${v.advance} ahead` })))
  add('LEDGER_MISMATCH', 'bad', (n) => `${n} supplier account${n === 1 ? ' does' : 's do'} not add up (opening + bills − returns − paid ≠ closing).`, d.payables.filter((v) => Math.abs(v.difference) >= 0.01).map((v) => ({ ref: v.vendor, who: v.vendor, detail: `off by ₹${v.difference}` })))
  add('VOIDED_PAYMENT', 'info', (n) => `${n} supplier payment${n === 1 ? ' was' : 's were'} cancelled this month.`, d.payments.filter((p) => p.voided).map((p) => ({ ref: p.vendor, who: p.by ?? '', detail: `₹${p.amount} on ${p.date}: ${p.voidReason ?? ''}` })))
  add('MANUAL_UNPAID', 'warn', (n) => `${n} manual order${n === 1 ? ' has' : 's have'} not been marked as paid yet.`, (d.manualUnpaid ?? []).map((m) => ({ ref: m.order, who: m.customer, detail: `₹${m.total} · ${m.date}` })))
  add('B2B_OVER_30', 'bad', (n) => `${n} B2B bill${n === 1 ? ' is' : 's are'} more than 30 days late.`, d.aging.filter((a) => a.bucket === 'Over 30 days late').map((a) => ({ ref: a.order, who: a.customer, detail: `₹${a.outstanding} late ${a.daysLate} days` })))
  return out
}
