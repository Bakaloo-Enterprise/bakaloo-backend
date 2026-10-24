/** Pure rules for the Founder view: per-order margin ladder, cohort table and decision alerts. */
const r2 = (n) => Math.round(n * 100) / 100
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null)

const DELIVERY = new Set(['RIDER_PAY', 'TRANSPORT'])
const PAYMENT = new Set(['GATEWAY_FEES'])
const PACKING = new Set(['PACKING'])
const GROWTH = new Set(['MARKETING'])

/**
 * What one order earns, step by step, from the month's totals. Contribution margins are the usual quick-commerce ladder:
 *   CM1 = sales − goods − spoilage        (what the products themselves earn)
 *   CM2 = CM1 − delivery − packing − payment fees   (after the cost of serving the order)
 *   CM3 = CM2 − marketing                 (after winning the customer)
 *   Profit = CM3 − the rest (rent, salaries …) + other income
 */
export function marginLadder({ pnl, orders }) {
  if (!(orders > 0)) return null
  const byCat = Object.fromEntries(pnl.expenses.byCategory.map((c) => [c.category, c.amount]))
  const sum = (set) => r2([...set].reduce((t, k) => t + (byCat[k] ?? 0), 0))
  const delivery = sum(DELIVERY), payment = sum(PAYMENT), packing = sum(PACKING), marketing = sum(GROWTH)
  const other = r2(pnl.expenses.total - delivery - payment - packing - marketing)
  const cm1 = r2(pnl.sales - pnl.cogs - pnl.wastage)
  const cm2 = r2(cm1 - delivery - packing - payment)
  const cm3 = r2(cm2 - marketing)
  const profit = r2(cm3 - other + pnl.otherIncome)
  const per = (v) => r2(v / orders)
  const step = (key, label, value, kind) => ({ key, label, total: r2(value), perOrder: per(value), pctOfSales: pct(value, pnl.sales), kind })
  return {
    orders,
    steps: [
      step('sales', 'Sales', pnl.sales, 'start'), step('goods', 'Cost of goods', -pnl.cogs, 'cost'), step('wastage', 'Spoilage', -pnl.wastage, 'cost'), step('cm1', 'Left after goods (CM1)', cm1, 'subtotal'),
      step('delivery', 'Delivery (riders, transport)', -delivery, 'cost'), step('packing', 'Packing', -packing, 'cost'), step('payment', 'Payment fees', -payment, 'cost'), step('cm2', 'After serving the order (CM2)', cm2, 'subtotal'),
      step('marketing', 'Marketing', -marketing, 'cost'), step('cm3', 'After winning the customer (CM3)', cm3, 'subtotal'),
      step('fixed', 'Rent, salaries and the rest', -other, 'cost'), step('income', 'Other income', pnl.otherIncome, 'gain'), step('profit', 'Profit', profit, 'end'),
    ],
  }
}

/** Customers grouped by the month of their first order, and how many ordered again k months later. */
export function cohortTable(rows, months) {
  const by = new Map()
  for (const r of rows) { const c = by.get(r.cohort) ?? { cohort: r.cohort, size: 0, retained: {} }; if (r.k === 0) c.size = r.n; else c.retained[r.k] = r.n; by.set(r.cohort, c) }
  return months.filter((m) => by.has(m)).map((m) => {
    const c = by.get(m)
    return { cohort: m, size: c.size, retention: Object.fromEntries(Object.entries(c.retained).map(([k, n]) => [k, pct(n, c.size)])) }
  })
}

/** Plain-words things worth a look. Each rule needs real money to matter, so a tiny month does not shout. */
export function alerts({ pnl, ladder, refundPct, cashBalance, overdue30, stores }) {
  const out = []
  if (pnl.sales > 0 && pnl.netProfit < 0) out.push({ level: 'bad', text: `The business is running at a loss this month: ${Math.round(Math.abs(pnl.netProfit)).toLocaleString('en-IN')} rupees.`, href: '/erp/accounting' })
  if (pnl.breakEvenSales && pnl.sales < pnl.breakEvenSales) out.push({ level: 'warn', text: `Sales are ${Math.round((pnl.sales / pnl.breakEvenSales) * 100)}% of what is needed to cover running costs.`, href: '/erp/accounting' })
  if (pnl.sales > 0 && pnl.wastage / pnl.sales > 0.04) out.push({ level: 'warn', text: `Spoilage is ${(Math.round((pnl.wastage / pnl.sales) * 1000) / 10)}% of sales — look at the Wastage Lab.`, href: '/erp/wastage' })
  if (refundPct != null && refundPct > 3) out.push({ level: 'warn', text: `Refunds are ${refundPct}% of sales — higher than the usual 1–3%.`, href: '/erp/explorer' })
  if (cashBalance != null && cashBalance < 0) out.push({ level: 'bad', text: 'The cash box balance is below zero — a bank deposit or a cash cost was probably recorded wrongly.', href: '/erp/accounting' })
  if (overdue30 > 0) out.push({ level: 'warn', text: `${Math.round(overdue30).toLocaleString('en-IN')} rupees from business customers is more than 30 days late.`, href: '/b2b/collections' })
  for (const s of stores) if (s.orders >= 30 && s.cancelledOrders / s.orders > 0.08) out.push({ level: 'warn', text: `${s.name} cancels ${Math.round((s.cancelledOrders / s.orders) * 100)}% of its orders.`, href: '/business-analytics' })
  if (ladder && ladder.steps.find((x) => x.key === 'cm1').perOrder <= 0) out.push({ level: 'bad', text: 'Each order loses money before delivery costs — prices are below what goods cost.', href: '/erp/daily-ops' })
  return out
}
