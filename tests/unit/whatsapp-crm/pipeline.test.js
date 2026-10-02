import { describe, expect, it } from 'vitest'
import { AUTO_LADDER, decideAutoMove, NEXT_ACTION, scoreCard, targetAutoStage } from '../../../src/modules/whatsapp-crm/pipeline.js'

describe('targetAutoStage', () => {
  it.each([
    [{ hasUser: false, orderCount: 0, hasOutbound: false }, 'lead'],
    [{ hasUser: false, orderCount: 0, hasOutbound: true }, 'conversation'],
    [{ hasUser: true, orderCount: 0, hasOutbound: false }, 'customer'],
    [{ hasUser: true, orderCount: 0, hasOutbound: true }, 'customer'],
    [{ hasUser: true, orderCount: 1, hasOutbound: false }, 'first_order'],
    [{ hasUser: true, orderCount: 2, hasOutbound: false }, 'second_order'],
    [{ hasUser: true, orderCount: 3, hasOutbound: false }, 'third_order'],
    [{ hasUser: true, orderCount: 4, hasOutbound: false }, 'repeat'],
    [{ hasUser: true, orderCount: 25, hasOutbound: false }, 'repeat'],
  ])('%j -> %s', (input, expected) => expect(targetAutoStage(input)).toBe(expected))

  it('an unregistered contact can never be placed in an order stage', () => {
    expect(targetAutoStage({ hasUser: false, orderCount: 5, hasOutbound: true })).toBe('conversation')
  })
  it('garbage order counts are treated as zero', () => {
    expect(targetAutoStage({ hasUser: true, orderCount: NaN, hasOutbound: false })).toBe('customer')
  })
  it('every target is a stage on the ladder', () => {
    for (const hasUser of [true, false]) for (const n of [0, 1, 2, 3, 4]) for (const o of [true, false]) expect(AUTO_LADDER).toContain(targetAutoStage({ hasUser, orderCount: n, hasOutbound: o }))
  })
})

describe('decideAutoMove', () => {
  const base = { currentIsAuto: true, currentSource: 'AUTO' }
  it('places a card that has no stage yet', () => {
    expect(decideAutoMove({ currentKey: null, currentIsAuto: false, currentSource: 'AUTO', targetKey: 'lead' })).toMatchObject({ move: true })
  })
  it('never moves a card out of a human-only stage', () => {
    for (const targetKey of AUTO_LADDER) {
      expect(decideAutoMove({ currentKey: 'follow_up', currentIsAuto: false, currentSource: 'MANUAL', targetKey }).move).toBe(false)
      expect(decideAutoMove({ currentKey: 'negotiation', currentIsAuto: false, currentSource: 'AUTO', targetKey }).move).toBe(false)
    }
  })
  it('does nothing when already in the right stage', () => {
    expect(decideAutoMove({ ...base, currentKey: 'first_order', targetKey: 'first_order' }).move).toBe(false)
  })
  it('AUTO card moves forward on a new order', () => {
    expect(decideAutoMove({ ...base, currentKey: 'first_order', targetKey: 'second_order' })).toEqual({ move: true, reason: 'order activity' })
  })
  it('AUTO card moves BACK when an order is cancelled (rollback rule)', () => {
    expect(decideAutoMove({ ...base, currentKey: 'second_order', targetKey: 'first_order' })).toEqual({ move: true, reason: 'order cancelled or reversed' })
  })
  it('MANUAL card on the ladder moves forward only, never back', () => {
    const m = { currentIsAuto: true, currentSource: 'MANUAL' }
    expect(decideAutoMove({ ...m, currentKey: 'customer', targetKey: 'first_order' }).move).toBe(true)
    expect(decideAutoMove({ ...m, currentKey: 'third_order', targetKey: 'customer' }).move).toBe(false)
  })
})

describe('scoreCard', () => {
  const NOW = new Date('2026-10-02T12:00:00Z')
  const minsAgo = (m) => new Date(NOW.getTime() - m * 60000)
  const card = (o = {}) => ({ lastDirection: 'OUTBOUND', lastMessageAt: minsAgo(5), windowOpen: true, openCartValue: 0, orderCount: 0, totalSpend: 0, isB2b: false, isVip: false, hasOwner: true, ...o })

  it('customer waiting for a reply inside the window -> REPLY_NOW, longer wait = higher score', () => {
    const fresh = scoreCard(card({ lastDirection: 'INBOUND', lastMessageAt: minsAgo(2) }), NOW)
    const stale = scoreCard(card({ lastDirection: 'INBOUND', lastMessageAt: minsAgo(50) }), NOW)
    expect(fresh.nextAction).toBe(NEXT_ACTION.REPLY_NOW)
    expect(stale.score).toBeGreaterThan(fresh.score)
    expect(stale.waitingMinutes).toBe(50)
  })
  it('waiting + big cart + VIP + repeat buyer = HIGH', () => {
    const r = scoreCard(card({ lastDirection: 'INBOUND', lastMessageAt: minsAgo(40), openCartValue: 1240, orderCount: 3, isVip: true }), NOW)
    expect(r.priority).toBe('HIGH')
  })
  it('an answered, quiet customer is NORMAL / NO_ACTION', () => {
    expect(scoreCard(card(), NOW)).toMatchObject({ priority: 'NORMAL', nextAction: NEXT_ACTION.NO_ACTION, waitingMinutes: 0 })
  })
  it('unanswered but window closed -> CALL_BACK (cannot reply freely)', () => {
    expect(scoreCard(card({ lastDirection: 'INBOUND', lastMessageAt: minsAgo(60 * 30), windowOpen: false }), NOW).nextAction).toBe(NEXT_ACTION.CALL_BACK)
  })
  it('answered customer with an open cart -> SEND_COUPON', () => {
    expect(scoreCard(card({ openCartValue: 600 }), NOW)).toMatchObject({ nextAction: NEXT_ACTION.SEND_COUPON, priority: 'NORMAL' })
  })
  it('unowned B2B lead with nothing else pending -> ASSIGN_TO_B2B', () => {
    expect(scoreCard(card({ isB2b: true, hasOwner: false }), NOW).nextAction).toBe(NEXT_ACTION.ASSIGN_TO_B2B)
    expect(scoreCard(card({ isB2b: true, hasOwner: true }), NOW).nextAction).toBe(NEXT_ACTION.NO_ACTION)
  })
  it('tolerates a card with no messages at all', () => {
    expect(scoreCard(card({ lastDirection: null, lastMessageAt: null }), NOW).nextAction).toBe(NEXT_ACTION.NO_ACTION)
  })
})
