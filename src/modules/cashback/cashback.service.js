import { logger } from '../../config/logger.js'
import { CashbackRepository } from './cashback.repository.js'
import { WalletService } from '../wallet/wallet.service.js'
import { WalletRepository } from '../wallet/wallet.repository.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { formatDateIst } from '../wallet/wallet-lots.js'

const SOURCE_LABELS = {
  COUPON: 'coupon',
  FIRST_TIME_OFFER: 'first order reward',
  CART_MILESTONE: 'cart milestone',
  PAYMENT_OFFER: 'payment offer',
}

/**
 * Cashback service — the single place that credits/cancels cashback
 * regardless of which feature produced it (coupon CASHBACK type,
 * first-time-offer WALLET_CASHBACK reward, cart-milestone reward later).
 *
 * Cashback is never credited at the moment it's "earned" — a PENDING
 * cashback_transactions row is created at checkout, and evaluateAndCredit()
 * is called from each order-lifecycle hook (payment success / order
 * confirmed / order delivered) to actually move money into the wallet once
 * the row's configured trigger matches that event. cancelForOrder() reverses
 * a PENDING row (no wallet action needed) or claws back a CREDITED one.
 */
export class CashbackService {
  constructor(
    repository = new CashbackRepository(),
    walletService = new WalletService(new WalletRepository()),
    notificationsService = new NotificationsService(new NotificationsRepository(), null)
  ) {
    this.repo = repository
    this.walletService = walletService
    this.notificationsService = notificationsService
  }

  /**
   * Create a PENDING cashback row for an order. Called at checkout time
   * (inside the same DB transaction as order creation when a client is
   * passed) — no wallet action happens yet.
   */
  async createPending({ orderId, userId, sourceType, sourceId, amount, creditTrigger }, client = null) {
    const roundedAmount = Math.round(Number(amount) * 100) / 100
    if (!roundedAmount || roundedAmount <= 0) return null
    return this.repo.createPending(
      { orderId, userId, sourceType, sourceId, amount: roundedAmount, creditTrigger },
      client
    )
  }

  /**
   * Credit every PENDING cashback row for an order whose trigger matches
   * the event that just happened (PAYMENT_SUCCESS / ORDER_CONFIRMED /
   * ORDER_DELIVERED). Best-effort per row — one failure doesn't block
   * the others or bubble up to the caller (this is always called as a
   * post-commit side effect, same convention as order notifications).
   */
  async evaluateAndCredit(orderId, eventTrigger) {
    let creditedCount = 0
    try {
      const pending = await this.repo.findPendingByOrderAndTrigger(orderId, eventTrigger)
      for (const tx of pending) {
        try {
          const result = await this.walletService.addMoney(tx.userId, {
            amount: tx.amount,
            description: `Cashback — ${SOURCE_LABELS[tx.sourceType] || 'reward'}`,
            referenceId: tx.orderId,
            subType: 'CASHBACK',
            sourceId: tx.id,
            orderId: tx.orderId,
            // Coupon cashback and first-order/milestone/payment-offer
            // cashback have separate validity rules in Wallet → Expiry.
            expirySource: tx.sourceType === 'COUPON' ? 'COUPON' : 'OFFER',
          })
          if (result.success) {
            await this.repo.markCredited(tx.id, result.transaction.id)
            creditedCount++
            this._notifyCashbackCredited(tx, result.transaction?.expiresAt).catch(() => {})
          } else {
            logger.error({ cashbackTxId: tx.id, orderId, message: result.message }, 'Cashback credit failed')
          }
        } catch (err) {
          logger.error({ err, cashbackTxId: tx.id, orderId }, 'Cashback credit threw')
        }
      }
    } catch (err) {
      logger.error({ err, orderId, eventTrigger }, 'Cashback evaluateAndCredit failed')
    }
    return creditedCount
  }

  /**
   * Cancel every active (PENDING or CREDITED) cashback row for an order
   * that's being cancelled/refunded. PENDING rows are simply marked
   * CANCELLED; CREDITED rows are clawed back from the wallet first.
   */
  async cancelForOrder(orderId) {
    let cancelledCount = 0
    try {
      const active = await this.repo.findActiveByOrder(orderId)
      for (const tx of active) {
        try {
          if (tx.status === 'CREDITED') {
            await this.walletService.deductMoney(tx.userId, {
              amount: tx.amount,
              description: `Cashback reversed — order cancelled`,
              referenceId: tx.orderId,
              subType: 'CASHBACK',
              sourceId: tx.id,
              orderId: tx.orderId,
            })
          }
          await this.repo.markCancelled(tx.id)
          cancelledCount++
        } catch (err) {
          logger.error({ err, cashbackTxId: tx.id, orderId }, 'Cashback cancellation threw')
        }
      }
    } catch (err) {
      logger.error({ err, orderId }, 'Cashback cancelForOrder failed')
    }
    return cancelledCount
  }

  /**
   * Push/in-app notification for a just-credited cashback row. Best-effort —
   * never allowed to affect the credit itself, which has already committed
   * by the time this runs.
   */
  async _notifyCashbackCredited(tx, expiresAt) {
    try {
      await this.notificationsService.sendNotification(tx.userId, {
        title: '🎉 Cashback credited!',
        body: `₹${tx.amount} cashback from your ${SOURCE_LABELS[tx.sourceType] || 'reward'} has been added to your wallet.${expiresAt ? ` Use it before ${formatDateIst(expiresAt)}.` : ''}`,
        type: 'WALLET',
        data: { type: 'WALLET', orderId: tx.orderId, amount: tx.amount, sourceType: tx.sourceType, expiresAt: expiresAt || null },
      })
    } catch (err) {
      logger.warn({ err: err.message, cashbackTxId: tx.id }, 'Cashback-credited notification failed (non-blocking)')
    }
  }
}
