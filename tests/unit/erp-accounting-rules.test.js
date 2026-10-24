import { describe, expect, it } from 'vitest'
import { accountOfMethod, add, amountProblem, emptyBooks, flowOf, netOf, profitAndLoss, total } from '../../src/modules/erp/accounting.rules.js'

describe('amounts', () => {
  it('accepts normal rupee amounts', () => {
    expect(amountProblem(250)).toBeNull()
    expect(amountProblem(99.5)).toBeNull()
  })
  it('refuses zero, negatives, nonsense, too many decimals and absurd sizes', () => {
    for (const v of [0, -5, NaN, 'abc', 1.234, 1e9]) expect(amountProblem(v), String(v)).not.toBeNull()
  })
})

describe('which box a payment touches', () => {
  it('only cash is cash; UPI, bank, gateway and cheques are the bank', () => {
    expect(accountOfMethod('CASH')).toBe('CASH')
    for (const m of ['UPI', 'BANK', 'RAZORPAY', 'OTHER']) expect(accountOfMethod(m)).toBe('BANK')
  })
})

describe('cash-book entries', () => {
  it('capital and other income add to their box; drawings take out', () => {
    expect(flowOf({ kind: 'OWNER_CAPITAL', account: 'BANK', amount: 500 })).toEqual([{ account: 'BANK', delta: 500 }])
    expect(flowOf({ kind: 'OTHER_INCOME', account: 'CASH', amount: 40 })).toEqual([{ account: 'CASH', delta: 40 }])
    expect(flowOf({ kind: 'OWNER_DRAWING', account: 'CASH', amount: 300 })).toEqual([{ account: 'CASH', delta: -300 }])
  })
  it('a deposit moves money from cash to bank — the total does not change', () => {
    const f = flowOf({ kind: 'BANK_DEPOSIT', amount: 1000 })
    expect(f).toEqual([{ account: 'CASH', delta: -1000 }, { account: 'BANK', delta: 1000 }])
    expect(f.reduce((t, x) => t + x.delta, 0)).toBe(0)
    expect(flowOf({ kind: 'BANK_WITHDRAWAL', amount: 200 }).reduce((t, x) => t + x.delta, 0)).toBe(0)
  })
  it('an opening balance is a starting point, not a flow', () => {
    expect(flowOf({ kind: 'OPENING_BALANCE', account: 'CASH', amount: 9000 })).toEqual([])
  })
})

describe('books', () => {
  it('groups lines by label, drops zeros, refuses negatives, and nets in minus out', () => {
    const b = emptyBooks()
    add(b, 'CASH', 'in', 'COD', 100.1); add(b, 'CASH', 'in', 'COD', 200.2); add(b, 'CASH', 'in', 'Nothing', 0); add(b, 'CASH', 'out', 'Rent', 50)
    expect(b.CASH.in).toEqual([{ label: 'COD', amount: 300.3 }])
    expect(total(b.CASH.in)).toBe(300.3)
    expect(netOf(b)).toEqual({ CASH: 250.3, BANK: 0 })
    expect(() => add(b, 'BANK', 'in', 'Bad', -1)).toThrow()
  })
})

describe('profit and loss', () => {
  // sales 10,000 − cost 7,000 = gross 3,000 (30 %); wastage 200 → 2,800; running costs 5,000 + 300 = 5,300 → operating −2,500;
  // other income 250 → net −2,250 (−22.5 %); after goods and wastage 28 % of each sale is left → sales needed = 5,300 / 0.28 = 18,928.57
  const pnl = profitAndLoss({
    profit: { sales: 10000, cogs: 7000, gross: 3000, loss: 200, afterLoss: 2800 },
    expenses: [{ category: 'RENT', kind: 'FIXED', amount: '5000.00' }, { category: 'PACKING', kind: 'VARIABLE', amount: 300 }],
    otherIncome: 250,
  })
  it('works out each step', () => {
    expect(pnl).toMatchObject({ sales: 10000, gross: 3000, grossMarginPct: 30, wastage: 200, afterWastage: 2800, operatingProfit: -2500, otherIncome: 250, netProfit: -2250, netMarginPct: -22.5 })
    expect(pnl.expenses).toMatchObject({ fixed: 5000, variable: 300, total: 5300 })
    expect(pnl.breakEvenSales).toBe(18928.57)
  })
  it('lists costs biggest first with friendly names', () => {
    expect(pnl.expenses.byCategory.map((c) => [c.label, c.amount])).toEqual([['Rent', 5000], ['Packing material', 300]])
  })
  it('has no margin or break-even when nothing sold', () => {
    const p = profitAndLoss({ profit: { sales: 0, cogs: 0, gross: 0, loss: 0, afterLoss: 0 }, expenses: [], otherIncome: 0 })
    expect(p.grossMarginPct).toBeNull(); expect(p.breakEvenSales).toBeNull(); expect(p.netProfit).toBe(0)
  })
})
