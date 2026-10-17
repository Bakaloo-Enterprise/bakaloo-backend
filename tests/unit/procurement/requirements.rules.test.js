import { describe, expect, it } from 'vitest'
import { checkTransition, cleanPhone, normalizeRequirement, planFor } from '../../../src/modules/procurement/requirements.rules.js'

const today = '2026-10-17'
const base = { customerName: 'Royal Biryani', source: 'WHATSAPP_PERSONAL', items: [{ productId: 'p1', quantity: 5 }] }

describe('normalizeRequirement', () => {
  it('accepts a simple WhatsApp request as an inquiry', () => {
    expect(normalizeRequirement(base, { today })).toMatchObject({ status: 'INQUIRY', paymentTerms: 'COD', customerPhone: null })
  })
  it('confirmed flag makes it committed demand', () => {
    expect(normalizeRequirement({ ...base, confirmed: true }, { today }).status).toBe('CONFIRMED')
  })
  it.each([
    [{ customerName: ' ' }], [{ source: 'FAX' }], [{ items: [] }], [{ items: [{ productId: 'p1', quantity: 0 }] }], [{ items: [{ productId: 'p1', quantity: 1.5 }] }],
    [{ items: [{ productId: 'p1', quantity: 1 }, { productId: 'p1', quantity: 2 }] }], [{ paymentTerms: 'BARTER' }], [{ deliveryDate: '2026-10-16' }],
    [{ deliveryDate: 'tomorrow' }], [{ items: [{ productId: 'p1', quantity: 1, unitPrice: -3 }] }],
  ])('rejects %j', (bad) => {
    expect(() => normalizeRequirement({ ...base, ...bad }, { today })).toThrow()
  })
})

describe('cleanPhone', () => {
  it('strips +91 and spaces', () => {
    expect(cleanPhone('+91 97758 45587')).toBe('9775845587')
    expect(cleanPhone('09775845587')).toBe('9775845587')
    expect(cleanPhone('')).toBeNull()
  })
  it('rejects nonsense', () => { expect(() => cleanPhone('123')).toThrow() })
})

describe('checkTransition', () => {
  it('allows inquiry → confirmed → delivered', () => {
    expect(() => checkTransition('INQUIRY', 'CONFIRMED')).not.toThrow()
    expect(() => checkTransition('CONFIRMED', 'DELIVERED')).not.toThrow()
  })
  it('blocks leaving a finished request', () => {
    expect(() => checkTransition('DELIVERED', 'INQUIRY')).toThrow()
    expect(() => checkTransition('CANCELLED', 'CONFIRMED')).toThrow()
  })
})

describe('planFor', () => {
  it('the potato example: 10 kg B2B + 10 kg stores low, nothing in stock → buy 20', () => {
    expect(planFor({ confirmed: 5, appOrders: 5, shopLow: 10 })).toMatchObject({ committed: 10, need: 20, toBuy: 20, status: 'BUY' })
  })
  it('subtracts stock already held (20 − 5 = 15)', () => {
    expect(planFor({ confirmed: 10, shopLow: 10, storeStock: 3, centralStock: 2 }).toBuy).toBe(15)
  })
  it('never goes negative and says OK when covered', () => {
    expect(planFor({ confirmed: 4, storeStock: 9 })).toMatchObject({ toBuy: 0, status: 'OK' })
  })
  it('ordered-but-not-arrived stock counts, so the same need is never bought twice', () => {
    expect(planFor({ confirmed: 10, shopLow: 10, incoming: 20 })).toMatchObject({ toBuy: 0, status: 'OK', incoming: 20 })
    expect(planFor({ confirmed: 10, shopLow: 10, incoming: 12 }).toBuy).toBe(8)
  })
  it('inquiries alone never create a purchase, only a WATCH', () => {
    expect(planFor({ inquiry: 8, storeStock: 2 })).toMatchObject({ toBuy: 0, status: 'WATCH', projected: 8 })
  })
})
