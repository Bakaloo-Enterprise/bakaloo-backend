import { describe, expect, it } from 'vitest'
import { alerts, cohortTable, marginLadder } from '../../src/modules/erp/founder.rules.js'

// 100 orders. Sales 10,000, goods 7,000, spoilage 200 → CM1 2,800.
// delivery 600 (riders 500 + transport 100), packing 150, gateway fees 100 → CM2 = 2,800 − 850 = 1,950.
// marketing 300 → CM3 1,650. Rent 800 + salary 700 = 1,500 "the rest"; other income 50 → profit 1,650 − 1,500 + 50 = 200.
const pnl = {
  sales: 10000, cogs: 7000, wastage: 200, otherIncome: 50, netProfit: 200,
  expenses: { total: 2650, byCategory: [{ category: 'RIDER_PAY', amount: 500 }, { category: 'TRANSPORT', amount: 100 }, { category: 'PACKING', amount: 150 }, { category: 'GATEWAY_FEES', amount: 100 }, { category: 'MARKETING', amount: 300 }, { category: 'RENT', amount: 800 }, { category: 'SALARY', amount: 700 }] },
}

describe('margin ladder', () => {
  const l = marginLadder({ pnl, orders: 100 })
  const by = Object.fromEntries(l.steps.map((s) => [s.key, s]))
  it('walks from sales to profit, per order', () => {
    expect(by.sales.perOrder).toBe(100)
    expect(by.cm1).toMatchObject({ total: 2800, perOrder: 28, pctOfSales: 28 })
    expect(by.delivery.total).toBe(-600)
    expect(by.cm2).toMatchObject({ total: 1950, perOrder: 19.5 })
    expect(by.cm3.total).toBe(1650)
    expect(by.fixed.total).toBe(-1500)
    expect(by.profit).toMatchObject({ total: 200, perOrder: 2, pctOfSales: 2 })
  })
  it('has nothing to say without orders', () => {
    expect(marginLadder({ pnl, orders: 0 })).toBeNull()
  })
})

describe('cohorts', () => {
  const rows = [{ cohort: '2026-01', k: 0, n: 100 }, { cohort: '2026-01', k: 1, n: 40 }, { cohort: '2026-01', k: 2, n: 25 }, { cohort: '2026-02', k: 0, n: 80 }, { cohort: '2026-02', k: 1, n: 20 }]
  it('turns counts into the share of each group that came back', () => {
    expect(cohortTable(rows, ['2026-01', '2026-02', '2026-03'])).toEqual([
      { cohort: '2026-01', size: 100, retention: { 1: 40, 2: 25 } },
      { cohort: '2026-02', size: 80, retention: { 1: 25 } },
    ])
  })
})

describe('alerts', () => {
  const base = { pnl: { sales: 10000, wastage: 200, netProfit: 200, breakEvenSales: 9000 }, ladder: marginLadder({ pnl, orders: 100 }), refundPct: 1.2, cashBalance: 5000, overdue30: 0, stores: [] }
  it('stays quiet when things are fine', () => {
    expect(alerts(base)).toEqual([])
  })
  it('speaks up in plain words, with a place to look', () => {
    const a = alerts({ ...base, pnl: { sales: 10000, wastage: 600, netProfit: -1500, breakEvenSales: 12500 }, refundPct: 5.5, cashBalance: -10, overdue30: 4000, stores: [{ name: 'North', orders: 100, cancelledOrders: 12 }, { name: 'Tiny', orders: 5, cancelledOrders: 3 }] })
    const texts = a.map((x) => x.text).join(' | ')
    expect(texts).toMatch(/running at a loss/)
    expect(texts).toMatch(/80% of what is needed/)
    expect(texts).toMatch(/Spoilage is 6%/)
    expect(texts).toMatch(/Refunds are 5.5%/)
    expect(texts).toMatch(/below zero/)
    expect(texts).toMatch(/more than 30 days late/)
    expect(texts).toMatch(/North cancels 12%/)
    expect(texts).not.toMatch(/Tiny/) // too few orders to judge
    expect(a.every((x) => x.href.startsWith('/'))).toBe(true)
  })
})
