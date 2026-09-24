// Coverage for SpinWheelService — server-authoritative prize resolution,
// spin-credit bookkeeping, and the coupon-linkage validation guard.
// Constructor injection covers repo/couponsRepo/walletService/usersRepo
// (mirrors cart-milestones.service.test.js's shape), but spin()/
// evaluateMilestones()/grantSpins() also open their own transaction via the
// module-level getClient() — mocked the same way
// payment-settings.service.spec.js does it, so this needs no live DB.

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/database.js', () => ({
  pool: { query: vi.fn() },
  query: vi.fn(),
  getClient: vi.fn(),
  closePool: vi.fn(),
}))

import { getClient } from '../../../src/config/database.js'
import { SpinWheelService } from '../../../src/modules/spin-wheel/spin-wheel.service.js'

/** A client stub satisfying the service's own BEGIN/COMMIT/ROLLBACK calls — the repo mock ignores it entirely, so it never needs to run real SQL. */
function makeClientMock() {
  return { query: vi.fn().mockResolvedValue({}), release: vi.fn() }
}
getClient.mockImplementation(async () => makeClientMock())

const USER_ID = 'user-1'
const ACTOR = { userId: 'admin-1', role: 'ADMIN', platformRole: null, ip: '127.0.0.1', userAgent: 'test' }

function prize(overrides = {}) {
  return {
    id: 'prize-1',
    type: 'CASHBACK',
    iconKey: 'star',
    label: 'Extra Savings',
    value: 20,
    winProbability: 100,
    displayOrder: 1,
    isActive: true,
    linkedCouponId: null,
    ...overrides,
  }
}

function makeRepoMock(overrides = {}) {
  return {
    findActivePrizes: vi.fn().mockResolvedValue([prize()]),
    findAllPrizes: vi.fn().mockResolvedValue([]),
    findPrizeById: vi.fn().mockResolvedValue(null),
    countActive: vi.fn().mockResolvedValue(0),
    createPrize: vi.fn().mockImplementation(async (data) => prize(data)),
    updatePrize: vi.fn().mockImplementation(async (id, data) => prize({ id, ...data })),
    deletePrize: vi.fn().mockResolvedValue(true),
    reorderPrizes: vi.fn().mockResolvedValue(true),
    getSettings: vi.fn().mockResolvedValue({ id: 's-1', dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN' }),
    updateSettings: vi.fn().mockResolvedValue({ id: 's-1', dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN' }),
    findAllMilestoneRules: vi.fn().mockResolvedValue([]),
    findActiveMilestoneRules: vi.fn().mockResolvedValue([]),
    findMilestoneRuleById: vi.fn().mockResolvedValue(null),
    createMilestoneRule: vi.fn(),
    updateMilestoneRule: vi.fn(),
    deleteMilestoneRule: vi.fn(),
    getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 0, grantedToday: false }),
    peekSpinWallet: vi.fn().mockResolvedValue({ availableSpins: 0, grantedToday: false }),
    setSpinWallet: vi.fn().mockImplementation(async (client, userId, { availableSpins }) => ({ userId, availableSpins })),
    // Defaults model a RETURNING user with no first-time pool configured —
    // most tests in this file predate the first-time reward feature and
    // shouldn't accidentally take that path.
    hasSpinHistory: vi.fn().mockResolvedValue(true),
    // Defaults to eligible so existing hasSpinHistory-only tests (predating
    // the account-cutoff check) keep exercising the same first-time/normal
    // branch they were written for.
    isEligibleAccountForFirstTimeReward: vi.fn().mockResolvedValue(true),
    findActiveFirstTimePrizes: vi.fn().mockResolvedValue([]),
    findAllFirstTimePrizes: vi.fn().mockResolvedValue([]),
    findFirstTimePrizeById: vi.fn().mockResolvedValue(null),
    countActiveFirstTime: vi.fn().mockResolvedValue(0),
    createFirstTimePrize: vi.fn().mockImplementation(async (data) => prize(data)),
    updateFirstTimePrize: vi.fn().mockImplementation(async (id, data) => prize({ id, ...data })),
    deleteFirstTimePrize: vi.fn().mockResolvedValue(true),
    reorderFirstTimePrizes: vi.fn().mockResolvedValue(true),
    insertGrant: vi.fn().mockResolvedValue(undefined),
    countGrantsForRule: vi.fn().mockResolvedValue(0),
    listGrants: vi.fn().mockResolvedValue([]),
    insertHistory: vi.fn().mockResolvedValue('history-1'),
    updateHistoryReward: vi.fn().mockResolvedValue(undefined),
    listHistory: vi.fn().mockResolvedValue({ total: 0, entries: [] }),
    ...overrides,
  }
}

function makeCouponsRepoMock(overrides = {}) {
  return {
    findById: vi.fn().mockResolvedValue(null),
    addTargetUser: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeWalletServiceMock(overrides = {}) {
  return {
    addMoney: vi.fn().mockResolvedValue({ success: true, transaction: { id: 'wtx-1' } }),
    ...overrides,
  }
}

function makeUsersRepoMock(overrides = {}) {
  return {
    getStats: vi.fn().mockResolvedValue({ total_orders: 0, total_spent: '0' }),
    findById: vi.fn().mockResolvedValue({ id: USER_ID, name: 'Test User' }),
    ...overrides,
  }
}

function makeService({ repo, couponsRepo, walletService, usersRepo } = {}) {
  return new SpinWheelService(
    repo || makeRepoMock(),
    couponsRepo || makeCouponsRepoMock(),
    walletService || makeWalletServiceMock(),
    usersRepo || makeUsersRepoMock()
  )
}

describe('SpinWheelService — prize coupon-linkage validation (positive + negative)', () => {
  it('rejects creating an active FREE_DELIVERY prize with no linked coupon (negative)', async () => {
    const service = makeService()
    const result = await service.createPrize({ type: 'FREE_DELIVERY', label: 'Free Delivery', isActive: true }, ACTOR)
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/linked coupon/i)
  })

  it('rejects linking a coupon whose targetType is not INDIVIDUAL (negative)', async () => {
    const couponsRepo = makeCouponsRepoMock({
      findById: vi.fn().mockResolvedValue({ id: 'c-1', code: 'ALL10', targetType: 'ALL', isActive: true }),
    })
    const service = makeService({ couponsRepo })
    const result = await service.createPrize(
      { type: 'PERCENTAGE_OFF', label: '10% OFF', value: 10, isActive: true, linkedCouponId: 'c-1' },
      ACTOR
    )
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Individual/i)
  })

  it('rejects linking an inactive coupon (negative)', async () => {
    const couponsRepo = makeCouponsRepoMock({
      findById: vi.fn().mockResolvedValue({ id: 'c-1', code: 'DEAD10', targetType: 'INDIVIDUAL', isActive: false }),
    })
    const service = makeService({ couponsRepo })
    const result = await service.createPrize(
      { type: 'FLAT_OFF', label: '₹50 OFF', value: 50, isActive: true, linkedCouponId: 'c-1' },
      ACTOR
    )
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/inactive/i)
  })

  it('accepts a coupon-requiring prize once linked to a real active INDIVIDUAL coupon (positive)', async () => {
    const couponsRepo = makeCouponsRepoMock({
      findById: vi.fn().mockResolvedValue({ id: 'c-1', code: 'BOGO1', targetType: 'INDIVIDUAL', isActive: true }),
    })
    const service = makeService({ couponsRepo })
    const result = await service.createPrize(
      { type: 'BUY_ONE_GET_ONE', label: 'BUY 1 GET 1', isActive: true, linkedCouponId: 'c-1' },
      ACTOR
    )
    expect(result.success).toBe(true)
  })

  it('rejects a PERCENTAGE_OFF prize linked to a coupon whose discount type is not Percentage (negative)', async () => {
    const couponsRepo = makeCouponsRepoMock({
      findById: vi.fn().mockResolvedValue({
        id: 'c-1', code: 'FLAT50', targetType: 'INDIVIDUAL', isActive: true, discountType: 'FLAT', discountValue: 50,
      }),
    })
    const service = makeService({ couponsRepo })
    const result = await service.createPrize(
      { type: 'PERCENTAGE_OFF', label: '10% OFF', isActive: true, linkedCouponId: 'c-1' },
      ACTOR
    )
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/discount type is Percentage/i)
  })

  it('derives value from the linked coupon for a PERCENTAGE_OFF prize instead of trusting a client-supplied one (positive)', async () => {
    const couponsRepo = makeCouponsRepoMock({
      findById: vi.fn().mockResolvedValue({
        id: 'c-1', code: 'SAVE15', targetType: 'INDIVIDUAL', isActive: true, discountType: 'PERCENTAGE', discountValue: 15,
      }),
    })
    const service = makeService({ couponsRepo })
    const result = await service.createPrize(
      { type: 'PERCENTAGE_OFF', label: '15% OFF', isActive: true, linkedCouponId: 'c-1' },
      ACTOR
    )
    expect(result.success).toBe(true)
    expect(result.prize.value).toBe(15)
  })

  it('derives value from the linked coupon for a FLAT_OFF prize (positive)', async () => {
    const couponsRepo = makeCouponsRepoMock({
      findById: vi.fn().mockResolvedValue({
        id: 'c-1', code: 'FLAT50', targetType: 'INDIVIDUAL', isActive: true, discountType: 'FLAT', discountValue: 50,
      }),
    })
    const service = makeService({ couponsRepo })
    const result = await service.createPrize(
      { type: 'FLAT_OFF', label: '₹50 OFF', isActive: true, linkedCouponId: 'c-1' },
      ACTOR
    )
    expect(result.success).toBe(true)
    expect(result.prize.value).toBe(50)
  })

  it('allows an INACTIVE coupon-requiring prize with no linked coupon — templates are a legitimate state (positive)', async () => {
    const service = makeService()
    const result = await service.createPrize({ type: 'BUY_ONE_GET_ONE', label: 'BUY 1 GET 1', isActive: false }, ACTOR)
    expect(result.success).toBe(true)
  })

  it('BETTER_LUCK never requires a coupon (positive)', async () => {
    const service = makeService()
    const result = await service.createPrize({ type: 'BETTER_LUCK', label: 'Better Luck Next Time', isActive: true }, ACTOR)
    expect(result.success).toBe(true)
  })

  it('rejects activating a 9th prize once 8 are already active (negative)', async () => {
    const repo = makeRepoMock({ countActive: vi.fn().mockResolvedValue(8) })
    const service = makeService({ repo })
    const result = await service.createPrize({ type: 'BETTER_LUCK', label: 'Extra', isActive: true }, ACTOR)
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/8/)
  })
})

describe('SpinWheelService.spin — eligibility + resolution', () => {
  it('a nameless account can still spin — no identity gate (positive)', async () => {
    const usersRepo = makeUsersRepoMock({ findById: vi.fn().mockResolvedValue({ id: USER_ID, name: null }) })
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 5, grantedToday: true }),
      findActivePrizes: vi.fn().mockResolvedValue([
        prize({ type: 'CASHBACK', value: 20, winProbability: 100 }),
        prize({ id: 'p2', winProbability: 0 }),
      ]),
    })
    const service = makeService({ repo, usersRepo })
    const result = await service.spin(USER_ID)
    expect(result.success).toBe(true)
  })

  it('rejects with no spins available and does not insert history (negative)', async () => {
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 0, grantedToday: true }),
      getSettings: vi.fn().mockResolvedValue({ dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN' }),
    })
    const service = makeService({ repo })
    const result = await service.spin(USER_ID)
    expect(result.success).toBe(false)
    expect(result.message).toBe('No spins available')
    expect(repo.insertHistory).not.toHaveBeenCalled()
  })

  it('lazily grants the daily allowance when not yet granted today, then spends one (positive)', async () => {
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 0, grantedToday: false }),
      getSettings: vi.fn().mockResolvedValue({ dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN' }),
      findActivePrizes: vi.fn().mockResolvedValue([prize({ type: 'BETTER_LUCK', winProbability: 100, linkedCouponId: null }), prize({ id: 'p2', winProbability: 0 })]),
    })
    const service = makeService({ repo })
    const result = await service.spin(USER_ID)
    expect(result.success).toBe(true)
    // Granted 1 (daily), spent 1 on this spin → 0 remaining.
    expect(result.spinsRemaining).toBe(0)
    expect(repo.setSpinWallet).toHaveBeenCalledWith(expect.anything(), USER_ID, expect.objectContaining({ markDailyGranted: true }))
  })

  it('does not re-grant the daily allowance when already granted today (positive)', async () => {
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 3, grantedToday: true }),
      getSettings: vi.fn().mockResolvedValue({ dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN' }),
      findActivePrizes: vi.fn().mockResolvedValue([
        prize({ type: 'BETTER_LUCK', winProbability: 100 }),
        prize({ id: 'p2', winProbability: 0 }),
      ]),
    })
    const service = makeService({ repo })
    const result = await service.spin(USER_ID)
    expect(result.success).toBe(true)
    expect(result.spinsRemaining).toBe(2) // 3 - 1, no daily top-up
  })

  it('a CASHBACK win credits the wallet with subType SCRATCH and marks reward ISSUED (positive)', async () => {
    const walletService = makeWalletServiceMock()
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 5, grantedToday: true }),
      findActivePrizes: vi.fn().mockResolvedValue([
        prize({ type: 'CASHBACK', value: 20, winProbability: 100 }),
        prize({ id: 'p2', winProbability: 0 }),
      ]),
    })
    const service = makeService({ repo, walletService })
    const result = await service.spin(USER_ID)
    expect(result.success).toBe(true)
    expect(result.rewardStatus).toBe('ISSUED')
    expect(walletService.addMoney).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ amount: 20, subType: 'SCRATCH', sourceId: 'history-1' })
    )
    expect(repo.updateHistoryReward).toHaveBeenCalledWith('history-1', { rewardStatus: 'ISSUED', rewardRef: 'wtx-1' })
  })

  it('a coupon-requiring win with no linked coupon marks FAILED without throwing back to the caller (negative)', async () => {
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 5, grantedToday: true }),
      findActivePrizes: vi.fn().mockResolvedValue([
        prize({ type: 'FREE_DELIVERY', linkedCouponId: null, winProbability: 100 }),
        prize({ id: 'p2', winProbability: 0 }),
      ]),
    })
    const service = makeService({ repo })
    const result = await service.spin(USER_ID)
    expect(result.success).toBe(true) // the customer still sees they won
    expect(result.rewardStatus).toBe('FAILED')
  })

  it('a coupon-requiring win targets the linked coupon and marks ISSUED (positive)', async () => {
    const couponsRepo = makeCouponsRepoMock()
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 5, grantedToday: true }),
      findActivePrizes: vi.fn().mockResolvedValue([
        prize({ type: 'FREE_DELIVERY', linkedCouponId: 'c-9', winProbability: 100 }),
        prize({ id: 'p2', winProbability: 0 }),
      ]),
    })
    const service = makeService({ repo, couponsRepo })
    const result = await service.spin(USER_ID)
    expect(result.rewardStatus).toBe('ISSUED')
    expect(couponsRepo.addTargetUser).toHaveBeenCalledWith('c-9', USER_ID)
  })

  it('rejects (fails closed) when the active set is misconfigured — count out of 2-8 range (negative)', async () => {
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 5, grantedToday: true }),
      findActivePrizes: vi.fn().mockResolvedValue([prize()]), // only 1 active — below MIN_ACTIVE_PRIZES
    })
    const service = makeService({ repo })
    const result = await service.spin(USER_ID)
    expect(result.success).toBe(false)
    expect(repo.insertHistory).not.toHaveBeenCalled()
  })

  it('rejects (fails closed) when active probabilities do not sum to 100 (negative)', async () => {
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 5, grantedToday: true }),
      findActivePrizes: vi.fn().mockResolvedValue([
        prize({ id: 'a', winProbability: 10 }),
        prize({ id: 'b', winProbability: 10 }),
      ]),
    })
    const service = makeService({ repo })
    const result = await service.spin(USER_ID)
    expect(result.success).toBe(false)
  })
})

describe('SpinWheelService.spin — first-time guaranteed reward', () => {
  it('a brand-new player (no spin history) draws from the first-time pool and is marked isFirstTimeReward (positive)', async () => {
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 1, grantedToday: true }),
      getSettings: vi.fn().mockResolvedValue({ dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN', firstTimeRewardEnabled: true }),
      hasSpinHistory: vi.fn().mockResolvedValue(false),
      findActiveFirstTimePrizes: vi.fn().mockResolvedValue([
        prize({ id: 'ft-1', type: 'CASHBACK', value: 25, winProbability: 100 }),
      ]),
      // A normal pool that would fail validation (only 1 active, below
      // MIN_ACTIVE_PRIZES) — proves the first-time pool was actually used
      // instead of falling through to this one.
      findActivePrizes: vi.fn().mockResolvedValue([prize()]),
    })
    const service = makeService({ repo })
    const result = await service.spin(USER_ID)
    expect(result.success).toBe(true)
    expect(result.isFirstTimeReward).toBe(true)
    expect(result.prize.type).toBe('CASHBACK')
    expect(result.prize.isWin).toBe(true)
    expect(repo.insertHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isFirstTimeReward: true })
    )
  })

  it('a returning player (has spin history) uses the normal pool even though first-time reward is enabled (negative)', async () => {
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 1, grantedToday: true }),
      getSettings: vi.fn().mockResolvedValue({ dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN', firstTimeRewardEnabled: true }),
      hasSpinHistory: vi.fn().mockResolvedValue(true),
      findActiveFirstTimePrizes: vi.fn().mockResolvedValue([
        prize({ id: 'ft-1', type: 'CASHBACK', value: 25, winProbability: 100 }),
      ]),
      findActivePrizes: vi.fn().mockResolvedValue([
        prize({ type: 'BETTER_LUCK', winProbability: 100 }),
        prize({ id: 'p2', winProbability: 0 }),
      ]),
    })
    const service = makeService({ repo })
    const result = await service.spin(USER_ID)
    expect(result.success).toBe(true)
    expect(result.isFirstTimeReward).toBe(false)
    expect(result.prize.type).toBe('BETTER_LUCK')
  })

  it('a first-ever spin with first-time reward disabled in settings uses the normal pool (negative)', async () => {
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 1, grantedToday: true }),
      getSettings: vi.fn().mockResolvedValue({ dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN', firstTimeRewardEnabled: false }),
      hasSpinHistory: vi.fn().mockResolvedValue(false),
      findActiveFirstTimePrizes: vi.fn().mockResolvedValue([
        prize({ id: 'ft-1', type: 'CASHBACK', value: 25, winProbability: 100 }),
      ]),
      findActivePrizes: vi.fn().mockResolvedValue([
        prize({ type: 'BETTER_LUCK', winProbability: 100 }),
        prize({ id: 'p2', winProbability: 0 }),
      ]),
    })
    const service = makeService({ repo })
    const result = await service.spin(USER_ID)
    expect(result.success).toBe(true)
    expect(result.isFirstTimeReward).toBe(false)
    expect(repo.findActiveFirstTimePrizes).not.toHaveBeenCalled()
  })

  it('a misconfigured first-time pool falls back to the normal pool instead of blocking a genuine first spin (negative)', async () => {
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 1, grantedToday: true }),
      getSettings: vi.fn().mockResolvedValue({ dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN', firstTimeRewardEnabled: true }),
      hasSpinHistory: vi.fn().mockResolvedValue(false),
      // No active first-time prizes at all — below MIN_ACTIVE_FIRST_TIME_PRIZES.
      findActiveFirstTimePrizes: vi.fn().mockResolvedValue([]),
      findActivePrizes: vi.fn().mockResolvedValue([
        prize({ type: 'CASHBACK', value: 20, winProbability: 100 }),
        prize({ id: 'p2', winProbability: 0 }),
      ]),
    })
    const service = makeService({ repo })
    const result = await service.spin(USER_ID)
    expect(result.success).toBe(true)
    expect(result.isFirstTimeReward).toBe(false)
    expect(result.prize.type).toBe('CASHBACK')
  })

  it('a pre-existing account (created before the first-time-reward cutoff, no spin history) uses the normal pool, not the first-time pool (negative — regression for old users getting the new-user offer after an app update)', async () => {
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 1, grantedToday: true }),
      getSettings: vi.fn().mockResolvedValue({ dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN', firstTimeRewardEnabled: true }),
      hasSpinHistory: vi.fn().mockResolvedValue(false),
      isEligibleAccountForFirstTimeReward: vi.fn().mockResolvedValue(false),
      findActiveFirstTimePrizes: vi.fn().mockResolvedValue([
        prize({ id: 'ft-1', type: 'CASHBACK', value: 25, winProbability: 100 }),
      ]),
      findActivePrizes: vi.fn().mockResolvedValue([
        prize({ type: 'BETTER_LUCK', winProbability: 100 }),
        prize({ id: 'p2', winProbability: 0 }),
      ]),
    })
    const service = makeService({ repo })
    const result = await service.spin(USER_ID)
    expect(result.success).toBe(true)
    expect(result.isFirstTimeReward).toBe(false)
    expect(result.prize.type).toBe('BETTER_LUCK')
    expect(repo.findActiveFirstTimePrizes).not.toHaveBeenCalled()
  })
})

describe('SpinWheelService.getActivePrizesForCustomer — wheel visual matches what spin() can actually land on', () => {
  it('a brand-new player (no spin history) sees the first-time pool, not the normal one (positive)', async () => {
    const repo = makeRepoMock({
      getSettings: vi.fn().mockResolvedValue({ dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN', firstTimeRewardEnabled: true }),
      hasSpinHistory: vi.fn().mockResolvedValue(false),
      findActiveFirstTimePrizes: vi.fn().mockResolvedValue([
        prize({ id: 'ft-1', label: 'Welcome Gift', winProbability: 100 }),
      ]),
      findActivePrizes: vi.fn().mockResolvedValue([
        prize({ type: 'BETTER_LUCK', label: 'Better Luck Next Time', winProbability: 100 }),
        prize({ id: 'p2', winProbability: 0 }),
      ]),
    })
    const service = makeService({ repo })
    const result = await service.getActivePrizesForCustomer(USER_ID)
    expect(result).toEqual([expect.objectContaining({ id: 'ft-1', label: 'Welcome Gift' })])
  })

  it('a returning player (has spin history) sees the normal pool (negative)', async () => {
    const repo = makeRepoMock({
      getSettings: vi.fn().mockResolvedValue({ dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN', firstTimeRewardEnabled: true }),
      hasSpinHistory: vi.fn().mockResolvedValue(true),
      findActiveFirstTimePrizes: vi.fn().mockResolvedValue([prize({ id: 'ft-1', winProbability: 100 })]),
      findActivePrizes: vi.fn().mockResolvedValue([prize({ id: 'normal-1', winProbability: 100 })]),
    })
    const service = makeService({ repo })
    const result = await service.getActivePrizesForCustomer(USER_ID)
    expect(result).toEqual([expect.objectContaining({ id: 'normal-1' })])
    expect(repo.findActiveFirstTimePrizes).not.toHaveBeenCalled()
  })

  it('first-time reward disabled in settings falls back to the normal pool for a first-ever player (negative)', async () => {
    const repo = makeRepoMock({
      getSettings: vi.fn().mockResolvedValue({ dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN', firstTimeRewardEnabled: false }),
      hasSpinHistory: vi.fn().mockResolvedValue(false),
      findActivePrizes: vi.fn().mockResolvedValue([prize({ id: 'normal-1', winProbability: 100 })]),
    })
    const service = makeService({ repo })
    const result = await service.getActivePrizesForCustomer(USER_ID)
    expect(result).toEqual([expect.objectContaining({ id: 'normal-1' })])
    expect(repo.findActiveFirstTimePrizes).not.toHaveBeenCalled()
  })

  it('a misconfigured first-time pool falls back to the normal pool instead of showing an invalid wheel (negative)', async () => {
    const repo = makeRepoMock({
      getSettings: vi.fn().mockResolvedValue({ dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN', firstTimeRewardEnabled: true }),
      hasSpinHistory: vi.fn().mockResolvedValue(false),
      findActiveFirstTimePrizes: vi.fn().mockResolvedValue([]), // below MIN_ACTIVE_FIRST_TIME_PRIZES
      findActivePrizes: vi.fn().mockResolvedValue([prize({ id: 'normal-1', winProbability: 100 })]),
    })
    const service = makeService({ repo })
    const result = await service.getActivePrizesForCustomer(USER_ID)
    expect(result).toEqual([expect.objectContaining({ id: 'normal-1' })])
  })

  it('a pre-existing account (no spin history, created before the cutoff) sees the normal pool, not the first-time pool (negative — regression for old users)', async () => {
    const repo = makeRepoMock({
      getSettings: vi.fn().mockResolvedValue({ dailyFreeSpins: 1, triggerMode: 'ALWAYS_ON_LOGIN', firstTimeRewardEnabled: true }),
      hasSpinHistory: vi.fn().mockResolvedValue(false),
      isEligibleAccountForFirstTimeReward: vi.fn().mockResolvedValue(false),
      findActiveFirstTimePrizes: vi.fn().mockResolvedValue([prize({ id: 'ft-1', winProbability: 100 })]),
      findActivePrizes: vi.fn().mockResolvedValue([prize({ id: 'normal-1', winProbability: 100 })]),
    })
    const service = makeService({ repo })
    const result = await service.getActivePrizesForCustomer(USER_ID)
    expect(result).toEqual([expect.objectContaining({ id: 'normal-1' })])
    expect(repo.findActiveFirstTimePrizes).not.toHaveBeenCalled()
  })

  it('an anonymous caller (no userId) sees the normal pool (negative)', async () => {
    const repo = makeRepoMock({
      findActivePrizes: vi.fn().mockResolvedValue([prize({ id: 'normal-1', winProbability: 100 })]),
    })
    const service = makeService({ repo })
    const result = await service.getActivePrizesForCustomer(null)
    expect(result).toEqual([expect.objectContaining({ id: 'normal-1' })])
    expect(repo.getSettings).not.toHaveBeenCalled()
  })
})

describe('SpinWheelService.getAppearanceForCustomer — background image + banner copy', () => {
  it('derives a capped1080-profile Cloudinary URL when a public id is on file (positive)', async () => {
    const repo = makeRepoMock({
      getSettings: vi.fn().mockResolvedValue({
        backgroundImagePublicId: 'bakaloo/spin-wheel/abc123',
        backgroundImageUrl: 'https://res.cloudinary.com/demo/image/upload/abc123.png',
        bannerTitle: 'Win up to ₹100 off',
        bannerSubtitle: 'on your next order',
        bannerTagline: 'Good Deals\nEveryday!',
      }),
    })
    const service = makeService({ repo })
    const result = await service.getAppearanceForCustomer()
    expect(result.backgroundImageUrl).toContain('w_1080')
    expect(result.backgroundImageUrl).toContain('abc123')
    expect(result.bannerTitle).toBe('Win up to ₹100 off')
  })

  it('falls back to the raw stored url when there is no public id (positive)', async () => {
    const repo = makeRepoMock({
      getSettings: vi.fn().mockResolvedValue({
        backgroundImagePublicId: null,
        backgroundImageUrl: 'https://example.com/custom-bg.png',
        bannerTitle: 'Win up to ₹100 off',
        bannerSubtitle: 'on your next order',
        bannerTagline: 'Good Deals\nEveryday!',
      }),
    })
    const service = makeService({ repo })
    const result = await service.getAppearanceForCustomer()
    expect(result.backgroundImageUrl).toBe('https://example.com/custom-bg.png')
  })

  it('returns null backgroundImageUrl when no admin upload exists yet — app keeps its bundled default (negative)', async () => {
    const repo = makeRepoMock({
      getSettings: vi.fn().mockResolvedValue({
        backgroundImagePublicId: null,
        backgroundImageUrl: null,
        bannerTitle: 'Win up to ₹100 off',
        bannerSubtitle: 'on your next order',
        bannerTagline: 'Good Deals\nEveryday!',
      }),
    })
    const service = makeService({ repo })
    const result = await service.getAppearanceForCustomer()
    expect(result.backgroundImageUrl).toBeNull()
  })
})

describe('SpinWheelService.evaluateMilestones — dedup + repeating multi-threshold math', () => {
  it('a non-repeating rule grants exactly once even if evaluated twice (positive + dedup)', async () => {
    let granted = 0
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 0, grantedToday: false }),
      findActiveMilestoneRules: vi.fn().mockResolvedValue([
        { id: 'rule-1', milestoneType: 'ORDER_COUNT', threshold: 5, bonusSpins: 1, isRepeating: false, isActive: true },
      ]),
      countGrantsForRule: vi.fn().mockImplementation(async () => granted),
      insertGrant: vi.fn().mockImplementation(async () => { granted += 1 }),
    })
    const usersRepo = makeUsersRepoMock({ getStats: vi.fn().mockResolvedValue({ total_orders: 5, total_spent: '0' }) })
    const service = makeService({ repo, usersRepo })

    await service.evaluateMilestones(USER_ID)
    await service.evaluateMilestones(USER_ID)

    expect(repo.insertGrant).toHaveBeenCalledTimes(1)
  })

  it('a repeating rule grants once per multiple of the threshold already crossed (positive)', async () => {
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 0, grantedToday: false }),
      findActiveMilestoneRules: vi.fn().mockResolvedValue([
        { id: 'rule-spend', milestoneType: 'TOTAL_SPEND', threshold: 500, bonusSpins: 1, isRepeating: true, isActive: true },
      ]),
      countGrantsForRule: vi.fn().mockResolvedValue(0),
    })
    // One big order jumps total_spend to 1250 — floor(1250/500) = 2 multiples earned, 0 already granted → grant twice.
    const usersRepo = makeUsersRepoMock({ getStats: vi.fn().mockResolvedValue({ total_orders: 1, total_spent: '1250' }) })
    const service = makeService({ repo, usersRepo })

    await service.evaluateMilestones(USER_ID)

    expect(repo.insertGrant).toHaveBeenCalledTimes(2)
  })

  it('an inactive rule never grants (negative)', async () => {
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 0, grantedToday: false }),
      findActiveMilestoneRules: vi.fn().mockResolvedValue([]), // repo itself only returns active rules
    })
    const usersRepo = makeUsersRepoMock({ getStats: vi.fn().mockResolvedValue({ total_orders: 999, total_spent: '999999' }) })
    const service = makeService({ repo, usersRepo })

    await service.evaluateMilestones(USER_ID)

    expect(repo.insertGrant).not.toHaveBeenCalled()
  })

  it('a user with no qualifying stats yet never grants (negative)', async () => {
    const repo = makeRepoMock({
      getOrCreateSpinWalletForUpdate: vi.fn().mockResolvedValue({ userId: USER_ID, availableSpins: 0, grantedToday: false }),
      findActiveMilestoneRules: vi.fn().mockResolvedValue([
        { id: 'rule-1', milestoneType: 'ORDER_COUNT', threshold: 5, bonusSpins: 1, isRepeating: false, isActive: true },
      ]),
      countGrantsForRule: vi.fn().mockResolvedValue(0),
    })
    const usersRepo = makeUsersRepoMock({ getStats: vi.fn().mockResolvedValue({ total_orders: 0, total_spent: '0' }) })
    const service = makeService({ repo, usersRepo })

    await service.evaluateMilestones(USER_ID)

    expect(repo.insertGrant).not.toHaveBeenCalled()
  })
})
