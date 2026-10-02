/**
 * Pipeline rules — pure functions, no I/O. See migration 143 for the model.
 */

/** Automatic stages in order. Keys match crm_stages.key. */
export const AUTO_LADDER = Object.freeze(['lead', 'conversation', 'customer', 'first_order', 'second_order', 'third_order', 'repeat'])

const RANK = Object.fromEntries(AUTO_LADDER.map((k, i) => [k, i]))

/**
 * Which automatic stage a contact belongs in right now.
 *
 *   4+ confirmed orders -> repeat · 3 -> third_order · 2 -> second_order · 1 -> first_order
 *   registered, no orders -> customer
 *   not registered, an agent has replied -> conversation
 *   otherwise -> lead
 *
 * @param {{ hasUser: boolean, orderCount: number, hasOutbound: boolean }} f
 */
export function targetAutoStage({ hasUser, orderCount, hasOutbound }) {
  const n = Number.isFinite(orderCount) ? orderCount : 0
  if (hasUser) {
    if (n >= 4) return 'repeat'
    if (n === 3) return 'third_order'
    if (n === 2) return 'second_order'
    if (n === 1) return 'first_order'
    return 'customer'
  }
  return hasOutbound ? 'conversation' : 'lead'
}

/**
 * May automation move this card, and where?
 *
 *  - no stage yet                         -> place it
 *  - sitting in a human-only stage        -> NEVER move (a person decided)
 *  - in an auto stage, put there by AUTO  -> follow the target, forward or back
 *                                           (back covers cancelled / expired orders)
 *  - in an auto stage, put there MANUALLY -> only move FORWARD past where the
 *                                           agent put it; never drag it back
 *
 * @param {{ currentKey: string|null, currentIsAuto: boolean, currentSource: 'AUTO'|'MANUAL', targetKey: string }} f
 * @returns {{ move: boolean, reason?: string }}
 */
export function decideAutoMove({ currentKey, currentIsAuto, currentSource, targetKey }) {
  if (!currentKey) return { move: true, reason: 'initial placement' }
  if (!currentIsAuto) return { move: false }
  if (currentKey === targetKey) return { move: false }
  if (currentSource === 'MANUAL') {
    return RANK[targetKey] > RANK[currentKey] ? { move: true, reason: 'order activity' } : { move: false }
  }
  return { move: true, reason: RANK[targetKey] > (RANK[currentKey] ?? -1) ? 'order activity' : 'order cancelled or reversed' }
}

// ─── Priority + next action ─────────────────────────────────────────

export const NEXT_ACTION = Object.freeze({
  REPLY_NOW: 'REPLY_NOW',
  CALL_BACK: 'CALL_BACK',
  SEND_COUPON: 'SEND_COUPON',
  ASSIGN_TO_B2B: 'ASSIGN_TO_B2B',
  NO_ACTION: 'NO_ACTION',
})

/**
 * @param {object} c
 * @param {string|null} c.lastDirection      'INBOUND' | 'OUTBOUND' | null
 * @param {Date|string|null} c.lastMessageAt
 * @param {boolean} c.windowOpen             24 h free-reply window
 * @param {number} c.openCartValue           abandoned cart value, 0 if none
 * @param {number} c.orderCount
 * @param {number} c.totalSpend
 * @param {boolean} c.isB2b                  approved business account or B2B label
 * @param {boolean} c.isVip
 * @param {boolean} c.hasOwner
 * @param {Date} [now]
 * @returns {{ priority: 'HIGH'|'MEDIUM'|'NORMAL', score: number, nextAction: string, waitingMinutes: number }}
 */
export function scoreCard(c, now = new Date()) {
  const awaiting = c.lastDirection === 'INBOUND'
  const waitingMinutes = awaiting && c.lastMessageAt ? Math.max(0, Math.floor((now.getTime() - new Date(c.lastMessageAt).getTime()) / 60000)) : 0

  let score = 0
  if (awaiting) score += 30 + Math.min(30, Math.floor(waitingMinutes / 2)) // waiting longer = more urgent
  if (c.openCartValue >= 1000) score += 20
  else if (c.openCartValue >= 500) score += 10
  if (c.orderCount >= 3 || c.totalSpend >= 5000) score += 15
  if (c.isVip) score += 10
  if (awaiting && !c.windowOpen) score -= 15 // can no longer be answered freely

  const priority = score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'NORMAL'

  let nextAction = NEXT_ACTION.NO_ACTION
  if (awaiting && c.windowOpen) nextAction = NEXT_ACTION.REPLY_NOW
  else if (awaiting) nextAction = NEXT_ACTION.CALL_BACK
  else if (c.openCartValue > 0) nextAction = NEXT_ACTION.SEND_COUPON
  else if (c.isB2b && !c.hasOwner) nextAction = NEXT_ACTION.ASSIGN_TO_B2B

  return { priority, score, nextAction, waitingMinutes }
}
