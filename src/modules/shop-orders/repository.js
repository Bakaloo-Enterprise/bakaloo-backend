import { query, getClient, pool } from '../../config/database.js'
import { revokeOrderPickupTokens } from '../../utils/pickupTokens.js'

/**
 * Shop Orders repository — wraps the existing `orders` table with
 * shop-scoped queries. No schema changes; all reads/writes target the
 * canonical `orders` row, filtered by `shop_id` (added in migration 033)
 * so that store users never see data outside their shop.
 *
 * Design source: §6.5 (canonical store endpoint mounted at
 * /api/v1/shop-orders) and §7 (state machine).
 *
 * Conventions:
 *   - All SQL is parameterized ($1, $2, …); no SELECT *.
 *   - Reads return camelCase rows via `formatRow()`.
 *   - State transitions run inside a single tx (BEGIN → SELECT FOR
 *     UPDATE → UPDATE → INSERT order_status_history → caller emits
 *     audit row inside the same tx → COMMIT).
 *
 * Requirements: R22.1, R22.3, R22.4, R22.5, R22.6, R22.7, R22.8,
 *               R22.9, R22.10, R22.12
 */

/**
 * Standard projection — every read in this module SELECTs exactly these
 * columns from `orders`. Centralised so a column rename never silently
 * drops a field from the wire payload.
 */
const ORDER_COLUMNS = [
  'id',
  'order_number',
  'user_id',
  'shop_id',
  'rider_id',
  'status',
  'items',
  'subtotal',
  'discount_amount',
  'delivery_fee',
  'platform_fee',
  'tax_amount',
  'total_amount',
  'payment_method',
  'payment_status',
  'coupon_code',
  'delivery_address',
  'delivery_notes',
  'estimated_delivery',
  'delivered_at',
  'proof_photo_url',
  'cancelled_reason',
  'tip_amount',
  'handling_fee',
  'late_night_fee',
  'delivery_instructions',
  'savings_total',
  'auto_assignment_status',
  'created_at',
  'updated_at',
]

/**
 * Coerce a value that may already be a JS object OR a JSON string into a
 * JS object. PostgreSQL JSON/JSONB columns sometimes round-trip as parsed
 * objects (jsonb) and sometimes as strings (json on older drivers); both
 * paths are handled.
 */
function parseJsonish(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value
}

function toFloat(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Convert a snake_case `orders` row into the camelCase shape consumed by
 * the dashboard. Mirrors `OrdersRepository._format` so the wire shape
 * stays identical between customer-facing and shop-scoped endpoints.
 *
 * @param {object} row
 * @returns {object}
 */
function formatRow(row) {
  if (!row) return null
  return {
    id: row.id,
    orderNumber: row.order_number,
    userId: row.user_id,
    shopId: row.shop_id || null,
    riderId: row.rider_id || null,
    riderName: row.rider_name || null,
    riderPhone: row.rider_phone || null,
    customerName: row.customer_name || null,
    customerPhone: row.customer_phone || null,
    status: row.status,
    items: parseJsonish(row.items) || [],
    subtotal: toFloat(row.subtotal),
    discountAmount: toFloat(row.discount_amount),
    deliveryFee: toFloat(row.delivery_fee),
    platformFee: toFloat(row.platform_fee),
    taxAmount: toFloat(row.tax_amount),
    totalAmount: toFloat(row.total_amount),
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    couponCode: row.coupon_code,
    deliveryAddress: parseJsonish(row.delivery_address) || {},
    deliveryNotes: row.delivery_notes,
    estimatedDelivery: row.estimated_delivery,
    deliveredAt: row.delivered_at,
    proofPhotoUrl: row.proof_photo_url,
    cancelledReason: row.cancelled_reason,
    tipAmount: toFloat(row.tip_amount),
    handlingFee: toFloat(row.handling_fee),
    lateNightFee: toFloat(row.late_night_fee),
    deliveryInstructions: row.delivery_instructions || null,
    savingsTotal: toFloat(row.savings_total),
    autoAssignmentStatus: row.auto_assignment_status || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class ShopOrdersRepository {
  /**
   * A pooled connection for the service's transactions (status changes, rider assignment, cancel, refund all
   * call `this.repo.getClient()`). This method was missing — the module only re-exported `getClient` at file
   * level — so every one of those operations failed with "this.repo.getClient is not a function" against a real
   * repository; unit tests passed because they mock the repository.
   */
  getClient() {
    return getClient()
  }

  /**
   * Build the WHERE clause + parameter array for the listing/export
   * filter set. Returns the SQL fragment (without the leading `WHERE`)
   * and the appended parameter list — caller is responsible for the
   * `WHERE` keyword and any subsequent ORDER BY / LIMIT / OFFSET clauses.
   *
   * Used by both the paginated `list()` and the streaming `streamForExport()`
   * so the filter semantics never drift between the two endpoints.
   *
   * @param {string} shopId
   * @param {{
   *   status?: string,
   *   payment_status?: string,
   *   created_at_from?: string,
   *   created_at_to?: string,
   *   q?: string,
   * }} filters
   * @returns {{ where: string, params: any[] }}
   */
  _buildFilterClause(shopId, filters = {}) {
    const where = ['o.shop_id = $1']
    const params = [shopId]
    let idx = 2

    if (filters.status) {
      where.push(`o.status = $${idx++}`)
      params.push(filters.status)
    }
    if (filters.payment_status) {
      where.push(`o.payment_status = $${idx++}`)
      params.push(filters.payment_status)
    }
    if (filters.created_at_from) {
      where.push(`o.created_at >= $${idx++}`)
      params.push(filters.created_at_from)
    }
    if (filters.created_at_to) {
      where.push(`o.created_at <= $${idx++}`)
      params.push(filters.created_at_to)
    }
    if (filters.q) {
      // Free-text on order_number, customer name, customer phone.
      // ILIKE on indexed text columns is acceptable for the typical
      // 1k–10k rows per shop; if cardinality grows we revisit with
      // pg_trgm GIN. Pattern is `%term%` so the planner uses a seq-scan
      // on the filtered subset.
      where.push(
        `(o.order_number ILIKE $${idx} OR u.name ILIKE $${idx} OR u.phone ILIKE $${idx})`
      )
      params.push(`%${filters.q}%`)
      idx++
    }

    return { where: where.join(' AND '), params }
  }

  /**
   * GET /shop-orders — paginated, filterable list scoped to one shop.
   *
   * Sort: `created_at DESC` (R22 AC#4). Customer name/phone come from
   * a LEFT JOIN on `users` so the `q` filter can match either.
   *
   * @param {string} shopId
   * @param {object} filters
   * @param {{ limit: number, offset: number }} pagination
   * @returns {Promise<{ orders: object[], total: number }>}
   */
  async list(shopId, filters, { limit, offset }) {
    const { where, params } = this._buildFilterClause(shopId, filters)

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE ${where}
    `
    const countResult = await query(countSql, params)
    const total = countResult.rows[0]?.total ?? 0

    const cols = ORDER_COLUMNS.map((c) => `o.${c}`).join(', ')
    const listSql = `
      SELECT ${cols},
             u.name  AS customer_name,
             u.phone AS customer_phone,
             ru.name AS rider_name,
             ru.phone AS rider_phone
      FROM orders o
      LEFT JOIN users u  ON u.id  = o.user_id
      LEFT JOIN users ru ON ru.id = o.rider_id
      WHERE ${where}
      ORDER BY o.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `
    const result = await query(listSql, [...params, limit, offset])

    return {
      orders: result.rows.map(formatRow),
      total,
    }
  }

  /**
   * Stream rows for CSV export. Uses a single-statement query bounded by
   * `LIMIT 10000` (R22 AC#12) and an async generator that yields formatted
   * rows one at a time so the controller can pipe them to the response
   * without keeping the whole CSV string in memory.
   *
   * The pg driver loads all rows into memory by default — true row-by-row
   * streaming requires `pg-cursor`, which is not currently a dependency.
   * The 10k cap keeps the snapshot well within the 4GB RAM budget
   * (~80 bytes/row CSV * 10k = ~800KB plus the joined columns).
   *
   * @param {string} shopId
   * @param {object} filters
   * @returns {AsyncGenerator<object>}
   */
  async *streamForExport(shopId, filters) {
    const { where, params } = this._buildFilterClause(shopId, filters)

    const cols = ORDER_COLUMNS.map((c) => `o.${c}`).join(', ')
    const sql = `
      SELECT ${cols},
             u.name  AS customer_name,
             u.phone AS customer_phone,
             ru.name AS rider_name,
             ru.phone AS rider_phone
      FROM orders o
      LEFT JOIN users u  ON u.id  = o.user_id
      LEFT JOIN users ru ON ru.id = o.rider_id
      WHERE ${where}
      ORDER BY o.created_at DESC
      LIMIT 10000
    `
    const result = await query(sql, params)
    for (const row of result.rows) {
      yield formatRow(row)
    }
  }

  /**
   * Read a single order belonging to the given shop. Returns `null` when
   * the order does not exist OR exists but belongs to a different shop —
   * both surface as a 404 to the caller, never leaking cross-shop
   * existence.
   *
   * @param {string} orderId
   * @param {string} shopId
   * @returns {Promise<object|null>}
   */
  async findByIdAndShop(orderId, shopId) {
    const cols = ORDER_COLUMNS.map((c) => `o.${c}`).join(', ')
    const result = await query(
      `SELECT ${cols},
              u.name  AS customer_name,
              u.phone AS customer_phone,
              ru.name AS rider_name,
              ru.phone AS rider_phone
         FROM orders o
         LEFT JOIN users u  ON u.id  = o.user_id
         LEFT JOIN users ru ON ru.id = o.rider_id
        WHERE o.id = $1 AND o.shop_id = $2`,
      [orderId, shopId]
    )
    return result.rows[0] ? formatRow(result.rows[0]) : null
  }

  /**
   * Lock an order row inside an existing transaction (`SELECT … FOR
   * UPDATE`) and return its current shop_id and status. Used by the
   * service layer at the top of every state-transition handler.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} orderId
   * @returns {Promise<{ id: string, shop_id: string|null, status: string,
   *                    cancelled_reason: string|null,
   *                    delivered_at: Date|null,
   *                    payment_status: string,
   *                    rider_id: string|null,
   *                    total_amount: string|number,
   *                    user_id: string }|null>}
   */
  async lockForUpdate(client, orderId) {
    const result = await client.query(
      `SELECT id, shop_id, status, cancelled_reason, delivered_at,
              payment_status, rider_id, total_amount, user_id
         FROM orders
        WHERE id = $1
        FOR UPDATE`,
      [orderId]
    )
    return result.rows[0] || null
  }

  /**
   * Apply a status change to `orders` inside an existing transaction.
   *
   * The `extra` map carries optional side-effect columns (`cancelled_reason`,
   * `payment_status`, `delivered_at`) so cancel/refund handlers can update
   * them in the same UPDATE without a second round-trip.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} orderId
   * @param {string} newStatus
   * @param {{
   *   cancelledReason?: string,
   *   paymentStatus?: string,
   *   deliveredAt?: Date,
   * }} [extra]
   * @returns {Promise<object|null>} the updated row formatted via formatRow
   */
  async updateStatusInTx(client, orderId, newStatus, extra = {}) {
    const sets = ['status = $1', 'updated_at = NOW()']
    const params = [newStatus]
    let idx = 2

    if (extra.cancelledReason !== undefined) {
      sets.push(`cancelled_reason = $${idx++}`)
      params.push(extra.cancelledReason)
    }
    if (extra.paymentStatus !== undefined) {
      sets.push(`payment_status = $${idx++}`)
      params.push(extra.paymentStatus)
    }
    if (extra.deliveredAt !== undefined) {
      sets.push(`delivered_at = $${idx++}`)
      params.push(extra.deliveredAt)
    }

    params.push(orderId)
    const cols = ORDER_COLUMNS.join(', ')
    const result = await client.query(
      `UPDATE orders SET ${sets.join(', ')}
        WHERE id = $${idx}
        RETURNING ${cols}`,
      params
    )

    if (newStatus === 'CANCELLED' || newStatus === 'DELIVERED') {
      await revokeOrderPickupTokens(client, orderId, `Order ${newStatus}`)

      // Closing the order here can happen out-of-band from the rider's
      // own pickup/delivery flow — without this, delivery_assignments
      // stays stuck on its last in-flight status forever, and the rider
      // app's getAssignedOrders() (which filters on delivery_assignments
      // .status, not orders.status) keeps resurfacing an already-closed
      // order as still needing pickup. See admin orders.repository.js's
      // updateStatus() for the same fix.
      await client.query(
        // $1 is reused both as a direct column assignment and inside
        // CASE/text comparisons — without the explicit cast, Postgres
        // can't reconcile the two inferred types for the same
        // placeholder and throws "inconsistent types deduced for
        // parameter $1" (42P08) at prepare time. See admin
        // orders.repository.js's updateStatus() for the same fix.
        `UPDATE delivery_assignments
         SET status = $1::text,
             delivered_at = CASE WHEN $1::text = 'DELIVERED' THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
             cancelled_at = CASE WHEN $1::text = 'CANCELLED' THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END,
             cancel_reason = CASE WHEN $1::text = 'CANCELLED' THEN COALESCE(cancel_reason, 'Order cancelled') ELSE cancel_reason END,
             updated_at = NOW()
         WHERE order_id = $2 AND status NOT IN ('DELIVERED', 'CANCELLED')`,
        [newStatus, orderId]
      )
    }

    return result.rows[0] ? formatRow(result.rows[0]) : null
  }

  /**
   * Append a row to `order_status_history` inside an existing transaction.
   *
   * @param {import('pg').PoolClient} client
   * @param {{
   *   orderId: string,
   *   fromStatus: string|null,
   *   toStatus: string,
   *   changedBy: string|null,
   *   note?: string|null,
   * }} entry
   */
  async insertStatusHistoryInTx(client, entry) {
    await client.query(
      `INSERT INTO order_status_history
         (order_id, from_status, to_status, changed_by, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        entry.orderId,
        entry.fromStatus,
        entry.toStatus,
        entry.changedBy,
        entry.note ?? null,
      ]
    )
  }

  /**
   * Update `orders.rider_id` inside an existing transaction. Returns the
   * RETURNING row formatted for the wire.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} orderId
   * @param {string} riderId
   * @returns {Promise<object|null>}
   */
  async setRiderInTx(client, orderId, riderId) {
    const cols = ORDER_COLUMNS.join(', ')
    const result = await client.query(
      `UPDATE orders SET rider_id = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING ${cols}`,
      [riderId, orderId]
    )
    return result.rows[0] ? formatRow(result.rows[0]) : null
  }

  /**
   * Cancel any open delivery_assignments for the order so a fresh ASSIGNED
   * row can be inserted without violating the partial uniqueness index.
   * Mirrors the pattern in admin/orders/orders.repository.js#assignRider.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} orderId
   */
  async cancelOpenAssignmentsInTx(client, orderId) {
    await client.query(
      `UPDATE delivery_assignments
          SET status = 'CANCELLED',
              cancel_reason = 'Reassigned by shop staff',
              cancelled_at = NOW(),
              updated_at = NOW()
        WHERE order_id = $1
          AND status IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')`,
      [orderId]
    )
    await revokeOrderPickupTokens(client, orderId, 'Reassigned by shop staff')
  }

  /**
   * Insert a fresh ASSIGNED `delivery_assignments` row scoped to the
   * order's shop_id. Earnings default to the order's delivery_fee
   * (or ₹25 when zero) so the rider screen always has a non-zero
   * payout to display.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} orderId
   * @param {string} riderId
   * @returns {Promise<{ id: string, order_id: string, rider_id: string,
   *                    status: string, assigned_at: Date }|null>}
   */
  async insertAssignmentInTx(client, orderId, riderId, commissionEnabled = true) {
    const result = await client.query(
      `INSERT INTO delivery_assignments (order_id, rider_id, status, assigned_at, earnings)
       SELECT $1, $2, 'ASSIGNED', NOW(),
              CASE WHEN $3 THEN COALESCE(NULLIF(o.delivery_fee, 0), 25) ELSE 0 END
         FROM orders o
        WHERE o.id = $1
        RETURNING id, order_id, rider_id, status, assigned_at`,
      [orderId, riderId, commissionEnabled]
    )
    return result.rows[0] || null
  }

  /**
   * Fetch order plus customer + items for the packing slip endpoint.
   * Returns `null` when the order does not exist or is outside the
   * caller's shop scope.
   *
   * @param {string} orderId
   * @param {string} shopId
   * @returns {Promise<{ order: object, items: object[], shop: object|null }|null>}
   */
  async findForPackingSlip(orderId, shopId) {
    const order = await this.findByIdAndShop(orderId, shopId)
    if (!order) return null

    const itemsResult = await query(
      `SELECT product_id, name, price, quantity, unit, total
         FROM order_items
        WHERE order_id = $1
        ORDER BY id ASC`,
      [orderId]
    )

    const shopResult = await query(
      `SELECT id, name, phone, address, city, state, pincode
         FROM shops
        WHERE id = $1`,
      [shopId]
    )

    return {
      order,
      items: itemsResult.rows,
      shop: shopResult.rows[0] || null,
    }
  }

  /**
   * GET /shop-orders/riders — riders currently engaged with non-terminal
   * delivery_assignments for the requester's shop.
   *
   * "Currently assigned" maps to assignment statuses ASSIGNED, ACCEPTED,
   * PICKED_UP, IN_TRANSIT (the same set used by the admin/dashboard
   * "on delivery" widget). Riders are deduplicated and ordered by the
   * most recent assigned_at descending, so the dashboard always shows
   * the currently-active set.
   *
   * @param {string} shopId
   * @param {{ limit: number, offset: number }} pagination
   * @returns {Promise<{ riders: object[], total: number }>}
   */
  async listAssignedRidersForShop(shopId, { limit, offset }) {
    // total = distinct riders with open assignments on orders for this shop
    const countResult = await query(
      `SELECT COUNT(DISTINCT da.rider_id)::int AS total
         FROM delivery_assignments da
         JOIN orders o ON o.id = da.order_id
        WHERE o.shop_id = $1
          AND da.status IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')`,
      [shopId]
    )
    const total = countResult.rows[0]?.total ?? 0

    const result = await query(
      `SELECT u.id           AS rider_id,
              u.name         AS rider_name,
              u.phone        AS rider_phone,
              MAX(da.assigned_at) AS last_assigned_at,
              COUNT(*)::int       AS active_assignments
         FROM delivery_assignments da
         JOIN orders o ON o.id = da.order_id
         JOIN users  u ON u.id = da.rider_id
        WHERE o.shop_id = $1
          AND da.status IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')
        GROUP BY u.id, u.name, u.phone
        ORDER BY last_assigned_at DESC NULLS LAST
        LIMIT $2 OFFSET $3`,
      [shopId, limit, offset]
    )

    return {
      riders: result.rows.map((row) => ({
        riderId: row.rider_id,
        name: row.rider_name,
        phone: row.rider_phone,
        lastAssignedAt: row.last_assigned_at,
        activeAssignments: Number(row.active_assignments) || 0,
      })),
      total,
    }
  }
}

// Export the format helper for tests / sibling utilities.
export { formatRow as _formatOrderRow, ORDER_COLUMNS as _ORDER_COLUMNS }

// Re-export pool/getClient/query so the service can run transactions
// without importing the pg config module directly. Keeps repository the
// only file in this module that touches the DB layer.
export { getClient, pool, query }
