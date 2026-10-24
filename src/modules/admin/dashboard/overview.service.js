import { BusinessError } from '../../../utils/business-error.js'
import { istDate, istDayStart, money, pct } from '../../../utils/business-period.js'

const DAY_MS = 86_400_000
const PERIOD_DAYS = { today: 1, week: 7, month: 30, year: 365 }

export const OVERVIEW_DEFINITIONS = Object.freeze({
  period: 'India calendar days. Today = since midnight; Week / Month / Year = the last 7 / 30 / 365 days including today. Compared with the same number of days just before.',
  grossSales: 'Value of orders placed in the period that are not cancelled and not still waiting for payment. Cash, online, wallet, COD and B2B credit all count — it is what customers bought, not what was collected.',
  refunds: 'Money handed back, counted on the day it was refunded. A cancelled order that was refunded is a cancellation, not a refund.',
  netRevenue: 'Gross sales minus refunds in the period.',
  orders: 'Orders placed that stood: placed orders minus the ones refunded in full. Cancelled orders and orders still waiting for payment are never counted.',
  cancelled: 'Orders cancelled in the period after they had been confirmed. Value is shown separately and is not part of sales.',
  avgOrderValue: 'Net revenue divided by orders.',
  codToCollect: 'Cash-on-delivery money for orders that are on their way and not yet paid.',
})

/** Quick period name → India-day window ending today, plus the equal-length window just before it. */
export function resolveWindow(period = 'week', now = new Date()) {
  const days = PERIOD_DAYS[period]
  if (!days) throw new BusinessError('Period must be today, week, month or year.', 400, 'VALIDATION', { period: 'Invalid' })
  return windowOfDays(days, now, period)
}

/** The last `days` India days ending today (and the equal window before it). */
export function windowOfDays(days, now = new Date(), period = `${days}d`) {
  const today = istDate(now)
  const end = new Date(istDayStart(today).getTime() + DAY_MS)
  const start = new Date(end.getTime() - days * DAY_MS)
  const prevStart = new Date(start.getTime() - days * DAY_MS)
  return { period, days, start, end, prevStart, prevEnd: start, from: istDate(new Date(start.getTime() + 1)), to: today }
}

const change = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null)

export class OverviewService {
  constructor({ repo, now = () => new Date() }) {
    Object.assign(this, { repo, now })
  }

  /** Money + order counts for one window. Used for both the current and the previous period, so they are comparable. */
  async #summary(start, end, shopId) {
    const args = [start, end, shopId]
    const [sales, refunds, cancelled] = await Promise.all([this.repo.sales(args), this.repo.refunds(args), this.repo.cancelled(args)])
    const gross = money(sales.gross)
    const refundAmount = money(refunds.amount)
    const net = money(gross - refundAmount)
    const orders = sales.placed - sales.fully_refunded
    return {
      grossSales: gross, refunds: refundAmount, netRevenue: net, cancelledValue: money(cancelled.amount), codGross: money(sales.cod_gross),
      orders: { placed: sales.placed, fullyRefunded: sales.fully_refunded, net: orders, refundEvents: refunds.n, cancelled: cancelled.n },
      avgOrderValue: orders > 0 ? money(net / orders) : null,
      buyers: sales.buyers,
    }
  }

  /** Money and order counts for any window and store, on the same rules as everything else. */
  summaryBetween(start, end, shopId = null) { return this.#summary(start, end, shopId) }

  async overview({ period = 'week', shopId = null, topLimit = 8 } = {}) {
    const w = resolveWindow(period, this.now())
    const args = [w.start, w.end, shopId]
    const [cur, prev, daily, hours, top, categories, channels, buyers, registered, live, refundReqs] = await Promise.all([
      this.#summary(w.start, w.end, shopId),
      this.#summary(w.prevStart, w.prevEnd, shopId),
      this.repo.daily(args),
      this.repo.hours(args),
      this.repo.topProducts(args, topLimit),
      this.repo.categories(args),
      this.repo.channels(args),
      this.repo.buyers(args),
      shopId ? null : this.repo.registered(w.start, w.end),
      this.repo.live(shopId),
      this.repo.pendingRefundRequests(shopId),
    ])

    const series = daily.map((d) => ({
      day: d.day, orders: d.orders - d.fully_refunded, placed: d.orders, gross: money(d.gross), refunds: money(d.refunds),
      net: money(Number(d.gross) - Number(d.refunds)), cancelled: d.cancelled, cod: money(d.cod),
    }))

    const catTotal = categories.reduce((t, c) => t + Number(c.revenue), 0)
    const totalGross = channels.reduce((s, c) => s + Number(c.gross), 0)
    const channelSplit = ['B2C', 'B2B'].map((ch) => {
      const r = channels.find((c) => c.channel === ch)
      return { channel: ch, orders: r?.orders ?? 0, gross: money(r?.gross ?? 0), sharePct: pct(r?.gross ?? 0, totalGross) }
    })

    return {
      period: w.period, from: w.from, to: w.to, days: w.days, shopId,
      previous: { from: istDate(new Date(w.prevStart.getTime() + 1)), to: istDate(new Date(w.prevEnd.getTime() - 1)) },
      money: { grossSales: cur.grossSales, refunds: cur.refunds, netRevenue: cur.netRevenue, cancelledValue: cur.cancelledValue, avgOrderValue: cur.avgOrderValue },
      orders: cur.orders,
      comparison: {
        netRevenue: { previous: prev.netRevenue, changePct: change(cur.netRevenue, prev.netRevenue) },
        orders: { previous: prev.orders.net, changePct: change(cur.orders.net, prev.orders.net) },
        avgOrderValue: { previous: prev.avgOrderValue, changePct: cur.avgOrderValue != null && prev.avgOrderValue != null ? change(cur.avgOrderValue, prev.avgOrderValue) : null },
        refunds: { previous: prev.refunds, changePct: change(cur.refunds, prev.refunds) },
      },
      customers: {
        buyers: buyers.buyers, newBuyers: buyers.new_buyers, repeatBuyers: buyers.repeat_buyers, repeatRatePct: pct(buyers.repeat_buyers, buyers.buyers),
        registered: registered?.total ?? null, joinedInPeriod: registered?.joined ?? null,
      },
      series,
      hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: hours.find((x) => x.hour === h)?.orders ?? 0 })),
      topProducts: top.map((r) => ({ id: r.id, name: r.name, thumbnailUrl: r.thumbnail_url, category: r.category, unitsSold: r.units_sold, revenue: money(r.revenue), orders: r.orders })),
      categories: categories.map((r) => ({ category: r.category, revenue: money(r.revenue), units: r.units, sharePct: pct(r.revenue, catTotal) })),
      channels: channelSplit,
      live: {
        newOrders: live.new_orders, preparing: live.preparing, outForDelivery: live.out_for_delivery, awaitingPayment: live.awaiting_payment,
        codToCollect: money(live.cod_to_collect), codCollectedToday: money(live.cod_collected_today), pendingRefundRequests: refundReqs.n,
      },
      definitions: OVERVIEW_DEFINITIONS,
    }
  }

  // ── lighter reads for the older dashboard endpoints (same rules, shorter windows) ──
  async dailySeries(days, shopId) {
    const w = windowOfDays(days, this.now())
    const rows = await this.repo.daily([w.start, w.end, shopId])
    return rows.map((d) => {
      const orders = d.orders - d.fully_refunded
      const net = money(Number(d.gross) - Number(d.refunds))
      return { date: d.day, orders, revenue: net, grossRevenue: money(d.gross), refunds: money(d.refunds), cancelled: d.cancelled, avgOrderValue: orders > 0 ? money(net / orders) : 0, codRevenue: money(d.cod) }
    })
  }

  async hourly(days, shopId) {
    const w = windowOfDays(days, this.now())
    const rows = await this.repo.hours([w.start, w.end, shopId])
    return Array.from({ length: 24 }, (_, h) => ({ hour: h, order_count: rows.find((x) => x.hour === h)?.orders ?? 0 })).filter((x) => x.order_count > 0)
  }

  async products(days, shopId, limit) {
    const w = windowOfDays(days, this.now())
    const rows = await this.repo.topProducts([w.start, w.end, shopId], limit)
    return rows.map((r) => ({ id: r.id, name: r.name, thumbnail_url: r.thumbnail_url, category: r.category, units_sold: r.units_sold, revenue: money(r.revenue) }))
  }

  async categoryRevenue(days, shopId) {
    const w = windowOfDays(days, this.now())
    return (await this.repo.categories([w.start, w.end, shopId])).map((r) => ({ category: r.category, revenue: money(r.revenue) }))
  }

  /** IST today in the shape the live bar and the old stats block expect. */
  async today(shopId) {
    const w = windowOfDays(1, this.now(), 'today')
    const [cur, live] = await Promise.all([this.#summary(w.start, w.end, shopId), this.repo.live(shopId)])
    return { revenue: cur.netRevenue, orders: cur.orders.net, cod_to_collect: money(live.cod_to_collect), delivered: live.delivered_today }
  }

  /** Every number is for the whole life of the business (used by the old "totals" strip). */
  allTime(shopId = null) {
    return this.#summary(new Date('2020-01-01T00:00:00Z'), new Date(this.now().getTime() + DAY_MS), shopId)
  }
}
