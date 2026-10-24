/**
 * Pure rules for the Operations ERP — no database, so every number can be checked by hand in a test.
 */
const r2 = (n) => Math.round(n * 100) / 100
const DAY_MS = 86_400_000

// ── targets ──
export const DEFAULT_TARGET_MARGIN_PCT = 22

/** Days a product stays sellable, read from text like "4 days" / "2 weeks" / "6 months"; null when unreadable. */
export function shelfLifeDays(text) {
  const m = /(\d+(?:\.\d+)?)\s*(day|days|d|week|weeks|w|month|months|m|year|years|y)\b/i.exec(String(text ?? ''))
  if (!m) return null
  const n = Number(m[1])
  const u = m[2].toLowerCase()
  return u.startsWith('d') ? n : u.startsWith('w') ? n * 7 : u.startsWith('m') ? n * 30 : n * 365
}

/** How much of what we handle may spoil before it is a problem: fresher goods are allowed more. */
export function defaultTargetWastagePct(shelfLife) {
  const d = typeof shelfLife === 'number' ? shelfLife : shelfLifeDays(shelfLife)
  if (d == null) return 5
  return d <= 2 ? 14 : d <= 5 ? 8 : d <= 15 ? 4 : 1.5
}

/** Cost of each sellable unit once the spoiled part is paid for too: cost × handled / (handled − wasted). */
export function effectiveCost(unitCost, handled, wasted) {
  const sellable = handled - wasted
  if (!(unitCost > 0) || !(handled > 0) || sellable <= 0) return unitCost > 0 ? unitCost : 0
  return r2((unitCost * handled) / sellable)
}

/** Price that earns the target margin on the effective cost, rounded UP to a whole rupee. */
export function suggestedPrice(effCost, targetMarginPct) {
  if (!(effCost > 0)) return null
  const m = Math.min(Math.max(Number(targetMarginPct) || 0, 0), 89) / 100
  return Math.ceil(effCost / (1 - m))
}

// ── forecast ──
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0)
const dowOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay()
export const addDays = (ymd, n) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10)

/** Fill missing days with 0 so a quiet day counts as a quiet day. `days` = ascending 'YYYY-MM-DD', `units` = Map(day → n). */
export const dense = (days, units) => days.map((d) => ({ day: d, units: units.get(d) ?? 0 }))

/**
 * Next-days demand for one product from its recent daily sales (oldest → newest, no gaps, last entry = the latest FULL day).
 * Level = recent average with the day-of-week effect taken out, Trend = last week vs the week before (damped),
 * Spread = how far real days landed from the model (used for safety stock).
 */
export function forecastDemand(history, horizon = 7) {
  const h = history.slice(-35)
  if (h.length < 7 || h.every((x) => x.units === 0)) return { daily: [], level: 0, spread: 0, confidence: 'none' }
  const overall = mean(h.map((x) => x.units))
  const byDow = Array.from({ length: 7 }, () => [])
  for (const x of h) byDow[dowOf(x.day)].push(x.units)
  const factor = byDow.map((a) => (overall > 0 ? clamp((a.length * (mean(a) / overall) + 2) / (a.length + 2), 0.6, 1.6) : 1)) // shrink thin weekdays toward 1
  const deseason = h.map((x) => x.units / factor[dowOf(x.day)])
  const last14 = deseason.slice(-14)
  const level = mean(last14)
  const prev7 = mean(deseason.slice(-14, -7))
  const last7 = mean(deseason.slice(-7))
  const trend = prev7 > 0 ? clamp((last7 - prev7) / prev7, -0.25, 0.25) : 0
  const resid = h.slice(-14).map((x) => x.units - level * factor[dowOf(x.day)])
  const spread = Math.sqrt(mean(resid.map((e) => e * e)))
  const start = h[h.length - 1].day
  const daily = Array.from({ length: horizon }, (_, k) => {
    const day = addDays(start, k + 1)
    return { day, units: Math.max(0, level * factor[dowOf(day)] * (1 + (trend / 7) * 0.5 * (k + 1))) }
  })
  return { daily, level, spread, trend, confidence: h.length >= 28 ? 'good' : h.length >= 14 ? 'fair' : 'low' }
}

/** How many days the stock lasts against the forecast (fractional). null = lasts beyond the forecast. */
export function coverDays(stock, daily) {
  let left = stock
  for (let i = 0; i < daily.length; i++) {
    if (daily[i].units >= left) return daily[i].units > 0 ? r2(i + left / daily[i].units) : null
    left -= daily[i].units
  }
  return null
}

/**
 * How much to buy for the next `coverDaysWanted` days: demand + safety − stock − already coming, plus what usually spoils.
 * z = 1.28 → about 9 in 10 days covered. Whole units, never negative.
 */
export function buyQuantity({ daily, spread, stock, incoming = 0, coverDaysWanted = 1, wastePct = 0, z = 1.28 }) {
  const demand = daily.slice(0, Math.max(1, Math.ceil(coverDaysWanted))).reduce((s, x) => s + x.units, 0)
  const need = demand + z * spread * Math.sqrt(Math.max(1, coverDaysWanted)) - stock - incoming
  if (need <= 0) return 0
  const waste = clamp(wastePct / 100, 0, 0.6)
  return Math.ceil(need / (1 - waste))
}

/**
 * How right was the method? Replay the last `days` days: forecast each day from only the days before it and compare with
 * what really sold. Accuracy = 1 − (total miss ÷ total sold), over all products.
 */
export function backtest(series /* Map productId → dense history */, days = 7) {
  let miss = 0
  let sold = 0
  for (const history of series.values()) {
    for (let k = days; k >= 1; k--) {
      const cut = history.length - k
      if (cut < 14) continue
      const f = forecastDemand(history.slice(0, cut), 1)
      const predicted = f.daily[0]?.units ?? 0
      const actual = history[cut].units
      miss += Math.abs(actual - predicted)
      sold += actual
    }
  }
  return sold > 0 ? { accuracyPct: Math.round((1 - miss / sold) * 1000) / 10, soldUnits: sold, missedUnits: Math.round(miss) } : { accuracyPct: null, soldUnits: 0, missedUnits: 0 }
}

/** A wastage breach: wasting clearly more than the target, and enough money to matter. */
export function wastageBreach({ wastagePct, targetPct, value, minValue = 80, factor = 1.35 }) {
  return wastagePct > targetPct * factor && value >= minValue
}

/** Share of a day's orders that is still to come after `hourNow` (India time, fractional), from the usual hour-by-hour pattern. */
export function shareLeftToday(hourCounts /* [{hour, orders}] */, hourNow) {
  const total = hourCounts.reduce((t, h) => t + h.orders, 0)
  if (total <= 0) return clamp((24 - hourNow) / 24, 0, 1)
  const whole = Math.floor(hourNow)
  let left = 0
  for (const h of hourCounts) {
    if (h.hour > whole) left += h.orders
    else if (h.hour === whole) left += h.orders * (1 - (hourNow - whole))
  }
  return clamp(left / total, 0, 1)
}
