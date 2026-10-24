import { describe, it, expect } from 'vitest'
import { resolveWindow, windowOfDays } from '../../../../src/modules/admin/dashboard/overview.service.js'

// "Today" is an India calendar day (IST = UTC+5:30), never the database's UTC day or a rolling 24 hours.
describe('Overview windows — India calendar days', () => {
  it('today starts at IST midnight even when the UTC date is still yesterday', () => {
    // 2026-10-10 20:00 UTC = 2026-10-11 01:30 IST → "today" is 11 Oct, which began at 2026-10-10T18:30Z
    const w = resolveWindow('today', new Date('2026-10-10T20:00:00Z'))
    expect(w.start.toISOString()).toBe('2026-10-10T18:30:00.000Z')
    expect(w.end.toISOString()).toBe('2026-10-11T18:30:00.000Z')
    expect(w.to).toBe('2026-10-11')
  })

  it('today at 23:59 IST still belongs to the same day', () => {
    const w = resolveWindow('today', new Date('2026-10-11T18:29:00Z'))
    expect(w.to).toBe('2026-10-11')
    expect(w.end.toISOString()).toBe('2026-10-11T18:30:00.000Z')
  })

  it('week = the last 7 India days including today, compared with the 7 days before', () => {
    const w = resolveWindow('week', new Date('2026-10-11T06:00:00Z'))
    expect(w.days).toBe(7)
    expect(w.from).toBe('2026-10-05')
    expect(w.to).toBe('2026-10-11')
    expect(w.prevEnd.getTime()).toBe(w.start.getTime())
    expect(w.start.getTime() - w.prevStart.getTime()).toBe(7 * 86_400_000)
  })

  it('year is supported (the dashboard has a This Year tab)', () => {
    expect(resolveWindow('year', new Date('2026-10-11T06:00:00Z')).days).toBe(365)
  })

  it('rejects an unknown period', () => {
    expect(() => resolveWindow('decade')).toThrow(/Period must be/)
    expect(windowOfDays(30, new Date('2026-10-11T06:00:00Z')).from).toBe('2026-09-12')
  })
})
