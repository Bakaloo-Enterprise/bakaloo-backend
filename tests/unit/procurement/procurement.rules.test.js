import { describe, expect, it } from 'vitest'
import { ADJUSTMENT_KINDS, canCancel, checkAdjustment, checkSplit, entryFigures, isLossKind, lineTotal, normalizeEntry } from '../../../src/modules/procurement/procurement.rules.js'

const today = '2026-10-02'
const base = { productId: 'p', expectedQty: 10, unitPrice: 28 }

describe('normalizeEntry', () => {
  it('works out the total (10 kg × Rs 28 = Rs 280)', () => {
    expect(normalizeEntry(base, { today })).toMatchObject({ receivedQty: 10, expectedQty: 10, damagedQty: 0, purchaseTotal: 280, purpose: 'RETAIL', procuredOn: today })
  })
  it('is exact to the paisa', () => {
    expect(lineTotal(3, 0.1)).toBe(0.3)
    expect(lineTotal(7, 19.99)).toBe(139.93)
    expect(normalizeEntry({ ...base, expectedQty: 3, unitPrice: 33.33 }, { today }).purchaseTotal).toBe(99.99)
  })
  it('takes an explicit invoice total', () => {
    expect(normalizeEntry({ ...base, purchaseTotal: 285.5 }, { today }).purchaseTotal).toBe(285.5)
  })
  it('records a shortage and damage at the door separately', () => {
    const n = normalizeEntry({ ...base, receivedQty: 9, damagedQty: 1 }, { today })
    expect(entryFigures(n)).toMatchObject({ usable: 8, shortage: 1, available: 8 })
  })
  it.each([
    [{ receivedQty: 0 }], [{ receivedQty: 1.5 }], [{ receivedQty: 5, damagedQty: 6 }], [{ unitPrice: -1 }], [{ unitPrice: 'x' }],
    [{ purchaseTotal: -5 }], [{ procuredOn: '2026-10-03' }], [{ procuredOn: 'yesterday' }], [{ purpose: 'BOGUS' }],
    [{ purpose: 'B2B_RESERVED' }], [{ purpose: 'B2B_RESERVED', reservationNote: 'Hotel order', destinationShopId: 's1' }],
  ])('rejects %j', (bad) => {
    expect(() => normalizeEntry({ ...base, ...bad }, { today })).toThrow()
  })
  it('allows a B2B reservation with a note or an account', () => {
    expect(normalizeEntry({ ...base, purpose: 'B2B_RESERVED', reservationNote: 'Hotel order' }, { today }).purpose).toBe('B2B_RESERVED')
    expect(normalizeEntry({ ...base, purpose: 'B2B_RESERVED', businessAccountId: 'b' }, { today }).purpose).toBe('B2B_RESERVED')
  })
})

describe('entryFigures', () => {
  it('available = usable − allocated − central adjustments', () => {
    expect(entryFigures({ expectedQty: 10, receivedQty: 10, damagedQty: 1 }, { allocated: 4, centralAdjusted: 2 })).toMatchObject({ usable: 9, available: 3 })
  })
  it('never reports a negative shortage', () => {
    expect(entryFigures({ expectedQty: 10, receivedQty: 12, damagedQty: 0 }).shortage).toBe(0)
  })
})

describe('checkSplit', () => {
  const entry = { available: 10, purpose: 'RETAIL', destinationShopId: null, status: 'ACTIVE' }
  it('accepts the 4 + 3 + 3 example exactly', () => {
    expect(checkSplit(entry, [{ shopId: 'a', quantity: 4 }, { shopId: 'b', quantity: 3 }, { shopId: 'c', quantity: 3 }])).toHaveLength(3)
  })
  it('refuses to send more than is available', () => {
    expect(() => checkSplit(entry, [{ shopId: 'a', quantity: 6 }, { shopId: 'b', quantity: 5 }])).toThrow(/only 10 is available/)
    try { checkSplit({ ...entry, available: 3 }, [{ shopId: 'a', quantity: 4 }]) } catch (e) { expect(e.code).toBe('OVER_ALLOCATION'); expect(e.statusCode).toBe(409) }
  })
  it('refuses duplicates, zero, fractions, empty', () => {
    expect(() => checkSplit(entry, [{ shopId: 'a', quantity: 1 }, { shopId: 'a', quantity: 1 }])).toThrow(/twice/)
    expect(() => checkSplit(entry, [{ shopId: 'a', quantity: 0 }])).toThrow()
    expect(() => checkSplit(entry, [{ shopId: 'a', quantity: 1.5 }])).toThrow()
    expect(() => checkSplit(entry, [])).toThrow()
    expect(() => checkSplit(entry, [{ quantity: 1 }])).toThrow()
  })
  it('keeps a dedicated purchase in its store', () => {
    const d = { ...entry, destinationShopId: 'a' }
    expect(checkSplit(d, [{ shopId: 'a', quantity: 5 }])).toHaveLength(1)
    expect(() => checkSplit(d, [{ shopId: 'b', quantity: 5 }])).toThrow(/dedicated/)
  })
  it('keeps B2B-reserved stock out of retail stores and cancelled purchases out of play', () => {
    expect(() => checkSplit({ ...entry, purpose: 'B2B_RESERVED' }, [{ shopId: 'a', quantity: 1 }])).toThrow(/reserved for B2B/)
    expect(() => checkSplit({ ...entry, status: 'CANCELLED' }, [{ shopId: 'a', quantity: 1 }])).toThrow(/cancelled/)
  })
})

describe('checkAdjustment', () => {
  const entry = { status: 'ACTIVE' }
  it('needs a reason, a known kind and a whole quantity', () => {
    expect(() => checkAdjustment(entry, { kind: 'DAMAGE', quantity: 1, reason: ' ' }, { available: 5 })).toThrow(/reason/)
    expect(() => checkAdjustment(entry, { kind: 'NOPE', quantity: 1, reason: 'x' }, { available: 5 })).toThrow()
    expect(() => checkAdjustment(entry, { kind: 'DAMAGE', quantity: 0, reason: 'x' }, { available: 5 })).toThrow()
  })
  it('central adjustments are capped by available stock, store adjustments by what that store holds', () => {
    expect(() => checkAdjustment(entry, { kind: 'WASTAGE', quantity: 6, reason: 'spoiled' }, { available: 5 })).toThrow(/Only 5/)
    expect(checkAdjustment(entry, { kind: 'WASTAGE', quantity: 5, reason: 'spoiled' }, { available: 5 })).toMatchObject({ shopId: null })
    expect(() => checkAdjustment(entry, { kind: 'DAMAGE', quantity: 4, shopId: 's', reason: 'dropped' }, { available: 99, shopHeld: 3 })).toThrow(/only has 3/)
    expect(checkAdjustment(entry, { kind: 'DAMAGE', quantity: 3, shopId: 's', reason: 'dropped' }, { available: 0, shopHeld: 3 }).shopId).toBe('s')
  })
  it('B2B supply comes from central stock only', () => {
    expect(() => checkAdjustment(entry, { kind: 'B2B_SUPPLY', quantity: 1, shopId: 's', reason: 'order 9' }, { available: 5, shopHeld: 5 })).toThrow(/central/)
  })
})

describe('loss vs not loss', () => {
  it('damage, wastage and authorised adjustments are losses; vendor returns and B2B supply are not', () => {
    expect(Object.keys(ADJUSTMENT_KINDS).filter(isLossKind).sort()).toEqual(['AUTHORIZED_ADJUSTMENT', 'DAMAGE', 'WASTAGE'])
  })
  it('only an untouched purchase can be cancelled', () => {
    expect(canCancel({ allocationCount: 0, adjustmentCount: 0 })).toBe(true)
    expect(canCancel({ allocationCount: 1, adjustmentCount: 0 })).toBe(false)
    expect(canCancel({ allocationCount: 0, adjustmentCount: 2 })).toBe(false)
  })
})
