import { describe, expect, it } from 'vitest'
import { collapseDeleted, costCounting, fillDays, istDate, istDayStart, money, normalizePricing, parseRange, pct, rateFor, validateRateCard, withRates } from '../../../src/modules/whatsapp-crm/analytics.js'

const NOW = new Date('2026-10-02T10:00:00Z') // 15:30 IST, 2 Oct

describe('India calendar days', () => {
  it('an instant late at night UTC is already tomorrow in India', () => {
    expect(istDate(new Date('2026-10-01T19:00:00Z'))).toBe('2026-10-02')
    expect(istDate(new Date('2026-10-01T18:29:59Z'))).toBe('2026-10-01')
  })
  it('a day starts at 18:30 UTC the evening before', () => {
    expect(istDayStart('2026-10-02').toISOString()).toBe('2026-10-01T18:30:00.000Z')
  })
  it('rejects impossible dates', () => {
    expect(istDayStart('2026-02-30')).toBeNull()
    expect(istDayStart('nope')).toBeNull()
    expect(istDayStart(undefined)).toBeNull()
  })
})

describe('parseRange', () => {
  it('defaults to the last 30 days ending today, end exclusive', () => {
    const r = parseRange({}, NOW)
    expect(r).toMatchObject({ from: '2026-09-03', to: '2026-10-02', days: 30, attributionDays: 7 })
    expect(r.end.toISOString()).toBe('2026-10-02T18:30:00.000Z')
  })
  it('a single day is one day', () => {
    expect(parseRange({ from: '2026-10-02', to: '2026-10-02' }, NOW).days).toBe(1)
  })
  it('refuses backwards, too long, bad dates and a bad order window', () => {
    expect(() => parseRange({ from: '2026-10-05', to: '2026-10-01' }, NOW)).toThrow(/must not be after/)
    expect(() => parseRange({ from: '2025-01-01', to: '2026-10-01' }, NOW)).toThrow(/at most 366/)
    expect(() => parseRange({ from: '2026-13-01' }, NOW)).toThrow(/From/)
    expect(() => parseRange({ to: '2026-02-31' }, NOW)).toThrow(/To/)
    expect(() => parseRange({ attributionDays: 0 }, NOW)).toThrow(/1–30/)
    expect(() => parseRange({ attributionDays: 31 }, NOW)).toThrow(/1–30/)
  })
  it('exactly 366 days is allowed', () => {
    expect(parseRange({ from: '2025-10-02', to: '2026-10-02' }, NOW).days).toBe(366)
  })
})

describe('pct / money', () => {
  it('rounds to one decimal and never divides by zero', () => {
    expect(pct(1, 3)).toBe(33.3)
    expect(pct(2, 3)).toBe(66.7)
    expect(pct(5, 0)).toBeNull()
    expect(pct(0, 10)).toBe(0)
    expect(pct('x', 10)).toBeNull()
  })
  it('keeps rupees to the paisa', () => {
    expect(money(0.1 + 0.2)).toBe(0.3)
    expect(money(null)).toBe(0)
    expect(money(12.3456)).toBe(12.35)
  })
})

describe('normalizePricing (Meta webhook "pricing" block)', () => {
  it('reads the billing record', () => {
    expect(normalizePricing({ billable: true, pricing_model: 'PMP', category: 'marketing', type: 'regular' })).toEqual({ billable: true, category: 'MARKETING', type: 'regular' })
  })
  it('a free customer-service message is not billable', () => {
    expect(normalizePricing({ billable: false, category: 'service', type: 'free_customer_service' })).toEqual({ billable: false, category: 'SERVICE', type: 'free_customer_service' })
  })
  it('maps authentication variants and marketing-lite', () => {
    expect(normalizePricing({ billable: true, category: 'authentication_international' }).category).toBe('AUTHENTICATION')
    expect(normalizePricing({ billable: true, category: 'marketing_lite' }).category).toBe('MARKETING')
  })
  it('keeps the billable flag when the category is one we do not know', () => {
    expect(normalizePricing({ billable: false, category: 'referral_conversion' })).toEqual({ billable: false, category: null, type: null })
  })
  it('nothing usable → null', () => {
    expect(normalizePricing(null)).toBeNull()
    expect(normalizePricing({})).toBeNull()
    expect(normalizePricing('x')).toBeNull()
    expect(normalizePricing({ billable: 'yes' })).toBeNull()
  })
})

describe('costCounting', () => {
  it('a message that was only sent, or failed, never costs — whatever Meta’s billable flag says', () => {
    for (const status of ['QUEUED', 'SENT', 'FAILED']) {
      expect(costCounting({ status, billable: true }).counted).toBe(false)
      expect(costCounting({ status, billable: null }).counted).toBe(false)
      expect(costCounting({ status, billable: false }).counted).toBe(false)
    }
  })
  it('a delivered or read message costs, unless Meta says it is free', () => {
    expect(costCounting({ status: 'DELIVERED', billable: false })).toEqual({ counted: false, estimated: false })
    expect(costCounting({ status: 'READ', billable: false })).toEqual({ counted: false, estimated: false })
  })
  it('Meta’s record makes it billed; without it, it is an estimate', () => {
    expect(costCounting({ status: 'DELIVERED', billable: true })).toEqual({ counted: true, estimated: false })
    expect(costCounting({ status: 'READ', billable: true })).toEqual({ counted: true, estimated: false })
    expect(costCounting({ status: 'DELIVERED', billable: null })).toEqual({ counted: true, estimated: true })
    expect(costCounting({ status: 'READ', billable: null })).toEqual({ counted: true, estimated: true })
  })
})

describe('rateFor (versioned prices)', () => {
  const cards = [
    { category: 'MARKETING', rate: '0.80', effective_from: '2026-01-01' },
    { category: 'MARKETING', rate: '0.90', effective_from: '2026-07-01' },
    { category: 'MARKETING', rate: '1.10', effective_from: '2027-01-01' },
    { category: 'UTILITY', rate: 0.12, effective_from: '2026-03-01' },
  ]
  it('uses the newest version that has started', () => {
    expect(rateFor(cards, 'MARKETING', '2026-03-15')).toBe(0.8)
    expect(rateFor(cards, 'MARKETING', '2026-07-01')).toBe(0.9)
    expect(rateFor(cards, 'MARKETING', '2026-12-31')).toBe(0.9)
    expect(rateFor(cards, 'MARKETING', '2027-01-01')).toBe(1.1)
  })
  it('null before the first price and for a category with none', () => {
    expect(rateFor(cards, 'MARKETING', '2025-12-31')).toBeNull()
    expect(rateFor(cards, 'UTILITY', '2026-02-28')).toBeNull()
    expect(rateFor(cards, 'AUTHENTICATION', '2026-10-01')).toBeNull()
  })
  it('does not depend on the order of the list', () => {
    expect(rateFor([...cards].reverse(), 'MARKETING', '2026-08-01')).toBe(0.9)
  })
})

describe('validateRateCard', () => {
  it('accepts a good one, upper-casing the category', () => {
    expect(validateRateCard({ category: 'marketing', rate: 0.8631, effectiveFrom: '2026-10-01', note: ' from Meta ' }, NOW)).toEqual({ category: 'MARKETING', rate: 0.8631, effectiveFrom: '2026-10-01', note: 'from Meta' })
  })
  it('a rate of zero is allowed (free category)', () => {
    expect(validateRateCard({ category: 'SERVICE', rate: 0, effectiveFrom: '2026-10-01' }, NOW).rate).toBe(0)
  })
  it.each([
    [{ category: 'X', rate: 1, effectiveFrom: '2026-10-01' }, 'category'],
    [{ category: 'UTILITY', rate: -1, effectiveFrom: '2026-10-01' }, 'rate'],
    [{ category: 'UTILITY', rate: '', effectiveFrom: '2026-10-01' }, 'rate'],
    [{ category: 'UTILITY', rate: 5000, effectiveFrom: '2026-10-01' }, 'rate'],
    [{ category: 'UTILITY', rate: 0.123456, effectiveFrom: '2026-10-01' }, 'rate'],
    [{ category: 'UTILITY', rate: 1, effectiveFrom: 'soon' }, 'effectiveFrom'],
    [{ category: 'UTILITY', rate: 1, effectiveFrom: '2030-01-01' }, 'effectiveFrom'],
    [{ category: 'UTILITY', rate: 1, effectiveFrom: '2019-01-01' }, 'effectiveFrom'],
  ])('rejects %j on %s', (input, field) => {
    try {
      validateRateCard(input, NOW)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e.code).toBe('VALIDATION')
      expect(Object.keys(e.details)).toContain(field)
    }
  })
})

describe('withRates', () => {
  it('adds percentages and cost ratios without touching counts', () => {
    const r = withRates({ sent: 200, delivered: 180, read: 90, replied: 18, failed: 20, orders: 10, cost: 100, revenue: 5000 })
    expect(r).toMatchObject({ sent: 200, delivery_rate: 90, read_rate: 50, reply_rate: 10, failure_rate: 9.1, cost_per_order: 10, revenue_per_rupee: 50 })
  })
  it('is null (not NaN or Infinity) when there is nothing to divide by', () => {
    const r = withRates({ sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, orders: 0, cost: 0, revenue: 120 })
    expect(r.delivery_rate).toBeNull()
    expect(r.cost_per_order).toBeNull()
    expect(r.revenue_per_rupee).toBeNull()
  })
  it('no revenue figure is invented when no cost was recorded', () => {
    expect(withRates({ sent: 5, delivered: 5, orders: 2, cost: 0, revenue: 300 }).revenue_per_rupee).toBeNull()
  })
})

describe('fillDays', () => {
  it('gives every day in the range, in order, with zeros for quiet days', () => {
    const start = istDayStart('2026-10-01')
    const out = fillDays([{ day: '2026-10-02', sent: 5 }], start, 3, { sent: 0, cost: 0 })
    expect(out).toEqual([{ day: '2026-10-01', sent: 0, cost: 0 }, { day: '2026-10-02', sent: 5, cost: 0 }, { day: '2026-10-03', sent: 0, cost: 0 }])
  })
})

describe('collapseDeleted', () => {
  it('folds every unnamed row into one, summing the counts', () => {
    const rows = [
      { id: 'a', name: 'Live', sent: 5, orders: 1 },
      { id: 'x', name: null, deleted: true, sent: 2, delivered: 2, cost: 0.2, orders: 0, revenue: 0 },
      { id: 'y', name: null, deleted: true, sent: 3, delivered: 1, cost: 0.1, orders: 1, revenue: 250 },
    ]
    const out = collapseDeleted(rows, 'Deleted automatic messages')
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ id: 'deleted', name: 'Deleted automatic messages', sent: 5, delivered: 3, orders: 1, revenue: 250, read: 0 })
    expect(out[1].cost).toBeCloseTo(0.3)
  })
  it('leaves the list alone when nothing is deleted', () => {
    const rows = [{ id: 'a', name: 'Live', sent: 1 }]
    expect(collapseDeleted(rows, 'x')).toEqual(rows)
  })
})
