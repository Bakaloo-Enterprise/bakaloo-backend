import { notificationQueue, orderQueue } from '../../../config/bullmq.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { generateInvoicePDF, generatePackingSlipPDF } from '../../../utils/invoiceGenerator.js'
import { generateGstInvoicePDF } from '../../../utils/gstInvoiceGenerator.js'
import { query as dbQuery, getClient, pool } from '../../../config/database.js'
import { logger } from '../../../config/logger.js'
import { NotificationsRepository } from '../../notifications/notifications.repository.js'
import { NotificationsService } from '../../notifications/notifications.service.js'
import { buildCustomerOrderEventNotification } from '../../notifications/customer-order-event.helper.js'
import { ShopProductsRepository } from '../../shop-products/shop-products.repository.js'
import { ShopProductsService } from '../../shop-products/shop-products.service.js'
import { buildOrderBill } from '../../../utils/orderBill.js'
import { extractAddressId } from '../../../utils/deliveryAddress.js'
import { getActivePickupToken } from '../../../utils/pickupTokens.js'
import { RiderAssignmentResolverService } from '../../rider-assignment/rider-assignment-resolver.service.js'
import { RiderAssignmentRepository } from '../../rider-assignment/rider-assignment.repository.js'
import { FinalizeAssignmentRepository } from '../../rider-assignment/finalize-assignment.repository.js'
import { CashbackService } from '../../cashback/cashback.service.js'
import { SpinWheelService } from '../../spin-wheel/spin-wheel.service.js'
import { ScratchCardService } from '../../scratch-card/scratch-card.service.js'
import { BusinessAccountsRepository } from '../../business-accounts/business-accounts.repository.js'
import ExcelJS from 'exceljs'

const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

const ALLOWED_TRANSITIONS = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['PACKED', 'CANCELLED'],
  PACKED: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: ['REFUNDED'],
  REFUNDED: [],
}

/**
 * Resolve a genuine road-route distance for the admin order-detail view —
 * never a straight-line (haversine) distance mislabeled as a road route.
 *
 * Checks, in priority order, for an actual stored route on the order:
 *   1. `route_distance_meters` — calculated ONCE at order placement via
 *      OpenRouteService and stored permanently (see
 *      OrderSplitterService#fireRouteDistanceLookup). This is the normal
 *      path for every order placed since migration 092.
 *   2. The sum of stored Google Directions route legs, for forward
 *      compatibility if a Google-sourced route is ever stored instead.
 *
 * Deliberately does NOT fall back to `delivery_assignments.distance_km`
 * (surfaced elsewhere as "Distance: X km") — that field is computed via
 * `haversineDistanceKm()` in workers/processors.js for rider auto-assignment
 * ranking, not a road route, so using it here would violate the "never show
 * straight-line distance as road distance" requirement this field exists to
 * satisfy. No polyline-decoding tier either: nothing in this schema stores
 * an encoded route polyline — add it if that ever changes.
 *
 * Returns `{ distance_km: null, source: null }` when no real route data
 * exists — the frontend renders that as "Road distance unavailable".
 *
 * Snake_case keys deliberately, to match every other field this endpoint
 * returns (customer_name, total_amount, route_distance_meters, ...) — the
 * dashboard's OrderDeliveryRoute type reads `distance_km`, not `distanceKm`.
 */
function resolveRoadRouteDistance(order) {
  const directMeters = Number(order.route_distance_meters ?? null)
  if (Number.isFinite(directMeters) && directMeters > 0) {
    return {
      distance_km: roundRouteKm(directMeters / 1000),
      source: order.route_source || 'stored_route_meters',
    }
  }

  const legs = order.route_legs || order.google_directions?.routes?.[0]?.legs
  if (Array.isArray(legs) && legs.length > 0) {
    const totalMeters = legs.reduce((sum, leg) => sum + (Number(leg?.distance?.value) || 0), 0)
    if (totalMeters > 0) {
      return { distance_km: roundRouteKm(totalMeters / 1000), source: 'route_legs_sum' }
    }
  }

  return { distance_km: null, source: null }
}

// One decimal place at any distance — "6.8 km" and "14.2 km" alike.
function roundRouteKm(km) {
  return Math.round(km * 10) / 10
}


export class AdminOrdersService {
  constructor(repository, fastify) {
    this.repository = repository
    this.fastify = fastify
    this.notificationsService = fastify
      ? new NotificationsService(new NotificationsRepository(), fastify)
      : null
    this.shopProductsRepo = new ShopProductsRepository()
    this.riderAssignmentResolver = new RiderAssignmentResolverService(fastify)
    this.riderAssignmentLogRepo = new RiderAssignmentRepository()
    this.finalizeAssignmentRepo = new FinalizeAssignmentRepository()
    this.cashbackService = new CashbackService()
    this.spinWheelService = new SpinWheelService()
    this.scratchCardService = new ScratchCardService()
    this.businessAccountsRepo = new BusinessAccountsRepository()
  }

  /**
   * Restore stock for every line item of an order being cancelled
   * pre-delivery (Requirements 23 — CANCELLATION_RESTORE). Best-effort: a
   * restore failure must never block the cancellation response, since the
   * order's CANCELLED status has already committed by the time this runs —
   * but the result IS returned (previously only logged) so the caller can
   * surface a warning instead of silently reporting "Order cancelled" when
   * stock wasn't actually restored (e.g. the listing was deleted between
   * order placement and cancellation).
   *
   * @returns {Promise<{ restoredCount: number, failedItems: Array<{shopProductId: string, productName: string|null, reason: string}> }>}
   */
  async _restoreStockForCancellation(orderId, shopId, adminId) {
    try {
      const items = await this.repository.getOrderItems(orderId)
      const client = await getClient()
      let result
      try {
        await client.query('BEGIN')
        result = await this.shopProductsRepo.restoreStockForCancelledOrder(client, {
          orderId,
          items,
          source: 'DASHBOARD',
          actor: { userId: adminId, shopRole: null },
        })
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
      // Cache invalidation happens after COMMIT per applyStockChange()'s
      // contract — every other stock-mutating path does the same.
      if (shopId) {
        await new ShopProductsService(this.shopProductsRepo).invalidateShopCache(shopId)
      }
      return result
    } catch (err) {
      logger.warn(
        { err: err.message, orderId },
        'Stock restore failed during admin cancellation (non-blocking)'
      )
      return {
        restoredCount: 0,
        failedItems: [{ shopProductId: null, productName: null, reason: err.message }],
      }
    }
  }

  /**
   * Send a customer push/in-app notification, best-effort. Mirrors the
   * working pattern already used by delivery.service.js — the previous
   * `notificationQueue.add('order-status-changed', ...)` calls here were a
   * dead path: the BullMQ notification worker only handles job.data.type
   * values 'push'/'in-app'/'order-status', but these calls never set a
   * `type` field, so every admin-driven order-status/cancel/refund
   * notification silently no-op'd since the feature was first built.
   */
  async _queueNotification(userId, notif) {
    if (!this.notificationsService || !userId || !notif) return
    try {
      await this.notificationsService.sendNotification(userId, notif)
    } catch (err) {
      console.error('Failed to send customer notification:', err?.message || err)
    }
  }

  async findAll(filters) {
    const offset = ((filters.page || 1) - 1) * (filters.limit || 20)
    const result = await this.repository.findAll({ ...filters, offset, limit: filters.limit || 20 })
    return {
      orders: result.orders,
      pagination: {
        page: filters.page || 1,
        limit: filters.limit || 20,
        total: result.total,
        totalPages: Math.ceil(result.total / (filters.limit || 20)),
      },
    }
  }

  async getStatsByStatus() {
    const [statusCounts, needsPaymentReview, recoveredFromFailed] = await Promise.all([
      this.repository.getStatsByStatus(),
      this.repository.countNeedsPaymentReview(),
      this.repository.countRecoveredFromFailed(),
    ])
    // NEEDS_REVIEW/RECOVERED aren't real order_status values — they're
    // payment-metadata flags spanning any order status — but bundled here
    // so the Orders page's existing tab-badge hook (useOrderStatusCounts)
    // surfaces them for free instead of needing extra round-trips.
    return { ...statusCounts, NEEDS_REVIEW: needsPaymentReview, RECOVERED: recoveredFromFailed }
  }

  async findById(orderId) {
    const [order, items, timeline, payment, delivery, pickupToken, assignmentHistory] = await Promise.all([
      this.repository.findById(orderId),
      this.repository.getOrderItems(orderId),
      this.repository.getOrderTimeline(orderId),
      this.repository.getOrderPayment(orderId),
      this.repository.getOrderDelivery(orderId),
      this.repository.getOrderPickupToken(orderId),
      this.riderAssignmentLogRepo.getAssignmentHistory(orderId),
    ])
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    const cashback = await dbQuery(
      `SELECT amount, status, source_type FROM cashback_transactions
        WHERE order_id = $1 AND status IN ('PENDING', 'CREDITED')`,
      [orderId]
    ).then((r) => r.rows).catch(() => [])

    const hasShopCoords = order.shop_lat != null && order.shop_lng != null
    const store = order.shop_id
      ? {
          id: order.shop_id,
          name: order.shop_name || null,
          lat: hasShopCoords ? Number(order.shop_lat) : null,
          lng: hasShopCoords ? Number(order.shop_lng) : null,
        }
      : null

    // Sticky-address rider suggestion — only meaningful before a rider is
    // actually assigned. Pre-fills the admin's "Rider Assignment" dropdown
    // once the order reaches PACKED; never overrides dispatch.
    let suggestedRider = null
    if (!order.rider_id) {
      const addressId = extractAddressId(order.delivery_address)
      if (addressId) {
        suggestedRider = await this.repository.getAddressRiderPreference(order.user_id, addressId)
      }
    }

    return {
      ...order,
      items,
      cashback,
      // Itemised bill for the dashboard + printed receipts (utils/orderBill.js).
      bill: buildOrderBill({ ...order, items: order.items }, { payment, cashback }),
      timeline,
      payment,
      delivery,
      store,
      delivery_route: resolveRoadRouteDistance(order),
      suggested_rider: suggestedRider,
      // "Assignment method / area segment / QR / pickup status" admin-card
      // fields (item 14) — pickup_status mirrors delivery.status since
      // delivery_assignments already tracks ASSIGNED/ACCEPTED/PICKED_UP/...;
      // route/batch position stays null until the multi-order batch model
      // exists (a later phase).
      pickup_token_status: pickupToken?.status ?? null,
      pickup_status: delivery?.status ?? null,
      notification_sent_at: delivery?.notification_sent_at ?? null,
      assignment_history: assignmentHistory,
    }
  }

  async getOrderNotes(orderId) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    return this.repository.getOrderNotes(orderId)
  }

  async addOrderNote(orderId, authorId, body, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    const note = await this.repository.addOrderNote(orderId, authorId, body)

    logAdminActivity(authorId, `Added note to order ${order.order_number}`, 'order', orderId,
      null, { note: body }, ip)

    return note
  }

  async updateStatus(orderId, newStatus, adminId, note, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    const allowed = ALLOWED_TRANSITIONS[order.status]
    if (!allowed || !allowed.includes(newStatus)) {
      throw { statusCode: 400, message: `Cannot transition from ${order.status} to ${newStatus}` }
    }

    // A "Place Order" B2B credit order sits PENDING with its stock
    // deliberately not yet deducted (see migration 128_b2b_place_order.sql)
    // — this generic status-change path must never be used to jump it
    // straight to CONFIRMED/CANCELLED, since that would bypass
    // approveB2BOrder()'s fresh stock re-check and deduction entirely. The
    // dedicated Approve action (B2B Orders page) is the only door out of
    // PENDING for these orders.
    if (order.b2b_approval_status === 'PENDING') {
      throw {
        statusCode: 400,
        message: 'This B2B credit order is awaiting admin approval — approve it from the B2B Orders page before changing its status.',
      }
    }

    const oldStatus = await this.repository.updateStatus(orderId, newStatus, adminId, note)

    logAdminActivity(adminId, `Order status: ${oldStatus} → ${newStatus}`, 'order', orderId,
      { status: oldStatus }, { status: newStatus }, ip)

    // Push/in-app notification to the customer
    await this._queueNotification(order.user_id, buildCustomerOrderEventNotification({
      orderId, orderNumber: order.order_number, timelineType: newStatus, status: newStatus,
    }))

    this._emitOrderStatus(order, newStatus)

    // Finalize rider assignment when the order becomes dispatch-ready
    // (PACKED) — the new modular resolver (manual > area segment > general
    // auto) runs here instead of the old CONFIRMED/PREPARING/PACKED
    // proximity fan-out. _queueAutoAssign/handleAutoAssign remain in the
    // codebase but are no longer invoked from this path.
    if (newStatus === 'PACKED' && !order.rider_id) {
      try {
        await this.riderAssignmentResolver.resolveAndFinalize(orderId, { trigger: `STATUS_${newStatus}` })
      } catch (err) {
        // Don't fail the status update — admin can still manually assign
        console.error('Rider assignment resolver failed (non-blocking):', err.message)
      }
    }

    // A rider can already be assigned by the time the order is cancelled —
    // without this the assignment silently lingers as ACCEPTED forever and
    // the rider's app keeps showing a pickup for an order that's gone.
    if (newStatus === 'CANCELLED') {
      try {
        await this.finalizeAssignmentRepo.cancelOpenAssignment(pool, orderId, note || 'Order cancelled')
      } catch (err) {
        console.error('Rider assignment cleanup failed after cancel (non-blocking):', err.message)
      }
      this.cashbackService.cancelForOrder(orderId).catch((err) => {
        logger.warn({ err: err.message, orderId }, 'Cashback cancellation failed (admin status update)')
      })
    }

    // Every other order-status path that reaches DELIVERED (rider app,
    // legacy orders.service.js adminUpdateStatus) credits any PENDING
    // cashback whose trigger is ORDER_DELIVERED — this dashboard-driven
    // transition was the one path that never did, so cashback silently
    // never landed for orders marked delivered from here.
    if (newStatus === 'DELIVERED') {
      this.cashbackService.evaluateAndCredit(orderId, 'ORDER_DELIVERED').catch((err) => {
        logger.warn({ err: err.message, orderId }, 'Cashback evaluation failed (admin status update)')
      })
      this.spinWheelService.evaluateMilestones(order.user_id).catch((err) => {
        logger.warn({ err: err.message, orderId }, 'Spin milestone evaluation failed (admin status update)')
      })
      this.scratchCardService.evaluateMilestones(order.user_id).catch((err) => {
        logger.warn({ err: err.message, orderId }, 'Scratch milestone evaluation failed (admin status update)')
      })
    }

    // orders.rider_id is never cleared by the DELIVERED/CANCELLED SQL above
    // (that only flips delivery_assignments.status) — leaving it stale is
    // what made a dashboard-driven status change leave the order looking
    // permanently "assigned" to the rider. Once the order reaches either
    // terminal state, the rider is done with it, so unassign for real.
    if (newStatus === 'DELIVERED' || newStatus === 'CANCELLED') {
      try {
        await this.finalizeAssignmentRepo.clearOrderAssignment(pool, orderId)
      } catch (err) {
        console.error('Rider unassignment failed after status update (non-blocking):', err.message)
      }
    }

    return { orderId, oldStatus, newStatus }
  }

  /**
   * Change an order's scheduled delivery slot after the fact — the
   * mistake-correction path (e.g. store closed unexpectedly and existing
   * pending orders need their promised slot pushed). Not a status
   * transition, so it doesn't go through ALLOWED_TRANSITIONS; instead it's
   * blocked once the order has reached a state where delivery timing is
   * no longer meaningful to change.
   */
  async rescheduleDelivery(orderId, { scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel, reason }, adminId, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    const TERMINAL_STATUSES = new Set(['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'REFUNDED'])
    if (TERMINAL_STATUSES.has(order.status)) {
      throw {
        statusCode: 400,
        message: `Cannot reschedule delivery for an order that is ${order.status}`,
      }
    }

    const before = {
      deliveryMode: order.delivery_mode,
      scheduledSlotStart: order.scheduled_slot_start,
      scheduledSlotEnd: order.scheduled_slot_end,
      scheduledSlotLabel: order.scheduled_slot_label,
    }

    const updated = await this.repository.rescheduleDelivery(orderId, {
      scheduledSlotStart,
      scheduledSlotEnd,
      scheduledSlotLabel,
    })

    logAdminActivity(
      adminId,
      `Order delivery rescheduled${reason ? `: ${reason}` : ''}`,
      'order',
      orderId,
      before,
      { deliveryMode: 'SCHEDULED', scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel },
      ip
    )

    await notificationQueue.add('order-rescheduled', {
      orderId,
      userId: order.user_id,
      orderNumber: order.order_number,
      scheduledSlotLabel,
    })

    this._emitOrderStatus(order, order.status) // status unchanged — just refresh delivery info

    return updated
  }

  async assignRider(orderId, riderId, adminId, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    // Manual admin assignment — tier 1, always wins, routed through the
    // same resolver/finalize path as area-segment and auto assignment so
    // there's exactly one place that creates delivery_assignments rows,
    // mints QR pickup tokens, and sends the rider notification.
    const result = await this.riderAssignmentResolver.resolveAndFinalize(orderId, {
      manualRiderId: riderId,
      actorAdminId: adminId,
      trigger: 'ADMIN_ASSIGN',
    })
    if (!result.success) {
      throw { statusCode: 400, message: `Could not assign rider: ${result.reason}` }
    }

    // Remember this rider for the customer's saved address — every manual
    // assign/reassign becomes the new sticky suggestion for next time.
    // Independent of (and unaffected by) the area-segment feature, which
    // is a hard admin-configured assignment rather than a UI hint.
    const addressId = extractAddressId(order.delivery_address)
    if (addressId) {
      await this.repository.upsertAddressRiderPreference(order.user_id, addressId, riderId)
    }

    logAdminActivity(adminId, `Assigned rider to order`, 'order', orderId,
      { rider_id: order.rider_id }, { rider_id: riderId }, ip)

    return { orderId, riderId }
  }

  async bulkAssign(assignments, adminId, ip) {
    if (assignments.length > 50) throw { statusCode: 400, message: 'Max 50 assignments at once' }

    const results = []
    for (const { orderId, riderId } of assignments) {
      const result = await this.riderAssignmentResolver.resolveAndFinalize(orderId, {
        manualRiderId: riderId,
        actorAdminId: adminId,
        trigger: 'ADMIN_BULK_ASSIGN',
      })
      results.push({
        assignmentId: result.assignmentId ?? null,
        orderId,
        riderId,
        status: result.success ? 'assigned' : 'failed',
        reason: result.success ? undefined : result.reason,
      })
    }

    logAdminActivity(adminId, `Bulk assigned ${assignments.length} orders`, 'order', null, null,
      { count: assignments.length }, ip)

    return results
  }

  async createManualOrder(data, adminId, ip) {
    const order = await this.repository.createManualOrder({ ...data, adminId })
    logAdminActivity(adminId, `Created manual order ${order.order_number}`, 'order', order.id,
      null, { order_number: order.order_number, total: order.total_amount }, ip)
    // Rider assignment resolves at PACKED, same as every other order — a
    // manual order is created CONFIRMED, so this only fires if it was
    // somehow created already-PACKED; the normal path resolves later via
    // updateStatus().
    if (!order.rider_id && order.status === 'PACKED') {
      await this.riderAssignmentResolver.resolveAndFinalize(order.id, { trigger: 'ADMIN_MANUAL_ORDER' })
    }
    return order
  }

  async getInvoice(orderId) {
    const order = await this._withPickupTokenForInvoice(orderId)
    return generateInvoicePDF(order)
  }

  async getPackingSlip(orderId) {
    const order = await this._withPickupTokenForInvoice(orderId)
    return generatePackingSlipPDF(order)
  }

  /** A4 GST tax invoice — separate document from getInvoice() above (an 80mm POS receipt). */
  async getGstInvoice(orderId) {
    const order = await this._withPickupTokenForInvoice(orderId)
    return generateGstInvoicePDF(order)
  }

  /**
   * Attaches the raw active pickup token (if any) so invoiceGenerator can
   * embed the signed QR. Kept off the plain findById() result so it never
   * leaks into the admin order-detail JSON response.
   */
  async _withPickupTokenForInvoice(orderId) {
    const order = await this.findById(orderId)
    const rawToken = await getActivePickupToken(orderId)
    return {
      ...order,
      pickup_token: rawToken
        ? { assignmentId: rawToken.delivery_assignment_id, token: rawToken.token, version: rawToken.version }
        : null,
    }
  }

  async exportCSV(filters) {
    const orders = await this.repository.getOrdersForExport(filters)
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Orders')

    sheet.columns = [
      { header: 'Order Number', key: 'order_number', width: 20 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Total (₹)', key: 'total_amount', width: 12 },
      { header: 'Payment', key: 'payment_method', width: 12 },
      { header: 'Payment Status', key: 'payment_status', width: 15 },
      { header: 'Customer', key: 'customer', width: 25 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'City', key: 'city', width: 15 },
      { header: 'Date', key: 'created_at', width: 22 },
    ]

    orders.forEach(o => sheet.addRow(o))

    return workbook.csv.writeBuffer()
  }

  /**
   * Refund a delivered/cancelled order. The refund amount is never
   * caller-supplied — it's always exactly what the customer actually paid
   * (from the `payments` row for online orders, or `total_amount` for a
   * COD order marked PAID on delivery — see `delivery.repository.js`'s
   * `payment_status = 'PAID'` write, the single source of truth for
   * "money actually changed hands" across both payment methods). An order
   * that was never paid (e.g. a COD order cancelled before delivery) has
   * nothing to refund and is rejected outright.
   */
  async refundOrder(orderId, { reason, refundTo = 'wallet' }, adminId, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    // Only delivered or cancelled orders can be refunded
    if (!['DELIVERED', 'CANCELLED'].includes(order.status)) {
      throw { statusCode: 400, message: `Cannot refund an order with status ${order.status}` }
    }

    if (order.payment_status !== 'PAID') {
      throw { statusCode: 400, message: 'This order was never paid — there is nothing to refund' }
    }

    // This endpoint's entire purpose is moving money back to the customer —
    // 'none' previously fell through to the bottom of this method anyway,
    // marking the order REFUNDED and sending a "your refund has been
    // processed" push even though ₹0 ever moved. Customers correctly read
    // that as a lie. Cancelling without a refund is a real, valid action —
    // it belongs to cancelOrder()'s refundTo='none' branch, which already
    // skips the order status change and the refund notification entirely.
    if (refundTo === 'none') {
      throw {
        statusCode: 400,
        message: 'Choose a refund destination — this action always refunds money. To cancel the order without a refund, use Cancel Order instead.',
      }
    }

    const payment = await this.repository.getOrderPayment(orderId)
    // The `payment.amount` branch (a genuine gateway payment) already
    // excludes any wallet offset — payments.service.js#createPaymentOrder
    // only ever charges Razorpay the remainder after wallet_amount_used.
    // The `order.total_amount` fallback (COD, no gateway row) must
    // subtract it explicitly, or a partial-offset COD refund would refund
    // the wallet-covered portion too, as if it were cash the customer paid.
    const paidAmount = payment
      ? parseFloat(payment.amount)
      : parseFloat(order.total_amount) - parseFloat(order.wallet_amount_used || 0)
    const hasGatewayPayment = !!(payment && payment.status === 'PAID' && payment.razorpay_payment_id)
    const refundAmount = paidAmount

    if (refundTo === 'original') {
      if (!hasGatewayPayment) {
        throw {
          statusCode: 400,
          message: 'No online payment on this order to refund to the original method — use Wallet instead',
        }
      }
      const { PaymentsService } = await import('../../payments/payments.service.js')
      const { PaymentsRepository } = await import('../../payments/payments.repository.js')
      const result = await new PaymentsService(new PaymentsRepository()).refund(payment.id, {
        reason: reason || `Refund for order ${order.order_number}`,
      })
      if (!result.success) {
        throw { statusCode: 400, message: result.message || 'Refund failed' }
      }
    } else if (refundTo === 'wallet') {
      const { AdminCustomersRepository } = await import('../customers/customers.repository.js')
      const customersRepo = new AdminCustomersRepository()
      await customersRepo.creditWallet(
        order.user_id,
        refundAmount,
        reason || `Refund for order ${order.order_number}`
      )
    }
    // refundTo === 'none' moves no money — order still gets marked
    // REFUNDED below so it's recorded as closed-out, just with ₹0 back.

    // Update order status to REFUNDED (also true when PaymentsService.refund
    // already flipped it — this call is idempotent and adds the
    // admin-attributed order_status_history row for the audit trail).
    const oldStatus = await this.repository.updateStatus(orderId, 'REFUNDED', adminId, reason || 'Refund issued')

    logAdminActivity(
      adminId,
      `Refund ₹${refundAmount} (${refundTo}) for order ${order.order_number}`,
      'order', orderId,
      { status: oldStatus }, { status: 'REFUNDED', refundTo, refundAmount },
      ip
    )

    const refundDestination = refundTo === 'original' ? 'original payment method' : 'wallet'
    await this._queueNotification(order.user_id, {
      title: '💰 Refund processed',
      body: refundAmount > 0
        ? `₹${refundAmount} has been refunded to your ${refundDestination} for order ${order.order_number}.`
        : `Your refund for order ${order.order_number} has been processed.`,
      type: 'ORDER_STATUS',
      data: {
        type: 'ORDER_STATUS', orderId, orderNumber: order.order_number,
        timelineType: 'REFUNDED', status: 'REFUNDED', refundAmount, refundTo,
      },
    })

    // Previously missing — unlike updateStatus()/rescheduleDelivery(), this
    // never emitted a Socket.IO order:status event, so the DB/notification
    // were correct but the customer's app kept showing the pre-refund
    // status until the order list/detail was manually refreshed.
    this._emitOrderStatus(order, 'REFUNDED')

    return { orderId, refundAmount, refundTo, status: 'REFUNDED' }
  }

  /**
   * Manually re-check a single order's payment against Razorpay directly —
   * the dashboard's "Re-check with Razorpay" action, for a payment stuck
   * PENDING (or one the customer/support suspects was actually captured).
   * Shares the exact fetchPayments-then-finalize path as the payment-expiry
   * worker and the customer cancel-time check
   * (PaymentsService.reconcileWithRazorpay) rather than a fourth
   * independent copy of the same logic.
   */
  async reconcilePayment(orderId, adminId, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    const payment = await this.repository.getOrderPayment(orderId)
    if (!payment || !payment.razorpay_order_id) {
      throw { statusCode: 400, message: 'No online Razorpay payment on this order to reconcile' }
    }

    const { PaymentsService } = await import('../../payments/payments.service.js')
    const { PaymentsRepository } = await import('../../payments/payments.repository.js')
    const paymentsService = new PaymentsService(new PaymentsRepository(), this.fastify)

    const result = await paymentsService.reconcileWithRazorpay(
      payment.razorpay_order_id,
      'ADMIN_MANUAL_RECONCILE'
    )

    logAdminActivity(
      adminId,
      `Manually re-checked Razorpay payment for order ${order.order_number}`,
      'order',
      orderId,
      { paymentStatus: payment.status },
      { captured: result.captured, needsManualReview: !!result.needsManualReview },
      ip
    )

    return {
      captured: result.captured,
      needsManualReview: !!result.needsManualReview,
      order: await this.repository.findById(orderId),
    }
  }

  /**
   * Full Razorpay payment detail for the order's payment, fetched live —
   * the dashboard's "Razorpay Details" panel, so support/finance never has
   * to leave the order drawer to see the VPA/bank/fee/ARN Razorpay tracks.
   */
  async getRazorpayDetails(orderId) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    const payment = await this.repository.getOrderPayment(orderId)
    if (!payment || !payment.razorpay_payment_id) {
      throw { statusCode: 404, message: 'No captured Razorpay payment on this order yet' }
    }

    const { PaymentsService } = await import('../../payments/payments.service.js')
    const { PaymentsRepository } = await import('../../payments/payments.repository.js')
    const paymentsService = new PaymentsService(new PaymentsRepository())

    return paymentsService.getFullRazorpayDetails(payment.razorpay_payment_id)
  }

  /**
   * Bulk "Re-check with Razorpay" — the historical-audit tool: select a
   * batch of old orders already marked FAILED (or stuck PENDING) and
   * re-verify each directly against Razorpay, recovering any that were
   * actually captured. Sequential, not parallel — respects Razorpay's
   * per-account rate limits rather than firing 50 requests at once.
   */
  async bulkReconcilePayments(orderIds, adminId, ip) {
    if (orderIds.length > 50) throw { statusCode: 400, message: 'Max 50 orders at once' }

    const results = []
    for (const orderId of orderIds) {
      try {
        const result = await this.reconcilePayment(orderId, adminId, ip)
        results.push({ orderId, captured: result.captured, needsManualReview: result.needsManualReview })
      } catch (err) {
        results.push({ orderId, error: err.message || 'Reconcile failed' })
      }
    }

    logAdminActivity(adminId, `Bulk re-checked ${orderIds.length} orders against Razorpay`, 'order', null, null,
      { count: orderIds.length, recovered: results.filter((r) => r.captured).length }, ip)

    return results
  }

  async cancelOrder(orderId, body, adminId, ip) {
    const { reason, refundTo } = body || {}
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }

    // Treat null status as PENDING
    const currentStatus = order.status || 'PENDING'
    const allowed = ALLOWED_TRANSITIONS[currentStatus]
    if (!allowed || !allowed.includes('CANCELLED')) {
      throw { statusCode: 400, message: `Cannot cancel an order with status ${currentStatus}` }
    }

    // Cancel the order
    const oldStatus = await this.repository.updateStatus(orderId, 'CANCELLED', adminId, reason || 'Cancelled by admin')

    // A rider can already be assigned by the time the order is cancelled —
    // without this the assignment silently lingers as ACCEPTED forever and
    // the rider's app keeps showing a pickup for an order that's gone.
    try {
      await this.finalizeAssignmentRepo.cancelOpenAssignment(pool, orderId, reason || 'Order cancelled by admin')
    } catch (err) {
      console.error('Rider assignment cleanup failed after cancel (non-blocking):', err.message)
    }

    this.cashbackService.cancelForOrder(orderId).catch((err) => {
      logger.warn({ err: err.message, orderId }, 'Cashback cancellation failed (admin cancel)')
    })

    // Previously missing entirely — an admin cancelling an order never gave
    // the deducted stock back, so every admin-cancelled order permanently
    // understated real available stock. CANCELLED is only reachable
    // pre-delivery (never from DELIVERED), so the product never physically
    // left the store and restoring is always correct here.
    const stockRestoreResult = await this._restoreStockForCancellation(orderId, order.shop_id, adminId)

    // Refund only makes sense once money has actually changed hands — most
    // cancellations happen on PENDING/CONFIRMED orders that were never
    // paid (COD, or an online order cancelled before capture), so skip any
    // money movement unless payment_status is actually PAID. Mirrors the
    // same gate as `refundOrder`.
    let refundAmount = 0
    let appliedRefundTo = 'none'
    if (refundTo && refundTo !== 'none' && order.payment_status === 'PAID') {
      const payment = await this.repository.getOrderPayment(orderId)
      // See refundOrder()'s identical computation above for why the COD
      // fallback branch subtracts wallet_amount_used.
      const paidAmount = payment
        ? parseFloat(payment.amount)
        : parseFloat(order.total_amount) - parseFloat(order.wallet_amount_used || 0)
      const hasGatewayPayment = !!(payment && payment.status === 'PAID' && payment.razorpay_payment_id)

      if (refundTo === 'original' && hasGatewayPayment) {
        const { PaymentsService } = await import('../../payments/payments.service.js')
        const { PaymentsRepository } = await import('../../payments/payments.repository.js')
        const result = await new PaymentsService(new PaymentsRepository()).refund(payment.id, {
          reason: reason || `Refund for cancelled order ${order.order_number}`,
        })
        if (result.success) {
          refundAmount = paidAmount
          appliedRefundTo = 'original'
        }
      } else {
        // 'wallet', or 'original' requested but no gateway payment on file
        // (e.g. COD collected then cancelled) — fall back to wallet credit
        // rather than silently doing nothing.
        const { AdminCustomersRepository } = await import('../customers/customers.repository.js')
        const customersRepo = new AdminCustomersRepository()
        await customersRepo.creditWallet(
          order.user_id,
          paidAmount,
          reason || `Refund for cancelled order ${order.order_number}`
        )
        refundAmount = paidAmount
        appliedRefundTo = 'wallet'
      }
    }

    logAdminActivity(
      adminId,
      `Cancelled order ${order.order_number}${refundAmount > 0 ? ` (refunded ₹${refundAmount} via ${appliedRefundTo})` : ''}`,
      'order', orderId,
      { status: oldStatus }, { status: 'CANCELLED', refundTo: appliedRefundTo, refundAmount },
      ip
    )

    await this._queueNotification(order.user_id, buildCustomerOrderEventNotification({
      orderId, orderNumber: order.order_number, timelineType: 'CANCELLED', status: 'CANCELLED',
    }))

    if (refundAmount > 0) {
      const refundDestination = appliedRefundTo === 'original' ? 'original payment method' : 'wallet'
      await this._queueNotification(order.user_id, {
        title: '💰 Refund processed',
        body: `₹${refundAmount} has been refunded to your ${refundDestination} for order ${order.order_number}.`,
        type: 'ORDER_STATUS',
        data: {
          type: 'ORDER_STATUS', orderId, orderNumber: order.order_number,
          timelineType: 'REFUNDED', status: 'REFUNDED', refundAmount, refundTo: appliedRefundTo,
        },
      })
    }

    // Previously missing — unlike updateStatus()/rescheduleDelivery(), this
    // never emitted a Socket.IO order:status event, so an admin cancelling
    // an order was correct in the DB (a repeat-cancel correctly gets
    // rejected) but the customer's app kept showing the pre-cancel status
    // until they manually refreshed.
    this._emitOrderStatus(order, 'CANCELLED')

    const stockRestoreWarning = stockRestoreResult.failedItems.length > 0
      ? `Stock could not be restored for: ${stockRestoreResult.failedItems
          .map((f) => f.productName || 'an item')
          .join(', ')}. Please check inventory manually.`
      : null

    return {
      orderId,
      status: 'CANCELLED',
      refundAmount,
      refundTo: appliedRefundTo,
      ...(stockRestoreWarning && { stockRestoreWarning }),
    }
  }

  // ── B2B "Place Order" — see migration 128_b2b_place_order.sql ─────────

  /**
   * List B2B "Place Order" orders (b2b_approval_status IS NOT NULL) for
   * the dedicated B2B Orders dashboard section, newest-first with PENDING
   * ones surfaced before APPROVED ones so an admin's queue always shows
   * what needs action first.
   */
  async findAllB2B({ status, hasPendingCollection, page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit
    const result = await this.repository.findAllB2B({ status, hasPendingCollection, offset, limit })
    return {
      orders: result.orders,
      pagination: {
        page, limit, total: result.total,
        totalPages: Math.ceil(result.total / limit),
      },
    }
  }

  async findB2BById(orderId) {
    // this.findById() (not this.repository.findById()) returns the flat,
    // dashboard-shaped object — order fields spread at the top level
    // alongside items/timeline/payment/delivery/etc. — matching what
    // OrderDetail expects on the frontend.
    const order = await this.findById(orderId)
    if (!order.b2b_approval_status) {
      throw { statusCode: 400, message: 'This order was not placed on B2B credit' }
    }
    const [settlements, businessAccount] = await Promise.all([
      this.repository.getB2BSettlements(orderId),
      this.businessAccountsRepo.findByUserId(order.user_id),
    ])
    return {
      ...order,
      settlements,
      company_name: businessAccount?.company_name || null,
      gst_number: businessAccount?.gst_number || null,
    }
  }

  /**
   * Approve a pending "Place Order" order: deducts stock now (deferred
   * until this exact moment — see OrderSplitterService#createOrders'
   * deferStockDeduction option), confirms the order, and fires the same
   * customer notification/realtime update every other confirmation does.
   * Deliberately never queues rider auto-assignment — B2B deliveries are
   * distributed manually by an admin, not through the rider-assignment
   * system.
   *
   * Stock is re-verified fresh at this point (not trusted from
   * placement time — real time has passed and other orders may have
   * consumed it): if any line is now short, the WHOLE approval is
   * rejected (see ShopProductsRepository#deductStockForApprovedOrder's
   * docstring for why this is all-or-nothing, unlike stock restoration).
   */
  async approveB2BOrder(orderId, adminId, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    if (order.b2b_approval_status !== 'PENDING') {
      throw {
        statusCode: 400,
        message: order.b2b_approval_status === 'APPROVED'
          ? 'This order has already been approved'
          : 'This order was not placed on B2B credit',
      }
    }

    const items = await this.repository.getOrderItems(orderId)

    const client = await getClient()
    let transitions = []
    try {
      await client.query('BEGIN')
      transitions = await this.shopProductsRepo.deductStockForApprovedOrder(client, {
        orderId,
        items,
        source: 'DASHBOARD',
        actor: { userId: adminId, shopRole: null },
      })
      await client.query(
        `UPDATE orders
            SET b2b_approval_status = 'APPROVED', b2b_approved_by = $1, b2b_approved_at = NOW(),
                status = 'CONFIRMED', updated_at = NOW()
          WHERE id = $2`,
        [adminId, orderId]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error(
        { err: err.message, code: err.code, stack: err.stack, orderId },
        'B2B order approval failed'
      )
      throw {
        statusCode: 400,
        message: `Could not approve — ${err.message}`,
      }
    } finally {
      client.release()
    }

    // Post-commit, mirroring OrderSplitterService#firePostCommitSideEffects
    // (cache invalidation + low-stock fan-out) — never allowed to affect
    // the approval's own transaction.
    if (order.shop_id) {
      try {
        await new ShopProductsService(this.shopProductsRepo).invalidateShopCache(order.shop_id)
      } catch (err) {
        logger.warn({ err: err.message, orderId }, 'Shop cache invalidation failed after B2B approval (non-blocking)')
      }
    }
    const shopProductsService = new ShopProductsService(this.shopProductsRepo)
    for (const transition of transitions) {
      try {
        await shopProductsService.handleStockTransitionSideEffects?.(transition)
      } catch (err) {
        logger.error(
          { err: err.message, orderId, shopProductId: transition.shopProduct?.id },
          'Stock transition side effects failed after B2B approval'
        )
      }
    }

    logAdminActivity(
      adminId,
      `Approved B2B credit order ${order.order_number}`,
      'order', orderId,
      { b2b_approval_status: 'PENDING' }, { b2b_approval_status: 'APPROVED', status: 'CONFIRMED' },
      ip
    )

    await this._queueNotification(order.user_id, buildCustomerOrderEventNotification({
      orderId, orderNumber: order.order_number, timelineType: 'CONFIRMED', status: 'CONFIRMED',
    }))
    this._emitOrderStatus(order, 'CONFIRMED')

    return this.repository.findById(orderId)
  }

  /**
   * Record a manual payment-collection entry against a delivered "Place
   * Order" order (e.g. ₹200 cash today, ₹500 online next week — multiple
   * partial entries are expected, not a single all-at-once figure). Rejects
   * an entry that would push the running total past the order's own
   * total_amount — there's no reason to ever collect more than the order
   * itself is worth.
   */
  async recordB2BSettlement(orderId, { method, amount, note }, adminId, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    if (!order.b2b_approval_status) {
      throw { statusCode: 400, message: 'This order was not placed on B2B credit' }
    }
    const parsedAmount = parseFloat(amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw { statusCode: 400, message: 'Settlement amount must be a positive number' }
    }

    const alreadySettled = parseFloat(order.b2b_amount_settled || 0)
    const orderTotal = parseFloat(order.total_amount)
    if (alreadySettled + parsedAmount > orderTotal + 0.01) {
      throw {
        statusCode: 400,
        message: `This would settle ₹${(alreadySettled + parsedAmount).toFixed(2)}, more than the order's own total of ₹${orderTotal.toFixed(2)}.`,
      }
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO order_b2b_settlements (order_id, method, amount, note, recorded_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, method, parsedAmount, note || null, adminId]
      )
      await client.query(
        `UPDATE orders SET b2b_amount_settled = b2b_amount_settled + $1, updated_at = NOW() WHERE id = $2`,
        [parsedAmount, orderId]
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw { statusCode: 400, message: `Could not record settlement — ${err.message}` }
    } finally {
      client.release()
    }

    logAdminActivity(
      adminId,
      `Recorded ₹${parsedAmount} ${method} settlement for B2B order ${order.order_number}`,
      'order', orderId,
      { b2b_amount_settled: alreadySettled }, { b2b_amount_settled: alreadySettled + parsedAmount },
      ip
    )

    return this.repository.findById(orderId)
  }

  /**
   * Set (or clear, passing null) the date a B2B customer promised to pay
   * by — e.g. "5 days later I will pay". Pure scheduling metadata: nothing
   * automated reacts to it (no auto-charge, no auto-suspension), it's just
   * surfaced to the admin on the B2B Orders/Collections pages.
   */
  async setB2BPaymentDueDate(orderId, dueDate, adminId, ip) {
    const order = await this.repository.findById(orderId)
    if (!order) throw { statusCode: 404, message: 'Order not found' }
    if (!order.b2b_approval_status) {
      throw { statusCode: 400, message: 'This order was not placed on B2B credit' }
    }

    await dbQuery(
      `UPDATE orders SET b2b_payment_due_date = $1, updated_at = NOW() WHERE id = $2`,
      [dueDate || null, orderId]
    )

    logAdminActivity(
      adminId,
      dueDate
        ? `Set B2B payment due date for order ${order.order_number} to ${dueDate}`
        : `Cleared B2B payment due date for order ${order.order_number}`,
      'order', orderId,
      { b2b_payment_due_date: order.b2b_payment_due_date || null },
      { b2b_payment_due_date: dueDate || null },
      ip
    )

    return this.repository.findById(orderId)
  }

  async bulkUpdateStatus(orderIds, newStatus, adminId, ip) {
    const results = []
    for (const orderId of orderIds) {
      try {
        const res = await this.updateStatus(orderId, newStatus, adminId, null, ip)
        results.push({ orderId, ...res, success: true })
      } catch (err) {
        results.push({ orderId, success: false, message: err.message || 'Failed' })
      }
    }
    return { updated: results.filter(r => r.success).length, results }
  }

  async _emitAssignedOrder(order, riderId) {
    try {
      if (!this.fastify?.emitOrderAssignedToRider) {
        return
      }

      // Get store location from app_settings (not hardcoded)
      let storeLat = 0, storeLng = 0
      let storeName = 'Bakaloo Store', storeAddr = 'Pickup location', storePhone = ''
      try {
        const { rows } = await dbQuery(
          `SELECT key, value FROM app_settings WHERE key IN ('store_lat', 'store_lng', 'store_name', 'store_address', 'store_phone')`
        )
        for (const row of rows) {
          const val = typeof row.value === 'string' ? row.value.replace(/^"|"$/g, '') : String(row.value)
          switch (row.key) {
            case 'store_lat': storeLat = parseFloat(val) || 0; break
            case 'store_lng': storeLng = parseFloat(val) || 0; break
            case 'store_name': storeName = val; break
            case 'store_address': storeAddr = val; break
            case 'store_phone': storePhone = val; break
          }
        }
      } catch (_) { /* use defaults if settings not found */ }

      const address = this._parseAddress(order.delivery_address)
      const riderEarning = parseFloat(order.delivery_fee || 25)
      this.fastify.emitOrderAssignedToRider(riderId, {
        orderId: order.id,
        orderNumber: order.order_number,
        status: 'ASSIGNED',
        totalAmount: parseFloat(order.total_amount || 0),
        paymentMethod: order.payment_method || 'ONLINE',
        estimatedDistance: 0,
        estimatedDuration: 0,
        riderEarning,
        offerTimeoutSeconds: 0,
        offerExpiresAt: null,
        isOfferActive: true,
        items: this._parseItems(order.items),
        customerAddress: {
          name: order.customer_name || address.name || 'Customer',
          address: address.address || address.fullAddress || 'Delivery address unavailable',
          landmark: address.landmark || '',
          phone: order.customer_phone || address.phone || '',
          lat: address.lat ?? address.latitude ?? 0,
          lng: address.lng ?? address.longitude ?? 0,
        },
        storeAddress: {
          name: storeName,
          address: storeAddr,
          landmark: '',
          phone: storePhone,
          lat: storeLat,
          lng: storeLng,
        },
      })
    } catch (_) {
      // Keep admin assignment non-blocking if realtime emit fails.
    }
  }

  /**
   * Keep admin flow aligned with worker-based auto-assign.
   */
  async _autoAssignRider(orderId, _order) {
    await this._queueAutoAssign(orderId, 'ADMIN_FALLBACK')
  }

  async _queueAutoAssign(orderId, source) {
    try {
      await orderQueue.add(
        'auto-assign',
        { type: 'auto-assign', orderId, source },
        {
          jobId: `auto-assign-${orderId}`,
          removeOnComplete: true,
        }
      )
      if (INLINE_AUTO_ASSIGN_IN_NON_PROD) {
        await this._runAutoAssignFallback(orderId, `${source}_DEV_INLINE`)
      }
    } catch (err) {
      console.warn('Auto-assign queue failed, running inline fallback:', err?.message || err)
      await this._runAutoAssignFallback(orderId, source)
    }
  }

  async _runAutoAssignFallback(orderId, source) {
    try {
      const { processOrderJob } = await import('../../../workers/processors.js')
      await processOrderJob({
        data: {
          type: 'auto-assign',
          orderId,
          source: `${source}_INLINE_FALLBACK`,
        },
      })
    } catch (fallbackErr) {
      console.error('Inline auto-assign fallback failed:', fallbackErr?.message || fallbackErr)
    }
  }

  _emitOrderStatus(order, status) {
    try {
      if (!this.fastify?.emitOrderUpdate) {
        return
      }

      const userIds = [order.user_id, order.rider_id].filter(Boolean)
      this.fastify.emitOrderUpdate(order.id, userIds, {
        orderId: order.id,
        orderNumber: order.order_number,
        status,
        message: this._statusMessage(status),
      })
    } catch (_) {
      // Keep admin status updates non-blocking if realtime emit fails.
    }
  }

  _statusMessage(status) {
    const messages = {
      CANCELLED: 'Order cancelled by support',
      OUT_FOR_DELIVERY: 'Order is now out for delivery',
      DELIVERED: 'Order delivered successfully',
      REFUNDED: 'Order refund processed',
    }

    return messages[status] || `Order updated to ${status}`
  }

  _parseAddress(value) {
    if (!value) return {}
    if (typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch (_) {
        return { address: value }
      }
    }
    return value
  }

  _parseItems(value) {
    if (!value) return []
    if (Array.isArray(value)) return value
    if (typeof value === 'string') {
      try {
        return JSON.parse(value)
      } catch (_) {
        return []
      }
    }
    return []
  }
}
