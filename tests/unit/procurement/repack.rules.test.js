import { describe, expect, it } from 'vitest'
import { checkPackSize, formatAmount, parseNetQuantity, planRepack, unitsNeeded } from '../../../src/modules/procurement/repack.rules.js'

describe('parseNetQuantity', () => {
  it.each([['500 g', 500, 'G'], ['1 kg', 1000, 'G'], ['1kg', 1000, 'G'], ['1.5 KG', 1500, 'G'], ['250gm', 250, 'G'], ['0.25 kg', 250, 'G'], ['750 ml', 750, 'ML'], ['1 L', 1000, 'ML'], ['2 ltr', 2000, 'ML']])('reads %s', (text, size, unit) => {
    expect(parseNetQuantity(text)).toEqual({ size, unit })
  })
  it.each([['2 x 500 g'], ['Pack of 6'], [''], [null], ['0 g'], ['fresh']])('does not guess at %j', (text) => { expect(parseNetQuantity(text)).toBeNull() })
})
describe('formatAmount', () => {
  it('says it the way a shopper would', () => {
    expect([[500, 'G'], [1000, 'G'], [1500, 'G'], [250, 'ML'], [2000, 'ML']].map(([s, u]) => formatAmount(s, u))).toEqual(['500 g', '1 kg', '1.5 kg', '250 ml', '2 L'])
  })
})
describe('checkPackSize', () => {
  it('accepts whole grams or ml and refuses the rest', () => {
    expect(checkPackSize({ size: 500, unit: 'G' })).toEqual({ size: 500, unit: 'G' })
    expect(() => checkPackSize({ size: 0, unit: 'G' })).toThrow()
    expect(() => checkPackSize({ size: 1.5, unit: 'G' })).toThrow()
    expect(() => checkPackSize({ size: 500, unit: 'KG' })).toThrow()
  })
})

describe('planRepack — 50 kg of potatoes, bought at ₹30 per 1 kg unit', () => {
  const entry = { unitSize: 1000, unit: 'G', price: 30, available: 50 }
  const line = (packs, packSize, extra = {}) => ({ shopId: 'A', productId: `p${packSize}`, packs, packSize, packUnit: 'G', ...extra })
  it('10 × 1 kg + 4 × 500 g uses exactly 12 units and loses nothing', () => {
    const r = planRepack(entry, { unitsUsed: 12, lines: [line(10, 1000), line(4, 500)] })
    expect(r).toMatchObject({ gramsUsed: 12000, gramsPacked: 12000, gramsLost: 0, lossPct: 0, lossValue: 0 })
    expect(r.lines.map((l) => l.unitCost)).toEqual([30, 15]) // cost follows weight: ₹30/kg → ₹30 per 1 kg pack, ₹15 per 500 g pack
  })
  it('value is carried over exactly: pack cost × packs = bulk cost of the grams packed', () => {
    const r = planRepack(entry, { unitsUsed: 12, lines: [line(10, 1000), line(4, 500)] })
    expect(r.lines.reduce((n, l) => n + l.unitCost * l.packs, 0)).toBe(12 * 30)
  })
  it('what does not fit in a pack is a recorded loss, valued at cost', () => {
    const r = planRepack(entry, { unitsUsed: 5, lines: [line(9, 500)] }) // 5000 g in, 4500 g out
    expect(r).toMatchObject({ gramsLost: 500, lossPct: 10, lossValue: 15 })
  })
  it('refuses packs that weigh more than the bulk used, and says how many units are needed', () => {
    expect(() => planRepack(entry, { unitsUsed: 2, lines: [line(5, 500)] })).toThrow(/at least 3 units/)
  })
  it('refuses more than is free, a missing size, a unit mismatch, bad counts and duplicates', () => {
    expect(() => planRepack({ ...entry, available: 3 }, { unitsUsed: 4, lines: [line(1, 500)] })).toThrow(/only 3 is free/)
    expect(() => planRepack({ ...entry, unitSize: null }, { unitsUsed: 1, lines: [line(1, 500)] })).toThrow(/how big one unit/)
    expect(() => planRepack(entry, { unitsUsed: 1, lines: [line(1, 500, { packUnit: 'ML' })] })).toThrow()
    expect(() => planRepack(entry, { unitsUsed: 1, lines: [line(0, 500)] })).toThrow()
    expect(() => planRepack(entry, { unitsUsed: 1, lines: [] })).toThrow()
    expect(() => planRepack(entry, { unitsUsed: 0, lines: [line(1, 500)] })).toThrow()
    expect(() => planRepack(entry, { unitsUsed: 2, lines: [line(1, 500), line(1, 500)] })).toThrow(/twice/)
  })
  it('the same pack can go to different stores', () => {
    expect(planRepack(entry, { unitsUsed: 2, lines: [line(2, 500), line(2, 500, { shopId: 'B' })] }).gramsPacked).toBe(2000)
  })
})
describe('unitsNeeded', () => { it('rounds up to whole units', () => { expect(unitsNeeded(2500, 1000)).toBe(3); expect(unitsNeeded(3000, 1000)).toBe(3) }) })
