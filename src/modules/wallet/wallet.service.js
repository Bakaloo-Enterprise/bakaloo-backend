import crypto from 'node:crypto'
import { getClient } from '../../config/database.js'
import { env } from '../../config/env.js'
import { orderQueue } from '../../config/bullmq.js'
import { logger } from '../../config/logger.js'
import { razorpay } from '../../config/razorpay.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { OrdersRepository } from '../orders/orders.repository.js'
import { PaymentSettingsService } from '../payment-settings/payment-settings.service.js'
import { WalletSettingsService } from '../wallet-settings/wallet-settings.service.js'
import { LOT_LABELS, formatDateIst, formatMoney } from './wallet-lots.js'
// CashbackService is imported dynamically inside payFromWallet() (not at
// module top-level) — cashback.service.js itself imports WalletService, so
// a static import here would be circular. Same convention already used in
// this file/payments.service.js for cart/notifications one-off imports.

const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

/**
 * Wallet service — business logic for digital wallet
 */
export class WalletService {
  constructor(repository, fastify = null) {
    this.repo = repository
    this.fastify = fastify
    this.ordersRepo = new OrdersRepository()
    this.paymentSettingsService = new PaymentSettingsService()
    this.walletSettingsService = new WalletSettingsService()
  }

  /**
   * Get or create wallet for a user
   */
  async getWallet(userId) {
    const wallet = await this._getOrCreateSwept(userId)

    const lots = await this.repo.getActiveLots(wallet.id)
    const expiringBalance = this._round2(lots.reduce((sum, l) => sum + l.remainingAmount, 0))
    return {
      ...wallet,
      // balance = permanentBalance (never expires) + expiringBalance
      permanentBalance: this._round2(Math.max(0, wallet.balance - expiringBalance)),
      expiringBalance,
      nextExpiry: lots[0]
        ? { amount: lots[0].remainingAmount, expiresAt: lots[0].expiresAt }
        : null,
    }
  }

  /**
   * Wallet row with any lapsed credits already expired — so a customer
   * never sees expired money in their balance or misses the "expired" line
   * in their history because the worker (polls every minute) hasn't run yet.
   */
  async _getOrCreateSwept(userId) {
    const wallet = await this.repo.getOrCreate(userId)
    if (await this.repo.hasDueLots(wallet.id)) {
      const swept = await this.repo.expireDueForWallet(wallet.id)
      return swept || (await this.repo.getOrCreate(userId))
    }
    return wallet
  }

  /**
   * The customer's still-usable expiring credits, soonest first, for a
   * "your cashback and when it expires" view.
   */
  async getExpiryDetails(userId) {
    const wallet = await this.getWallet(userId)
    const lots = await this.repo.getActiveLots(wallet.id)
    return {
      balance: wallet.balance,
      permanentBalance: wallet.permanentBalance,
      expiringBalance: wallet.expiringBalance,
      credits: lots.map((l) => ({
        id: l.id,
        sourceType: l.sourceType,
        label: LOT_LABELS[l.sourceType] || 'Cashback',
        originalAmount: l.originalAmount,
        remainingAmount: l.remainingAmount,
        expiresAt: l.expiresAt,
        createdAt: l.createdAt,
      })),
    }
  }

  _round2(n) {
    return Math.round(Number(n) * 100) / 100
  }

  /**
   * Get wallet transactions (paginated)
   */
  async getTransactions(userId, filters) {
    const wallet = await this._getOrCreateSwept(userId)
    const { offset, limit } = getOffsetLimit(filters)
    const page = Math.max(1, Math.floor(filters.page || 1))

    const { transactions, total } = await this.repo.getTransactions(wallet.id, {
      limit,
      offset,
      type: filters.type,
    })

    return {
      transactions,
      pagination: buildPagination({ page, limit, total }),
    }
  }

  /**
   * Admin: get all transactions across all users (paginated, filterable)
   *
   * `filters.userId` accepts either an exact user UUID (existing behavior)
   * or an Indian mobile number, resolved to the matching user's id via
   * `findUserByPhone` — the wallet search box only exposes a single free-text
   * field, so this needs to detect which shape was pasted in. Anything that
   * matches neither shape can never match a real user/wallet, so it short-
   * circuits to an empty result instead of letting an invalid-UUID string
   * reach Postgres and 500 the whole page.
   */
  async getAdminTransactions(filters = {}) {
    const page = filters.page || 1
    const limit = filters.limit || 20
    const offset = (page - 1) * limit

    let resolvedUserId = filters.userId || undefined
    if (resolvedUserId) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resolvedUserId)
      if (!isUuid) {
        const isPhone = /^[6-9]\d{9}$/.test(resolvedUserId)
        const user = isPhone ? await this.repo.findUserByPhone(resolvedUserId) : null
        if (!user) {
          return { transactions: [], pagination: buildPagination({ page, limit, total: 0 }) }
        }
        resolvedUserId = user.id
      }
    }

    const { transactions, total } = await this.repo.getAdminTransactions({
      limit,
      offset,
      type: filters.type,
      userId: resolvedUserId,
    })

    return {
      transactions,
      pagination: buildPagination({ page, limit, total }),
    }
  }

  async _getOrCreateWalletForUpdate(client, userId) {
    let wallet = await this.repo.getForUpdate(client, userId)
    if (wallet) return wallet

    await client.query(
      `INSERT INTO wallets (user_id, balance) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    )

    wallet = await this.repo.getForUpdate(client, userId)
    return wallet
  }

  /**
   * Step 1: create a Razorpay order for wallet top-up.
   * This does not credit the wallet.
   */
  async createTopUp(userId, amount) {
    if (!razorpay) {
      return { success: false, message: 'Online payments are not configured' }
    }

    // Admin kill-switch (Settings → Wallet) — checked before anything else
    // so a known Razorpay outage or similar can be stopped at the source
    // instead of letting customers hit a broken payment flow and land in
    // the exact stuck-pending state the reconciliation worker exists for.
    const { topupEnabled, maxWalletBalance } = await this.walletSettingsService.getConfig()
    if (!topupEnabled) {
      return { success: false, message: 'Wallet top-up is currently unavailable. Please try again later.' }
    }

    const normalizedAmount = Number(amount)
    if (!Number.isFinite(normalizedAmount) || normalizedAmount < 10 || normalizedAmount > 10000) {
      return { success: false, message: 'Amount must be between ₹10 and ₹10,000' }
    }

    const wallet = await this.repo.getOrCreate(userId)

    if (wallet.balance + normalizedAmount > maxWalletBalance) {
      const remaining = Math.max(0, maxWalletBalance - wallet.balance)
      return {
        success: false,
        message: `Adding ₹${normalizedAmount} would exceed your ₹${maxWalletBalance} wallet limit. You can add up to ₹${remaining} more.`,
      }
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(normalizedAmount * 100),
      currency: env.RAZORPAY_CURRENCY,
      receipt: `topup_${Date.now()}`,
      notes: {
        userId,
        purpose: 'wallet_topup',
      },
    })

    await this.repo.createPendingTopUp(wallet.id, {
      amount: normalizedAmount,
      razorpayOrderId: razorpayOrder.id,
      description: 'Wallet top-up',
    })

    logger.info({ userId, amount: normalizedAmount, razorpayOrderId: razorpayOrder.id }, 'Wallet top-up order created')

    return {
      success: true,
      data: {
        razorpayOrderId: razorpayOrder.id,
        amount: normalizedAmount,
        currency: env.RAZORPAY_CURRENCY,
        keyId: env.RAZORPAY_KEY_ID,
      },
    }
  }

  /**
   * Step 2: verify Razorpay payment and credit wallet exactly once.
   */
  async verifyTopUp(userId, { paymentId, orderId, signature }) {
    if (!paymentId || !orderId || !signature) {
      return { success: false, message: 'Missing payment verification details' }
    }

    const client = await getClient()

    try {
      await client.query('BEGIN')

      const topup = await this.repo.findTopUpByOrderIdForUpdate(client, orderId)
      if (!topup) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Top-up record not found' }
      }

      if (topup.userId !== userId) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Unauthorized' }
      }

      if (topup.status === 'COMPLETED') {
        const wallet = await this._getOrCreateWalletForUpdate(client, userId)
        await client.query('COMMIT')
        return { success: true, wallet, transaction: topup }
      }

      if (topup.status === 'FAILED') {
        await client.query('ROLLBACK')
        return { success: false, message: 'Top-up already marked as failed' }
      }

      // Constant-time comparison — matches the convention already used for
      // QR pickup signatures in utils/qrToken.js. See payments.service.js's
      // verifyPayment for the same fix and reasoning.
      const expectedSignature = crypto
        .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest('hex')

      const providedSignature = String(signature || '')
      const signatureMatches =
        expectedSignature.length === providedSignature.length &&
        crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(providedSignature))

      if (!signatureMatches) {
        await this.repo.markTopUpFailed(client, topup.id)
        await client.query('COMMIT')
        logger.warn({ userId, orderId }, 'Wallet top-up signature verification failed')
        return { success: false, message: 'Payment verification failed' }
      }

      const wallet = await this._getOrCreateWalletForUpdate(client, userId)
      if (!wallet) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Wallet not found' }
      }

      const result = await this.repo.applyPendingTopUp(
        client,
        wallet.id,
        topup.id,
        topup.amount
      )

      await client.query('COMMIT')

      logger.info({ userId, amount: topup.amount, orderId }, 'Wallet top-up verified and credited')

      // Money is already captured by Razorpay at this point — never refuse
      // to credit it (that would leave a payment charged but un-credited).
      // Just flag it for admin visibility if it pushed the wallet over the
      // configured cap.
      const { maxWalletBalance } = await this.walletSettingsService.getConfig()
      if (result.wallet.balance > maxWalletBalance) {
        logger.warn(
          { userId, orderId, balance: result.wallet.balance, maxWalletBalance },
          'Wallet top-up pushed balance above configured limit'
        )
      }

      return { success: true, ...result }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId, orderId }, 'Wallet top-up verification failed')
      return { success: false, message: 'Top-up verification failed: ' + err.message }
    } finally {
      client.release()
    }
  }

  /**
   * Safety net for wallet top-ups — completes a PENDING top-up once we
   * have independent confirmation (not from the client) that Razorpay
   * actually captured the payment. Two callers:
   *   - the Razorpay webhook (payment.captured), when configured
   *   - the reconciliation worker, which polls Razorpay directly and
   *     doesn't depend on the webhook being registered at all
   * Both exist because verifyTopUp() above is a single client-side call
   * with no retry: if the app is killed, loses network, or the UPI
   * app-switch doesn't cleanly return control before that call fires,
   * Razorpay has already captured the money but the wallet never gets
   * credited, and the top-up sits at status='PENDING' forever with
   * nothing to catch it otherwise.
   *
   * Idempotent: only acts on a PENDING row. A COMPLETED one means
   * verifyTopUp() already won the race; a FAILED one means signature
   * verification rejected it and is left alone here rather than silently
   * re-credited.
   */
  async completeVerifiedTopUp(razorpayOrderId) {
    const client = await getClient()

    try {
      await client.query('BEGIN')

      const topup = await this.repo.findTopUpByOrderIdForUpdate(client, razorpayOrderId)
      if (!topup) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Top-up record not found' }
      }

      if (topup.status !== 'PENDING') {
        await client.query('ROLLBACK')
        return { success: true, skipped: true, reason: topup.status }
      }

      const wallet = await this._getOrCreateWalletForUpdate(client, topup.userId)
      if (!wallet) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Wallet not found' }
      }

      const result = await this.repo.applyPendingTopUp(client, wallet.id, topup.id, topup.amount)

      await client.query('COMMIT')

      logger.info(
        { userId: topup.userId, amount: topup.amount, razorpayOrderId },
        'Wallet top-up completed by safety net (client verify call never arrived)'
      )

      return { success: true, ...result }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, razorpayOrderId }, 'Wallet top-up safety-net completion failed')
      return { success: false, message: 'Top-up completion failed: ' + err.message }
    } finally {
      client.release()
    }
  }

  /**
   * Internal only: add money to wallet without a payment gateway.
   * Use this for refunds or admin/manual credits, never for customer top-ups.
   */
  /**
   * `expirySource` (SPIN | SCRATCH | COUPON | OFFER | ADMIN) marks the credit
   * as expiring bonus money subject to the admin's Wallet → Expiry rules;
   * leave it unset for real money (top-ups, refunds, plain admin credits),
   * which never expires. `expiryDays` overrides the configured validity for
   * this one credit.
   */
  async addMoney(userId, { amount, description, referenceId, subType, sourceId, orderId, expirySource, expiryDays }) {
    const client = await getClient()

    try {
      await client.query('BEGIN')

      const walletForOp = await this._getOrCreateWalletForUpdate(client, userId)
      if (!walletForOp) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Failed to create wallet' }
      }

      const { maxWalletBalance } = await this.walletSettingsService.getConfig()

      const expiresAt = expirySource
        ? await this.walletSettingsService.resolveExpiry(expirySource, { daysOverride: expiryDays })
        : null
      const baseDescription = description || 'Money added'

      const result = await this.repo.credit(
        client,
        walletForOp.id,
        amount,
        // The unmodified app prints this string verbatim, so the expiry date
        // goes in the description to reach the customer without app changes.
        expiresAt ? `${baseDescription} (valid till ${formatDateIst(expiresAt)})` : baseDescription,
        referenceId,
        {
          maxBalance: maxWalletBalance,
          subType,
          sourceId,
          orderId,
          expiresAt,
          lotSource: expiresAt ? expirySource : null,
        }
      )

      // A refund for an order that was part-paid with bonus money gives that
      // bonus back to its original credit (so it keeps expiring on schedule)
      // rather than turning it into never-expiring balance.
      if (subType === 'REFUND' && orderId) {
        await this.repo.restoreLotsForOrder(client, walletForOp.id, orderId, amount)
      }

      await client.query('COMMIT')

      logger.info({ userId, amount, balance: result.wallet.balance }, 'Wallet credited')
      return { success: true, ...result }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId, amount }, 'Wallet credit failed')
      return { success: false, message: 'Failed to add money: ' + err.message }
    } finally {
      client.release()
    }
  }

  /**
   * Internal only: remove money from wallet without a customer-initiated
   * debit flow. Used to claw back a previously-credited cashback when the
   * underlying order is cancelled/refunded after the reward was credited.
   *
   * If the wallet balance is less than `amount` (the user already spent
   * the cashback), debits whatever remains instead of failing outright —
   * the cashback_transactions row is still marked CANCELLED by the caller,
   * and the partial/zero debit is logged for reconciliation.
   */
  async deductMoney(userId, { amount, description, referenceId, subType, sourceId, orderId }) {
    const client = await getClient()

    try {
      await client.query('BEGIN')

      const wallet = await this.repo.getForUpdate(client, userId)
      if (!wallet) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Wallet not found' }
      }

      const deductible = Math.min(amount, wallet.balance)
      if (deductible <= 0) {
        await client.query('ROLLBACK')
        logger.warn(
          { userId, amount, balance: wallet.balance },
          'Cashback clawback skipped — wallet balance already zero'
        )
        return { success: true, deducted: 0 }
      }

      const result = await this.repo.debit(
        client,
        wallet.id,
        deductible,
        description || 'Wallet adjustment',
        referenceId,
        // Reverse the cashback's own credit first if it is still unspent.
        { subType, sourceId, orderId, preferLotSourceId: sourceId }
      )

      await client.query('COMMIT')

      if (deductible < amount) {
        logger.warn(
          { userId, requested: amount, deducted: deductible },
          'Cashback clawback partially applied — balance was insufficient for full reversal'
        )
      }

      logger.info({ userId, deducted: deductible, balance: result.wallet.balance }, 'Wallet debited (clawback)')
      return { success: true, deducted: deductible, ...result }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId, amount }, 'Wallet clawback failed')
      return { success: false, message: 'Failed to deduct money: ' + err.message }
    } finally {
      client.release()
    }
  }

  /**
   * Pay for an order from wallet balance
   */
  async payFromWallet(userId, orderId) {
    const { walletEnabled } = await this.paymentSettingsService.getConfig()
    if (!walletEnabled) {
      return { success: false, message: 'Wallet payment is currently unavailable.' }
    }

    const order = await this.ordersRepo.findByIdAndUser(orderId, userId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    if (order.paymentMethod !== 'WALLET') {
      return { success: false, message: 'Order is not set for wallet payment' }
    }

    if (order.paymentStatus === 'PAID') {
      return { success: false, message: 'Order is already paid' }
    }

    const client = await getClient()

    try {
      await client.query('BEGIN')

      const wallet = await this.repo.getForUpdate(client, userId)
      if (!wallet) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Wallet not found' }
      }

      if (wallet.balance < order.totalAmount) {
        await client.query('ROLLBACK')
        return {
          success: false,
          message: `Insufficient balance. Need ₹${order.totalAmount}, have ₹${wallet.balance}`,
        }
      }

      const result = await this.repo.debit(
        client,
        wallet.id,
        order.totalAmount,
        `Payment for order ${order.orderNumber}`,
        order.id
      )

      await client.query('COMMIT')

      // Update order payment status
      await this.ordersRepo.updateStatus(orderId, 'CONFIRMED', {
        paymentStatus: 'PAID',
      })
      await this._queueAutoAssign(orderId, 'WALLET_PAY')

      // Credit any cashback whose trigger is PAYMENT_SUCCESS or
      // ORDER_CONFIRMED — wallet-pay satisfies both at the same moment.
      // Dynamic import avoids a circular dependency (cashback.service.js
      // imports WalletService).
      import('../cashback/cashback.service.js').then(({ CashbackService }) => {
        const cashbackService = new CashbackService()
        return Promise.all([
          cashbackService.evaluateAndCredit(orderId, 'PAYMENT_SUCCESS'),
          cashbackService.evaluateAndCredit(orderId, 'ORDER_CONFIRMED'),
        ])
      }).catch((err) => {
        logger.warn({ err: err.message, orderId }, 'Cashback evaluation failed (wallet pay)')
      })

      // Clear cart and send notification AFTER successful wallet deduction
      try {
        const { CartRepository } = await import('../cart/cart.repository.js')
        const cartRepo = new CartRepository()
        await cartRepo.clearCart(userId)
        await cartRepo.clearExtras(userId)
      } catch (cartErr) {
        logger.warn({ err: cartErr.message, userId }, 'Cart clear after wallet pay failed (non-critical)')
      }

      // Record coupon usage only now that the wallet deduction actually
      // succeeded — reported bug: a customer whose wallet payment never
      // completed still had their coupon immediately counted as used
      // (orders.service.js used to record this unconditionally at order
      // creation, before this confirmation step even ran).
      try {
        const { CouponsService } = await import('../coupons/coupons.service.js')
        const { CouponsRepository } = await import('../coupons/coupons.repository.js')
        await new CouponsService(new CouponsRepository()).recordUsageForOrder(orderId)
      } catch (couponErr) {
        logger.warn({ err: couponErr.message, orderId }, 'Coupon usage recording after wallet pay failed (non-critical)')
      }

      // Same deferred-confirmation reasoning for a matched payment offer's
      // per-user usage cap — see PaymentOffersService.recordUsageForOrder().
      try {
        const { PaymentOffersService } = await import('../payment-offers/payment-offers.service.js')
        await new PaymentOffersService().recordUsageForOrder(orderId)
      } catch (offerErr) {
        logger.warn({ err: offerErr.message, orderId }, 'Payment offer usage recording after wallet pay failed (non-critical)')
      }

      // Send "Order placed" notification only after confirmed payment
      try {
        const { NotificationsRepository } = await import('../notifications/notifications.repository.js')
        const { NotificationsService } = await import('../notifications/notifications.service.js')
        const { buildCustomerOrderEventNotification } = await import('../notifications/customer-order-event.helper.js')
        const notifService = new NotificationsService(new NotificationsRepository(), null)
        await notifService.sendNotification(userId, buildCustomerOrderEventNotification({
          orderId: order.id,
          orderNumber: order.orderNumber || order.order_number,
          timelineType: 'ORDER_PLACED',
          status: 'CONFIRMED',
        }))

        this.fastify?.emitDashboardNewOrder?.({
          id: order.id,
          order_number: order.orderNumber,
          total: order.totalAmount,
          payment_method: 'WALLET',
          delivery_mode: order.deliveryMode,
          created_at: order.createdAt,
        })
      } catch (notifErr) {
        logger.warn({ err: notifErr.message, orderId }, 'Notification after wallet pay failed (non-critical)')
      }

      logger.info(
        { userId, orderId, amount: order.totalAmount },
        'Wallet payment successful'
      )

      return { success: true, ...result }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId, orderId }, 'Wallet payment failed')
      return { success: false, message: 'Payment failed: ' + err.message }
    } finally {
      client.release()
    }
  }

  /**
   * Transaction-scoped debit for the wallet-balance-toggle checkout
   * feature. Unlike payFromWallet() above (which owns its own
   * BEGIN/COMMIT and runs the full order-confirmation cascade), this is a
   * narrow primitive: the caller already holds an open transaction and a
   * FOR UPDATE lock context (orders.service.js#placeOrder for the
   * immediate-debit case, payments.service.js#completeVerifiedPayment for
   * the deferred-remainder case) and is responsible for everything else.
   * Throws on missing wallet / insufficient balance — callers decide how
   * to handle that in their own transaction.
   */
  async debitForOrder(client, userId, { amount, orderId, orderNumber }) {
    const wallet = await this.repo.getForUpdate(client, userId)
    if (!wallet) {
      throw new Error('Wallet not found')
    }
    return this.repo.debit(
      client,
      wallet.id,
      amount,
      `Wallet payment for order ${orderNumber || orderId}`,
      orderId,
      // 'ORDER' is the only order-related value wallet_transactions'
      // chk_wallet_tx_sub_type CHECK constraint allows (migration
      // 068_first_time_offers_and_cashback.sql) — 'ORDER_PAYMENT' isn't in
      // that list and made every real debit through this method fail.
      { subType: 'ORDER', orderId }
    )
  }

  /**
   * Transfer money to another user by phone number
   */
  async transfer(userId, { phone, amount, description }) {
    const { minTransferAmount, maxTransferAmount, maxWalletBalance, transfersEnabled } =
      await this.walletSettingsService.getConfig()

    if (!transfersEnabled) {
      return { success: false, message: 'Wallet transfers are temporarily unavailable', code: 'WALLET_TRANSFERS_DISABLED' }
    }

    const recipient = await this.repo.findUserByPhone(phone)
    if (!recipient) {
      return { success: false, message: 'Recipient not found' }
    }

    if (recipient.id === userId) {
      return { success: false, message: 'Cannot transfer to yourself' }
    }

    if (amount < minTransferAmount) {
      return { success: false, message: `Minimum transfer amount is ₹${minTransferAmount}` }
    }
    if (amount > maxTransferAmount) {
      return { success: false, message: `Maximum transfer amount is ₹${maxTransferAmount}` }
    }

    const client = await getClient()

    try {
      await client.query('BEGIN')

      // Lock sender wallet
      const senderWallet = await this.repo.getForUpdate(client, userId)
      if (!senderWallet) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Wallet not found' }
      }

      if (senderWallet.balance < amount) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Insufficient balance' }
      }

      // Only never-expiring money can be sent to someone else; cashback and
      // prizes are for the customer who earned them.
      const expiringTotal = await this.repo.getExpiringTotal(client, senderWallet.id)
      const transferable = senderWallet.balance - expiringTotal
      if (transferable < amount) {
        await client.query('ROLLBACK')
        return {
          success: false,
          message: `Only ${formatMoney(Math.max(0, transferable))} of your wallet balance can be transferred — cashback and prizes can't be sent to others`,
        }
      }

      // Ensure recipient wallet exists
      await client.query(
        `INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
        [recipient.id]
      )

      // Lock recipient wallet
      const recipientWallet = await this.repo.getForUpdate(client, recipient.id)

      // Sender's own phone is looked up here (not passed in) so the
      // recipient's CREDIT description always shows a real, unspoofable
      // number — the display name is user-editable and changes over time,
      // so phone is the only identifier stable enough to rely on for
      // transaction history (mobile + admin dashboard both render this
      // description string verbatim).
      const sender = await this.repo.findUserById(userId)

      // Debit sender
      const senderResult = await this.repo.debit(
        client,
        senderWallet.id,
        amount,
        description || `Transfer to ${recipient.phone}`,
        `transfer:${recipient.id}`,
        { skipLots: true }
      )

      // Credit recipient
      await this.repo.credit(
        client,
        recipientWallet.id,
        amount,
        `Transfer from ${sender?.phone || 'user'}`,
        `transfer:${userId}`,
        { maxBalance: maxWalletBalance }
      )

      await client.query('COMMIT')

      logger.info(
        { from: userId, to: recipient.id, amount },
        'Wallet transfer successful'
      )

      return { success: true, ...senderResult }
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, userId, amount }, 'Wallet transfer failed')
      return { success: false, message: 'Transfer failed: ' + err.message }
    } finally {
      client.release()
    }
  }

  /**
   * Search users by phone number prefix, for the transfer recipient picker.
   */
  async searchRecipient(userId, q) {
    const { transfersEnabled } = await this.walletSettingsService.getConfig()
    if (!transfersEnabled) {
      return []
    }
    return this.repo.searchUsersByPhonePrefix(q, userId)
  }

  /**
   * Admin: credit a user's wallet (refunds, promotions, etc.)
   */
  /**
   * `isBonus: true` issues it as expiring promotional credit under the
   * admin's Expiry → "Admin bonus" rule (or `expiryDays` for this credit
   * alone); otherwise it is plain, never-expiring money.
   */
  async adminCredit(targetUserId, { amount, description, referenceId, isBonus, expiryDays }) {
    return this.addMoney(targetUserId, {
      amount,
      description: description || (isBonus ? 'Bonus credit' : 'Admin credit'),
      referenceId,
      subType: isBonus ? 'BONUS' : undefined,
      expirySource: isBonus ? 'ADMIN' : undefined,
      expiryDays: isBonus ? expiryDays : undefined,
    })
  }

  /**
   * Admin: debit (withdraw) money from a user's wallet. Unlike
   * deductMoney() (cashback clawback, which clamps to available balance),
   * this fails outright on insufficient funds — an admin manually deducting
   * money should get an explicit error, not a silent partial debit.
   */
  async adminDebit(targetUserId, { amount, description, referenceId }) {
    const client = await getClient()

    try {
      await client.query('BEGIN')

      const wallet = await this.repo.getForUpdate(client, targetUserId)
      if (!wallet) {
        await client.query('ROLLBACK')
        return { success: false, message: 'Wallet not found' }
      }

      const result = await this.repo.debit(
        client,
        wallet.id,
        amount,
        description || 'Amount deducted by company',
        referenceId
      )

      await client.query('COMMIT')

      logger.info({ userId: targetUserId, amount, balance: result.wallet.balance }, 'Wallet debited (admin)')
      return { success: true, ...result }
    } catch (err) {
      await client.query('ROLLBACK')
      if (err.message === 'Insufficient wallet balance') {
        return { success: false, message: 'Insufficient wallet balance' }
      }
      logger.error({ err, userId: targetUserId, amount }, 'Admin wallet debit failed')
      return { success: false, message: 'Failed to debit money: ' + err.message }
    } finally {
      client.release()
    }
  }

  /**
   * Admin: resolve a User ID or phone number to the matching user's basic
   * info — used by the Credit/Debit dialogs so an admin sees who they're
   * about to act on (name + phone) before submitting, instead of pasting
   * a bare UUID blind with no confirmation. Also carries the user's recent
   * actually-PAID order amounts, so the Credit dialog can warn when the
   * amount an admin is about to credit doesn't match any real paid order —
   * the mistake that lets a customer get refunded for an order that was
   * never actually paid for (e.g. a COD order cancelled before delivery,
   * or an ONLINE order whose payment window expired unpaid).
   */
  async resolveUser(input) {
    if (!input) return null
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)
    const isPhone = /^[6-9]\d{9}$/.test(input)
    const user = isUuid
      ? await this.repo.findUserById(input)
      : isPhone
        ? await this.repo.findUserByPhone(input)
        : null
    if (!user) return null

    const recentPaidOrders = await this.repo.getRecentPaidOrderAmounts(user.id)
    return { ...user, recentPaidOrders }
  }

  /**
   * Admin: get wallet overview statistics
   */
  async getAdminStats() {
    const { query: dbQuery } = await import('../../config/database.js')

    const balanceRes = await dbQuery('SELECT COALESCE(SUM(balance), 0) AS total_balance FROM wallets')
    const creditRes = await dbQuery(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_transactions WHERE type = 'CREDIT' AND COALESCE(status, 'COMPLETED') = 'COMPLETED'"
    )
    const debitRes = await dbQuery(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_transactions WHERE type = 'DEBIT' AND COALESCE(status, 'COMPLETED') = 'COMPLETED'"
    )
    const refundRes = await dbQuery(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_transactions WHERE type = 'CREDIT' AND description ILIKE '%refund%' AND COALESCE(status, 'COMPLETED') = 'COMPLETED'"
    )

    const expiryStats = await this.repo.getExpiryStats()

    return {
      totalBalance: parseFloat(balanceRes.rows[0].total_balance),
      totalAdded: parseFloat(creditRes.rows[0].total),
      totalUsed: parseFloat(debitRes.rows[0].total),
      totalRefunded: parseFloat(refundRes.rows[0].total),
      ...expiryStats,
    }
  }

  async _queueAutoAssign(orderId, source = 'WALLET_SERVICE') {
    try {
      await orderQueue.add(
        'auto-assign',
        {
          type: 'auto-assign',
          orderId,
          source,
        },
        {
          jobId: `auto-assign-${orderId}`,
          removeOnComplete: true,
        }
      )
      if (INLINE_AUTO_ASSIGN_IN_NON_PROD) {
        await this._runAutoAssignFallback(orderId, `${source}_DEV_INLINE`)
      }
    } catch (err) {
      logger.warn({ err, orderId, source }, 'Failed to queue auto-assign job')
      await this._runAutoAssignFallback(orderId, source)
    }
  }

  async _runAutoAssignFallback(orderId, source) {
    try {
      const { processOrderJob } = await import('../../workers/processors.js')
      await processOrderJob({
        data: {
          type: 'auto-assign',
          orderId,
          source: `${source}_INLINE_FALLBACK`,
        },
      })
      logger.info({ orderId, source }, 'Inline auto-assign fallback executed')
    } catch (fallbackErr) {
      logger.error(
        { err: fallbackErr, orderId, source },
        'Inline auto-assign fallback failed'
      )
    }
  }
}
