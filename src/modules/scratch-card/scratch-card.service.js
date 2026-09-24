import { getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { buildCloudinaryUrl } from '../../config/cloudinary.js'
import { ScratchCardRepository } from './scratch-card.repository.js'
import { CouponsRepository } from '../coupons/coupons.repository.js'
import { WalletService } from '../wallet/wallet.service.js'
import { WalletRepository } from '../wallet/wallet.repository.js'
import { UsersRepository } from '../users/users.repository.js'

const COUPON_REQUIRED_TYPES = new Set(['FREE_DELIVERY', 'PERCENTAGE_OFF', 'FLAT_OFF', 'BUY_ONE_GET_ONE'])
const MAX_ACTIVE_PRIZES = 8
const MIN_ACTIVE_PRIZES = 2
const MIN_ACTIVE_FIRST_TIME_PRIZES = 1
const PROBABILITY_SUM_TOLERANCE = 0.5

/**
 * Pure weighted-pick — identical algorithm to spin-wheel.service.js's
 * pickWeightedPrize, duplicated rather than imported cross-module (each
 * gamification module stays self-contained here, same as spin-wheel/
 * cart-milestones/first-time-offers never importing each other's internals).
 * Exported standalone so the property test can drive it directly with
 * thousands of trials and a real (or seeded) RNG, with no DB/service
 * scaffolding involved.
 *
 * @param {Array<{winProbability:number}>} prizes
 * @param {() => number} [random] - defaults to Math.random; inject a
 *   seeded generator in tests.
 */
export function pickWeightedPrize(prizes, random = Math.random) {
  const roll = random() * 100
  let cumulative = 0
  for (const prize of prizes) {
    cumulative += prize.winProbability
    if (roll < cumulative) return prize
  }
  // Floating-point rounding can leave the cumulative sum a hair under 100
  // (e.g. 99.99999998) — fall back to the last prize rather than ever
  // returning undefined.
  return prizes[prizes.length - 1]
}

export class ScratchCardService {
  constructor(
    repo = new ScratchCardRepository(),
    couponsRepo = new CouponsRepository(),
    walletService = new WalletService(new WalletRepository()),
    usersRepo = new UsersRepository()
  ) {
    this.repo = repo
    this.couponsRepo = couponsRepo
    this.walletService = walletService
    this.usersRepo = usersRepo
  }

  // ─── Customer-facing ────────────────────────────────────────────────────

  /**
   * Cover ("foil") image scratched away to reveal the prize. Deliberately
   * excludes dailyFreeScratches/triggerMode (not the client's business) —
   * same spirit as SpinWheelService#getAppearanceForCustomer.
   * coverImageUrl is null when no admin upload exists yet, which the app
   * reads as "keep using the bundled default cover asset".
   */
  async getAppearanceForCustomer() {
    const settings = await this.repo.getSettings()
    const coverImageUrl = settings?.coverImagePublicId
      ? buildCloudinaryUrl(settings.coverImagePublicId, 'capped1080')
      : (settings?.coverImageUrl || null)
    return { coverImageUrl }
  }

  async getEligibility(userId) {
    const [settings, wallet] = await Promise.all([
      this.repo.getSettings(),
      this.repo.peekScratchWallet(userId),
    ])
    const scratchesAvailable = wallet.grantedToday
      ? wallet.availableScratches
      : wallet.availableScratches + settings.dailyFreeScratches
    return {
      scratchesAvailable,
      dailyFreeScratches: settings.dailyFreeScratches,
      triggerMode: settings.triggerMode,
    }
  }

  _validateActiveSetForScratch(prizes) {
    if (prizes.length < MIN_ACTIVE_PRIZES || prizes.length > MAX_ACTIVE_PRIZES) {
      return { ok: false, reason: `active prize count ${prizes.length} out of range ${MIN_ACTIVE_PRIZES}-${MAX_ACTIVE_PRIZES}` }
    }
    const sum = prizes.reduce((total, p) => total + p.winProbability, 0)
    if (Math.abs(sum - 100) > PROBABILITY_SUM_TOLERANCE) {
      return { ok: false, reason: `active probabilities sum to ${sum}, expected 100` }
    }
    return { ok: true }
  }

  /**
   * Same shape as _validateActiveSetForScratch, but the first-time pool
   * only needs 1 active row minimum (it's fine to always hand out the same
   * single "Welcome Gift") — BETTER_LUCK can never appear here at all, so
   * there's nothing else to gate.
   */
  _validateActiveSetForFirstTime(prizes) {
    if (prizes.length < MIN_ACTIVE_FIRST_TIME_PRIZES || prizes.length > MAX_ACTIVE_PRIZES) {
      return { ok: false, reason: `active first-time prize count ${prizes.length} out of range ${MIN_ACTIVE_FIRST_TIME_PRIZES}-${MAX_ACTIVE_PRIZES}` }
    }
    const sum = prizes.reduce((total, p) => total + p.winProbability, 0)
    if (Math.abs(sum - 100) > PROBABILITY_SUM_TOLERANCE) {
      return { ok: false, reason: `active first-time probabilities sum to ${sum}, expected 100` }
    }
    return { ok: true }
  }

  /**
   * The core transaction: lazily grants today's daily scratch if not yet
   * granted, rejects if the user has none left, otherwise decrements and
   * resolves a winner. Reward issuance (§ below) deliberately happens AFTER
   * this transaction commits — same reasoning as SpinWheelService#spin: a
   * reward-issuance failure can never roll back (and thus hide) a scratch
   * result the customer already saw revealed.
   */
  async scratch(userId) {
    const client = await getClient()
    let wonPrize = null
    let scratchesRemaining = 0
    let historyId = null
    let isFirstTimeReward = false
    try {
      await client.query('BEGIN')
      const wallet = await this.repo.getOrCreateScratchWalletForUpdate(client, userId)
      const settings = await this.repo.getSettings()

      let availableScratches = wallet.availableScratches
      const markDailyGranted = !wallet.grantedToday
      if (!wallet.grantedToday && settings.dailyFreeScratches > 0) {
        availableScratches += settings.dailyFreeScratches
      }

      if (availableScratches <= 0) {
        await this.repo.setScratchWallet(client, userId, { availableScratches, markDailyGranted })
        await client.query('COMMIT')
        return { success: false, message: 'No scratch cards available' }
      }

      // A brand-new player's very first scratch ever draws from a small
      // admin-configured, always-a-real-win pool instead of the normal
      // odds (which include BETTER_LUCK) — see migration 139. Checked
      // inside this transaction, after the wallet row lock above is
      // already held, so two concurrent first scratches for one user
      // can't both land here. Falls back to the normal pool — logged, not
      // fatal — if the first-time pool itself is misconfigured, so an
      // admin mistake there never blocks a genuine first scratch outright.
      let prizes = null
      if (settings.firstTimeRewardEnabled && !(await this.repo.hasScratchHistory(client, userId))
        && (await this.repo.isEligibleAccountForFirstTimeReward(client, userId))) {
        const firstTimePrizes = await this.repo.findActiveFirstTimePrizes()
        const ftValidation = this._validateActiveSetForFirstTime(firstTimePrizes)
        if (ftValidation.ok) {
          prizes = firstTimePrizes
          isFirstTimeReward = true
        } else {
          logger.warn({ userId, reason: ftValidation.reason }, 'First-time scratch pool misconfigured — falling back to normal odds')
        }
      }

      if (!prizes) {
        prizes = await this.repo.findActivePrizes()
        const validation = this._validateActiveSetForScratch(prizes)
        if (!validation.ok) {
          await client.query('ROLLBACK')
          logger.error({ userId, reason: validation.reason }, 'Scratch blocked: card misconfigured')
          return { success: false, message: 'Scratch card is not configured correctly — please contact support.' }
        }
      }

      availableScratches -= 1
      await this.repo.setScratchWallet(client, userId, { availableScratches, markDailyGranted })

      const won = pickWeightedPrize(prizes)
      historyId = await this.repo.insertHistory(client, {
        userId,
        prizeId: won.id,
        prizeType: won.type,
        prizeLabel: won.label,
        prizeValue: won.value,
        isWin: won.type !== 'BETTER_LUCK',
        rewardStatus: 'N_A',
        isFirstTimeReward,
      })

      await client.query('COMMIT')
      wonPrize = won
      scratchesRemaining = availableScratches
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId }, 'Scratch transaction failed')
      return { success: false, message: 'Something went wrong — please try again.' }
    } finally {
      client.release()
    }

    const { rewardStatus, rewardRef } = await this._issueReward(userId, wonPrize, historyId)
    await this.repo.updateHistoryReward(historyId, { rewardStatus, rewardRef })

    return {
      success: true,
      prize: {
        id: wonPrize.id,
        type: wonPrize.type,
        iconKey: wonPrize.iconKey,
        label: wonPrize.label,
        value: wonPrize.value,
        isWin: wonPrize.type !== 'BETTER_LUCK',
      },
      rewardStatus,
      scratchesRemaining,
      isFirstTimeReward,
    }
  }

  /**
   * Issues the actual reward — identical mechanics to SpinWheelService#
   * _issueReward. CASHBACK credits the wallet directly (subType 'SCRATCH',
   * the same previously-unused sub_type from 068_first_time_offers_and_
   * cashback.sql that Spin & Win also reuses); every other winning type
   * targets a pre-linked INDIVIDUAL coupon via the same coupon_target_users
   * mechanism. Never throws — a failure here must never take away a win the
   * customer already saw revealed; it's recorded as reward_status='FAILED'
   * for an admin to fix manually (see scratch_history / GET
   * /scratch-card/history) instead.
   */
  async _issueReward(userId, prize, historyId) {
    if (prize.type === 'BETTER_LUCK') {
      return { rewardStatus: 'N_A', rewardRef: null }
    }
    if (prize.type === 'CASHBACK') {
      try {
        const result = await this.walletService.addMoney(userId, {
          amount: prize.value,
          description: 'Scratch Card prize',
          subType: 'SCRATCH',
          sourceId: historyId,
        })
        if (result.success) {
          return { rewardStatus: 'ISSUED', rewardRef: result.transaction?.id ?? null }
        }
        logger.warn({ userId, historyId, message: result.message }, 'Scratch win wallet credit failed')
        return { rewardStatus: 'FAILED', rewardRef: null }
      } catch (err) {
        logger.error({ err, userId, historyId }, 'Scratch win wallet credit threw')
        return { rewardStatus: 'FAILED', rewardRef: null }
      }
    }
    // Coupon-requiring types (FREE_DELIVERY / PERCENTAGE_OFF / FLAT_OFF / BUY_ONE_GET_ONE)
    if (!prize.linkedCouponId) {
      logger.warn({ userId, historyId, prizeType: prize.type }, 'Scratch win has no linked coupon')
      return { rewardStatus: 'FAILED', rewardRef: null }
    }
    try {
      await this.couponsRepo.addTargetUser(prize.linkedCouponId, userId)
      return { rewardStatus: 'ISSUED', rewardRef: prize.linkedCouponId }
    } catch (err) {
      logger.error({ err, userId, historyId }, 'Scratch win coupon targeting failed')
      return { rewardStatus: 'FAILED', rewardRef: null }
    }
  }

  /**
   * Grants bonus scratch cards for any admin-defined milestone rule this
   * user has newly earned — called (fire-and-forget) from every place an
   * order can reach DELIVERED, alongside SpinWheelService#evaluateMilestones.
   * Takes the same user_scratch_wallet row lock scratch() uses, as the FIRST
   * step, so two orders delivered near-simultaneously for one user can't
   * both grant a non-repeating rule.
   */
  async evaluateMilestones(userId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const wallet = await this.repo.getOrCreateScratchWalletForUpdate(client, userId)
      const rules = await this.repo.findActiveMilestoneRules()
      if (rules.length === 0) {
        await client.query('COMMIT')
        return
      }
      const stats = await this.usersRepo.getStats(userId)
      let totalGrant = 0
      for (const rule of rules) {
        const statValue = rule.milestoneType === 'ORDER_COUNT'
          ? stats.total_orders
          : parseFloat(stats.total_spent)
        const alreadyGranted = await this.repo.countGrantsForRule(userId, rule.id, client)
        let toGrant = 0
        if (rule.isRepeating) {
          const earnedMultiples = Math.floor(statValue / rule.threshold)
          toGrant = Math.max(0, earnedMultiples - alreadyGranted)
        } else if (alreadyGranted === 0 && statValue >= rule.threshold) {
          toGrant = 1
        }
        for (let i = 0; i < toGrant; i++) {
          await this.repo.insertGrant(client, {
            userId, amount: rule.bonusScratches, source: 'MILESTONE', sourceRef: rule.id,
          })
          totalGrant += rule.bonusScratches
        }
      }
      if (totalGrant > 0) {
        await this.repo.setScratchWallet(client, userId, {
          availableScratches: wallet.availableScratches + totalGrant,
          markDailyGranted: wallet.grantedToday,
        })
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId }, 'Scratch milestone evaluation failed')
    } finally {
      client.release()
    }
  }

  // ─── Admin: prizes ──────────────────────────────────────────────────────

  async listPrizes() {
    return this.repo.findAllPrizes()
  }

  /**
   * Mirrors SpinWheelService#_validatePrizeCoupon exactly — a
   * coupon-requiring prize being activated must point at a real, active,
   * INDIVIDUAL-target coupon, or the "win" would silently do nothing at
   * checkout. Inactive prizes are exempt (a template with no coupon linked
   * yet is a legitimate, expected state — see the seed data in migration 137).
   */
  async _validatePrizeCoupon(data) {
    if (!COUPON_REQUIRED_TYPES.has(data.type)) return null
    if (data.isActive === false) return null
    if (!data.linkedCouponId) {
      return `${data.type} prizes need a linked coupon before they can go active — link one from the Coupons page first.`
    }
    const coupon = await this.couponsRepo.findById(data.linkedCouponId)
    if (!coupon) return 'Selected coupon was not found'
    if (coupon.targetType !== 'INDIVIDUAL') {
      return `"${coupon.code}" must have its Target Audience set to "Individual" to work as a scratch prize — it's currently "${coupon.targetType}".`
    }
    if (!coupon.isActive) {
      return `"${coupon.code}" is inactive — activate it before linking it as a scratch prize.`
    }
    return null
  }

  async createPrize(data, actor) {
    if (!data.type || !data.label) {
      return { success: false, message: 'type and label are required' }
    }
    const couponError = await this._validatePrizeCoupon(data)
    if (couponError) return { success: false, message: couponError }
    if (data.isActive !== false) {
      const activeCount = await this.repo.countActive()
      if (activeCount + 1 > MAX_ACTIVE_PRIZES) {
        return { success: false, message: `Only ${MAX_ACTIVE_PRIZES} prizes can be active at once — deactivate one first.` }
      }
    }
    const prize = await this.repo.createPrize(data)
    emitAudit('scratch_prize_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'scratch_prize',
      target_id: prize.id,
      before: null,
      after: prize,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, prize }
  }

  async updatePrize(id, data, actor) {
    const existing = await this.repo.findPrizeById(id)
    if (!existing) return { success: false, message: 'Prize not found' }
    const merged = { ...existing, ...data }
    const couponError = await this._validatePrizeCoupon(merged)
    if (couponError) return { success: false, message: couponError }
    if (merged.isActive !== false && !existing.isActive) {
      const activeCount = await this.repo.countActive(id)
      if (activeCount + 1 > MAX_ACTIVE_PRIZES) {
        return { success: false, message: `Only ${MAX_ACTIVE_PRIZES} prizes can be active at once — deactivate one first.` }
      }
    }
    const prize = await this.repo.updatePrize(id, data)
    emitAudit('scratch_prize_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'scratch_prize',
      target_id: id,
      before: existing,
      after: prize,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, prize }
  }

  async deletePrize(id, actor) {
    const existing = await this.repo.findPrizeById(id)
    if (!existing) return { success: false, message: 'Prize not found' }
    await this.repo.deletePrize(id)
    emitAudit('scratch_prize_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'scratch_prize',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }

  async reorderPrizes(orderedIds, actor) {
    await this.repo.reorderPrizes(orderedIds)
    emitAudit('scratch_prizes_reordered', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'scratch_prize',
      target_id: null,
      before: null,
      after: { count: orderedIds.length },
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }

  // ─── Admin: first-time reward prizes ────────────────────────────────────
  // Mirrors the regular prize CRUD above exactly (including reusing
  // _validatePrizeCoupon), just against the first-time pool and its own
  // MIN_ACTIVE_FIRST_TIME_PRIZES floor of 1 instead of 2.

  async listFirstTimePrizes() {
    return this.repo.findAllFirstTimePrizes()
  }

  async createFirstTimePrize(data, actor) {
    if (!data.type || !data.label) {
      return { success: false, message: 'type and label are required' }
    }
    const couponError = await this._validatePrizeCoupon(data)
    if (couponError) return { success: false, message: couponError }
    if (data.isActive !== false) {
      const activeCount = await this.repo.countActiveFirstTime()
      if (activeCount + 1 > MAX_ACTIVE_PRIZES) {
        return { success: false, message: `Only ${MAX_ACTIVE_PRIZES} first-time prizes can be active at once — deactivate one first.` }
      }
    }
    const prize = await this.repo.createFirstTimePrize(data)
    emitAudit('scratch_first_time_prize_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'scratch_first_time_prize',
      target_id: prize.id,
      before: null,
      after: prize,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, prize }
  }

  async updateFirstTimePrize(id, data, actor) {
    const existing = await this.repo.findFirstTimePrizeById(id)
    if (!existing) return { success: false, message: 'Prize not found' }
    const merged = { ...existing, ...data }
    const couponError = await this._validatePrizeCoupon(merged)
    if (couponError) return { success: false, message: couponError }
    if (merged.isActive !== false && !existing.isActive) {
      const activeCount = await this.repo.countActiveFirstTime(id)
      if (activeCount + 1 > MAX_ACTIVE_PRIZES) {
        return { success: false, message: `Only ${MAX_ACTIVE_PRIZES} first-time prizes can be active at once — deactivate one first.` }
      }
    }
    const prize = await this.repo.updateFirstTimePrize(id, data)
    emitAudit('scratch_first_time_prize_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'scratch_first_time_prize',
      target_id: id,
      before: existing,
      after: prize,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, prize }
  }

  async deleteFirstTimePrize(id, actor) {
    const existing = await this.repo.findFirstTimePrizeById(id)
    if (!existing) return { success: false, message: 'Prize not found' }
    await this.repo.deleteFirstTimePrize(id)
    emitAudit('scratch_first_time_prize_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'scratch_first_time_prize',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }

  async reorderFirstTimePrizes(orderedIds, actor) {
    await this.repo.reorderFirstTimePrizes(orderedIds)
    emitAudit('scratch_first_time_prizes_reordered', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'scratch_first_time_prize',
      target_id: null,
      before: null,
      after: { count: orderedIds.length },
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }

  // ─── Admin: settings ────────────────────────────────────────────────────

  async getSettings() {
    return this.repo.getSettings()
  }

  async updateSettings(data, actor) {
    const before = await this.repo.getSettings()
    const settings = await this.repo.updateSettings(data)
    emitAudit('scratch_card_settings_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'scratch_card_settings',
      target_id: settings.id,
      before,
      after: settings,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, settings }
  }

  // ─── Admin: milestone rules ─────────────────────────────────────────────

  async listMilestoneRules() {
    return this.repo.findAllMilestoneRules()
  }

  async createMilestoneRule(data, actor) {
    if (!data.milestoneType || data.threshold == null) {
      return { success: false, message: 'milestoneType and threshold are required' }
    }
    const rule = await this.repo.createMilestoneRule(data)
    emitAudit('scratch_milestone_rule_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'scratch_milestone_rule',
      target_id: rule.id,
      before: null,
      after: rule,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, rule }
  }

  async updateMilestoneRule(id, data, actor) {
    const existing = await this.repo.findMilestoneRuleById(id)
    if (!existing) return { success: false, message: 'Milestone rule not found' }
    const rule = await this.repo.updateMilestoneRule(id, data)
    emitAudit('scratch_milestone_rule_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'scratch_milestone_rule',
      target_id: id,
      before: existing,
      after: rule,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, rule }
  }

  async deleteMilestoneRule(id, actor) {
    const existing = await this.repo.findMilestoneRuleById(id)
    if (!existing) return { success: false, message: 'Milestone rule not found' }
    await this.repo.deleteMilestoneRule(id)
    emitAudit('scratch_milestone_rule_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'scratch_milestone_rule',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }

  // ─── Admin: manual grant + history ──────────────────────────────────────

  async grantScratches(targetUserId, amount, actor) {
    if (!targetUserId || !amount || amount <= 0) {
      return { success: false, message: 'targetUserId and a positive amount are required' }
    }
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const wallet = await this.repo.getOrCreateScratchWalletForUpdate(client, targetUserId)
      const newBalance = wallet.availableScratches + amount
      await this.repo.setScratchWallet(client, targetUserId, {
        availableScratches: newBalance,
        markDailyGranted: wallet.grantedToday,
      })
      await this.repo.insertGrant(client, {
        userId: targetUserId, amount, source: 'ADMIN', sourceRef: actor.userId, createdBy: actor.userId,
      })
      await client.query('COMMIT')
      emitAudit('scratch_credits_granted', {
        actor_user_id: actor.userId,
        actor_role: actor.platformRole || actor.role,
        target_type: 'user_scratch_wallet',
        target_id: targetUserId,
        before: null,
        after: { amount, newBalance },
        ip_address: actor.ip,
        user_agent: actor.userAgent,
      })
      return { success: true, scratchesAvailable: newBalance }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, targetUserId, amount }, 'Grant scratches failed')
      return { success: false, message: 'Failed to grant scratch cards' }
    } finally {
      client.release()
    }
  }

  async listHistory(params) {
    return this.repo.listHistory(params)
  }
}
