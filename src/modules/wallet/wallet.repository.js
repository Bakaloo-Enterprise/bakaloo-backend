import { query, getClient } from '../../config/database.js'
import { LOT_SOURCES, expiryDescription } from './wallet-lots.js'

/**
 * Wallet repository — SQL queries for wallets + wallet_transactions
 * Uses SELECT ... FOR UPDATE row locking for balance operations
 */
export class WalletRepository {
  /**
   * Get or create wallet for a user
   */
  async getOrCreate(userId) {
    // Try to find existing wallet
    let { rows } = await query(
      `SELECT * FROM wallets WHERE user_id = $1`,
      [userId]
    )

    if (rows[0]) return this._formatWallet(rows[0])

    // Create wallet
    const result = await query(
      `INSERT INTO wallets (user_id, balance) VALUES ($1, 0)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [userId]
    )
    return this._formatWallet(result.rows[0])
  }

  /**
   * Get wallet with FOR UPDATE lock (for transaction use)
   */
  async getForUpdate(client, userId) {
    const { rows } = await client.query(
      `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId]
    )
    if (!rows[0]) return null
    // Every credit/debit path locks the wallet through here, so sweeping
    // lapsed credits at this point guarantees an expired bonus can never be
    // spent or counted towards a balance check, even if the periodic worker
    // hasn't reached it yet.
    const swept = await this._expireDueLots(client, rows[0])
    return this._formatWallet(swept || rows[0])
  }

  /**
   * Credit wallet (add money) within a transaction
   * Returns { wallet, transaction }
   *
   * When `maxBalance` is given, the UPDATE only applies if the resulting
   * balance would stay within it — an atomic guard (mirrors debit()'s
   * `WHERE balance >= $1`) so the cap holds even under concurrent credits,
   * not just whatever a caller checked before opening the transaction.
   */
  async credit(
    client,
    walletId,
    amount,
    description,
    referenceId,
    { maxBalance, subType, sourceId, orderId, expiresAt, lotSource } = {}
  ) {
    const params = [amount, walletId]
    let sql = `UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2`
    if (maxBalance != null) {
      sql += ` AND balance + $1 <= $3`
      params.push(maxBalance)
    }
    sql += ` RETURNING *`

    const { rows: walletRows } = await client.query(sql, params)

    if (walletRows.length === 0) {
      throw new Error('Wallet balance limit exceeded')
    }

    const wallet = this._formatWallet(walletRows[0])

    // Record transaction
    const { rows: txRows } = await client.query(
      `INSERT INTO wallet_transactions
         (wallet_id, type, amount, description, reference_id, balance_after, sub_type, source_id, order_id, expires_at)
       VALUES ($1, 'CREDIT', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        walletId,
        amount,
        description || 'Credit',
        referenceId || null,
        wallet.balance,
        subType || null,
        sourceId || null,
        orderId || null,
        expiresAt || null,
      ]
    )
    const transaction = this._formatTransaction(txRows[0])

    // An expiring credit also gets a lot, which is what the debit path
    // spends from and the expiry sweep later removes.
    if (expiresAt) {
      if (!LOT_SOURCES.includes(lotSource)) {
        throw new Error(`Invalid wallet lot source: ${lotSource}`)
      }
      await client.query(
        `INSERT INTO wallet_credit_lots
           (wallet_id, user_id, source_type, original_amount, remaining_amount,
            expires_at, credit_tx_id, source_id)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7)`,
        [walletId, wallet.userId, lotSource, amount, expiresAt, transaction.id, sourceId || null]
      )
    }

    return { wallet, transaction }
  }

  /**
   * Debit wallet (deduct money) within a transaction
   * Returns { wallet, transaction }
   */
  async debit(client, walletId, amount, description, referenceId, { subType, sourceId, orderId, preferLotSourceId, skipLots } = {}) {
    // Update balance (CHECK constraint enforces >= 0)
    const { rows: walletRows } = await client.query(
      `UPDATE wallets SET balance = balance - $1, updated_at = NOW()
       WHERE id = $2 AND balance >= $1 RETURNING *`,
      [amount, walletId]
    )

    if (walletRows.length === 0) {
      throw new Error('Insufficient wallet balance')
    }

    const wallet = this._formatWallet(walletRows[0])

    // Record transaction
    const { rows: txRows } = await client.query(
      `INSERT INTO wallet_transactions
         (wallet_id, type, amount, description, reference_id, balance_after, sub_type, source_id, order_id)
       VALUES ($1, 'DEBIT', $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        walletId,
        amount,
        description || 'Debit',
        referenceId || null,
        wallet.balance,
        subType || null,
        sourceId || null,
        orderId || null,
      ]
    )
    const transaction = this._formatTransaction(txRows[0])

    // Pay from expiring credits first (soonest expiry first) so a customer
    // always uses bonus money before the money they topped up themselves.
    // `skipLots` is for money that must come out of permanent balance only
    // (wallet-to-wallet transfers: bonus can't be turned into transferable cash).
    if (!skipLots) {
      await this._consumeLots(client, walletId, amount, transaction.id, orderId, preferLotSourceId)
    }

    return { wallet, transaction }
  }

  /**
   * Get wallet transactions (paginated)
   */
  async getTransactions(walletId, { limit, offset, type }) {
    const conditions = ["wallet_id = $1", "COALESCE(status, 'COMPLETED') = 'COMPLETED'"]
    const params = [walletId]
    let idx = 2

    if (type) {
      conditions.push(`type = $${idx++}`)
      params.push(type)
    }

    const where = conditions.join(' AND ')

    const countResult = await query(
      `SELECT COUNT(*) FROM wallet_transactions WHERE ${where}`,
      params
    )

    const { rows } = await query(
      `SELECT * FROM wallet_transactions
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    )

    return {
      transactions: rows.map(this._formatTransaction),
      total: parseInt(countResult.rows[0].count, 10),
    }
  }

  /**
   * Create a pending wallet top-up transaction before Razorpay payment succeeds
   */
  async createPendingTopUp(walletId, { amount, razorpayOrderId, description }) {
    const { rows } = await query(
      `INSERT INTO wallet_transactions
         (wallet_id, type, amount, description, reference_id, status)
       VALUES ($1, 'CREDIT', $2, $3, $4, 'PENDING')
       RETURNING *`,
      [walletId, amount, description || 'Wallet top-up', razorpayOrderId]
    )

    return this._formatTransaction(rows[0])
  }

  /**
   * Find a wallet top-up transaction by Razorpay order ID and lock it for update
   */
  async findTopUpByOrderIdForUpdate(client, razorpayOrderId) {
    const { rows } = await client.query(
      `SELECT wt.*, w.user_id
       FROM wallet_transactions wt
       JOIN wallets w ON w.id = wt.wallet_id
       WHERE wt.reference_id = $1
         AND wt.type = 'CREDIT'
       ORDER BY wt.created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [razorpayOrderId]
    )

    return rows[0] ? this._formatTransaction(rows[0]) : null
  }

  /**
   * Apply a verified pending top-up to the wallet and complete the ledger entry
   */
  async applyPendingTopUp(client, walletId, topupId, amount) {
    const { rows: walletRows } = await client.query(
      `UPDATE wallets
       SET balance = balance + $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [amount, walletId]
    )
    const wallet = this._formatWallet(walletRows[0])

    const { rows: txRows } = await client.query(
      `UPDATE wallet_transactions
       SET status = 'COMPLETED', balance_after = $2
       WHERE id = $1
       RETURNING *`,
      [topupId, wallet.balance]
    )
    const transaction = this._formatTransaction(txRows[0])

    return { wallet, transaction }
  }

  /**
   * Mark a pending top-up as failed after signature verification fails
   */
  async markTopUpFailed(client, topupId) {
    const { rows } = await client.query(
      `UPDATE wallet_transactions
       SET status = 'FAILED'
       WHERE id = $1
       RETURNING *`,
      [topupId]
    )

    return rows[0] ? this._formatTransaction(rows[0]) : null
  }

  /**
   * Reconciliation worker only: mark a long-abandoned pending top-up as
   * FAILED after confirming with Razorpay that no payment was ever
   * captured for it — cleans it out of admin views without ever touching
   * a row that might still be genuinely in-flight. Self-contained (opens
   * its own short transaction) since the worker calls this standalone,
   * not as part of a larger unit of work.
   */
  async markStalePendingAsFailed(razorpayOrderId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `UPDATE wallet_transactions
         SET status = 'FAILED'
         WHERE reference_id = $1 AND type = 'CREDIT' AND status = 'PENDING'
         RETURNING *`,
        [razorpayOrderId]
      )
      await client.query('COMMIT')
      return rows[0] ? this._formatTransaction(rows[0]) : null
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Find user by phone number (for transfers)
   */
  async findUserByPhone(phone) {
    const { rows } = await query(
      `SELECT id, name, phone FROM users WHERE phone = $1 AND is_active = true`,
      [phone]
    )
    return rows[0] || null
  }

  /**
   * Find user by id (for transfers — looking up the sender's own phone to
   * stamp on the recipient's CREDIT transaction description).
   */
  async findUserById(id) {
    const { rows } = await query(
      `SELECT id, name, phone FROM users WHERE id = $1`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Search users by phone number prefix (for the recipient picker).
   * Left-anchored LIKE so it's servable by an index (idx_users_phone /
   * idx_users_phone_pattern) instead of scanning the whole users table.
   */
  async searchUsersByPhonePrefix(prefix, excludeUserId, limit = 8) {
    const { rows } = await query(
      `SELECT id, name, phone FROM users
       WHERE phone LIKE $1 || '%' AND is_active = true AND is_blocked = false AND id != $2
       ORDER BY phone
       LIMIT $3`,
      [prefix, excludeUserId, limit]
    )
    return rows
  }

  /**
   * A user's most recent orders that were actually paid for — powers the
   * Credit Wallet dialog's "does this amount match a real paid order"
   * warning, so an admin refunding/compensating a customer can see at a
   * glance whether the order they have in mind was ever actually paid
   * (as opposed to a COD order that was cancelled before cash changed
   * hands, or an ONLINE order whose payment window simply expired).
   */
  async getRecentPaidOrderAmounts(userId, limit = 10) {
    const { rows } = await query(
      `SELECT order_number, total_amount
       FROM orders
       WHERE user_id = $1 AND payment_status = 'PAID'
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    )
    return rows.map((r) => ({ orderNumber: r.order_number, amount: parseFloat(r.total_amount) }))
  }

  /**
   * Get ALL wallet transactions across all users (admin view)
   * Joins users table to show customer info
   */
  async getAdminTransactions({ limit, offset, type, userId }) {
    const conditions = []
    const params = []
    let idx = 1

    if (userId) {
      conditions.push(`w.user_id = $${idx++}`)
      params.push(userId)
    }
    if (type) {
      conditions.push(`wt.type = $${idx++}`)
      params.push(type)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countResult = await query(
      `SELECT COUNT(*) FROM wallet_transactions wt
       JOIN wallets w ON w.id = wt.wallet_id
       ${where}`,
      params
    )

    const { rows } = await query(
      `SELECT wt.*, w.user_id, u.name AS user_name, u.phone AS user_phone
       FROM wallet_transactions wt
       JOIN wallets w ON w.id = wt.wallet_id
       LEFT JOIN users u ON u.id = w.user_id
       ${where}
       ORDER BY wt.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    )

    return {
      transactions: rows.map(r => ({
        ...this._formatTransaction(r),
        userId: r.user_id,
        userName: r.user_name,
        userPhone: r.user_phone,
      })),
      total: parseInt(countResult.rows[0].count, 10),
    }
  }

  /**
   * Format wallet row
   */
  _formatWallet(row) {
    return {
      id: row.id,
      userId: row.user_id,
      balance: parseFloat(row.balance),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Format transaction row
   */
  _formatTransaction(row) {
    return {
      id: row.id,
      walletId: row.wallet_id,
      userId: row.user_id ?? null,
      type: row.type,
      subType: row.sub_type ?? null,
      amount: parseFloat(row.amount),
      description: row.description,
      referenceId: row.reference_id,
      sourceId: row.source_id ?? null,
      orderId: row.order_id ?? null,
      balanceAfter: row.balance_after != null ? parseFloat(row.balance_after) : null,
      status: row.status || 'COMPLETED',
      expiresAt: row.expires_at ?? null,
      createdAt: row.created_at,
    }
  }

  // ─── Expiring credits (wallet_credit_lots) ───────────────────────────

  /**
   * Take `amount` out of ACTIVE lots, `preferLotSourceId`'s lot first and
   * then soonest-expiry first. Whatever the lots can't cover came out of
   * permanent money, which needs no bookkeeping. Caller holds the wallet
   * row lock.
   */
  async _consumeLots(client, walletId, amount, walletTxId, orderId, preferLotSourceId) {
    let need = Math.round(Number(amount) * 100)
    if (need <= 0) return 0

    const { rows: lots } = await client.query(
      `SELECT id, remaining_amount FROM wallet_credit_lots
       WHERE wallet_id = $1 AND status = 'ACTIVE' AND remaining_amount > 0 AND expires_at > NOW()
       ORDER BY COALESCE(source_id = $2::uuid, false) DESC, expires_at ASC, created_at ASC
       FOR UPDATE`,
      [walletId, preferLotSourceId || null]
    )

    let consumed = 0
    for (const lot of lots) {
      if (need <= 0) break
      const available = Math.round(parseFloat(lot.remaining_amount) * 100)
      const take = Math.min(available, need)
      if (take <= 0) continue
      const takeAmount = take / 100

      await client.query(
        `UPDATE wallet_credit_lots
         SET remaining_amount = remaining_amount - $2,
             status = CASE WHEN remaining_amount - $2 <= 0 THEN 'EXHAUSTED' ELSE status END,
             updated_at = NOW()
         WHERE id = $1`,
        [lot.id, takeAmount]
      )
      await client.query(
        `INSERT INTO wallet_lot_consumptions (lot_id, wallet_tx_id, order_id, amount)
         VALUES ($1, $2, $3, $4)`,
        [lot.id, walletTxId, orderId || null, takeAmount]
      )
      need -= take
      consumed += take
    }
    return consumed / 100
  }

  /**
   * Give an order's bonus money back to the lots it was taken from when the
   * order is cancelled/refunded, instead of turning it into never-expiring
   * balance. Only the part that can still be used (lot not yet expired)
   * goes back into a lot; the rest simply stays as the permanent credit the
   * refund already made. Returns the amount restored into lots. Caller holds
   * the wallet row lock and has already credited `refundAmount`.
   */
  async restoreLotsForOrder(client, walletId, orderId, refundAmount) {
    let budget = Math.round(Number(refundAmount) * 100)
    if (budget <= 0 || !orderId) return 0

    const { rows } = await client.query(
      `SELECT c.id, c.lot_id, c.amount, c.restored_amount, l.status, l.expires_at
       FROM wallet_lot_consumptions c
       JOIN wallet_credit_lots l ON l.id = c.lot_id
       WHERE c.order_id = $1 AND l.wallet_id = $2 AND c.restored_amount < c.amount
       ORDER BY c.created_at ASC
       FOR UPDATE OF c, l`,
      [orderId, walletId]
    )

    let restored = 0
    for (const row of rows) {
      if (budget <= 0) break
      // Already-lapsed bonus stays gone; this refund keeps its permanent value.
      if (row.status === 'EXPIRED' || new Date(row.expires_at) <= new Date()) continue
      const open = Math.round((parseFloat(row.amount) - parseFloat(row.restored_amount)) * 100)
      const give = Math.min(open, budget)
      if (give <= 0) continue
      const giveAmount = give / 100

      await client.query(
        `UPDATE wallet_lot_consumptions SET restored_amount = restored_amount + $2 WHERE id = $1`,
        [row.id, giveAmount]
      )
      await client.query(
        `UPDATE wallet_credit_lots
         SET remaining_amount = remaining_amount + $2, status = 'ACTIVE', updated_at = NOW()
         WHERE id = $1`,
        [row.lot_id, giveAmount]
      )
      budget -= give
      restored += give
    }
    return restored / 100
  }

  /**
   * Remove every lapsed ACTIVE lot of a wallet from its balance and write
   * one DEBIT 'EXPIRY' history row per lot. Caller holds the wallet lock.
   * Returns the updated wallet row, or null when nothing was due.
   */
  async _expireDueLots(client, walletRow) {
    const { rows: due } = await client.query(
      `SELECT * FROM wallet_credit_lots
       WHERE wallet_id = $1 AND status = 'ACTIVE' AND expires_at <= NOW()
       ORDER BY expires_at ASC
       FOR UPDATE`,
      [walletRow.id]
    )
    if (due.length === 0) return null

    let current = walletRow
    for (const lot of due) {
      const remaining = parseFloat(lot.remaining_amount)
      if (remaining <= 0) {
        await client.query(
          `UPDATE wallet_credit_lots SET status = 'EXHAUSTED', updated_at = NOW() WHERE id = $1`,
          [lot.id]
        )
        continue
      }

      // balance = permanent + active lots, so the balance always covers a lot.
      const { rows: walletRows } = await client.query(
        `UPDATE wallets SET balance = balance - $1, updated_at = NOW()
         WHERE id = $2 AND balance >= $1 RETURNING *`,
        [remaining, walletRow.id]
      )
      if (walletRows.length === 0) {
        throw new Error(`Wallet ${walletRow.id} balance is below its expiring credit ${lot.id}`)
      }
      current = walletRows[0]

      const { rows: txRows } = await client.query(
        `INSERT INTO wallet_transactions
           (wallet_id, type, amount, description, reference_id, balance_after, sub_type, source_id)
         VALUES ($1, 'DEBIT', $2, $3, $4, $5, 'EXPIRY', $6)
         RETURNING id`,
        [
          walletRow.id,
          remaining,
          expiryDescription({
            sourceType: lot.source_type,
            originalAmount: lot.original_amount,
            remaining,
            expiresAt: lot.expires_at,
          }),
          `expiry:${lot.id}`,
          current.balance,
          lot.id,
        ]
      )
      await client.query(
        `UPDATE wallet_credit_lots
         SET status = 'EXPIRED', expired_amount = $2, expired_at = NOW(),
             expired_tx_id = $3, remaining_amount = 0, updated_at = NOW()
         WHERE id = $1`,
        [lot.id, remaining, txRows[0].id]
      )
    }
    return current
  }

  /**
   * Expire one wallet's lapsed lots in its own short transaction — used by
   * the periodic worker and by the balance read path. SKIP LOCKED: a wallet
   * mid-payment is left for the next pass (or for that payment's own
   * getForUpdate sweep) instead of blocking behind it.
   */
  async expireDueForWallet(walletId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT * FROM wallets WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [walletId]
      )
      const swept = rows[0] ? await this._expireDueLots(client, rows[0]) : null
      await client.query('COMMIT')
      return swept ? this._formatWallet(swept) : null
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async hasDueLots(walletId) {
    const { rows } = await query(
      `SELECT 1 FROM wallet_credit_lots
       WHERE wallet_id = $1 AND status = 'ACTIVE' AND expires_at <= NOW() LIMIT 1`,
      [walletId]
    )
    return rows.length > 0
  }

  /** Wallets that have at least one lapsed lot, for the worker's sweep. */
  async findWalletsWithDueLots(limit = 200) {
    const { rows } = await query(
      `SELECT DISTINCT wallet_id FROM wallet_credit_lots
       WHERE status = 'ACTIVE' AND expires_at <= NOW()
       LIMIT $1`,
      [limit]
    )
    return rows.map((r) => r.wallet_id)
  }

  /** Still-usable credits of a wallet, soonest expiry first. */
  async getActiveLots(walletId) {
    const { rows } = await query(
      `SELECT id, source_type, original_amount, remaining_amount, expires_at, created_at
       FROM wallet_credit_lots
       WHERE wallet_id = $1 AND status = 'ACTIVE' AND remaining_amount > 0 AND expires_at > NOW()
       ORDER BY expires_at ASC, created_at ASC`,
      [walletId]
    )
    return rows.map((r) => ({
      id: r.id,
      sourceType: r.source_type,
      originalAmount: parseFloat(r.original_amount),
      remainingAmount: parseFloat(r.remaining_amount),
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    }))
  }

  /** Sum of the wallet's still-usable expiring credits (inside a transaction). */
  async getExpiringTotal(client, walletId) {
    const { rows } = await client.query(
      `SELECT COALESCE(SUM(remaining_amount), 0) AS total FROM wallet_credit_lots
       WHERE wallet_id = $1 AND status = 'ACTIVE' AND remaining_amount > 0`,
      [walletId]
    )
    return parseFloat(rows[0].total)
  }

  /**
   * Worker: atomically claim expiry notifications that haven't been sent.
   * The UPDATE ... SKIP LOCKED claim means two API processes never both
   * pick the same lot.
   */
  async claimExpiredNotifications(limit = 100) {
    const { rows } = await query(
      `UPDATE wallet_credit_lots SET expired_notified_at = NOW()
       WHERE id IN (
         SELECT id FROM wallet_credit_lots
         WHERE status = 'EXPIRED' AND expired_notified_at IS NULL
         ORDER BY expired_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, user_id, source_type, original_amount, expired_amount, expires_at`,
      [limit]
    )
    return rows
  }

  /**
   * Worker: claim "about to expire" reminders. Only lots whose total
   * validity was longer than the reminder window qualify, so a short-lived
   * credit doesn't get a "expires soon" nudge the moment it is issued.
   */
  async claimExpiryReminders(reminderDays, limit = 100) {
    if (!(reminderDays > 0)) return []
    const { rows } = await query(
      `UPDATE wallet_credit_lots SET reminder_sent_at = NOW()
       WHERE id IN (
         SELECT id FROM wallet_credit_lots
         WHERE status = 'ACTIVE' AND remaining_amount > 0 AND reminder_sent_at IS NULL
           AND expires_at > NOW()
           AND expires_at <= NOW() + make_interval(days => $1::int)
           AND expires_at - created_at > make_interval(days => $1::int)
         ORDER BY expires_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, user_id, source_type, remaining_amount, expires_at`,
      [reminderDays, limit]
    )
    return rows
  }

  /** Admin: expiry numbers for the wallet overview cards. */
  async getExpiryStats() {
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(remaining_amount) FILTER (WHERE status = 'ACTIVE' AND expires_at > NOW()), 0) AS expiring_balance,
         COALESCE(SUM(remaining_amount) FILTER (
           WHERE status = 'ACTIVE' AND expires_at > NOW() AND expires_at <= NOW() + INTERVAL '7 days'), 0) AS expiring_7d,
         COALESCE(SUM(expired_amount) FILTER (WHERE status = 'EXPIRED'), 0) AS total_expired,
         COALESCE(SUM(expired_amount) FILTER (
           WHERE status = 'EXPIRED' AND expired_at >= NOW() - INTERVAL '30 days'), 0) AS expired_30d
       FROM wallet_credit_lots`
    )
    const r = rows[0]
    return {
      expiringBalance: parseFloat(r.expiring_balance),
      expiringIn7Days: parseFloat(r.expiring_7d),
      totalExpired: parseFloat(r.total_expired),
      expiredLast30Days: parseFloat(r.expired_30d),
    }
  }
}
