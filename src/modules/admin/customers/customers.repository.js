import { query, getClient } from '../../../config/database.js'

export class AdminCustomersRepository {
  async findAll({ offset, limit, search, status, segment, sortBy = 'created_at', sortOrder = 'DESC' }) {
    const params = []
    // A user who registered as a customer and later also signed up as a
    // rider (via OTP in the rider app, which overwrites users.role to
    // 'RIDER') must still show up here — they can place orders regardless
    // of which app they most recently logged into. Anyone with real order
    // history counts as a customer even if role now reads 'RIDER'.
    const clauses = [`(u.role = 'CUSTOMER' OR EXISTS (SELECT 1 FROM orders eo WHERE eo.user_id = u.id))`]
    let idx = 1

    if (search) {
      clauses.push(`(u.name ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.email ILIKE $${idx})`)
      params.push(`%${search}%`)
      idx++
    }
    if (status === 'active') { clauses.push('u.is_active = true AND u.is_blocked IS NOT TRUE') }
    else if (status === 'blocked') { clauses.push('u.is_blocked = true') }
    else if (status === 'inactive') { clauses.push('u.is_active = false') }

    // Mirrors the dashboard's own VIP/Churned badge logic (10+ orders or
    // ₹10k+ spent for VIP; 60+ days since the last of 2+ orders for
    // Churned) so the segment filter agrees with what's shown on-screen.
    // Needs the o_stats join below in every query that uses `where`, since
    // it references o_stats columns.
    if (segment === 'vip') {
      clauses.push(`(COALESCE(o_stats.order_count, 0) >= 10 OR COALESCE(o_stats.total_spent, 0) >= 10000)`)
    } else if (segment === 'churned') {
      clauses.push(`(o_stats.last_order_at IS NOT NULL AND o_stats.last_order_at < NOW() - INTERVAL '60 days' AND COALESCE(o_stats.order_count, 0) >= 2)`)
    }

    const allowedSort = { created_at: 'u.created_at', name: 'u.name', orders: 'order_count', spent: 'total_spent' }
    const orderCol = allowedSort[sortBy] || 'u.created_at'
    const dir = sortOrder === 'ASC' ? 'ASC' : 'DESC'
    const where = clauses.join(' AND ')
    const statsJoin = `LEFT JOIN (
         SELECT user_id, COUNT(*)::int AS order_count, SUM(total_amount) AS total_spent, MAX(created_at) AS last_order_at
         FROM orders WHERE status != 'CANCELLED' GROUP BY user_id
       ) o_stats ON o_stats.user_id = u.id`

    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, u.email, u.avatar_url, u.is_active, u.is_blocked, u.created_at,
              u.loyalty_points, COALESCE(w.balance, 0) AS wallet_balance,
              COALESCE(o_stats.order_count, 0)::int AS order_count,
              COALESCE(o_stats.total_spent, 0) AS total_spent,
              o_stats.last_order_at
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       ${statsJoin}
       WHERE ${where}
       ORDER BY ${orderCol} ${dir} NULLS LAST
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )

    const countRes = await query(
      `SELECT COUNT(*)::int AS total FROM users u ${statsJoin} WHERE ${where}`,
      params
    )

    // Real daily-active count — anyone matching the current filters who has
    // made an authenticated request today (stamped by the `authenticate`
    // preHandler). "Today" is the IST calendar day (00:00-23:59:59 IST),
    // not a rolling 24h window, so a customer who opens the app several
    // times in one day is still only counted once — and the count resets
    // at midnight IST rather than 24h after their last visit. Replaces
    // the old client-side "not blocked" proxy the dashboard used to show
    // as "Active".
    const activeTodayRes = await query(
      `SELECT COUNT(*)::int AS active_today FROM users u ${statsJoin}
       WHERE ${where} AND (u.last_active_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
      params
    )

    const total = countRes.rows[0].total
    const page = Math.floor(offset / limit) + 1

    return {
      customers: rows.map(r => ({
        ...r,
        wallet_balance: parseFloat(r.wallet_balance || 0),
        total_spent: parseFloat(r.total_spent || 0),
      })),
      activeToday: activeTodayRes.rows[0].active_today,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  /** Bulk-resolve customers by phone number — used by segment Excel/CSV import,
   *  which matches on number only since it's the one field guaranteed unique. */
  async findByPhones(phones) {
    if (!phones?.length) return []
    const { rows } = await query(
      `SELECT u.id, u.phone, u.name
       FROM users u
       WHERE u.phone = ANY($1::text[])
         AND (u.role = 'CUSTOMER' OR EXISTS (SELECT 1 FROM orders eo WHERE eo.user_id = u.id))`,
      [phones]
    )
    return rows
  }

  async userName(id) {
    const { rows } = await query(`SELECT name FROM users WHERE id = $1`, [id])
    return rows[0]?.name ?? null
  }

  /** Notifications this customer received, newest first. personal = only staff-to-customer messages. */
  async notificationHistory(userId, { personal, limit }) {
    const { rows } = await query(
      `SELECT id, title, body, type, data, is_read, read_at, created_at FROM notifications
        WHERE user_id = $1 AND ($2::boolean = false OR type = 'ADMIN_MESSAGE') ORDER BY created_at DESC LIMIT $3`,
      [userId, personal, limit])
    return rows
  }

  async findById(id) {
    const { rows: [customer] } = await query(
      `SELECT u.*, COALESCE(w.balance, 0) AS wallet_balance,
              COALESCE(o_stats.order_count, 0)::int AS order_count,
              COALESCE(o_stats.total_spent, 0) AS total_spent,
              COALESCE(o_stats.avg_order, 0) AS avg_order_value,
              o_stats.last_order_at,
              COALESCE(o_status.completed_orders, 0)::int AS completed_orders,
              COALESCE(o_status.cancelled_orders, 0)::int AS cancelled_orders,
              COALESCE(o_status.returned_orders, 0)::int AS returned_orders
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*)::int AS order_count, SUM(total_amount) AS total_spent,
                AVG(total_amount) AS avg_order, MAX(created_at) AS last_order_at
         FROM orders WHERE status != 'CANCELLED' GROUP BY user_id
       ) o_stats ON o_stats.user_id = u.id
       LEFT JOIN (
         -- Quick reliability signal for admins reviewing a customer/order:
         -- how many of their orders actually completed vs. were cancelled
         -- or refunded (a "return" — there's no distinct RETURNED status,
         -- an order marked REFUNDED post-delivery is what a return is).
         SELECT user_id,
                COUNT(*) FILTER (WHERE status = 'DELIVERED')::int AS completed_orders,
                COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled_orders,
                COUNT(*) FILTER (WHERE status = 'REFUNDED')::int AS returned_orders
         FROM orders GROUP BY user_id
       ) o_status ON o_status.user_id = u.id
       WHERE u.id = $1 AND (u.role = 'CUSTOMER' OR EXISTS (SELECT 1 FROM orders eo WHERE eo.user_id = u.id))`,
      [id]
    )
    if (!customer) return null
    return {
      ...customer,
      wallet_balance: parseFloat(customer.wallet_balance || 0),
      total_spent: parseFloat(customer.total_spent || 0),
      avg_order_value: parseFloat(customer.avg_order_value || 0),
    }
  }

  async getCustomerOrders(customerId, { offset, limit }) {
    const { rows } = await query(
      `SELECT id, order_number, status, total_amount, payment_method, created_at
       FROM orders WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [customerId, limit, offset]
    )
    const countRes = await query('SELECT COUNT(*)::int AS total FROM orders WHERE user_id = $1', [customerId])
    const total = countRes.rows[0].total
    const page = Math.floor(offset / limit) + 1
    return {
      orders: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    }
  }

  /**
   * Returns every address a customer has ever saved, active ones first
   * (default first, then newest), followed by soft-deleted ones (newest
   * removal first) — admins need to see recently-removed addresses too,
   * for delivery-dispute/security review during their retention window
   * (see ADDRESS_RETENTION_DAYS).
   */
  async getCustomerAddresses(customerId) {
    const { rows } = await query(
      `SELECT * FROM addresses
        WHERE user_id = $1
        ORDER BY (deleted_at IS NULL) DESC, is_default DESC, COALESCE(deleted_at, created_at) DESC`,
      [customerId]
    )
    return rows
  }

  async getLTV() {
    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, u.email, u.created_at,
              COALESCE(o.total_spent, 0) AS ltv,
              COALESCE(o.order_count, 0)::int AS order_count,
              COALESCE(o.avg_order, 0) AS avg_order_value,
              EXTRACT(EPOCH FROM (NOW() - u.created_at)) / 86400 AS days_since_signup
       FROM users u
       LEFT JOIN (
         SELECT user_id, SUM(total_amount) AS total_spent, COUNT(*)::int AS order_count, AVG(total_amount) AS avg_order
         FROM orders WHERE status = 'DELIVERED' GROUP BY user_id
       ) o ON o.user_id = u.id
       WHERE (u.role = 'CUSTOMER' OR EXISTS (SELECT 1 FROM orders eo WHERE eo.user_id = u.id))
       ORDER BY ltv DESC NULLS LAST
       LIMIT 100`
    )
    return rows.map(r => ({
      ...r,
      ltv: parseFloat(r.ltv),
      avg_order_value: parseFloat(r.avg_order_value),
      days_since_signup: Math.floor(parseFloat(r.days_since_signup)),
    }))
  }

  async getChurned(days = 30) {
    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, u.email,
              o.last_order_at, o.order_count::int, COALESCE(o.total_spent, 0) AS total_spent
       FROM users u
       JOIN (
         SELECT user_id, MAX(created_at) AS last_order_at, COUNT(*)::int AS order_count, SUM(total_amount) AS total_spent
         FROM orders WHERE status = 'DELIVERED' GROUP BY user_id HAVING COUNT(*) >= 2
       ) o ON o.user_id = u.id
       WHERE (u.role = 'CUSTOMER' OR EXISTS (SELECT 1 FROM orders eo WHERE eo.user_id = u.id)) AND u.is_active = true
         AND o.last_order_at < NOW() - make_interval(days => $1)
       ORDER BY o.total_spent DESC`,
      [days]
    )
    return rows.map(r => ({ ...r, total_spent: parseFloat(r.total_spent) }))
  }

  async getVIP(minOrders = 10) {
    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, u.email, u.loyalty_points,
              COALESCE(w.balance, 0) AS wallet_balance,
              o.order_count::int, COALESCE(o.total_spent, 0) AS total_spent,
              COALESCE(o.avg_order, 0) AS avg_order_value, o.last_order_at
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       JOIN (
         SELECT user_id, COUNT(*)::int AS order_count, SUM(total_amount) AS total_spent,
                AVG(total_amount) AS avg_order, MAX(created_at) AS last_order_at
         FROM orders WHERE status = 'DELIVERED' GROUP BY user_id HAVING COUNT(*) >= $1
       ) o ON o.user_id = u.id
       WHERE (u.role = 'CUSTOMER' OR EXISTS (SELECT 1 FROM orders eo WHERE eo.user_id = u.id)) AND u.is_active = true
       ORDER BY o.total_spent DESC`,
      [minOrders]
    )
    return rows.map(r => ({ ...r, total_spent: parseFloat(r.total_spent), avg_order_value: parseFloat(r.avg_order_value) }))
  }

  async creditWallet(userId, amount, description) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows: [wallet] } = await client.query(
        `INSERT INTO wallets (user_id, balance) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2, updated_at = NOW()
         RETURNING *`,
        [userId, amount]
      )
      await client.query(
        `INSERT INTO wallet_transactions (wallet_id, type, amount, description, balance_after)
         VALUES ($1, 'CREDIT', $2, $3, $4)`,
        [wallet.id, amount, description || 'Admin credit', wallet.balance]
      )
      await client.query('COMMIT')
      return { balance: parseFloat(wallet.balance) }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async toggleBlock(userId, blocked) {
    const { rows: [user] } = await query(
      'UPDATE users SET is_blocked = $1, blocked_at = $3, is_active = $4, updated_at = NOW() WHERE id = $2 RETURNING id, name, is_active, is_blocked',
      [blocked, userId, blocked ? new Date() : null, !blocked]
    )
    return user
  }

  async getAllForExport() {
    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, u.email, u.is_active, u.loyalty_points,
              COALESCE(w.balance, 0) AS wallet_balance, u.created_at,
              COALESCE(o.order_count, 0)::int AS order_count, COALESCE(o.total_spent, 0) AS total_spent
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*)::int AS order_count, SUM(total_amount) AS total_spent
         FROM orders WHERE status != 'CANCELLED' GROUP BY user_id
       ) o ON o.user_id = u.id
       WHERE (u.role = 'CUSTOMER' OR EXISTS (SELECT 1 FROM orders eo WHERE eo.user_id = u.id))
       ORDER BY u.created_at DESC`
    )
    return rows
  }
}

