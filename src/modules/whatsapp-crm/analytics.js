import { CrmError } from './errors.js'

/**
 * Pure rules for CRM analytics and cost (Phase 10). No database, no clock of its own —
 * everything here is unit-tested directly; the SQL that mirrors the cost rule is checked against it.
 */

export const RATE_CATEGORIES = Object.freeze(['MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE'])
export const MAX_RANGE_DAYS = 366
export const DEFAULT_RANGE_DAYS = 30
export const DEFAULT_ATTRIBUTION_DAYS = 7
export const REPLY_WINDOW_HOURS = 24

const IST_OFFSET_MS = 5.5 * 3_600_000
const DAY_MS = 86_400_000
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** "2026-10-02" in India time for an instant. */
export function istDate(at) {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)
}

/** The instant an India calendar day starts. Rejects 2026-02-30 style dates. */
export function istDayStart(ymd) {
  const m = DATE.exec(String(ymd ?? ''))
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return new Date(t - IST_OFFSET_MS)
}

/**
 * Report window. `from` and `to` are India calendar days, both inclusive; the default is the last 30 days
 * ending today. The returned `end` is exclusive (the start of the day after `to`).
 *
 * @returns {{ from: string, to: string, start: Date, end: Date, days: number, attributionDays: number }}
 */
export function parseRange({ from, to, attributionDays } = {}, now = new Date()) {
  const today = istDate(now)
  const toYmd = to ?? today
  const toStart = istDayStart(toYmd)
  if (!toStart) throw new CrmError('“To” must be a date like 2026-10-31.', 400, 'VALIDATION', { to: 'Invalid date' })
  const fromYmd = from ?? istDate(new Date(toStart.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS + IST_OFFSET_MS))
  const start = istDayStart(fromYmd)
  if (!start) throw new CrmError('“From” must be a date like 2026-10-01.', 400, 'VALIDATION', { from: 'Invalid date' })
  if (start.getTime() > toStart.getTime()) throw new CrmError('“From” must not be after “To”.', 400, 'VALIDATION', { from: 'After the end date' })
  const days = Math.round((toStart.getTime() - start.getTime()) / DAY_MS) + 1
  if (days > MAX_RANGE_DAYS) throw new CrmError(`Pick at most ${MAX_RANGE_DAYS} days at a time.`, 400, 'RANGE_TOO_LONG')
  const attr = attributionDays ?? DEFAULT_ATTRIBUTION_DAYS
  if (!Number.isInteger(attr) || attr < 1 || attr > 30) throw new CrmError('The order window must be 1–30 days.', 400, 'VALIDATION', { attributionDays: '1–30' })
  return { from: fromYmd, to: toYmd, start, end: new Date(toStart.getTime() + DAY_MS), days, attributionDays: attr }
}

/** Safe percentage with one decimal; null when there is nothing to divide by. */
export function pct(n, d) {
  const num = Number(n)
  const den = Number(d)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null
  return Math.round((num / den) * 1000) / 10
}

/** Amount in rupees, 2 decimals (money is summed in SQL as numeric; this only tidies the output). */
export function money(n) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0
}

// ─── Cost ───────────────────────────────────────────────────────────

/**
 * What Meta said it charged for, from the `pricing` block on a delivery webhook.
 * Meta: { billable: boolean, pricing_model: 'PMP', category: 'marketing' | 'utility' | …, type: 'regular' | 'free_customer_service' | … }
 * @returns {{ billable: boolean|null, category: string|null, type: string|null } | null}
 */
export function normalizePricing(raw) {
  if (!raw || typeof raw !== 'object') return null
  const cat = String(raw.category ?? '').toLowerCase()
  let category = null
  if (cat === 'marketing' || cat === 'marketing_lite') category = 'MARKETING'
  else if (cat === 'utility') category = 'UTILITY'
  else if (cat.startsWith('authentication')) category = 'AUTHENTICATION'
  else if (cat === 'service') category = 'SERVICE'
  const billable = typeof raw.billable === 'boolean' ? raw.billable : null
  const type = raw.type ? String(raw.type).toLowerCase().slice(0, 30) : null
  if (billable === null && !category && !type) return null
  return { billable, category, type }
}

/**
 * Does this message cost money? Meta bills a template message once it is DELIVERED — never because it was only
 * sent, and never when it failed (its `pricing` block also arrives on the earlier "sent" status, so the flag
 * alone proves nothing).
 *  - not delivered yet / failed → free
 *  - delivered and Meta says billable = false (e.g. free inside the customer-service window) → free
 *  - delivered and Meta says billable = true → billed, priced by Meta's category
 *  - delivered, no billing record yet → counted as an ESTIMATE, priced by the template's category
 * Free-form replies inside the 24-hour window are free and never reach this rule.
 *
 * @returns {{ counted: boolean, estimated: boolean }}
 */
export function costCounting({ status, billable }) {
  if (status !== 'DELIVERED' && status !== 'READ') return { counted: false, estimated: billable == null }
  if (billable === false) return { counted: false, estimated: false }
  return { counted: true, estimated: billable !== true }
}

/**
 * The rate in force on a day: the card with the latest effective date that is not in the future.
 * @param {Array<{ category: string, rate: number|string, effective_from: string }>} cards
 * @returns {number|null} null when no card applies yet
 */
export function rateFor(cards, category, ymd) {
  let best = null
  for (const c of cards) {
    if (c.category !== category) continue
    const eff = String(c.effective_from).slice(0, 10)
    if (eff > ymd) continue
    if (!best || eff > String(best.effective_from).slice(0, 10)) best = c
  }
  return best ? Number(best.rate) : null
}

export function validateRateCard(input, now = new Date()) {
  const errors = {}
  const category = String(input?.category ?? '').toUpperCase()
  if (!RATE_CATEGORIES.includes(category)) errors.category = 'Choose a category'
  const rate = Number(input?.rate)
  if (input?.rate === '' || input?.rate == null || !Number.isFinite(rate) || rate < 0 || rate > 1000) errors.rate = 'Enter the price in rupees (0–1000)'
  else if (Math.round(rate * 10000) / 10000 !== rate) errors.rate = 'At most 4 decimal places'
  const eff = istDayStart(input?.effectiveFrom)
  if (!eff) errors.effectiveFrom = 'Pick a date'
  else if (eff.getTime() > now.getTime() + 366 * DAY_MS) errors.effectiveFrom = 'Too far in the future'
  else if (eff.getTime() < Date.UTC(2023, 0, 1)) errors.effectiveFrom = 'Too far in the past'
  const note = input?.note ? String(input.note).trim().slice(0, 200) : null
  if (Object.keys(errors).length) throw new CrmError('Please fix the highlighted fields.', 400, 'VALIDATION', errors)
  return { category, rate, effectiveFrom: input.effectiveFrom, note }
}

// ─── Reading numbers ────────────────────────────────────────────────

/** Adds the percentages the dashboard shows next to raw counts. Counts are never altered. */
export function withRates(row) {
  const sent = Number(row.sent ?? 0)
  const delivered = Number(row.delivered ?? 0)
  const orders = Number(row.orders ?? 0)
  const cost = Number(row.cost ?? 0)
  const revenue = Number(row.revenue ?? 0)
  return {
    ...row,
    delivery_rate: pct(delivered, sent),
    read_rate: pct(row.read, delivered),
    reply_rate: pct(row.replied, delivered),
    failure_rate: pct(row.failed, Number(row.failed ?? 0) + sent),
    cost_per_order: orders > 0 && cost > 0 ? money(cost / orders) : null,
    // revenue earned for each rupee spent; only meaningful when something was spent
    revenue_per_rupee: cost > 0 ? Math.round((revenue / cost) * 10) / 10 : null,
  }
}

/** Fill gaps so a chart shows every day in the range, even quiet ones. */
export function fillDays(rows, start, days, zero) {
  const byDay = new Map(rows.map((r) => [String(r.day).slice(0, 10), r]))
  const out = []
  for (let i = 0; i < days; i++) {
    const ymd = istDate(new Date(start.getTime() + i * DAY_MS))
    out.push({ ...zero, ...(byDay.get(ymd) ?? {}), day: ymd })
  }
  return out
}

const SUMMED = ['sent', 'delivered', 'read', 'failed', 'replied', 'cost', 'unpriced', 'orders', 'revenue']

/**
 * Rows whose campaign / workflow / template no longer exists are history we keep but cannot name.
 * They are folded into ONE row so a few deletions do not bury the report in "(deleted)" lines.
 */
export function collapseDeleted(rows, label) {
  const live = rows.filter((r) => !r.deleted)
  const gone = rows.filter((r) => r.deleted)
  if (!gone.length) return live
  const merged = { id: 'deleted', name: label, deleted: true }
  for (const k of SUMMED) merged[k] = gone.reduce((n, r) => n + Number(r[k] ?? 0), 0)
  return [...live, merged]
}
