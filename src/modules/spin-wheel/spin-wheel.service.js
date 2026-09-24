import { getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { buildCloudinaryUrl } from '../../config/cloudinary.js'
import { SpinWheelRepository } from './spin-wheel.repository.js'
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
 * Pure weighted-pick — exported standalone so the property test can drive
 * it directly with thousands of trials and a real (or seeded) RNG, with no
 * DB/service scaffolding involved. `prizes` must already be the resolved
 * active set (see SpinWheelService#_validateActiveSetForSpin) with each
 * item's `winProbability` a 0-100 number.
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

export class SpinWheelService {
  constructor(
    repo = new SpinWheelRepository(),
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
   * Active prizes for rendering the wheel — deliberately excludes
   * winProbability and linkedCouponId (odds/internal wiring aren't the
   * client's business).
   *
   * For a logged-in viewer on their very first spin ever, this returns the
   * first-time pool instead of the normal one — the wheel a customer looks
   * at (and watches land) has to be the same pool spin() will actually
   * resolve from, or the wedge it lands on wouldn't even be one of the
   * options drawn on screen. Same enabled/history/validation checks as
   * spin()'s own first-time branch, just read-only (no wallet row lock
   * needed — this is a display fetch, not a transaction). Falls back to
   * the normal pool exactly like spin() does when the first-time pool
   * itself isn't configured validly, or for an anonymous/no-userId caller.
   */
  async getActivePrizesForCustomer(userId = null) {
    let prizes = null
    if (userId) {
      const settings = await this.repo.getSettings()
      if (settings.firstTimeRewardEnabled && !(await this.repo.hasSpinHistory(null, userId))
        && (await this.repo.isEligibleAccountForFirstTimeReward(null, userId))) {
        const firstTimePrizes = await this.repo.findActiveFirstTimePrizes()
        if (this._validateActiveSetForFirstTime(firstTimePrizes).ok) {
          prizes = firstTimePrizes
        }
      }
    }
    if (!prizes) {
      prizes = await this.repo.findActivePrizes()
    }
    return prizes.map((p) => ({
      id: p.id,
      type: p.type,
      iconKey: p.iconKey,
      label: p.label,
      value: p.value,
      displayOrder: p.displayOrder,
    }))
  }

  /**
   * Popup background image + banner-box copy — deliberately excludes
   * dailyFreeSpins/triggerMode (not the client's business, same spirit as
   * getActivePrizesForCustomer excluding winProbability/linkedCouponId).
   * backgroundImageUrl is null when no admin upload exists yet, which the
   * app reads as "keep using the bundled default asset".
   */
  async getAppearanceForCustomer() {
    const settings = await this.repo.getSettings()
    const backgroundImageUrl = settings?.backgroundImagePublicId
      ? buildCloudinaryUrl(settings.backgroundImagePublicId, 'capped1080')
      : (settings?.backgroundImageUrl || null)
    return {
      backgroundImageUrl,
      bannerTitle: settings?.bannerTitle || null,
      bannerSubtitle: settings?.bannerSubtitle || null,
      bannerTagline: settings?.bannerTagline || null,
    }
  }

  async getEligibility(userId) {
    const [settings, wallet] = await Promise.all([
      this.repo.getSettings(),
      this.repo.peekSpinWallet(userId),
    ])
    const spinsAvailable = wallet.grantedToday
      ? wallet.availableSpins
      : wallet.availableSpins + settings.dailyFreeSpins
    return {
      spinsAvailable,
      dailyFreeSpins: settings.dailyFreeSpins,
      triggerMode: settings.triggerMode,
    }
  }

  _validateActiveSetForSpin(prizes) {
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
   * Same shape as _validateActiveSetForSpin, but the first-time pool only
   * needs 1 active row minimum (it's fine to always hand out the same
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
   * The core transaction: lazily grants today's daily spin if not yet
   * granted, rejects if the user has none left, otherwise decrements and
   * resolves a winner. Reward issuance (§ below) deliberately happens
   * AFTER this transaction commits — mirrors orders.service.js's
   * post-commit follow-through (e.g. lines ~792-807) rather than trying to
   * fold a coupon-targeting/wallet-credit call into the same DB
   * transaction, so a reward-issuance failure can never roll back (and
   * thus hide) a spin the customer already saw resolve.
   */
  async spin(userId) {
    const client = await getClient()
    let wonPrize = null
    let spinsRemaining = 0
    let historyId = null
    let isFirstTimeReward = false
    try {
      await client.query('BEGIN')
      const wallet = await this.repo.getOrCreateSpinWalletForUpdate(client, userId)
      const settings = await this.repo.getSettings()

      let availableSpins = wallet.availableSpins
      const markDailyGranted = !wallet.grantedToday
      if (!wallet.grantedToday && settings.dailyFreeSpins > 0) {
        availableSpins += settings.dailyFreeSpins
      }

      if (availableSpins <= 0) {
        await this.repo.setSpinWallet(client, userId, { availableSpins, markDailyGranted })
        await client.query('COMMIT')
        return { success: false, message: 'No spins available' }
      }

      // A brand-new player's very first spin ever draws from a small
      // admin-configured, always-a-real-win pool instead of the normal
      // odds (which include BETTER_LUCK) — see migration 139. Checked
      // inside this transaction, after the wallet row lock above is
      // already held, so two concurrent first spins for one user can't
      // both land here (the second blocks until the first's spin_history
      // insert commits). Falls back to the normal pool — logged, not
      // fatal — if the first-time pool itself is misconfigured, so an
      // admin mistake there never blocks a genuine first spin outright.
      let prizes = null
      if (settings.firstTimeRewardEnabled && !(await this.repo.hasSpinHistory(client, userId))
        && (await this.repo.isEligibleAccountForFirstTimeReward(client, userId))) {
        const firstTimePrizes = await this.repo.findActiveFirstTimePrizes()
        const ftValidation = this._validateActiveSetForFirstTime(firstTimePrizes)
        if (ftValidation.ok) {
          prizes = firstTimePrizes
          isFirstTimeReward = true
        } else {
          logger.warn({ userId, reason: ftValidation.reason }, 'First-time spin pool misconfigured — falling back to normal odds')
        }
      }

      if (!prizes) {
        prizes = await this.repo.findActivePrizes()
        const validation = this._validateActiveSetForSpin(prizes)
        if (!validation.ok) {
          await client.query('ROLLBACK')
          logger.error({ userId, reason: validation.reason }, 'Spin blocked: wheel misconfigured')
          return { success: false, message: 'Spin wheel is not configured correctly — please contact support.' }
        }
      }

      availableSpins -= 1
      await this.repo.setSpinWallet(client, userId, { availableSpins, markDailyGranted })

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
      spinsRemaining = availableSpins
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId }, 'Spin transaction failed')
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
      spinsRemaining,
      isFirstTimeReward,
    }
  }

  /**
   * Issues the actual reward — CASHBACK credits the wallet directly
   * (subType 'SCRATCH', previously-unused per 068_first_time_offers_and_
   * cashback.sql); every other winning type targets a pre-linked
   * INDIVIDUAL coupon via the same coupon_target_users mechanism
   * cart_milestones/first_time_offers already use (CouponsRepository#
   * addTargetUser). Never throws — a failure here must never take away a
   * win the customer already saw the wheel land on; it's recorded as
   * reward_status='FAILED' for an admin to fix manually (see spin_history
   * / GET /spin-wheel/history) instead.
   */
  async _issueReward(userId, prize, historyId) {
    if (prize.type === 'BETTER_LUCK') {
      return { rewardStatus: 'N_A', rewardRef: null }
    }
    if (prize.type === 'CASHBACK') {
      try {
        const result = await this.walletService.addMoney(userId, {
          amount: prize.value,
          description: 'Spin & Win prize',
          subType: 'SCRATCH',
          sourceId: historyId,
        })
        if (result.success) {
          return { rewardStatus: 'ISSUED', rewardRef: result.transaction?.id ?? null }
        }
        logger.warn({ userId, historyId, message: result.message }, 'Spin win wallet credit failed')
        return { rewardStatus: 'FAILED', rewardRef: null }
      } catch (err) {
        logger.error({ err, userId, historyId }, 'Spin win wallet credit threw')
        return { rewardStatus: 'FAILED', rewardRef: null }
      }
    }
    // Coupon-requiring types (FREE_DELIVERY / PERCENTAGE_OFF / FLAT_OFF / BUY_ONE_GET_ONE)
    if (!prize.linkedCouponId) {
      logger.warn({ userId, historyId, prizeType: prize.type }, 'Spin win has no linked coupon')
      return { rewardStatus: 'FAILED', rewardRef: null }
    }
    try {
      await this.couponsRepo.addTargetUser(prize.linkedCouponId, userId)
      return { rewardStatus: 'ISSUED', rewardRef: prize.linkedCouponId }
    } catch (err) {
      logger.error({ err, userId, historyId }, 'Spin win coupon targeting failed')
      return { rewardStatus: 'FAILED', rewardRef: null }
    }
  }

  /**
   * Grants bonus spins for any admin-defined milestone rule this user has
   * newly earned — called (fire-and-forget) from every place an order can
   * reach DELIVERED. Takes the same user_spin_wallet row lock spin() uses,
   * as the FIRST step, so two orders delivered near-simultaneously for one
   * user can't both grant a non-repeating rule (the second evaluation
   * blocks on the lock until the first commits its dedupe-defeating
   * spin_credit_grants row).
   */
  async evaluateMilestones(userId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const wallet = await this.repo.getOrCreateSpinWalletForUpdate(client, userId)
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
            userId, amount: rule.bonusSpins, source: 'MILESTONE', sourceRef: rule.id,
          })
          totalGrant += rule.bonusSpins
        }
      }
      if (totalGrant > 0) {
        await this.repo.setSpinWallet(client, userId, {
          availableSpins: wallet.availableSpins + totalGrant,
          markDailyGranted: wallet.grantedToday,
        })
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId }, 'Spin milestone evaluation failed')
    } finally {
      client.release()
    }
  }

  // ─── Admin: prizes ──────────────────────────────────────────────────────

  async listPrizes() {
    return this.repo.findAllPrizes()
  }

  /**
   * Mirrors CartMilestonesService#_validateCouponUnlock exactly — a
   * coupon-requiring prize being activated must point at a real, active,
   * INDIVIDUAL-target coupon, or the "win" would silently do nothing at
   * checkout. Inactive prizes are exempt (a template with no coupon linked
   * yet is a legitimate, expected state — see the seed data in migration
   * 118).
   *
   * For PERCENTAGE_OFF/FLAT_OFF this also derives `value` straight from
   * the linked coupon's own discount_value (returned as `derivedValue` for
   * the caller to fold into the row it's about to write). The wheel wedge
   * and the app's "You've won…" copy both need a real number, but the
   * coupon is the only place that number should ever be typed in — the
   * dashboard no longer collects it a second time, which would just be a
   * driftable copy that silently goes stale the next time someone edits
   * the coupon. Rejects a coupon whose own discount_type doesn't match the
   * prize type (e.g. a FLAT coupon linked to a Percentage Off prize) so
   * that mismatch can't silently produce a nonsense value.
   */
  async _validatePrizeCoupon(data) {
    if (!COUPON_REQUIRED_TYPES.has(data.type)) return {}
    if (data.isActive === false) return {}
    if (!data.linkedCouponId) {
      return { error: `${data.type} prizes need a linked coupon before they can go active — link one from the Coupons page first.` }
    }
    const coupon = await this.couponsRepo.findById(data.linkedCouponId)
    if (!coupon) return { error: 'Selected coupon was not found' }
    if (coupon.targetType !== 'INDIVIDUAL') {
      return { error: `"${coupon.code}" must have its Target Audience set to "Individual" to work as a spin prize — it's currently "${coupon.targetType}".` }
    }
    if (!coupon.isActive) {
      return { error: `"${coupon.code}" is inactive — activate it before linking it as a spin prize.` }
    }
    if (data.type === 'PERCENTAGE_OFF' && coupon.discountType !== 'PERCENTAGE') {
      return { error: `"${coupon.code}" is a ${coupon.discountType} coupon — a Percentage Off prize needs a coupon whose discount type is Percentage.` }
    }
    if (data.type === 'FLAT_OFF' && coupon.discountType !== 'FLAT') {
      return { error: `"${coupon.code}" is a ${coupon.discountType} coupon — a Flat Amount Off prize needs a coupon whose discount type is Flat.` }
    }
    const derivedValue = (data.type === 'PERCENTAGE_OFF' || data.type === 'FLAT_OFF') ? coupon.discountValue : undefined
    return { derivedValue }
  }

  async createPrize(data, actor) {
    if (!data.type || !data.label) {
      return { success: false, message: 'type and label are required' }
    }
    const { error: couponError, derivedValue } = await this._validatePrizeCoupon(data)
    if (couponError) return { success: false, message: couponError }
    if (derivedValue !== undefined) data.value = derivedValue
    if (data.isActive !== false) {
      const activeCount = await this.repo.countActive()
      if (activeCount + 1 > MAX_ACTIVE_PRIZES) {
        return { success: false, message: `Only ${MAX_ACTIVE_PRIZES} prizes can be active at once — deactivate one first.` }
      }
    }
    const prize = await this.repo.createPrize(data)
    emitAudit('spin_prize_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_prize',
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
    const { error: couponError, derivedValue } = await this._validatePrizeCoupon(merged)
    if (couponError) return { success: false, message: couponError }
    if (derivedValue !== undefined) data.value = derivedValue
    if (merged.isActive !== false && !existing.isActive) {
      const activeCount = await this.repo.countActive(id)
      if (activeCount + 1 > MAX_ACTIVE_PRIZES) {
        return { success: false, message: `Only ${MAX_ACTIVE_PRIZES} prizes can be active at once — deactivate one first.` }
      }
    }
    const prize = await this.repo.updatePrize(id, data)
    emitAudit('spin_prize_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_prize',
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
    emitAudit('spin_prize_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_prize',
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
    emitAudit('spin_prizes_reordered', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_prize',
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
  // _validatePrizeCoupon — a coupon-requiring first-time prize needs the
  // same real/active/INDIVIDUAL coupon), just against the first-time pool
  // and its own MIN_ACTIVE_FIRST_TIME_PRIZES floor of 1 instead of 2.

  async listFirstTimePrizes() {
    return this.repo.findAllFirstTimePrizes()
  }

  async createFirstTimePrize(data, actor) {
    if (!data.type || !data.label) {
      return { success: false, message: 'type and label are required' }
    }
    const { error: couponError, derivedValue } = await this._validatePrizeCoupon(data)
    if (couponError) return { success: false, message: couponError }
    if (derivedValue !== undefined) data.value = derivedValue
    if (data.isActive !== false) {
      const activeCount = await this.repo.countActiveFirstTime()
      if (activeCount + 1 > MAX_ACTIVE_PRIZES) {
        return { success: false, message: `Only ${MAX_ACTIVE_PRIZES} first-time prizes can be active at once — deactivate one first.` }
      }
    }
    const prize = await this.repo.createFirstTimePrize(data)
    emitAudit('spin_first_time_prize_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_first_time_prize',
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
    const { error: couponError, derivedValue } = await this._validatePrizeCoupon(merged)
    if (couponError) return { success: false, message: couponError }
    if (derivedValue !== undefined) data.value = derivedValue
    if (merged.isActive !== false && !existing.isActive) {
      const activeCount = await this.repo.countActiveFirstTime(id)
      if (activeCount + 1 > MAX_ACTIVE_PRIZES) {
        return { success: false, message: `Only ${MAX_ACTIVE_PRIZES} first-time prizes can be active at once — deactivate one first.` }
      }
    }
    const prize = await this.repo.updateFirstTimePrize(id, data)
    emitAudit('spin_first_time_prize_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_first_time_prize',
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
    emitAudit('spin_first_time_prize_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_first_time_prize',
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
    emitAudit('spin_first_time_prizes_reordered', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_first_time_prize',
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
    emitAudit('spin_wheel_settings_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_wheel_settings',
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
    emitAudit('spin_milestone_rule_created', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_milestone_rule',
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
    emitAudit('spin_milestone_rule_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_milestone_rule',
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
    emitAudit('spin_milestone_rule_deleted', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'spin_milestone_rule',
      target_id: id,
      before: existing,
      after: null,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true }
  }

  // ─── Admin: manual grant + history ──────────────────────────────────────

  async grantSpins(targetUserId, amount, actor) {
    if (!targetUserId || !amount || amount <= 0) {
      return { success: false, message: 'targetUserId and a positive amount are required' }
    }
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const wallet = await this.repo.getOrCreateSpinWalletForUpdate(client, targetUserId)
      const newBalance = wallet.availableSpins + amount
      await this.repo.setSpinWallet(client, targetUserId, {
        availableSpins: newBalance,
        markDailyGranted: wallet.grantedToday,
      })
      await this.repo.insertGrant(client, {
        userId: targetUserId, amount, source: 'ADMIN', sourceRef: actor.userId, createdBy: actor.userId,
      })
      await client.query('COMMIT')
      emitAudit('spin_credits_granted', {
        actor_user_id: actor.userId,
        actor_role: actor.platformRole || actor.role,
        target_type: 'user_spin_wallet',
        target_id: targetUserId,
        before: null,
        after: { amount, newBalance },
        ip_address: actor.ip,
        user_agent: actor.userAgent,
      })
      return { success: true, spinsAvailable: newBalance }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, targetUserId, amount }, 'Grant spins failed')
      return { success: false, message: 'Failed to grant spins' }
    } finally {
      client.release()
    }
  }

  async listHistory(params) {
    return this.repo.listHistory(params)
  }
}
