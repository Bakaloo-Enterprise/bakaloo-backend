import { query, getClient } from '../../../config/database.js'
import { revokeOrderPickupTokens } from '../../../utils/pickupTokens.js'
import { ShopProductsRepository } from '../../shop-products/shop-products.repository.js'

export class AdminOrdersRepository {
  stock = new ShopProductsRepository()

  async findAll({ offset, limit, status, paymentMethod, paymentStatus, search, startDate, endDate, deliveryType, needsPaymentReview, recoveredFromFailed, riderId, minAmount, maxAmount, area, isB2B }) {
    // needsPaymentReview/recoveredFromFailed both key off payments.metadata,
    // so they share one join — kept out of the base query (not a LEFT JOIN)
    // so it costs nothing for the normal order list, and only applies when
    // one of these two flags is actually requested.
    const needsPaymentsJoin = needsPaymentReview || recoveredFromFailed
    // Built once and reused verbatim in both the row query and the count
    // query below, instead of the row query's SQL being built first and
    // the count query trying to reconstruct its WHERE clause out of it via
    // string splitting on a 'WHERE 1=1' marker — that marker could (and
    // did) also match a code comment quoting the same string, silently
    // truncating every actual filter out of the count query and causing a
    // param-count mismatch as soon as any filter was applied.
    //
    // "Place Order" B2B credit orders never appear in the general Orders
    // list, unconditionally — they live exclusively in the dedicated B2B
    // Orders page (findAllB2B below), which has its own approval/
    // settlement workflow this list doesn't support. b2b_approval_status
    // is NULL for every other order.
    let whereClause = ' WHERE 1=1 AND o.b2b_approval_status IS NULL'
    const params = []
    let idx = 1

    if (status) { params.push(status); whereClause += ` AND o.status = $${idx++}` }
    if (paymentMethod) { params.push(paymentMethod); whereClause += ` AND o.payment_method = $${idx++}` }
    if (paymentStatus) { params.push(paymentStatus); whereClause += ` AND o.payment_status = $${idx++}` }
    if (startDate) { params.push(startDate); whereClause += ` AND o.created_at >= $${idx++}` }
    if (endDate) { params.push(endDate); whereClause += ` AND o.created_at <= $${idx++}` }
    if (search) {
      params.push(`%${search}%`)
      whereClause += ` AND (o.order_number ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.name ILIKE $${idx})`
      idx++
    }
    if (deliveryType === 'express') {
      whereClause += ` AND o.delivery_mode = 'ASAP' AND o.quick_delivery_selected = true`
    } else if (deliveryType === 'standard') {
      whereClause += ` AND o.delivery_mode = 'ASAP' AND o.quick_delivery_selected = false`
    } else if (deliveryType === 'scheduled') {
      whereClause += ` AND o.delivery_mode = 'SCHEDULED'`
    }
    if (needsPaymentReview) {
      whereClause += ` AND p.metadata->>'needs_manual_review' = 'true'`
    }
    if (recoveredFromFailed) {
      // Historical audit trail: a payment that was shown FAILED (and may
      // already have been told to the customer) but Razorpay later
      // confirmed was actually captured — auto-recovered by the payment
      // recovery sweep or a manual "Re-check with Razorpay".
      whereClause += ` AND p.metadata->>'recovered_from_failed' = 'true'`
    }
    if (riderId) { params.push(riderId); whereClause += ` AND o.rider_id = $${idx++}` }
    if (minAmount != null) { params.push(minAmount); whereClause += ` AND o.total_amount >= $${idx++}` }
    if (maxAmount != null) { params.push(maxAmount); whereClause += ` AND o.total_amount <= $${idx++}` }
    if (area) {
      // Free-text box on the UI ("Area / Pincode") — matches either the
      // saved delivery pincode or city, whichever the admin typed.
      params.push(`%${area}%`)
      whereClause += ` AND (o.delivery_address->>'pincode' ILIKE $${idx} OR o.delivery_address->>'city' ILIKE $${idx})`
      idx++
    }
    if (isB2B) {
      // Orders snapshotted a buyer GSTIN at checkout only when the
      // customer had an APPROVED business account at order time — the B2B
      // Orders dashboard page's filter.
      whereClause += ` AND o.buyer_gstin IS NOT NULL`
    }

    const paymentsJoinSql = needsPaymentsJoin ? 'JOIN payments p ON p.order_id = o.id' : ''

    const countSql = `
      SELECT COUNT(*) FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      ${paymentsJoinSql}
      ${whereClause}
    `
    const countRes = await query(countSql, params)
    const total = parseInt(countRes.rows[0].count)

    const sql = `
      SELECT o.*, u.name AS customer_name, u.phone AS customer_phone,
             ru.name AS rider_name, sh.name AS shop_name,
             CASE
               WHEN o.delivery_mode = 'SCHEDULED' THEN 'SCHEDULED'
               WHEN o.quick_delivery_selected = true THEN 'EXPRESS'
               ELSE 'STANDARD'
             END AS order_type
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN users ru ON ru.id = o.rider_id
      LEFT JOIN shops sh ON sh.id = o.shop_id
      ${paymentsJoinSql}
      ${whereClause}
      ORDER BY o.created_at DESC LIMIT $${idx++} OFFSET $${idx++}
    `
    const rowParams = [...params, limit, offset]

    const { rows } = await query(sql, rowParams)
    return { orders: rows, total }
  }

  async getStatsByStatus() {
    // Excludes B2B credit orders, same as findAll() above — these tab
    // badges belong to the general Orders page, which never shows them.
    const { rows } = await query(
      `SELECT status, COUNT(*)::int AS count
         FROM orders
        WHERE b2b_approval_status IS NULL
        GROUP BY status`
    )
    return rows.reduce((acc, r) => { acc[r.status] = r.count; return acc }, {})
  }

  /** Count of orders currently flagged needs_manual_review — for the
   *  Orders page's "Needs Review" tab badge. */
  async countNeedsPaymentReview() {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count
       FROM orders o
       JOIN payments p ON p.order_id = o.id
       WHERE p.metadata->>'needs_manual_review' = 'true'`
    )
    return rows[0].count
  }

  /** Count of orders where a payment previously shown FAILED was later
   *  confirmed captured by Razorpay — for the Orders page's "Recovered"
   *  filter tab badge. */
  async countRecoveredFromFailed() {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count
       FROM orders o
       JOIN payments p ON p.order_id = o.id
       WHERE p.metadata->>'recovered_from_failed' = 'true'`
    )
    return rows[0].count
  }

  async findById(orderId) {
    const { rows } = await query(
      `SELECT o.*, u.name AS customer_name, u.phone AS customer_phone, u.email AS customer_email,
              ru.name AS rider_name, ru.phone AS rider_phone,
              sh.name AS shop_name, sh.lat AS shop_lat, sh.lng AS shop_lng,
              aseg.name AS area_segment_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN users ru ON ru.id = o.rider_id
       LEFT JOIN shops sh ON sh.id = o.shop_id
       LEFT JOIN area_segments aseg ON aseg.id = o.area_segment_id
       WHERE o.id = $1`,
      [orderId]
    )
    return rows[0] || null
  }

  /**
   * List "Place Order" B2B-credit orders (b2b_approval_status IS NOT
   * NULL) for the dedicated B2B Orders dashboard page — narrower than the
   * `isB2B` filter on findAll() above (which matches every order from a
   * B2B customer regardless of payment method; this matches only orders
   * placed via the credit-line "Place Order" button). Joined against the
   * customer's business account so the list can show their company name
   * alongside each order without a second round-trip per row — there's no
   * credit limit/balance to show since Place Order has no cap.
   */
  async findAllB2B({ status, hasPendingCollection, offset, limit }) {
    const params = []
    let idx = 1
    let where = 'WHERE o.b2b_approval_status IS NOT NULL'
    if (status) {
      params.push(status)
      where += ` AND o.b2b_approval_status = $${idx++}`
    }
    if (hasPendingCollection) {
      // The B2B Collections page's filter — only orders where something is
      // still owed. A PENDING (not-yet-approved) order is excluded even
      // though its full credit draw is technically unsettled: nothing has
      // shipped yet, so there's nothing to collect payment for in
      // practice — collection only makes sense once the order is real.
      where += ` AND o.b2b_approval_status = 'APPROVED' AND o.total_amount - o.b2b_amount_settled > 0.01`
    }

    const countRes = await query(
      `SELECT COUNT(*) FROM orders o ${where}`,
      params
    )
    const total = parseInt(countRes.rows[0].count)

    params.push(limit, offset)
    const { rows } = await query(
      `SELECT o.*, u.name AS customer_name, u.phone AS customer_phone,
              sh.name AS shop_name,
              COALESCE(ba.company_name, u.staff_business_name) AS company_name
         FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
         LEFT JOIN shops sh ON sh.id = o.shop_id
         LEFT JOIN business_accounts ba ON ba.user_id = o.user_id
         ${where}
        ORDER BY (o.b2b_approval_status = 'PENDING') DESC, o.created_at DESC
        LIMIT $${idx++} OFFSET $${idx++}`,
      params
    )
    return { orders: rows, total }
  }

  async getB2BSettlements(orderId) {
    const { rows } = await query(
      `SELECT s.*, u.name AS recorded_by_name
         FROM order_b2b_settlements s
         LEFT JOIN users u ON u.id = s.recorded_by
        WHERE s.order_id = $1
        ORDER BY s.created_at DESC`,
      [orderId]
    )
    return rows
  }

  /** Most recent QR pickup token for the order — surfaced as "QR status" on the admin order card. */
  async getOrderPickupToken(orderId) {
    const { rows } = await query(
      `SELECT id, status, version, issued_at, verified_at, consumed_at, revoked_at
       FROM order_pickup_tokens
       WHERE order_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [orderId]
    )
    return rows[0] || null
  }


  async getOrderItems(orderId) {
    const { rows } = await query(
      `SELECT oi.*, p.thumbnail_url, p.net_quantity
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.created_at`,
      [orderId]
    )
    return rows
  }

  async getOrderTimeline(orderId) {
    const { rows } = await query(
      `SELECT osh.*, u.name AS changed_by_name
       FROM order_status_history osh
       LEFT JOIN users u ON u.id = osh.changed_by
       WHERE osh.order_id = $1
       ORDER BY osh.changed_at ASC`,
      [orderId]
    )
    return rows
  }

  async getOrderNotes(orderId) {
    const { rows } = await query(
      `SELECT n.*, u.name AS author_name
       FROM order_notes n
       LEFT JOIN users u ON u.id = n.author_id
       WHERE n.order_id = $1
       ORDER BY n.created_at ASC`,
      [orderId]
    )
    return rows
  }

  async addOrderNote(orderId, authorId, body) {
    const { rows } = await query(
      `WITH ins AS (
         INSERT INTO order_notes (order_id, author_id, body)
         VALUES ($1, $2, $3)
         RETURNING *
       )
       SELECT ins.*, u.name AS author_name
       FROM ins
       LEFT JOIN users u ON u.id = ins.author_id`,
      [orderId, authorId, body]
    )
    return rows[0]
  }

  async getOrderPayment(orderId) {
    const { rows } = await query(
      'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
      [orderId]
    )
    return rows[0] || null
  }

  async getOrderDelivery(orderId) {
    const { rows } = await query(
      'SELECT * FROM delivery_assignments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
      [orderId]
    )
    return rows[0] || null
  }

  async updateStatus(orderId, newStatus, adminId, note) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows: [order] } = await client.query(
        'SELECT status, payment_method, payment_status FROM orders WHERE id = $1 FOR UPDATE', [orderId]
      )
      if (!order) throw { statusCode: 404, message: 'Order not found' }

      // Only the rider-app delivery-completion flow (delivery.repository.js)
      // was setting delivered_at — this admin-dashboard path never did, so
      // any order an admin marked DELIVERED directly (support/testing) had
      // a permanently NULL delivered_at. The nightly settlement worker
      // filters strictly on delivered_at falling within its date window,
      // so those orders were silently excluded from shop_financials and
      // shop_transactions forever, even though status correctly read
      // DELIVERED everywhere else in the dashboard.
      if (newStatus === 'DELIVERED') {
        // COD cash is collected at the door the moment the rider's own app
        // marks a delivery complete — that flow sets payment_status='PAID'
        // as the single source of truth for "money actually changed
        // hands" (see refundOrder/cancelOrder's identical assumption).
        // This admin-manual path (support closing an order out-of-band
        // from the rider app) never did the same, so a COD order marked
        // DELIVERED here got stuck showing payment PENDING forever — which
        // then also incorrectly blocked refundOrder/cancelOrder/refund
        // requests with "this order was never paid".
        const markCodPaid = order.payment_method === 'COD' && order.payment_status !== 'PAID'
        await client.query(
          `UPDATE orders SET status = $1, delivered_at = COALESCE(delivered_at, NOW()),
                  payment_status = CASE WHEN $3 THEN 'PAID' ELSE payment_status END,
                  updated_at = NOW()
           WHERE id = $2`,
          [newStatus, orderId, markCodPaid]
        )
      } else {
        await client.query(
          'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
          [newStatus, orderId]
        )
      }

      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, order.status, newStatus, adminId, note || null]
      )

      // A QR pickup token must stop working once its order is cancelled or
      // delivered — nothing left to scan it for.
      if (newStatus === 'CANCELLED' || newStatus === 'DELIVERED') {
        await revokeOrderPickupTokens(client, orderId, `Order ${newStatus}`)
      }

      // This admin path can close an order out-of-band from the rider's
      // own pickup/delivery flow (e.g. support marking an order DELIVERED
      // after the rider handed it over but the app never confirmed
      // pickup). Without this, delivery_assignments stays stuck on its
      // last in-flight status (ASSIGNED/ACCEPTED/PICKED_UP/IN_TRANSIT)
      // forever, and the rider app's getAssignedOrders() — which filters
      // purely on delivery_assignments.status, not orders.status — keeps
      // resurfacing an already-closed order as still needing pickup.
      if (newStatus === 'CANCELLED' || newStatus === 'DELIVERED') {
        await client.query(
          // $1 is reused both as a direct column assignment and inside
          // CASE/text comparisons — without the explicit cast, Postgres's
          // extended-query protocol can't reconcile the two inferred
          // types for the same placeholder and throws "inconsistent
          // types deduced for parameter $1" (42P08) at prepare time,
          // before any row is even touched.
          `UPDATE delivery_assignments
           SET status = $1::text,
               delivered_at = CASE WHEN $1::text = 'DELIVERED' THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
               cancelled_at = CASE WHEN $1::text = 'CANCELLED' THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END,
               cancel_reason = CASE WHEN $1::text = 'CANCELLED' THEN COALESCE(cancel_reason, 'Order cancelled by admin') ELSE cancel_reason END,
               updated_at = NOW()
           WHERE order_id = $2 AND status NOT IN ('DELIVERED', 'CANCELLED')`,
          [newStatus, orderId]
        )
      }

      await client.query('COMMIT')
      return order.status // return old status for activity log
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /** Plain field update — no status-machine transition involved, unlike updateStatus(). */
  async rescheduleDelivery(orderId, { scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel }) {
    const { rows } = await query(
      `UPDATE orders
       SET delivery_mode = 'SCHEDULED',
           scheduled_delivery_at = $1,
           scheduled_slot_start = $1,
           scheduled_slot_end = $2,
           scheduled_slot_label = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, user_id, rider_id, order_number, status,
                 scheduled_slot_start, scheduled_slot_end, scheduled_slot_label`,
      [scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel, orderId]
    )
    return rows[0] || null
  }

  async assignRider(orderId, riderId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      await client.query(
        `UPDATE delivery_assignments
         SET status = 'CANCELLED',
             cancel_reason = 'Reassigned by admin',
             cancelled_at = NOW(),
             updated_at = NOW()
         WHERE order_id = $1
           AND status IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')`,
        [orderId]
      )

      await client.query(
        'UPDATE orders SET rider_id = $1, updated_at = NOW() WHERE id = $2',
        [riderId, orderId]
      )

      // Create a fresh assignment row (no ON CONFLICT dependency on order_id).
      const { rows: [assignment] } = await client.query(
        `INSERT INTO delivery_assignments (order_id, rider_id, status, assigned_at, earnings)
         SELECT $1, $2, 'ASSIGNED', NOW(), COALESCE(NULLIF(o.delivery_fee, 0), 25)
         FROM orders o
         WHERE o.id = $1
         RETURNING id, order_id, rider_id, status, assigned_at`,
        [orderId, riderId]
      )

      await client.query('COMMIT')
      return assignment
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Record (or update) which rider was last assigned for this customer's
   * delivery to this saved address — the sticky-address preference behind
   * the "suggested rider" hint in the admin order-detail drawer. Called
   * from every manual assign/reassign, so an admin override just becomes
   * the new preference going forward.
   */
  async upsertAddressRiderPreference(userId, addressId, riderId) {
    await query(
      `INSERT INTO customer_address_rider_preferences (user_id, address_id, rider_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, address_id)
       DO UPDATE SET rider_id = EXCLUDED.rider_id, updated_at = NOW()`,
      [userId, addressId, riderId]
    )
  }

  /** Sticky-address rider preference lookup, with the rider's current name/phone/online status. */
  async getAddressRiderPreference(userId, addressId) {
    const { rows } = await query(
      `SELECT capr.rider_id AS id, u.name, u.phone,
              COALESCE(rp.is_online, false) AS is_online
       FROM customer_address_rider_preferences capr
       JOIN users u ON u.id = capr.rider_id
       LEFT JOIN rider_profiles rp ON rp.user_id = capr.rider_id
       WHERE capr.user_id = $1 AND capr.address_id = $2`,
      [userId, addressId]
    )
    return rows[0] || null
  }

  async bulkAssign(assignments) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const results = []
      for (const { orderId, riderId } of assignments) {
        await client.query(
          `UPDATE delivery_assignments
           SET status = 'CANCELLED',
               cancel_reason = 'Reassigned by bulk assign',
               cancelled_at = NOW(),
               updated_at = NOW()
           WHERE order_id = $1
             AND status IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')`,
          [orderId]
        )

        await client.query(
          'UPDATE orders SET rider_id = $1, updated_at = NOW() WHERE id = $2',
          [riderId, orderId]
        )

        const { rows: [assignment] } = await client.query(
          `INSERT INTO delivery_assignments (order_id, rider_id, status, assigned_at, earnings)
           SELECT $1, $2, 'ASSIGNED', NOW(), COALESCE(NULLIF(o.delivery_fee, 0), 25)
           FROM orders o
           WHERE o.id = $1
           RETURNING id, order_id, rider_id, status, assigned_at`,
          [orderId, riderId]
        )
        results.push({
          assignmentId: assignment.id,
          orderId,
          riderId,
          status: 'assigned',
        })
      }
      await client.query('COMMIT')
      return results
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * An order an admin places for a customer (phone / WhatsApp / walk-in).
   *
   * It follows the SAME rules as an app order: it belongs to one store (orders.shop_id), takes that store's price,
   * and removes stock from that store's shop_products through the audited stock ledger (stock_movements), with the
   * order line remembering which store product it came from so a cancellation puts the stock back.
   * Payment: COD stays PENDING until delivery; MANUAL is PAID only when the admin says the money is already in hand.
   */
  async createManualOrder({ userId, items, paymentMethod, paymentReceived, deliveryAddress, adminId, shopId, orderType = 'B2C', dueDate, advance, requirementId }) {
    const isB2B = orderType === 'B2B'
    const method = isB2B ? 'B2B_CREDIT' : paymentMethod || 'MANUAL'
    const client = await getClient()
    try {
      await client.query('BEGIN')

      // One line per product (a product typed twice is one line).
      const wanted = new Map()
      const negotiated = new Map() // B2B: the price agreed with the customer for a product, if staff typed one
      for (const it of items) {
        wanted.set(it.productId, (wanted.get(it.productId) || 0) + it.quantity)
        if (isB2B && it.unitPrice !== undefined && it.unitPrice !== null) negotiated.set(it.productId, Number(it.unitPrice))
      }
      const productIds = [...wanted.keys()]
      const quantities = productIds.map((id) => wanted.get(id))

      const shop = await this._resolveManualOrderShop(client, shopId, productIds, quantities)

      let subtotalPaise = 0
      const lines = []
      for (const productId of productIds) {
        const qty = wanted.get(productId)
        const { rows: [row] } = await client.query(
          `SELECT sp.id AS shop_product_id, sp.stock_quantity, sp.price AS sp_price, sp.sale_price AS sp_sale_price, sp.wholesale_price AS sp_wholesale_price, p.wholesale_price,
                  p.id AS product_id, p.name, p.price, p.sale_price, p.unit, p.hsn_code, p.gst_rate
             FROM shop_products sp JOIN products p ON p.id = sp.product_id
            WHERE sp.shop_id = $1 AND sp.product_id = $2 AND sp.deleted_at IS NULL AND p.is_active = true`,
          [shop.id, productId]
        )
        if (!row) throw { statusCode: 400, message: `That product is not sold at ${shop.name}.` }
        // Same price order as the cart: the store's sale price, then the catalogue sale price, then the list price.
        // B2B: the agreed price, else the wholesale price (no sale tier), else the list price — same as the cart does.
        const price = isB2B
          ? Number(negotiated.get(productId) ?? row.sp_wholesale_price ?? row.wholesale_price ?? row.sp_price ?? row.price)
          : Number(row.sp_sale_price ?? row.sale_price ?? row.sp_price ?? row.price)
        if (!Number.isFinite(price) || price < 0) throw { statusCode: 400, message: `${row.name} has no price.` }
        const totalPaise = Math.round(price * 100) * qty
        subtotalPaise += totalPaise
        lines.push({ ...row, qty, price, total: totalPaise / 100 })
      }
      const subtotal = subtotalPaise / 100

      const orderItems = lines.map((l) => ({
        product_id: l.product_id, shopId: shop.id, shopProductId: l.shop_product_id, name: l.name, price: l.price, quantity: l.qty, unit: l.unit, total: l.total,
        hsn_code_snapshot: l.hsn_code || null, gst_rate_snapshot: l.gst_rate ?? null,
      }))
      const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`
      const paid = method === 'MANUAL' && paymentReceived === true
      if (isB2B && dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw { statusCode: 400, message: 'The pay-by date must look like 2026-11-05.' }
      const adv = isB2B && advance && Number(advance.amount) > 0 ? { amount: Math.round(Number(advance.amount) * 100) / 100, method: advance.method } : null
      if (adv && !['CASH', 'UPI'].includes(adv.method)) throw { statusCode: 400, message: 'Money received now must be Cash or UPI.' }
      if (adv && adv.amount > subtotal + 0.001) throw { statusCode: 400, message: `That is more than the order total of ₹${subtotal}.` }
      const { rows: [order] } = await client.query(
        `INSERT INTO orders (order_number, user_id, shop_id, status, items, subtotal, total_amount, payment_method, payment_status, delivery_address,
                             b2b_approval_status, b2b_approved_by, b2b_approved_at, b2b_payment_due_date, b2b_amount_settled)
         VALUES ($1, $2, $3, 'CONFIRMED', $4, $5, $6, $7, $8, $9,
                 $10, $11, ${isB2B ? 'NOW()' : 'NULL'}, $12, $13)
         RETURNING *`,
        [orderNumber, userId, shop.id, JSON.stringify(orderItems), subtotal, subtotal, method,
          isB2B ? (adv && adv.amount + 0.01 >= subtotal ? 'PAID' : 'PENDING') : paid ? 'PAID' : 'PENDING', JSON.stringify(deliveryAddress),
          isB2B ? 'APPROVED' : null, isB2B ? adminId : null, isB2B ? dueDate || null : null, adv ? adv.amount : 0]
      )
      if (adv) {
        await client.query(`INSERT INTO order_b2b_settlements (order_id, method, amount, note, recorded_by) VALUES ($1, $2, $3, 'Received when the order was taken', $4)`, [order.id, adv.method, adv.amount, adminId])
      }

      if (requirementId) {
        if (!isB2B) throw { statusCode: 400, message: 'A customer request becomes a Business order.' }
        const { rows: [rq] } = await client.query(`SELECT id, status, req_no FROM b2b_requirements WHERE id = $1 FOR UPDATE`, [requirementId])
        if (!rq) throw { statusCode: 404, message: 'That customer request no longer exists.' }
        if (rq.status !== 'CONFIRMED') throw { statusCode: 409, message: `Request #${rq.req_no} is not marked “Sure” any more, so it cannot become an order.`, code: 'REQUIREMENT_NOT_CONFIRMED' }
        const { rows: held } = await client.query(`SELECT 1 FROM b2b_reservations WHERE requirement_id = $1 AND status = 'RESERVED' LIMIT 1`, [requirementId])
        if (held.length) throw { statusCode: 409, message: `Request #${rq.req_no} has stock held for it in the warehouse. Use “Delivered” on the request instead — that uses the held stock.`, code: 'REQUIREMENT_HAS_HOLDS' }
        await client.query(`UPDATE b2b_requirements SET status = 'DELIVERED', order_id = $2, updated_at = NOW() WHERE id = $1`, [requirementId, order.id])
        await client.query(`INSERT INTO b2b_requirement_events (requirement_id, actor_id, kind, detail) VALUES ($1,$2,'ORDER_MADE',$3)`, [requirementId, adminId, JSON.stringify({ orderNumber: order.order_number })])
      }

      for (const l of lines) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, shop_product_id, name, price, quantity, unit, total, hsn_code_snapshot, gst_rate_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [order.id, l.product_id, l.shop_product_id, l.name, l.price, l.qty, l.unit, l.total, l.hsn_code || null, l.gst_rate ?? null]
        )
        try {
          await this.stock.applyStockChange(client, {
            shopProductId: l.shop_product_id, delta: -l.qty, type: 'ORDER_DEDUCTION', source: 'DASHBOARD', orderId: order.id, actor: { userId: adminId },
          })
        } catch (err) {
          if (err?.code === 'STOCK_NEGATIVE_FORBIDDEN') throw { statusCode: 400, message: `${l.name} is out of stock at ${shop.name}.` }
          throw err
        }
        await client.query('UPDATE products SET total_sold = total_sold + $1 WHERE id = $2', [l.qty, l.product_id])
      }

      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
         VALUES ($1, NULL, 'CONFIRMED', $2, $3)`,
        [order.id, adminId, isB2B ? 'B2B order taken by admin (on credit)' : paid ? 'Manual order by admin — money already received' : 'Manual order by admin']
      )

      await client.query('COMMIT')
      order._touched = { shopId: shop.id, productIds }
      return order
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Customers for the Create Order screen, each with the labels staff need: a business or a home customer, and
   * whether this person has ever opened the app (staff-added customers who have not are "not on the app yet").
   */
  async customerLookup(search) {
    const term = String(search ?? '').trim().slice(0, 60)
    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, ba.company_name, ba.status AS business_status, u.staff_business_name, u.staff_business_gstin,
              (u.added_by_staff IS NOT NULL) AS added_by_staff, (u.added_by_staff IS NOT NULL AND u.last_active_at IS NULL) AS not_on_app,
              (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id)::int AS order_count
         FROM users u LEFT JOIN business_accounts ba ON ba.user_id = u.id
        WHERE u.role = 'CUSTOMER' AND u.is_active IS NOT FALSE AND u.is_blocked IS NOT TRUE
          AND ($1 = '' OR u.name ILIKE $2 OR u.phone ILIKE $2 OR ba.company_name ILIKE $2 OR u.staff_business_name ILIKE $2)
        ORDER BY (ba.status = 'APPROVED') DESC NULLS LAST, u.last_active_at DESC NULLS LAST, u.created_at DESC LIMIT 10`,
      [term, `%${term}%`]
    )
    return rows
  }

  /** A customer added by staff. If the phone number already has an account, that account is returned untouched. */
  async createCustomerByStaff({ name, phone, businessName, gstin, adminId }) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows: [found] } = await client.query('SELECT id FROM users WHERE phone = $1 FOR UPDATE', [phone])
      if (found) { await client.query('COMMIT'); return { id: found.id, existing: true } }
      const code = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, 'X')
      const { rows: [u] } = await client.query(
        `INSERT INTO users (phone, name, role, referral_code, added_by_staff, staff_added_at, staff_business_name, staff_business_gstin)
         VALUES ($1, $2, 'CUSTOMER', $3, $4, NOW(), $5, $6) RETURNING id`,
        [phone, name, code, adminId, businessName || null, gstin || null]
      )
      await client.query('COMMIT')
      return { id: u.id, existing: false }
    } catch (err) {
      await client.query('ROLLBACK')
      if (err?.code === '23505') throw { statusCode: 409, message: 'That phone number or referral code is already in use. Try again.' }
      throw err
    } finally {
      client.release()
    }
  }

  /** The store that will deliver a manual order: the one chosen, the only one, or the only one that can cover every line. */
  async _resolveManualOrderShop(client, shopId, productIds, quantities) {
    if (shopId) {
      const { rows: [shop] } = await client.query('SELECT id, name FROM shops WHERE id = $1 AND is_active = true AND deleted_at IS NULL', [shopId])
      if (!shop) throw { statusCode: 400, message: 'That store is not active.' }
      return shop
    }
    const { rows: shops } = await client.query('SELECT id, name FROM shops WHERE is_active = true AND deleted_at IS NULL ORDER BY name')
    if (shops.length === 1) return shops[0]
    const { rows: ok } = await client.query(
      `SELECT s.id, s.name FROM shops s
        WHERE s.is_active = true AND s.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM unnest($1::uuid[], $2::int[]) AS w(pid, qty)
             WHERE NOT EXISTS (SELECT 1 FROM shop_products sp WHERE sp.shop_id = s.id AND sp.product_id = w.pid AND sp.deleted_at IS NULL AND sp.is_available IS NOT FALSE AND sp.stock_quantity >= w.qty))
        ORDER BY s.name`,
      [productIds, quantities]
    )
    if (ok.length === 1) return ok[0]
    if (ok.length === 0) throw { statusCode: 400, message: 'No single store has enough stock for all of these items. Choose a store, or change the quantities.', code: 'NO_STORE_HAS_STOCK' }
    throw { statusCode: 400, message: 'Choose which store will deliver this order.', code: 'SHOP_REQUIRED' }
  }

  async invalidateStockCaches(order) {
    if (!order?._touched) return
    const { invalidateCatalogCaches } = await import('../../catalog-bulk/catalog-cache.js')
    await invalidateCatalogCaches({ shopIds: [order._touched.shopId], productIds: order._touched.productIds })
  }

  async markManualOrderPaid(orderId, adminId, note) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows: [o] } = await client.query(`UPDATE orders SET payment_status = 'PAID', updated_at = NOW() WHERE id = $1 AND payment_method = 'MANUAL' AND payment_status <> 'PAID' RETURNING *`, [orderId])
      if (!o) throw { statusCode: 409, message: 'This order is already marked paid.' }
      await client.query(`INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note) VALUES ($1, $2, $2, $3, $4)`, [orderId, o.status, adminId, `Money received${note ? ` — ${note}` : ''}`])
      await client.query('COMMIT')
      return o
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async getOrdersForExport({ status, startDate, endDate }) {
    let sql = `
      SELECT o.order_number, o.status, o.total_amount, o.payment_method, o.payment_status,
             o.created_at, u.name AS customer, u.phone, o.delivery_address->>'city' AS city
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE 1=1
    `
    const params = []
    let idx = 1
    if (status) { params.push(status); sql += ` AND o.status = $${idx++}` }
    if (startDate) { params.push(startDate); sql += ` AND o.created_at >= $${idx++}` }
    if (endDate) { params.push(endDate); sql += ` AND o.created_at <= $${idx++}` }
    sql += ' ORDER BY o.created_at DESC'

    const { rows } = await query(sql, params)
    return rows
  }

  async findUserByPhone(phone) {
    const { rows } = await query('SELECT id, name, phone FROM users WHERE phone = $1', [phone])
    return rows[0] || null
  }
}
