import { BusinessError } from '../../utils/business-error.js'
import { money, parsePeriod, pct } from '../../utils/business-period.js'

const CHANNELS = ['ALL', 'B2B', 'B2C']

export const DEFINITIONS = Object.freeze({
  period: 'India calendar days; from–to inclusive.',
  grossSales: 'Value of orders placed in the period that are not cancelled or still waiting for payment — before any refund. Includes orders later refunded.',
  netRevenue: 'Gross sales minus refunds paid in the period.',
  procurementCost: 'What was paid to buy stock (purchase total by purchase date). With a store chosen: only the part of each purchase sent to that store. B2B = stock reserved for B2B; B2C = the rest.',
  commission: 'Platform commission on orders DELIVERED in the period: order subtotal × the store’s commission rate (same formula as store settlements).',
  refunds: 'Money handed back, counted once per order on the day it was refunded (approved refund request, or a gateway refund when there is no request). Cancelled orders are not counted here — they are not in gross sales.',
  returns: 'Goods returned to store stock in the period, valued at the price the customer paid.',
  cancelledValue: 'Orders cancelled in the period after they had been confirmed. An unpaid order that expired is not counted, and a cancelled order is not treated as a loss.',
  trackedLoss: 'Recorded loss only: stock damaged at receiving, damage / wastage / authorised adjustments, and damaged stock written off at a store. Vendor returns and B2B supply are not losses.',
  channel: 'B2B = placed by a business account (GST snapshot or B2B credit order). Everything else is B2C.',
})

/** Business Analytics — the dashboard management opens every day. Pure orchestration over the repository. */
export class BusinessAnalyticsService {
  constructor({ repo, procurement, now = () => new Date() }) {
    Object.assign(this, { repo, procurement, now })
  }

  #scope(q) {
    const p = parsePeriod(q, this.now())
    const channel = q.channel ?? 'ALL'
    if (!CHANNELS.includes(channel)) throw new BusinessError('Channel must be ALL, B2B or B2C.', 400, 'VALIDATION', { channel: 'Invalid' })
    const shopId = q.shopId ?? null
    return { p, shopId, channel, ch: channel === 'ALL' ? null : channel, orderArgs: [p.start, p.end, shopId, channel === 'ALL' ? null : channel], dateArgs: [p.from, p.to, shopId, channel === 'ALL' ? null : channel] }
  }
  #meta({ p, shopId, channel }) {
    return { period: p.period, from: p.from, to: p.to, days: p.days, shopId, channel }
  }

  async overview(q) {
    const sc = this.#scope(q)
    const [sales, series, refunds, cancelled, commission, returns, cost, loss] = await Promise.all([
      this.repo.sales(sc.orderArgs), this.repo.salesByDay(sc.orderArgs), this.repo.refunds(sc.orderArgs), this.repo.cancelled(sc.orderArgs),
      this.repo.commission(sc.orderArgs), this.repo.returns(sc.orderArgs), this.repo.procurementCost(sc.dateArgs), this.repo.trackedLoss(sc.dateArgs),
    ])
    const gross = money(sales.gross)
    const refundAmount = money(refunds.amount)
    const lossTotal = money(Number(loss.door) + Number(loss.adjustments) + Number(loss.storeDamage))
    const procurementCost = money(cost.amount)
    return {
      ...this.#meta(sc),
      cards: {
        grossSales: gross, netRevenue: money(gross - refundAmount), procurementCost, commissionEarned: money(commission.amount),
        refunds: refundAmount, returns: money(returns.amount), cancelledValue: money(cancelled.amount), trackedLoss: lossTotal,
      },
      counts: { orders: sales.orders, customers: sales.customers, refundedOrders: refunds.n, cancelledOrders: cancelled.n, deliveredOrders: commission.orders, purchases: cost.entries, returnMovements: returns.n },
      avgOrderValue: sales.orders > 0 ? money(gross / sales.orders) : null,
      lossBreakdown: { damagedAtReceiving: money(loss.door), procurementAdjustments: money(loss.adjustments), storeDamage: money(loss.storeDamage), unpricedStoreDamageRecords: loss.unpriced },
      series: series.map((d) => ({ day: d.day, orders: d.orders, gross: money(d.gross) })),
      warnings: [
        ...(loss.unpriced > 0 ? [`${loss.unpriced} damaged-stock record(s) at stores have no cost price, so they count as Rs 0 in tracked loss.`] : []),
        ...(sc.shopId && cost.entries === 0 ? ['No purchase was sent to this store in the period, so procurement cost is Rs 0.'] : []),
      ],
      definitions: DEFINITIONS,
    }
  }

  async products(q) {
    const sc = this.#scope(q)
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 50)
    const prevEnd = sc.p.start
    const prevStart = new Date(sc.p.start.getTime() - (sc.p.end.getTime() - sc.p.start.getTime()))
    const { cur, prev } = await this.repo.products(sc.orderArgs, { start: prevStart, end: prevEnd, limit })
    const prevUnits = new Map(prev.map((r) => [r.product_id, r.units]))
    let rows = cur.map((r) => {
      const before = prevUnits.get(r.product_id) ?? 0
      return {
        productId: r.product_id, name: r.name, sku: r.sku, units: r.units, revenue: money(r.revenue), orders: r.orders, buyers: r.buyers, repeatBuyers: r.repeat_buyers,
        repeatRatePct: pct(r.repeat_buyers, r.buyers), previousUnits: before, growthPct: before > 0 ? Math.round(((r.units - before) / before) * 1000) / 10 : null, isNew: before === 0,
      }
    })
    const sort = q.sort ?? 'revenue'
    const key = { revenue: (r) => r.revenue, units: (r) => r.units, trending: (r) => (r.growthPct ?? (r.isNew ? Infinity : -Infinity)) }[sort]
    if (!key) throw new BusinessError('Sort must be revenue, units or trending.', 400, 'VALIDATION', { sort: 'Invalid' })
    rows = rows.sort((a, b) => key(b) - key(a) || b.revenue - a.revenue).slice(0, limit)
    return { ...this.#meta(sc), sort, previousPeriod: { from: prevStart.toISOString(), to: prevEnd.toISOString() }, items: rows }
  }

  async customers(q) {
    const sc = this.#scope(q)
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 50)
    const [rows, repeat] = await Promise.all([this.repo.customers(sc.orderArgs, { limit }), this.repo.customerRepeat(sc.orderArgs)])
    return {
      ...this.#meta(sc),
      summary: { customers: repeat.customers, repeatCustomers: repeat.repeat_customers, repeatRatePct: pct(repeat.repeat_customers, repeat.customers) },
      items: rows.map((r) => ({
        userId: r.user_id, name: r.name, phone: r.phone, company: r.is_b2b ? r.company : null, channel: r.is_b2b ? 'B2B' : 'B2C', orders: r.orders, spend: money(r.spend),
        avgOrderValue: r.orders > 0 ? money(Number(r.spend) / r.orders) : null, lastOrderAt: r.last_order_at, isRepeat: r.orders >= 2 || r.earlier_orders > 0,
      })),
      note: 'Repeat = ordered at least twice in the period, or had ordered before it.',
    }
  }

  async stores(q) {
    const sc = this.#scope(q)
    const rows = await this.repo.stores(sc.orderArgs)
    return {
      ...this.#meta(sc),
      items: rows.map((r) => ({
        shopId: r.shop_id, name: r.name, branchCode: r.branch_code, orders: r.orders, sales: money(r.gross), avgOrderValue: r.orders > 0 ? money(Number(r.gross) / r.orders) : null,
        unitsSold: r.units, refunds: money(r.refunds), returns: money(r.returns), cancelledOrders: r.cancelled_orders, cancelledValue: money(r.cancelled_value),
        avgFulfillmentMinutes: r.avg_minutes == null ? null : Number(r.avg_minutes), stock: { receivedUnits: r.received_units, soldUnits: r.sold_units, damagedUnits: r.damaged_units },
      })),
    }
  }

  async channels(q) {
    const sc = this.#scope({ ...q, channel: 'ALL' })
    const split = await this.repo.channelSplit([sc.p.start, sc.p.end, sc.shopId, null])
    const out = {}
    for (const ch of ['B2B', 'B2C']) {
      const row = split.find((r) => r.channel === ch)
      const args = [sc.p.start, sc.p.end, sc.shopId, ch]
      const top = await this.repo.products(args, { start: sc.p.start, end: sc.p.start, limit: 5 })
      const cust = await this.repo.customerRepeat(args)
      out[ch] = {
        orders: row?.orders ?? 0, sales: money(row?.gross ?? 0), customers: row?.customers ?? 0, avgOrderValue: row && row.orders > 0 ? money(Number(row.gross) / row.orders) : null,
        valuePerCustomer: row && row.customers > 0 ? money(Number(row.gross) / row.customers) : null, repeatRatePct: pct(cust.repeat_customers, cust.customers),
        topProducts: top.cur.slice(0, 5).map((r) => ({ productId: r.product_id, name: r.name, units: r.units, revenue: money(r.revenue) })),
      }
    }
    const total = out.B2B.sales + out.B2C.sales
    return { ...this.#meta({ ...sc, channel: 'ALL' }), ...out, b2bSharePct: total > 0 ? Math.round((out.B2B.sales / total) * 1000) / 10 : null }
  }

  vendors(q) { return this.procurement.vendorReport(q) }
  reconciliation(q) { return this.procurement.reconciliation(q) }
}
