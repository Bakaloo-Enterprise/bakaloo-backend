import { describe, expect, it } from 'vitest'
import { checkDocument, checkPayment, cleanVendorProfile, maskAccount, settleBills } from '../../../src/modules/procurement/suppliers.rules.js'

const today = '2026-10-17'
const bill = (entryNo, procuredOn, total, credit = 0) => ({ entryId: `e${entryNo}`, entryNo, procuredOn, total, credit })

describe('cleanVendorProfile', () => {
  it('accepts real-looking details and normalises them', () => {
    expect(cleanVendorProfile({ gstin: '19abcde1234f1z5', upiId: 'Ghosh@OkBank', bankIfsc: 'sbin0001234', bankAccountNo: '1234 5678 9012', paymentTerms: 'CREDIT', creditDays: 7 }))
      .toEqual({ gstin: '19ABCDE1234F1Z5', upiId: 'ghosh@okbank', bankIfsc: 'SBIN0001234', bankAccountNo: '123456789012', paymentTerms: 'CREDIT', creditDays: 7 })
  })
  it('clears a field with an empty string and leaves undefined alone', () => {
    expect(cleanVendorProfile({ gstin: '', address: undefined })).toEqual({ gstin: null })
  })
  it('credit days reset when the supplier is no longer on credit', () => {
    expect(cleanVendorProfile({ paymentTerms: 'CASH' })).toEqual({ paymentTerms: 'CASH', creditDays: 0 })
  })
  it.each([[{ gstin: '123' }], [{ upiId: 'nobank' }], [{ bankIfsc: 'XX' }], [{ bankAccountNo: 'abc' }], [{ paymentTerms: 'BARTER' }], [{ creditDays: 400 }], [{ creditDays: 1.5 }]])('rejects %j', (bad) => {
    expect(() => cleanVendorProfile(bad)).toThrow()
  })
  it('masks the account number', () => { expect(maskAccount('123456789012')).toBe('••••••••9012') })
})

describe('settleBills', () => {
  it('the potato example: ₹600 owed, pay ₹300 → ₹300 left', () => {
    const s = settleBills([bill(1, '2026-10-17', 600)], 300, { creditDays: 7, today })
    expect(s).toMatchObject({ owed: 300, overdue: 0, nextDue: '2026-10-24' })
    expect(s.bills[0]).toMatchObject({ bill: 600, paid: 300, left: 300, status: 'PART' })
  })
  it('credit for goods sent back lowers the bill', () => {
    expect(settleBills([bill(1, '2026-10-17', 600, 60)], 0, { today }).owed).toBe(540)
  })
  it('payments settle the oldest bill first and flag overdue ones', () => {
    const s = settleBills([bill(2, '2026-10-09', 100), bill(1, '2026-10-01', 200)], 250, { creditDays: 7, today })
    expect(s.bills.map((b) => [b.entryNo, b.status, b.left])).toEqual([[1, 'PAID', 0], [2, 'PART', 50]])
    expect(s).toMatchObject({ owed: 50, overdue: 50 })
  })
  it('exact to the paisa', () => {
    expect(settleBills([bill(1, '2026-10-17', 0.3)], 0.1, { today }).owed).toBe(0.2)
  })
  it('never owes less than zero when the credit is bigger than the bill', () => {
    expect(settleBills([bill(1, '2026-10-17', 50, 80)], 0, { today }).owed).toBe(0)
  })
})

describe('checkPayment', () => {
  const ok = { amount: 300, method: 'UPI' }
  it('accepts up to what is owed', () => {
    expect(checkPayment(ok, { balance: 600, today })).toEqual({ amount: 300, method: 'UPI', paidOn: today })
    expect(checkPayment({ ...ok, amount: 600 }, { balance: 600, today }).amount).toBe(600)
  })
  it('refuses overpaying, bad amounts, bad methods and future dates', () => {
    expect(() => checkPayment({ ...ok, amount: 600.01 }, { balance: 600, today })).toThrow(/only owe/)
    expect(() => checkPayment({ ...ok, amount: 0 }, { balance: 600, today })).toThrow()
    expect(() => checkPayment({ ...ok, method: 'GOLD' }, { balance: 600, today })).toThrow()
    expect(() => checkPayment({ ...ok, paidOn: '2026-10-18' }, { balance: 600, today })).toThrow()
  })
})

describe('checkDocument', () => {
  it('allows PDF/JPG/PNG up to 5 MB', () => {
    expect(checkDocument({ mime: 'application/pdf', size: 1000, kind: 'INVOICE' })).toBe('pdf')
  })
  it('refuses other types, empty and huge files', () => {
    expect(() => checkDocument({ mime: 'text/html', size: 10, kind: 'INVOICE' })).toThrow()
    expect(() => checkDocument({ mime: 'image/png', size: 0, kind: 'INVOICE' })).toThrow()
    expect(() => checkDocument({ mime: 'image/png', size: 6 * 1024 * 1024, kind: 'INVOICE' })).toThrow()
    expect(() => checkDocument({ mime: 'image/png', size: 10, kind: 'SELFIE' })).toThrow()
  })
})
