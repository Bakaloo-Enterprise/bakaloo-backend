import { BusinessError } from '../../utils/business-error.js'
import { emitInTx } from '../../utils/audit-log.js'
import { withTransaction } from '../procurement/procurement.repository.js'
import { ShopProductsRepository } from '../shop-products/shop-products.repository.js'
import { istDate, istDayStart, money, parsePeriod, pct } from '../../utils/business-period.js'
import {
  DEFAULT_TARGET_MARGIN_PCT, addDays, backtest, buyQuantity, coverDays, defaultTargetWastagePct, dense, effectiveCost, forecastDemand, shareLeftToday, shelfLifeDays, suggestedPrice, wastageBreach,
} from './ops.rules.js'

const DAY_MS = 86_400_000
const r1 = (n) => Math.round(n * 10) / 10
const num = (v) => (v == null ? null : Number(v))

export const WASTE_REASONS = Object.freeze(['Spoilage / Rot', 'Over-ripe', 'Transit damage', 'Unsold dump (EOD)', 'Pest damage', 'Moisture / weight loss', 'Other'])

export const OPS_DEFINITIONS = Object.freeze({
  sold: 'Units on orders that stood — not cancelled, not unpaid, not refunded in full.',
  revenue: 'What customers were charged for those units (before any part-refund).',
  cost: 'What we paid per unit: the average of purchases that day, else the latest purchase, else the shelf cost price.',
  cogs: 'Units sold × cost per unit.',
  wasted: 'Units written off as damaged/spoiled from the stock ledger, valued at cost. Damage found at the door when a purchase arrives is shown separately.',
  profit: 'Revenue − cost of goods sold − wastage. Delivery, commission, gateway fees, GST and running costs are not in here (see Accounting).',
  effectiveCost: 'Cost of each sellable unit after paying for what spoiled, over the last 14 days: cost × handled ÷ (handled − wasted).',
  suggestedPrice: 'Effective cost ÷ (1 − target margin), rounded up to a whole rupee. Advice only — nothing changes by itself.',
  ledgerCheck: 'Opening + bought + cancelled/returned back − sold − wasted ± adjustments must equal closing. Anything else is a gap in the stock records.',
  forecast: 'Home-delivery demand only (business orders are planned from requests). Recent level with the day-of-week effect, a damped trend, and a safety cushion for ordinary ups and downs.',
  accuracy: 'Last 7 days replayed: each day forecast from only the days before it, compared with what really sold.',
})

const dayWindow = (date, now) => {
  const ymd = date ?? istDate(now)
  const start = istDayStart(ymd)
  if (!start) throw new BusinessError('Date must look like 2026-10-24.', 400, 'VALIDATION', { date: 'Invalid date' })
  return { ymd, start, end: new Date(start.getTime() + DAY_MS) }
}

/** Day-close, wastage and forecast for the shop owner. Pure orchestration over OpsRepository + ops.rules. */
export class OpsService {
  constructor({ repo, now = () => new Date() }) {
    Object.assign(this, { repo, now })
  }

  /** One day, product by product: what we had, bought, sold, lost — and whether today's prices earned their keep. */
  async dayClose({ date, shopId = null } = {}) {
    const now = this.now()
    const w = dayWindow(date, now)
    const back14 = new Date(w.end.getTime() - 14 * DAY_MS)
    const [ledger, sales, costs, hist, purchases] = await Promise.all([
      this.repo.ledger([w.start, w.end, shopId]), this.repo.sales([w.start, w.end, shopId]), this.repo.costs([w.start, w.end, shopId]),
      this.repo.ledger([back14, w.end, shopId]), this.repo.purchases([w.ymd, w.ymd, shopId]),
    ])
    const saleBy = new Map(sales.map((s) => [s.product_id, s]))
    const costBy = new Map(costs.map((c) => [c.product_id, c]))
    const histBy = new Map(hist.map((h) => [h.product_id, h]))
    const doorBy = new Map()
    for (const p of purchases) { const x = doorBy.get(p.product_id) ?? { qty: 0, value: 0, spend: 0 }; x.qty += p.damaged_qty; x.value += Number(p.damaged_value); x.spend += Number(p.spend); doorBy.set(p.product_id, x) }
    const isToday = w.ymd === istDate(now)

    const rows = ledger.map((l) => {
      const s = saleBy.get(l.product_id)
      const c = costBy.get(l.product_id) ?? {}
      const h = histBy.get(l.product_id)
      const unitCost = num(c.window_cost) ?? num(c.last_cost) ?? num(c.shop_cost) ?? num(c.catalog_cost) ?? 0
      const units = s?.units ?? 0
      const revenue = money(s?.revenue ?? 0)
      const cogs = money(units * unitCost)
      const wasteValue = money(l.wasted * unitCost)
      const profit = money(revenue - cogs - wasteValue)
      const handled = l.opening + l.bought
      const expected = l.opening + l.bought + l.cancel_back + l.returned - l.sold_out - l.wasted + l.adjusted
      const targetWaste = num(l.target_wastage_pct) ?? defaultTargetWastagePct(l.shelf_life)
      const targetMargin = num(l.target_margin_pct) ?? DEFAULT_TARGET_MARGIN_PCT
      const effCost = effectiveCost(unitCost, h ? h.opening + h.bought : 0, h?.wasted ?? 0)
      const suggested = suggestedPrice(effCost, targetMargin)
      const avgPrice = units > 0 ? money(revenue / units) : num(c.shelf_price) ?? num(c.catalog_price)
      let advice = null
      if (suggested != null && avgPrice != null) advice = avgPrice < suggested * 0.98 ? 'RAISE' : avgPrice > suggested * 1.3 ? 'ROOM_TO_DISCOUNT' : 'OK'
      return {
        productId: l.product_id, name: l.name, category: l.category, unit: l.unit, pack: l.net_quantity,
        opening: l.opening, bought: l.bought, sold: units, wasted: l.wasted, returnedToShelf: l.cancel_back + l.returned, adjusted: l.adjusted, closing: l.closing,
        orders: s?.orders ?? 0, revenue, unitCost: money(unitCost), cogs, wasteValue, profit, marginPct: pct(profit, revenue),
        wastePct: pct(l.wasted, handled), targetWastePct: targetWaste, doorDamage: doorBy.get(l.product_id) ? { qty: doorBy.get(l.product_id).qty, value: money(doorBy.get(l.product_id).value) } : null,
        price: { average: avgPrice == null ? null : money(avgPrice), effectiveCost: money(effCost), targetMarginPct: targetMargin, suggested, advice },
        ledgerGap: l.closing - expected, // 0 = the stock records add up
        shelfMismatch: isToday ? l.stock_now - l.closing : 0,
      }
    }).filter((r) => r.sold > 0 || r.bought > 0 || r.wasted > 0 || r.adjusted !== 0 || r.returnedToShelf > 0 || r.ledgerGap !== 0 || r.shelfMismatch !== 0)
      .sort((a, b) => b.revenue - a.revenue || b.wasteValue - a.wasteValue)

    const sum = (f) => money(rows.reduce((t, r) => t + f(r), 0))
    const revenue = sum((r) => r.revenue)
    const cogs = sum((r) => r.cogs)
    const wasteValue = sum((r) => r.wasteValue)
    const profit = money(revenue - cogs - wasteValue)
    const purchaseSpend = money([...doorBy.values()].reduce((t, x) => t + x.spend, 0))
    const doorValue = money([...doorBy.values()].reduce((t, x) => t + x.value, 0))
    const gaps = rows.filter((r) => r.ledgerGap !== 0 || r.shelfMismatch !== 0)
    return {
      date: w.ymd, shopId, isToday, inProgress: isToday,
      totals: { revenue, cogs, wasteValue, profit, marginPct: pct(profit, revenue), unitsSold: rows.reduce((t, r) => t + r.sold, 0), unitsWasted: rows.reduce((t, r) => t + r.wasted, 0), purchaseSpend, doorDamageValue: doorValue },
      raise: rows.filter((r) => r.price.advice === 'RAISE').length,
      ledger: { gaps: gaps.length, items: gaps.slice(0, 10).map((r) => ({ productId: r.productId, name: r.name, gap: r.ledgerGap, shelfMismatch: r.shelfMismatch })) },
      items: rows, definitions: OPS_DEFINITIONS,
    }
  }

  /** Where the loss is: by reason, product, category, day and weekday; and who breaches their target. */
  async wastage(q = {}) {
    const p = parsePeriod({ period: q.period ?? '30d', from: q.from, to: q.to }, this.now())
    const shopId = q.shopId ?? null
    const args = [p.start, p.end, shopId]
    const [rows, ledger, purchases] = await Promise.all([this.repo.wastage(args), this.repo.ledger(args), this.repo.purchases([p.from, p.to, shopId])])
    const meta = new Map(ledger.map((l) => [l.product_id, l]))
    const total = { qty: 0, value: 0 }
    const by = { reason: new Map(), product: new Map(), category: new Map(), day: new Map(), dow: new Map() }
    const heat = new Map() // product → weekday[7] value
    const bump = (m, k, qty, value, extra = {}) => { const x = m.get(k) ?? { qty: 0, value: 0, ...extra }; x.qty += qty; x.value += value; m.set(k, x) }
    for (const r of rows) {
      const qty = r.qty
      const value = Number(r.value)
      const l = meta.get(r.product_id)
      const dow = new Date(`${r.day}T00:00:00Z`).getUTCDay()
      total.qty += qty; total.value += value
      bump(by.reason, r.reason, qty, value)
      bump(by.product, r.product_id, qty, value)
      bump(by.category, l?.category ?? 'Other', qty, value)
      bump(by.day, r.day, qty, value)
      bump(by.dow, dow, qty, value)
      const hrow = heat.get(r.product_id) ?? Array(7).fill(0)
      hrow[dow] += value; heat.set(r.product_id, hrow)
    }
    const reasonOf = new Map() // product → its biggest reason
    for (const r of rows) { const k = `${r.product_id}|${r.reason}`; reasonOf.set(k, (reasonOf.get(k) ?? 0) + Number(r.value)) }
    const topReason = (pid) => { let best = null; for (const [k, v] of reasonOf) if (k.startsWith(`${pid}|`) && (!best || v > best.v)) best = { r: k.slice(pid.length + 1), v }; return best?.r ?? null }

    const handledTotal = ledger.reduce((t, l) => t + l.opening + l.bought, 0)
    const products = [...by.product.entries()].map(([pid, x]) => {
      const l = meta.get(pid)
      const handled = l ? l.opening + l.bought : 0
      const target = num(l?.target_wastage_pct) ?? defaultTargetWastagePct(l?.shelf_life)
      const wastePct = pct(x.qty, handled)
      return { productId: pid, name: l?.name ?? 'Unknown', category: l?.category ?? null, qty: x.qty, value: money(x.value), handled, wastePct, targetPct: target, breach: wastePct != null && wastageBreach({ wastagePct: wastePct, targetPct: target, value: x.value }), topReason: topReason(pid) }
    }).sort((a, b) => b.value - a.value)
    let run = 0
    for (const x of products) { run += x.value; x.cumulativePct = pct(run, total.value) } // Pareto: how few products make most of the loss

    const days = []
    for (let d = p.from; d <= p.to; d = addDays(d, 1)) days.push({ day: d, value: money(by.day.get(d)?.value ?? 0), qty: by.day.get(d)?.qty ?? 0 })
    const doorValue = purchases.reduce((t, x) => t + Number(x.damaged_value), 0)
    const vendors = new Map()
    for (const x of purchases) if (x.damaged_qty > 0) bump(vendors, x.vendor, x.damaged_qty, Number(x.damaged_value))
    const top = products.slice(0, 8)
    return {
      period: p.period, from: p.from, to: p.to, days: p.days, shopId,
      totals: { qty: total.qty, value: money(total.value), wastePct: pct(total.qty, handledTotal), handled: handledTotal, perDay: money(total.value / p.days), doorDamageValue: money(doorValue) },
      breaches: products.filter((x) => x.breach).length,
      byReason: [...by.reason.entries()].map(([reason, x]) => ({ reason, qty: x.qty, value: money(x.value), sharePct: pct(x.value, total.value) })).sort((a, b) => b.value - a.value),
      byCategory: [...by.category.entries()].map(([category, x]) => ({ category, qty: x.qty, value: money(x.value), sharePct: pct(x.value, total.value) })).sort((a, b) => b.value - a.value),
      byWeekday: Array.from({ length: 7 }, (_, d) => ({ weekday: d, value: money(by.dow.get(d)?.value ?? 0) })),
      products: products.slice(0, 40),
      heatmap: top.map((x) => ({ productId: x.productId, name: x.name, weekdays: heat.get(x.productId).map(money) })),
      daily: days,
      doorDamage: { value: money(doorValue), byVendor: [...vendors.entries()].map(([vendor, x]) => ({ vendor, qty: x.qty, value: money(x.value) })).sort((a, b) => b.value - a.value) },
      definitions: OPS_DEFINITIONS,
    }
  }

  /**
   * What to buy for tomorrow, how long stock lasts, and how much to trust the forecast.
   * Sales history ends with the last FULL day (yesterday), so forecast[0] is today and forecast[1] is tomorrow. Today's stock
   * is first reduced by what is still expected to sell before closing — a shelf that looks thin at 5 PM is not a problem yet.
   */
  async forecast({ shopId = null, horizon = 7, cover = 1 } = {}) {
    const now = this.now()
    const today = istDate(now)
    const end = istDayStart(today)
    const lastDay = addDays(today, -1)
    const days = Array.from({ length: 35 }, (_, i) => addDays(lastDay, -(34 - i)))
    const start = istDayStart(days[0])
    const wasteStart = new Date(end.getTime() - 28 * DAY_MS)
    const hourNow = (now.getTime() - end.getTime()) / 3_600_000
    const [daily, stock, ledger, hours] = await Promise.all([
      this.repo.dailyUnits([start, end, shopId]), this.repo.stockAndIncoming(shopId), this.repo.ledger([wasteStart, end, shopId]), this.repo.hours([wasteStart, end, shopId]),
    ])
    const left = shareLeftToday(hours, hourNow)
    const sold = new Map()
    for (const r of daily) { const m = sold.get(r.product_id) ?? new Map(); m.set(r.day, r.units); sold.set(r.product_id, m) }
    const series = new Map()
    for (const [pid, m] of sold) series.set(pid, dense(days, m))
    const wasteOf = new Map(ledger.map((l) => [l.product_id, pct(l.wasted, l.opening + l.bought) ?? 0]))

    const items = []
    for (const s of stock) {
      const hist = series.get(s.product_id)
      if (!hist && s.stock === 0) continue
      const f = hist ? forecastDemand(hist, Math.max(horizon, 3) + 1) : { daily: [], level: 0, spread: 0, confidence: 'none' }
      const shelf = shelfLifeDays(s.shelf_life)
      const wastePct = wasteOf.get(s.product_id) ?? 0
      const todayUnits = f.daily[0]?.units ?? 0
      const ahead = f.daily.slice(1) // tomorrow onward
      const tomorrow = ahead[0]?.units ?? 0
      const stockAtClose = Math.max(0, s.stock - todayUnits * left) // what is expected to be on the shelf tonight
      const cd = ahead.length ? coverDays(stockAtClose + s.incoming, ahead) : null
      const buy = ahead.length ? buyQuantity({ daily: ahead, spread: f.spread, stock: stockAtClose, incoming: s.incoming, coverDaysWanted: cover, wastePct }) : 0
      const week = ahead.slice(0, 7).reduce((t, x) => t + x.units, 0)
      let risk = 'OK'
      if (ahead.length && todayUnits * left > s.stock + 0.5) risk = 'RUNS_OUT_TODAY' // the shelf empties before closing
      else if (ahead.length && tomorrow > 0) {
        if (cd != null && cd < 1) risk = 'BUY_FOR_TOMORROW' // tonight's stock will not cover tomorrow
        else if (cd != null && cd < 2) risk = 'LOW'
        else if (shelf != null && shelf <= 7 && stockAtClose > week * 1.2 + 3) risk = 'WILL_SPOIL'
      } else if (s.stock > 0 && !ahead.length) risk = 'NO_DATA'
      items.push({
        productId: s.product_id, name: s.name, category: s.category, unit: s.unit, pack: s.net_quantity, stock: s.stock, incoming: s.incoming, expectedTonight: r1(stockAtClose),
        avgPerDay: r1(f.level), today: r1(todayUnits), tomorrow: r1(tomorrow), nextWeek: r1(week), coverDays: cd, buy, buyValue: money(buy * Number(s.cost)),
        wastePct: r1(wastePct), confidence: f.confidence, risk,
        daily: ahead.slice(0, horizon).map((x) => ({ day: x.day, units: r1(x.units) })),
      })
    }
    const order = { RUNS_OUT_TODAY: 0, BUY_FOR_TOMORROW: 1, LOW: 2, WILL_SPOIL: 3, OK: 4, NO_DATA: 5 }
    items.sort((a, b) => order[a.risk] - order[b.risk] || b.buyValue - a.buyValue)
    return {
      asOf: now.toISOString(), forecastFrom: addDays(today, 1), shopId, horizon, cover, shareOfDayLeft: Math.round(left * 100) / 100,
      totals: { toBuy: items.filter((i) => i.buy > 0).length, buyValue: money(items.reduce((t, i) => t + i.buyValue, 0)), urgent: items.filter((i) => i.risk === 'RUNS_OUT_TODAY').length, short: items.filter((i) => i.risk === 'BUY_FOR_TOMORROW' || i.risk === 'LOW').length, willSpoil: items.filter((i) => i.risk === 'WILL_SPOIL').length },
      accuracy: backtest(series, 7),
      items, definitions: OPS_DEFINITIONS,
    }
  }

  shelf(shopId) { return this.repo.shelf(shopId).then((rows) => rows.map((r) => ({ productId: r.product_id, name: r.name, pack: r.net_quantity, category: r.category, stock: r.stock }))) }

  /**
   * Write off spoiled / damaged stock from a store's shelf. It goes through the same stock ledger as everything else
   * (type DAMAGED_STOCK), so Day close, Wastage Lab, Forecast, valuation and the month-end report all see it at once.
   * Only "now": backdating would quietly change days that were already reported or closed.
   */
  async logWastage({ shopId, productId, quantity, reason, note }, actor) {
    const qty = Number(quantity)
    if (!Number.isInteger(qty) || qty < 1 || qty > 100000) throw new BusinessError('Quantity must be a whole number, 1 or more.', 400, 'VALIDATION', { quantity: 'Invalid' })
    if (!WASTE_REASONS.includes(reason)) throw new BusinessError('Choose why it was lost.', 400, 'VALIDATION', { reason: 'Required' })
    const sp = await this.repo.shopProduct(shopId, productId)
    if (!sp) throw new BusinessError('That product is not on this store’s shelf.', 404, 'NOT_FOUND')
    if (qty > sp.stock) throw new BusinessError(`Only ${sp.stock} of ${sp.name} on the shelf — cannot remove ${qty}.`, 409, 'NOT_ENOUGH_STOCK', { stock: sp.stock })
    const cleanNote = String(note ?? '').trim().slice(0, 200) || null
    const shopProducts = new ShopProductsRepository()
    try {
      return await withTransaction(async (client) => {
        const { movement } = await shopProducts.applyStockChange(client, {
          shopProductId: sp.id, delta: -qty, type: 'DAMAGED_STOCK', reason: `Wastage: ${reason}`, source: 'DASHBOARD', actor: { userId: actor.userId }, metadata: { reason, ...(cleanNote ? { note: cleanNote } : {}), via: 'erp.daily-ops' },
        })
        await emitInTx(client, 'erp.wastage.log', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'stock_movement', target_id: movement.id, after: { shopId, productId, quantity: qty, reason } })
        return { movementId: movement.id, product: sp.name, removed: qty, left: sp.stock - qty, reason }
      })
    } catch (err) {
      if (err?.code === 'STOCK_NEGATIVE_FORBIDDEN') throw new BusinessError('The shelf changed while you were typing — check the count and try again.', 409, 'NOT_ENOUGH_STOCK')
      throw err
    }
  }

  async setTargets(productId, { marginPct = null, wastagePct = null }) {
    const bad = (v) => v != null && (!Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > 100)
    if (bad(marginPct) || (marginPct != null && Number(marginPct) >= 90)) throw new BusinessError('Target margin must be between 0 and 89.', 400, 'VALIDATION', { marginPct: 'Out of range' })
    if (bad(wastagePct)) throw new BusinessError('Target wastage must be between 0 and 100.', 400, 'VALIDATION', { wastagePct: 'Out of range' })
    const row = await this.repo.setTargets(productId, { marginPct: marginPct == null ? null : Number(marginPct), wastagePct: wastagePct == null ? null : Number(wastagePct) })
    if (!row) throw new BusinessError('Product not found.', 404, 'NOT_FOUND')
    return { productId: row.id, marginPct: num(row.target_margin_pct), wastagePct: num(row.target_wastage_pct) }
  }
}
