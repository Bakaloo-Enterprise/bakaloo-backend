import { BusinessError } from './business-error.js'

const IST_OFFSET_MS = 5.5 * 3_600_000
const DAY_MS = 86_400_000
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
export const MAX_PERIOD_DAYS = 366

/** "2026-10-02" in India time for an instant. */
export function istDate(at) {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)
}

/** The instant an India calendar day starts; null for anything that is not a real date (2026-02-30). */
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
 * Report window in India calendar days. `period` is the quick filter from the screens:
 * today | 7d | 30d (ending today) or custom (from + to, both inclusive). The returned `end` is exclusive.
 * @returns {{ period: string, from: string, to: string, start: Date, end: Date, days: number }}
 */
export function parsePeriod({ period = '30d', from, to } = {}, now = new Date(), maxDays = MAX_PERIOD_DAYS) {
  const today = istDate(now)
  let fromYmd
  let toYmd
  if (period === 'custom' || (from && to)) {
    if (!from || !to) throw new BusinessError('Pick both a start and an end date.', 400, 'VALIDATION', { from: 'Required', to: 'Required' })
    fromYmd = from
    toYmd = to
    period = 'custom'
  } else {
    const n = { today: 1, '7d': 7, '30d': 30 }[period]
    if (!n) throw new BusinessError('Period must be today, 7d, 30d or custom.', 400, 'VALIDATION', { period: 'Invalid' })
    toYmd = today
    fromYmd = istDate(new Date(istDayStart(today).getTime() - (n - 1) * DAY_MS + IST_OFFSET_MS))
  }
  const start = istDayStart(fromYmd)
  const toStart = istDayStart(toYmd)
  if (!start) throw new BusinessError('“From” must be a date like 2026-10-01.', 400, 'VALIDATION', { from: 'Invalid date' })
  if (!toStart) throw new BusinessError('“To” must be a date like 2026-10-31.', 400, 'VALIDATION', { to: 'Invalid date' })
  if (start.getTime() > toStart.getTime()) throw new BusinessError('“From” must not be after “To”.', 400, 'VALIDATION', { from: 'After the end date' })
  const days = Math.round((toStart.getTime() - start.getTime()) / DAY_MS) + 1
  if (days > maxDays) throw new BusinessError(`Pick at most ${maxDays} days at a time.`, 400, 'RANGE_TOO_LONG')
  return { period, from: fromYmd, to: toYmd, start, end: new Date(toStart.getTime() + DAY_MS), days }
}

/** Rupees to 2 decimals (sums happen in SQL as numeric; this only tidies output). */
export function money(n) {
  const v = Number(n)
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0
}

/** Percentage with one decimal; null when there is nothing to divide by. */
export function pct(n, d) {
  const num = Number(n)
  const den = Number(d)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null
  return Math.round((num / den) * 1000) / 10
}
