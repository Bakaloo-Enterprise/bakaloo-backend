import { describe, expect, it } from 'vitest'
import { shareFairly, suggestDistribution } from '../../../src/modules/procurement/distribution.rules.js'

const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0)

describe('shareFairly', () => {
  it('gives everyone their need when there is enough', () => {
    expect([...shareFairly(10, [{ key: 'a', need: 3 }, { key: 'b', need: 4 }]).entries()]).toEqual([['a', 3], ['b', 4]])
  })
  it('shares proportionally in whole units and never hands out more than there is', () => {
    const m = shareFairly(5, [{ key: 'a', need: 6 }, { key: 'b', need: 3 }, { key: 'c', need: 3 }])
    expect(sum(m)).toBe(5)
    expect(m.get('a')).toBeGreaterThanOrEqual(m.get('b'))
    for (const k of ['a', 'b', 'c']) expect(m.get(k)).toBeLessThanOrEqual(k === 'a' ? 6 : 3)
  })
  it('handles nothing to give or nothing needed', () => {
    expect(sum(shareFairly(0, [{ key: 'a', need: 3 }]))).toBe(0)
    expect(sum(shareFairly(5, []))).toBe(0)
  })
})

const shops = [{ shopId: 'A', name: 'Store A', stock: 0, low: 5 }, { shopId: 'B', name: 'Store B', stock: 0, low: 3 }]

describe('suggestDistribution — the 18 kg example', () => {
  it('10 for two restaurants first, the rest to shelves, shortage flagged', () => {
    const s = suggestDistribution(18, {
      requirements: [{ id: 'r1', customer: 'Royal Biryani', due: '2026-10-18', open: 5 }, { id: 'r2', customer: 'Kolkata Kitchen', due: '2026-10-18', open: 5 }],
      shops: [{ shopId: 'A', name: 'Store A', stock: 0, low: 10 }, { shopId: 'B', name: 'Store B', stock: 0, low: 0 }],
    })
    expect(s.reservations.map((r) => r.quantity)).toEqual([5, 5])
    expect(s.stores.find((x) => x.shopId === 'A').retailQty).toBe(8)
    expect(s.keepCentral).toBe(0)
    expect(s.shortages).toEqual({ b2b: 0, appOrders: 0, shelves: 2 })
  })
  it('never cuts a customer to fill a shelf', () => {
    const s = suggestDistribution(6, { requirements: [{ id: 'r1', customer: 'X', open: 8 }], shops })
    expect(s.reservations[0].quantity).toBe(6)
    expect(s.stores.every((x) => x.total === 0)).toBe(true)
    expect(s.shortages.b2b).toBe(2)
  })
  it('earliest delivery date is served first', () => {
    const s = suggestDistribution(5, { requirements: [{ id: 'late', customer: 'L', due: '2026-10-20', open: 5 }, { id: 'soon', customer: 'S', due: '2026-10-18', open: 5 }], shops })
    expect(s.reservations.map((r) => r.requirementId)).toEqual(['soon'])
  })
  it('app B2B orders go to the store that delivers them (stock is taken there on approval)', () => {
    const s = suggestDistribution(10, { appDemand: [{ shopId: 'B', qty: 4 }], shops: [{ shopId: 'A', name: 'A', stock: 0, low: 0 }, { shopId: 'B', name: 'B', stock: 1, low: 0 }] })
    expect(s.stores.find((x) => x.shopId === 'B')).toMatchObject({ b2bQty: 3, total: 3 })
    expect(s.keepCentral).toBe(7)
  })
  it('a dedicated purchase only reaches its own store', () => {
    const s = suggestDistribution(10, { shops, onlyShopId: 'B' })
    expect(s.stores.map((x) => x.shopId)).toEqual(['B'])
    expect(s.stores[0].retailQty).toBe(3)
    expect(s.keepCentral).toBe(7)
  })
  it('leftover stays in the warehouse and totals always add up', () => {
    const s = suggestDistribution(40, { requirements: [{ id: 'r', customer: 'C', open: 5 }], shops })
    const sent = s.stores.reduce((n, x) => n + x.total, 0)
    expect(5 + sent + s.keepCentral).toBe(40)
    expect(s.keepCentral).toBe(27)
  })
})
