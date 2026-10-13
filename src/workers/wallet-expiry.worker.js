/**
 * Wallet Credit Expiry Worker
 *
 * Expiring wallet credits (spin / scratch / coupon & offer cashback / admin
 * bonus — see migration 158_wallet_credit_expiry.sql) are removed from the
 * balance once their expires_at passes. The balance read path and every
 * credit/debit already sweep a wallet's lapsed credits on contact
 * (WalletRepository#getForUpdate), so spending never sees expired money;
 * this worker is what handles customers who simply don't open the app:
 *
 *   1. sweep   — expire lapsed credits of idle wallets (writes the DEBIT
 *                "… expired" transaction the customer sees in their history)
 *   2. notify  — tell the customer their credit expired
 *   3. remind  — warn N days ahead (Settings → Wallet → Expiry reminder)
 *
 * Safe to run in every API process of a cluster: sweeps lock each wallet
 * with SKIP LOCKED and notifications are claimed with a single UPDATE, so a
 * lot is never expired or announced twice.
 */
import { logger } from '../config/logger.js'
import { WalletRepository } from '../modules/wallet/wallet.repository.js'
import { WalletSettingsService } from '../modules/wallet-settings/wallet-settings.service.js'
import { NotificationsRepository } from '../modules/notifications/notifications.repository.js'
import { NotificationsService } from '../modules/notifications/notifications.service.js'
import { LOT_LABELS, formatDateIst, formatMoney } from '../modules/wallet/wallet-lots.js'

const POLL_INTERVAL_MS = 60 * 1000

let _intervalHandle = null
let _running = false

const walletRepo = new WalletRepository()
const settings = new WalletSettingsService()
const notifications = new NotificationsService(new NotificationsRepository(), null)

export function startWalletExpiryWorker() {
  if (_intervalHandle) return
  logger.info('Wallet expiry worker started (polling every 1 min)')

  const tick = async () => {
    // A slow pass must not overlap the next one in the same process.
    if (_running) return
    _running = true
    try {
      await runWalletExpiryPass()
    } catch (err) {
      logger.error({ err: err.message }, 'Wallet expiry worker poll error')
    } finally {
      _running = false
    }
  }

  _intervalHandle = setInterval(tick, POLL_INTERVAL_MS)
  tick()
}

export function stopWalletExpiryWorker() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
  }
}

export async function runWalletExpiryPass() {
  const expiredWallets = await _sweepExpired()
  const notified = await _notifyExpired()
  const reminded = await _sendReminders()
  if (expiredWallets || notified || reminded) {
    logger.info({ expiredWallets, notified, reminded }, 'Wallet expiry pass complete')
  }
  return { expiredWallets, notified, reminded }
}

async function _sweepExpired() {
  const walletIds = await walletRepo.findWalletsWithDueLots()
  let swept = 0
  for (const walletId of walletIds) {
    try {
      if (await walletRepo.expireDueForWallet(walletId)) swept++
    } catch (err) {
      logger.error({ err: err.message, walletId }, 'Wallet credit expiry failed')
    }
  }
  return swept
}

async function _notifyExpired() {
  const lots = await walletRepo.claimExpiredNotifications()
  for (const lot of lots) {
    await _send(lot.user_id, {
      title: '⏰ Cashback expired',
      body: `${formatMoney(lot.expired_amount)} ${LOT_LABELS[lot.source_type] || 'cashback'} in your wallet expired on ${formatDateIst(lot.expires_at)}.`,
      type: 'WALLET',
      data: { type: 'WALLET', event: 'WALLET_CREDIT_EXPIRED', amount: Number(lot.expired_amount), lotId: lot.id },
    })
  }
  return lots.length
}

async function _sendReminders() {
  const { expiryEnabled, expiryReminderDays } = await settings.getConfig()
  if (!expiryEnabled || !(expiryReminderDays > 0)) return 0
  const lots = await walletRepo.claimExpiryReminders(expiryReminderDays)
  for (const lot of lots) {
    await _send(lot.user_id, {
      title: '⏳ Use your cashback soon',
      body: `${formatMoney(lot.remaining_amount)} ${LOT_LABELS[lot.source_type] || 'cashback'} in your wallet expires on ${formatDateIst(lot.expires_at)}. Use it before it's gone!`,
      type: 'WALLET',
      data: { type: 'WALLET', event: 'WALLET_CREDIT_EXPIRING', amount: Number(lot.remaining_amount), lotId: lot.id },
    })
  }
  return lots.length
}

async function _send(userId, payload) {
  try {
    await notifications.sendNotification(userId, payload)
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'Wallet expiry notification failed (non-blocking)')
  }
}
