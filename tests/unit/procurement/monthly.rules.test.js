import { describe, expect, it } from 'vitest'
import { ageBucket, daysBetween, findExceptions, monthWindow, sumMoney } from '../../../src/modules/procurement/monthly.rules.js'

const now = new Date('2026-10-17T10:00:00Z')

describe('monthWindow', () => {
  it('October covers 1 Oct to 31 Oct India time and is still running', () => {
    const w = monthWindow('2026-10', now)
    expect(w).toMatchObject({ from: '2026-10-01', to: '2026-10-31', asOf: '2026-10-17', dayBefore: '2026-09-30', inProgress: true })
    expect(w.end.toISOString()).toBe('2026-10-31T18:30:00.000Z')
    expect(w.start.toISOString()).toBe('2026-09-30T18:30:00.000Z')
  })
  it('a finished month is not in progress; December rolls into January', () => {
    expect(monthWindow('2026-09', now)).toMatchObject({ inProgress: false, asOf: '2026-09-30' })
    expect(monthWindow('2025-12', now).to).toBe('2025-12-31')
  })
  it('February in a leap year', () => { expect(monthWindow('2024-02', now).to).toBe('2024-02-29') })
  it.each(['2026-13', '2026-00', 'October', '2026-11', '2019-05', ''])('rejects %j', (bad) => { expect(() => monthWindow(bad, now)).toThrow() })
})

describe('ageBucket / daysBetween / sumMoney', () => {
  it('puts late bills in the buckets people use', () => {
    expect([0, -3, 1, 7, 8, 30, 31].map(ageBucket)).toEqual(['Not due yet', 'Not due yet', '1–7 days late', '1–7 days late', '8–30 days late', '8–30 days late', 'Over 30 days late'])
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30)
  })
  it('adds money exactly', () => { expect(sumMoney([{ a: 0.1 }, { a: 0.2 }], (r) => r.a)).toBe(0.3) })
})

describe('findExceptions', () => {
  const base = { window: { asOf: '2026-10-31' }, purchases: [], payables: [], payments: [], aging: [] }
  it('says nothing when everything is fine', () => { expect(findExceptions(base)).toEqual([]) })
  it('flags missing invoices, stale orders, late suppliers, voided payments, very late customers and broken ledgers', () => {
    const d = {
      window: { asOf: '2026-10-31' },
      purchases: [
        { entryNo: 1, status: 'ACTIVE', invoices: 0, vendor: 'V', product: 'P', total: 600, date: '2026-10-02', owedQty: 0 },
        { entryNo: 2, status: 'ORDERED', invoices: 0, vendor: 'V', product: 'P', total: 100, date: '2026-10-10', owedQty: 0 },
        { entryNo: 3, status: 'ORDERED', invoices: 0, vendor: 'V', product: 'P', total: 100, date: '2026-10-30', owedQty: 0 },
      ],
      payables: [{ vendor: 'V', closing: 300, overdue: 300, advance: 0, difference: 0 }, { vendor: 'W', closing: 0, overdue: 0, advance: 50, difference: 5 }],
      payments: [{ vendor: 'V', amount: 10, date: '2026-10-03', voided: true, voidReason: 'typo', by: 'Admin' }],
      manualUnpaid: [{ order: 'ORD-1', customer: 'C', date: '2026-10-05', total: 140 }],
      aging: [{ order: 'B1', customer: 'C', outstanding: 90, daysLate: 45, bucket: 'Over 30 days late' }],
    }
    const codes = findExceptions(d).map((e) => e.code)
    expect(codes).toEqual(['NO_INVOICE', 'STILL_ORDERED', 'SUPPLIER_OVERDUE', 'SUPPLIER_ADVANCE', 'LEDGER_MISMATCH', 'VOIDED_PAYMENT', 'MANUAL_UNPAID', 'B2B_OVER_30'])
    expect(findExceptions(d).find((e) => e.code === 'STILL_ORDERED').rows).toHaveLength(1)
  })
})
