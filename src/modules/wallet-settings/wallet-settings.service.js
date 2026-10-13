import { WalletSettingsRepository } from './wallet-settings.repository.js'

const KEYS = [
  'wallet_max_balance',
  'wallet_max_transfer_amount',
  'wallet_min_transfer_amount',
  'wallet_transfers_enabled',
  'wallet_topup_enabled',
  'wallet_expiry_enabled',
  'wallet_expiry_days_spin',
  'wallet_expiry_days_scratch',
  'wallet_expiry_days_coupon',
  'wallet_expiry_days_offer',
  'wallet_expiry_days_admin',
  'wallet_expiry_reminder_days',
]

// Lot source_type (wallet_credit_lots) -> the settings field holding its
// validity in days. Top-ups and refunds have no entry on purpose: they are
// real money and never expire.
const EXPIRY_DAYS_FIELD = {
  SPIN: 'expirySpinDays',
  SCRATCH: 'expiryScratchDays',
  COUPON: 'expiryCouponDays',
  OFFER: 'expiryOfferDays',
  ADMIN: 'expiryAdminDays',
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

const DEFAULTS = {
  maxWalletBalance: 2000,
  maxTransferAmount: 2000,
  minTransferAmount: 1,
  // Off by default: user-to-user wallet transfer is gated to RBI-authorized
  // Full-KYC PPI issuers regardless of transfer/balance limits, which this
  // platform is not. Wallet top-up + spend-on-order is unaffected by this
  // flag. Flip on in the dashboard only after that's been cleared.
  transfersEnabled: false,
  // On by default. A manual kill-switch for the admin to flip off during a
  // Razorpay outage or similar — stops new top-up attempts at the source
  // (createTopUp) instead of letting customers hit a broken payment flow.
  topupEnabled: true,
  // Off until an admin opts in, so shipping the feature never silently
  // starts expiring money customers already hold.
  expiryEnabled: false,
  expirySpinDays: 30,
  expiryScratchDays: 30,
  expiryCouponDays: 30,
  expiryOfferDays: 30,
  expiryAdminDays: 30,
  expiryReminderDays: 3,
}

/**
 * Wallet Settings service — resolves the admin-configurable wallet balance
 * cap and transfer min/max from the `app_settings` table, falling back to
 * safe defaults. This is the single place `WalletService` consults before
 * crediting a wallet or accepting a transfer, so an admin change in the
 * dashboard is actually enforced, not just cosmetic.
 */
export class WalletSettingsService {
  constructor(repository = new WalletSettingsRepository()) {
    this.repo = repository
  }

  async getConfig() {
    const raw = await this.repo.getMany(KEYS)

    return {
      maxWalletBalance: this._toNumber(raw.wallet_max_balance, DEFAULTS.maxWalletBalance),
      maxTransferAmount: this._toNumber(raw.wallet_max_transfer_amount, DEFAULTS.maxTransferAmount),
      minTransferAmount: this._toNumber(raw.wallet_min_transfer_amount, DEFAULTS.minTransferAmount),
      transfersEnabled: this._toBoolean(raw.wallet_transfers_enabled, DEFAULTS.transfersEnabled),
      topupEnabled: this._toBoolean(raw.wallet_topup_enabled, DEFAULTS.topupEnabled),
      expiryEnabled: this._toBoolean(raw.wallet_expiry_enabled, DEFAULTS.expiryEnabled),
      expirySpinDays: this._toDays(raw.wallet_expiry_days_spin, DEFAULTS.expirySpinDays),
      expiryScratchDays: this._toDays(raw.wallet_expiry_days_scratch, DEFAULTS.expiryScratchDays),
      expiryCouponDays: this._toDays(raw.wallet_expiry_days_coupon, DEFAULTS.expiryCouponDays),
      expiryOfferDays: this._toDays(raw.wallet_expiry_days_offer, DEFAULTS.expiryOfferDays),
      expiryAdminDays: this._toDays(raw.wallet_expiry_days_admin, DEFAULTS.expiryAdminDays),
      expiryReminderDays: this._toDays(raw.wallet_expiry_reminder_days, DEFAULTS.expiryReminderDays),
    }
  }

  /**
   * When a credit from `sourceType` (SPIN | SCRATCH | COUPON | OFFER | ADMIN)
   * issued right now would expire, or null if it never does — expiry is off,
   * the source has no rule, or its validity is 0 days. `daysOverride` lets an
   * admin pick a one-off validity for a single manual bonus credit.
   *
   * Expiry lands at the END of the last valid day in IST (23:59:59), so a
   * customer told "valid till 12 Nov" really has all of the 12th.
   */
  async resolveExpiry(sourceType, { daysOverride, now = new Date() } = {}) {
    const config = await this.getConfig()
    if (!config.expiryEnabled) return null
    const field = EXPIRY_DAYS_FIELD[sourceType]
    if (!field) return null
    const days = daysOverride != null ? Number(daysOverride) : config[field]
    if (!Number.isFinite(days) || days <= 0) return null
    return WalletSettingsService.endOfDayIst(now, days)
  }

  static endOfDayIst(from, days) {
    const istNow = new Date(from.getTime() + IST_OFFSET_MS)
    const istMidnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate())
    const istEnd = istMidnight + (Math.floor(days) + 1) * 86_400_000 - 1000
    return new Date(istEnd - IST_OFFSET_MS)
  }

  async updateConfig(input) {
    const {
      maxWalletBalance, maxTransferAmount, minTransferAmount, transfersEnabled, topupEnabled,
      expiryEnabled, expirySpinDays, expiryScratchDays, expiryCouponDays,
      expiryOfferDays, expiryAdminDays, expiryReminderDays,
    } = input
    const current = await this.getConfig()
    const next = {
      maxWalletBalance: maxWalletBalance ?? current.maxWalletBalance,
      maxTransferAmount: maxTransferAmount ?? current.maxTransferAmount,
      minTransferAmount: minTransferAmount ?? current.minTransferAmount,
      transfersEnabled: transfersEnabled ?? current.transfersEnabled,
      topupEnabled: topupEnabled ?? current.topupEnabled,
      expiryEnabled: expiryEnabled ?? current.expiryEnabled,
      expirySpinDays: expirySpinDays ?? current.expirySpinDays,
      expiryScratchDays: expiryScratchDays ?? current.expiryScratchDays,
      expiryCouponDays: expiryCouponDays ?? current.expiryCouponDays,
      expiryOfferDays: expiryOfferDays ?? current.expiryOfferDays,
      expiryAdminDays: expiryAdminDays ?? current.expiryAdminDays,
      expiryReminderDays: expiryReminderDays ?? current.expiryReminderDays,
    }

    for (const label of ['maxWalletBalance', 'maxTransferAmount', 'minTransferAmount']) {
      const value = next[label]
      if (!Number.isFinite(value) || value <= 0) {
        return { success: false, message: `${label} must be a positive number` }
      }
    }
    for (const label of Object.keys(next).filter((k) => /^expiry.*Days$/.test(k))) {
      const value = next[label]
      if (!Number.isInteger(value) || value < 0 || value > 3650) {
        return { success: false, message: `${label} must be a whole number of days between 0 and 3650` }
      }
    }

    if (next.minTransferAmount > next.maxTransferAmount) {
      return { success: false, message: 'Minimum transfer amount cannot exceed the maximum transfer amount' }
    }
    if (next.maxTransferAmount > next.maxWalletBalance) {
      return { success: false, message: 'Maximum transfer amount cannot exceed the maximum wallet balance' }
    }

    await this.repo.upsert('wallet_max_balance', next.maxWalletBalance)
    await this.repo.upsert('wallet_max_transfer_amount', next.maxTransferAmount)
    await this.repo.upsert('wallet_min_transfer_amount', next.minTransferAmount)
    await this.repo.upsert('wallet_transfers_enabled', next.transfersEnabled)
    await this.repo.upsert('wallet_topup_enabled', next.topupEnabled)
    await this.repo.upsert('wallet_expiry_enabled', next.expiryEnabled)
    await this.repo.upsert('wallet_expiry_days_spin', next.expirySpinDays)
    await this.repo.upsert('wallet_expiry_days_scratch', next.expiryScratchDays)
    await this.repo.upsert('wallet_expiry_days_coupon', next.expiryCouponDays)
    await this.repo.upsert('wallet_expiry_days_offer', next.expiryOfferDays)
    await this.repo.upsert('wallet_expiry_days_admin', next.expiryAdminDays)
    await this.repo.upsert('wallet_expiry_reminder_days', next.expiryReminderDays)

    return { success: true, data: next }
  }

  _toNumber(value, fallback) {
    if (value === undefined || value === null) return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  _toDays(value, fallback) {
    const n = this._toNumber(value, fallback)
    return Number.isInteger(n) && n >= 0 ? n : fallback
  }

  _toBoolean(value, fallback) {
    if (value === undefined || value === null) return fallback
    if (typeof value === 'boolean') return value
    return value === 'true' || value === true
  }
}
