import { istDate, money, pct } from '../../utils/business-period.js'
import { monthWindow } from '../procurement/monthly.rules.js'
import { alerts, cohortTable, marginLadder } from './founder.rules.js'

/** The founder's one-page view for a month, assembled from the same services every other screen uses — so it cannot disagree with them. */
export class FounderService {
  constructor({ accounting, analytics, overview, monthly, repo, now = () => new Date() }) {
    Object.assign(this, { accounting, analytics, overview, monthly, repo, now })
  }

  async build({ month } = {}) {
    const w = monthWindow(month ?? istDate(this.now()).slice(0, 7), this.now())
    const period = { period: 'custom', from: w.from, to: w.to }
    const report = await this.monthly.build(w.month) // the heaviest read: build it once and share it
    const [acc, sum, stores, cohortRows] = await Promise.all([
      this.accounting.summary({ month: w.month, report }), this.overview.summaryBetween(w.start, w.end, null), this.analytics.stores(period), this.repo.cohorts(w.start),
    ])
    const ladder = marginLadder({ pnl: acc.pnl, orders: sum.orders.net })
    const months = Array.from({ length: 6 }, (_, i) => { const d = new Date(Date.UTC(Number(w.month.slice(0, 4)), Number(w.month.slice(5)) - 1 - (5 - i), 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` })
    const refundPct = pct(sum.refunds, sum.grossSales)
    const overdue30 = money((report.aging ?? []).filter((a) => a.daysLate > 30).reduce((t, a) => t + a.outstanding, 0))
    const storeRows = stores.items.map((s) => ({ shopId: s.shopId, name: s.name, orders: s.orders, sales: s.sales, avgOrderValue: s.avgOrderValue, refunds: s.refunds, cancelledOrders: s.cancelledOrders, cancelledValue: s.cancelledValue, avgFulfillmentMinutes: s.avgFulfillmentMinutes, damagedUnits: s.stock.damagedUnits }))
    return {
      month: w.month, label: w.label, from: w.from, to: w.to, inProgress: w.inProgress,
      headline: { sales: acc.pnl.sales, netRevenue: sum.netRevenue, orders: sum.orders.net, avgOrderValue: sum.avgOrderValue, refundPct, netProfit: acc.pnl.netProfit, netMarginPct: acc.pnl.netMarginPct, cashBalance: acc.position.CASH.balance, bankBalance: acc.position.BANK.balance },
      ladder,
      stores: storeRows,
      cohorts: cohortTable(cohortRows, months),
      b2b: { billed: report.summary.b2b.billed, collected: report.summary.b2b.collected, outstanding: report.summary.b2b.outstanding, overdue: report.summary.b2b.overdue, overdue30, aging: report.agingTotals, topLate: (report.aging ?? []).filter((a) => a.daysLate > 0).slice(0, 5).map((a) => ({ order: a.order, customer: a.customer, outstanding: a.outstanding, daysLate: a.daysLate })) },
      alerts: alerts({ pnl: acc.pnl, ladder, refundPct, cashBalance: acc.position.CASH.balance, overdue30, stores: storeRows }),
      notes: ['Built from the same records as Accounting, Business Analytics and the month-end report, so the numbers always match them.', 'Cohorts group customers by the month of their first order that stood (not cancelled or unpaid).'],
    }
  }
}
