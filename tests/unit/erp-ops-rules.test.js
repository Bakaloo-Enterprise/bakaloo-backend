import { describe, expect, it } from 'vitest'
import {
  addDays, backtest, buyQuantity, coverDays, defaultTargetWastagePct, dense, effectiveCost, forecastDemand, shelfLifeDays, suggestedPrice, wastageBreach,
} from '../../src/modules/erp/ops.rules.js'

describe('shelf life and wastage targets', () => {
  it('reads days, weeks, months from text', () => {
    expect(shelfLifeDays('4 days')).toBe(4)
    expect(shelfLifeDays('2 weeks')).toBe(14)
    expect(shelfLifeDays('6 months')).toBe(180)
    expect(shelfLifeDays('keep cool')).toBeNull()
    expect(shelfLifeDays(null)).toBeNull()
  })
  it('allows fresher goods more spoilage', () => {
    expect(defaultTargetWastagePct('2 days')).toBe(14)
    expect(defaultTargetWastagePct('4 days')).toBe(8)
    expect(defaultTargetWastagePct('12 days')).toBe(4)
    expect(defaultTargetWastagePct('365 days')).toBe(1.5)
    expect(defaultTargetWastagePct('unknown')).toBe(5)
  })
})

describe('price advisor', () => {
  // Bought 100 at Rs 20; 20 spoiled → 80 left to sell → each sellable unit really costs 20 × 100 / 80 = 25
  it('spreads the cost of spoiled goods over what is left', () => {
    expect(effectiveCost(20, 100, 20)).toBe(25)
    expect(effectiveCost(20, 100, 0)).toBe(20)
    expect(effectiveCost(20, 0, 0)).toBe(20)
    expect(effectiveCost(0, 100, 10)).toBe(0)
  })
  // 25 / (1 − 0.20) = 31.25 → rounded UP to a whole rupee = 32
  it('prices for the target margin and rounds up', () => {
    expect(suggestedPrice(25, 20)).toBe(32)
    expect(suggestedPrice(40, 0)).toBe(40)
    expect(suggestedPrice(0, 20)).toBeNull()
  })
})

const flat = (n, units, end = '2026-03-10') => Array.from({ length: n }, (_, i) => ({ day: addDays(end, -(n - 1 - i)), units }))

describe('forecast', () => {
  it('a steady 10 a day forecasts about 10 a day', () => {
    const f = forecastDemand(flat(28, 10), 3)
    expect(f.daily).toHaveLength(3)
    for (const d of f.daily) expect(d.units).toBeCloseTo(10, 0)
    expect(f.confidence).toBe('good')
    expect(f.spread).toBeCloseTo(0, 5)
  })
  it('knows weekends are busier', () => {
    // 2026-03-10 is a Tuesday; Saturdays and Sundays sell 20, other days 10
    const h = Array.from({ length: 35 }, (_, i) => { const day = addDays('2026-03-10', -(34 - i)); const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); return { day, units: dow === 0 || dow === 6 ? 20 : 10 } })
    const f = forecastDemand(h, 7)
    const sat = f.daily.find((d) => new Date(`${d.day}T00:00:00Z`).getUTCDay() === 6)
    const wed = f.daily.find((d) => new Date(`${d.day}T00:00:00Z`).getUTCDay() === 3)
    expect(sat.units).toBeGreaterThan(wed.units * 1.5)
  })
  it('says nothing without enough days or any sales', () => {
    expect(forecastDemand(flat(5, 10), 3).confidence).toBe('none')
    expect(forecastDemand(flat(30, 0), 3).daily).toEqual([])
  })
  it('follows a rising week but only part of the way', () => {
    const h = [...flat(21, 10, '2026-03-03'), ...flat(7, 14, '2026-03-10')]
    const f = forecastDemand(h, 1)
    expect(f.daily[0].units).toBeGreaterThan(11)
    expect(f.daily[0].units).toBeLessThan(18)
  })
  it('fills quiet days with zero', () => {
    expect(dense(['2026-03-01', '2026-03-02', '2026-03-03'], new Map([['2026-03-02', 5]])).map((x) => x.units)).toEqual([0, 5, 0])
  })
})

describe('stock cover and buying', () => {
  const d = (...u) => u.map((units, i) => ({ day: addDays('2026-03-10', i + 1), units }))
  it('counts days of cover, fractionally', () => {
    expect(coverDays(25, d(10, 10, 10))).toBe(2.5)
    expect(coverDays(5, d(10, 10))).toBe(0.5)
    expect(coverDays(100, d(10, 10))).toBeNull()
  })
  // demand for 1 day = 10, safety = 1.28 × 2 = 2.56, stock 4, nothing coming → 10 + 2.56 − 4 = 8.56 → 9
  it('buys what is missing plus a safety cushion', () => {
    expect(buyQuantity({ daily: d(10, 10), spread: 2, stock: 4, coverDaysWanted: 1 })).toBe(9)
  })
  it('buys nothing when stock and incoming already cover it', () => {
    expect(buyQuantity({ daily: d(10), spread: 0, stock: 6, incoming: 10 })).toBe(0)
  })
  // need 8.56, 20% usually spoils → 8.56 / 0.8 = 10.7 → 11
  it('buys extra for what usually spoils', () => {
    expect(buyQuantity({ daily: d(10), spread: 2, stock: 4, wastePct: 20 })).toBe(11)
  })
})

describe('backtest', () => {
  it('is near-perfect on a steady product and reports misses honestly on a noisy one', () => {
    const steady = new Map([['a', flat(35, 10)]])
    expect(backtest(steady, 7).accuracyPct).toBeGreaterThan(99)
    const noisy = new Map([['a', flat(35, 10).map((x, i) => ({ ...x, units: i % 2 ? 4 : 16 }))]])
    expect(backtest(noisy, 7).accuracyPct).toBeLessThan(80)
  })
  it('has no verdict when nothing sold', () => {
    expect(backtest(new Map([['a', flat(35, 0)]]), 7).accuracyPct).toBeNull()
  })
})

describe('wastage breach', () => {
  it('needs both a high rate and real money', () => {
    expect(wastageBreach({ wastagePct: 12, targetPct: 8, value: 500 })).toBe(true)
    expect(wastageBreach({ wastagePct: 12, targetPct: 8, value: 20 })).toBe(false)
    expect(wastageBreach({ wastagePct: 9, targetPct: 8, value: 500 })).toBe(false)
  })
})

import { shareLeftToday } from '../../src/modules/erp/ops.rules.js'
describe('share of the day left', () => {
  const hours = [{ hour: 8, orders: 10 }, { hour: 9, orders: 10 }, { hour: 18, orders: 20 }, { hour: 19, orders: 20 }] // total 60
  it('is everything before the first order and nothing after the last', () => {
    expect(shareLeftToday(hours, 0)).toBe(1)
    expect(shareLeftToday(hours, 23)).toBe(0)
  })
  // at 18:30 half of the 18:00 hour (10) and all of 19:00 (20) remain = 30 / 60
  it('counts the rest of the current hour part-way', () => {
    expect(shareLeftToday(hours, 18.5)).toBeCloseTo(0.5, 5)
  })
  it('falls back to the clock when there is no history', () => {
    expect(shareLeftToday([], 12)).toBeCloseTo(0.5, 5)
  })
})
