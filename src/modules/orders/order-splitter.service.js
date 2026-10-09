import { logger } from '../../config/logger.js'
import { ORDER_STATUS } from '../../constants/orderStatus.js'
import { haversineKm } from '../../utils/distance.js'
import { fetchRoadRouteDistanceMeters } from '../../utils/routing.js'
import {
  STOCK_MOVEMENT_TYPES,
  STOCK_MOVEMENT_SOURCES,
} from '../shop-products/shop-products.repository.js'
import { PurchaseLimitsService } from '../purchase-limits/purchase-limits.service.js'

/**
 * Order Splitter — groups a multi-shop cart into one order per shop and
 * persists them atomically inside a single PostgreSQL transaction.
 *
 * Requirements covered:
 *   - 5.6  Group cart items by shop_id and create separate orders
 *   - 5.7  Compute fees independently per shop (free-delivery threshold per shop)
 *   - 5.8  Each order gets its own delivery assignment
 *   - 5.9  Roll back the entire checkout on any failure
 *   - 11.7 SELECT FOR UPDATE on shop_products during stock deduction
 *   - 12.7 Re-validate max_order_qty at checkout
 *   - 15.9/15.10 Multi-table financial writes share a single transaction
 *
 * The splitter is constructed with explicit collaborators so it can be unit
 * tested in isolation:
 *   - ordersRepository       — repo.create(client, …) and repo.generateOrderNumber()
 *   - shopProductsRepository — repo.findByIdForUpdate / repo.applyStockUpdate
 *   - shopProductsService    — optional, exposes
 *       handleStockTransitionSideEffects(...) for post-commit fan-out (Req 11)
 *
 * It does NOT enqueue delivery assignments itself — that responsibility lives
 * with the OrdersService, which reads the returned per-order ids and pushes
 * one job per order onto the existing `orderQueue`. Keeping the splitter pure
 * around the database makes Property 7 (Transaction Atomicity) easy to test.
 *
 * Stock transition side effects (Requirements 11.1–11.4, 11.6, 11.9) are
 * collected during `createOrders` (the in-tx phase records every prev→new
 * transition) and fired by `firePostCommitSideEffects` AFTER the caller's
 * COMMIT. This split keeps the transaction free of best-effort I/O.
 */

const DEFAULT_DELIVERY_FEE = 25
const DEFAULT_PLATFORM_FEE = 5
const DEFAULT_FREE_DELIVERY_THRESHOLD = 499

export class OrderSplitterService {
  /**
   * @param {object} deps
   * @param {object} deps.ordersRepository   - OrdersRepository instance
   * @param {object} deps.shopProductsRepository - ShopProductsRepository instance
   * @param {object} [deps.shopProductsService] - Optional ShopProductsService
   *   used to fire post-commit stock-transition side effects (Req 11). When
   *   omitted, side effects are silently skipped (e.g., test harnesses).
   * @param {object} [deps.fees]
   * @param {number} [deps.fees.deliveryFee=25]
   * @param {number} [deps.fees.platformFee=5]
   * @param {number} [deps.fees.freeDeliveryThreshold=499]
   */
  constructor({
    ordersRepository,
    shopProductsRepository,
    shopProductsService = null,
    feeSettingsService = null,
    totalsEngine = null,
    purchaseLimitsService = null,
    fees = {},
  }) {
    if (!ordersRepository) {
      throw new Error('OrderSplitterService requires ordersRepository')
    }
    if (!shopProductsRepository) {
      throw new Error('OrderSplitterService requires shopProductsRepository')
    }
    this.ordersRepo = ordersRepository
    this.shopProductsRepo = shopProductsRepository
    this.shopProductsService = shopProductsService
    // Admin-configured category/product purchase caps — final,
    // race-condition-safe re-check, run inside this method's transaction.
    this.purchaseLimitsService = purchaseLimitsService || new PurchaseLimitsService()
    // Canonical fee engine + config. When provided, per-shop fees are
    // computed dynamically (distance-based delivery + configurable fees).
    // When absent (e.g. legacy unit tests), the static `fees` fallback
    // below keeps the old behaviour deterministic.
    this.feeSettingsService = feeSettingsService
    this.totalsEngine = totalsEngine
    this.deliveryFee = Number.isFinite(fees.deliveryFee)
      ? fees.deliveryFee
      : DEFAULT_DELIVERY_FEE
    this.platformFee = Number.isFinite(fees.platformFee)
      ? fees.platformFee
      : DEFAULT_PLATFORM_FEE
    this.freeDeliveryThreshold = Number.isFinite(fees.freeDeliveryThreshold)
      ? fees.freeDeliveryThreshold
      : DEFAULT_FREE_DELIVERY_THRESHOLD
  }

  // ────────────────────────────────────────────────────────
  // Pure split (Requirement 5.6, Property 6)
  // ────────────────────────────────────────────────────────

  /**
   * Group cart items by shop_id.
   *
   * Pure: no IO, deterministic. Used directly by Property 6 tests.
   *
   * @param {Array<{productId: string, shopId: string, quantity: number, [key: string]: any}>} cartItems
   * @returns {Map<string, Array<object>>} Map from shop_id to items
   */
  splitCart(cartItems) {
    const groups = new Map()
    for (const item of cartItems || []) {
      if (!item || !item.shopId) continue
      const arr = groups.get(item.shopId)
      if (arr) arr.push(item)
      else groups.set(item.shopId, [item])
    }
    return groups
  }

  // ────────────────────────────────────────────────────────
  // Fee computation (Requirement 5.7)
  // ────────────────────────────────────────────────────────

  /**
   * Compute per-shop totals. Free-delivery threshold is applied to each
   * shop's subtotal in isolation (Requirement 5.7).
   *
   * @param {Array<object>} items
   * @returns {{
   *   subtotal: number,
   *   deliveryFee: number,
   *   platformFee: number,
   *   totalAmount: number,
   * }}
   */
  computeFees(items) {
    const subtotal = items.reduce(
      (sum, item) => sum + Number(item.lineTotal ?? 0),
      0
    )
    const subtotalRounded = Number(subtotal.toFixed(2))
    const deliveryFee =
      subtotalRounded >= this.freeDeliveryThreshold ? 0 : this.deliveryFee
    const platformFee = this.platformFee
    const totalAmount = Number(
      (subtotalRounded + deliveryFee + platformFee).toFixed(2)
    )
    return {
      subtotal: subtotalRounded,
      deliveryFee,
      platformFee,
      totalAmount,
    }
  }

  /**
   * Compute per-shop fees using the canonical TotalsEngine when available,
   * falling back to the legacy static calculation otherwise.
   *
   * @param {object} args
   * @param {string} args.shopId
   * @param {Array<object>} args.items
   * @param {object} args.feeContext - { deliveryCoords, shopCoords(Map), couponDiscount, couponShopId, freeDeliveryOverride, freeDeliveryShopId, configByShop(Map) }
   * @returns {Promise<{
   *   subtotal:number, deliveryFee:number, platformFee:number, handlingFee:number,
   *   smallCartFee:number, surgeFee:number, packagingFee:number, taxAmount:number,
   *   discountAmount:number, savingsTotal:number, totalAmount:number, feeBreakdown:object|null
   * }>}
   */
  async computeShopFees({ shopId, items, feeContext }) {
    const subtotal = Number(
      items.reduce((sum, item) => sum + Number(item.lineTotal ?? 0), 0).toFixed(2)
    )

    // Coupon discount applies only to the shop it was validated against
    // (single-shop carts today). Clamp to subtotal so totals never go negative.
    const couponDiscount =
      feeContext.couponShopId && feeContext.couponShopId === shopId
        ? Math.min(Number(feeContext.couponDiscount || 0), subtotal)
        : 0

    // Tip belongs to a single order (single-shop checkouts only). Apply it to
    // the designated shop so the charged total matches the cart summary.
    const tipAmount =
      feeContext.tipShopId && feeContext.tipShopId === shopId
        ? Number(feeContext.tipAmount || 0)
        : 0

    // Quick Delivery surcharge (opt-in ASAP upgrade) — same single-shop
    // assignment convention as tip/coupon above.
    const quickDeliverySelected =
      feeContext.quickDeliveryShopId && feeContext.quickDeliveryShopId === shopId
        ? !!feeContext.quickDeliverySelected
        : false

    // A coupon (FREE_DELIVERY discountType) or first-time-offer
    // (FREE_DELIVERY rewardType) can waive delivery for this order,
    // scoped to the same single shop the coupon/offer was resolved
    // against (mirrors couponShopId — single-shop carts only, same as
    // coupons today).
    const freeDeliveryOverride =
      feeContext.freeDeliveryShopId && feeContext.freeDeliveryShopId === shopId
        ? !!feeContext.freeDeliveryOverride
        : false

    // Legacy fallback when no engine is wired (unit tests / safety net).
    if (!this.totalsEngine) {
      const deliveryFee = subtotal >= this.freeDeliveryThreshold ? 0 : this.deliveryFee
      const platformFee = this.platformFee
      const totalAmount = Number(
        (subtotal - couponDiscount + deliveryFee + platformFee + tipAmount).toFixed(2)
      )
      return {
        subtotal,
        deliveryFee,
        platformFee,
        handlingFee: 0,
        smallCartFee: 0,
        surgeFee: 0,
        packagingFee: 0,
        taxAmount: 0,
        discountAmount: couponDiscount,
        tipAmount,
        savingsTotal: couponDiscount,
        totalAmount: totalAmount < 0 ? 0 : totalAmount,
        feeBreakdown: null,
        quickDeliverySelected: false,
        quickDeliverySurchargeAmount: 0,
        // GSTR-1: no config resolved on this legacy/no-engine path, so
        // order_items fall back to their own gstRate (from the product) or
        // the historical-fallback COALESCE chain at report time.
        effectiveGlobalGstRate: null,
      }
    }

    // Resolve config (per-shop override → global) and distance.
    const config =
      feeContext.configByShop?.get(shopId) ||
      (await this.feeSettingsService.resolveForShop(shopId)).config

    const coords = feeContext.shopCoords?.get(shopId)
    const deliveryCoords = feeContext.deliveryCoords
    const distanceKm =
      coords &&
      deliveryCoords &&
      Number.isFinite(coords.lat) &&
      Number.isFinite(coords.lng)
        ? haversineKm(deliveryCoords.lat, deliveryCoords.lng, coords.lat, coords.lng)
        : null

    const breakdown = this.totalsEngine.computeBreakdown({
      config,
      itemsSubtotal: subtotal,
      couponDiscount,
      distanceKm,
      tipAmount,
      storeName: coords?.name || null,
      forceFreeDelivery: freeDeliveryOverride,
      quickDeliverySelected,
    })

    // Itemised discount sources (coupon / first-order offer / milestone) so
    // the bill can name each one — see utils/orderBill.js.
    if (couponDiscount > 0 && Array.isArray(feeContext.discountParts)) {
      breakdown.discounts = feeContext.discountParts
    }

    return {
      subtotal: breakdown.itemsSubtotal,
      deliveryFee: breakdown.deliveryFee,
      platformFee: breakdown.platformFee,
      handlingFee: breakdown.handlingFee,
      smallCartFee: breakdown.smallCartFee,
      surgeFee: breakdown.surgeFee,
      packagingFee: breakdown.packagingFee,
      taxAmount: breakdown.tax,
      discountAmount: couponDiscount,
      tipAmount: breakdown.tipAmount,
      savingsTotal: breakdown.totalSavings,
      totalAmount: breakdown.totalPayable,
      feeBreakdown: breakdown,
      quickDeliverySelected,
      quickDeliverySurchargeAmount: breakdown.quickDeliverySurcharge || 0,
      // GSTR-1 HSN Summary snapshot fallback: the GST rate actually
      // configured for this shop at order time, used when an item itself
      // has no per-product gstRate set.
      effectiveGlobalGstRate:
        config?.gst_rate !== undefined && config?.gst_rate !== null
          ? Number(config.gst_rate)
          : null,
    }
  }

  // ────────────────────────────────────────────────────────
  // Atomic create (Requirements 5.6, 5.7, 5.8, 5.9, 11.7)
  // ────────────────────────────────────────────────────────

  /**
   * Create per-shop orders inside a transaction owned by the caller.
   * The caller is responsible for `BEGIN`, `COMMIT`, `ROLLBACK` and
   * releasing the client. Throwing from this method causes the caller's
   * outer try/catch to roll back the entire checkout (Property 7).
   *
   * For each shop group:
   *   1. Lock each shop_product row (SELECT FOR UPDATE) — Req 11.7
   *   2. Re-verify max_order_qty + stock — Req 12.7, 5.5
   *   3. Apply stock decrement (sets is_available/sold_out_at as needed)
   *   4. Insert orders + order_items
   *
   * Any per-item failure throws an Error whose `failures` array lists every
   * `{ productId, shopId, reason, code }`. The OrdersService catches that
   * and surfaces a CHECKOUT_PARTIAL_FAIL response.
   *
   * @param {object} args
   * @param {import('pg').PoolClient} args.client - Open transaction client
   * @param {string} args.userId
   * @param {Map<string, Array<object>>} args.groups - Output of splitCart
   * @param {object} args.deliveryAddress
   * @param {object} args.payment - { method, status }
   * @param {object} [args.checkoutMeta] - Coupon, notes, tip, instructions, etc.
   * @returns {Promise<Array<object>>} Per-shop orders created
   */
  async createOrders({
    client,
    userId,
    groups,
    deliveryAddress,
    payment,
    checkoutMeta = {},
    feeContext = {},
    // B2B "Place Order" (payment_method 'B2B_CREDIT') — see migration
    // 128_b2b_place_order.sql. Stock availability is still verified in
    // step 1 below (so an obviously-impossible order fails fast), but the
    // actual decrement is skipped and deferred to admin approval
    // (ShopProductsRepository#deductStockForApprovedOrder), re-verifying
    // stock fresh at that later point since time will have passed.
    deferStockDeduction = false,
  }) {
    if (!client) throw new Error('createOrders requires an open pg client')
    if (!groups || groups.size === 0) {
      const err = new Error('Cart has no items to split')
      err.code = 'EMPTY_CART'
      err.failures = []
      throw err
    }

    const failures = []
    const createdOrders = []
    /**
     * Captured per-row stock transitions for post-commit fan-out
     * (Req 11.1–11.4, 11.6, 11.9). One entry per item; the caller invokes
     * `firePostCommitSideEffects(transitions)` AFTER COMMIT so a flaky
     * Socket.IO server or queue cannot affect transaction semantics.
     */
    const stockTransitions = []
    /**
     * Captured per-order road-route lookup inputs (store coords + delivery
     * coords) — resolved and stored on the order AFTER commit by
     * `fireRouteDistanceLookup`, exactly once, never recalculated after.
     */
    const routeLookups = []

    // ─── 0. Purchase-limit re-check (race-safe, spans every shop) ─────
    // Distinct from the per-item max_order_qty re-check inside the loop
    // below: a purchase-limit rule is a platform-wide, per-user cap that
    // can span multiple products (a CATEGORY rule) and multiple shops, so
    // it's resolved once here across the WHOLE checkout rather than per
    // shop group. Acquires an advisory lock per restricted rule so two
    // concurrent checkouts from the same user can't both slip under the
    // same cap (see PurchaseLimitsService#evaluateCheckout). Bails before
    // any shop_products lock/mutation, same as the "failures.length > 0"
    // bail below, so a breach here never touches stock.
    const allItemsAcrossShops = Array.from(groups.values()).flat()
    const purchaseLimitFailures = await this.purchaseLimitsService.evaluateCheckout(
      userId,
      allItemsAcrossShops,
      client
    )
    if (purchaseLimitFailures.length > 0) {
      const err = new Error('One or more items exceed a purchase limit')
      err.code = 'CHECKOUT_PARTIAL_FAIL'
      err.failures = purchaseLimitFailures
      throw err
    }

    // Iterate shops in a stable order so test snapshots stay deterministic
    const shopIds = Array.from(groups.keys()).sort()

    for (const shopId of shopIds) {
      const items = groups.get(shopId)

      // ─── 1. Lock + revalidate every shop_product row in this group ────
      const verified = []
      for (const item of items) {
        const locked = await this.shopProductsRepo.findByIdForUpdate(
          client,
          item.shopProductId,
          shopId
        )

        if (!locked) {
          failures.push({
            productId: item.productId,
            shopId,
            reason: 'Product is no longer available in this shop',
            code: 'SHOP_PRODUCT_UNAVAILABLE',
          })
          continue
        }

        if (locked.is_available !== true) {
          failures.push({
            productId: item.productId,
            shopId,
            reason: 'Product is currently unavailable',
            code: 'SHOP_PRODUCT_UNAVAILABLE',
          })
          continue
        }

        // Requirement 12.7 — re-validate max_order_qty at checkout time
        const maxOrderQty = Number(locked.max_order_qty)
        if (item.quantity > maxOrderQty) {
          failures.push({
            productId: item.productId,
            shopId,
            reason: `Quantity exceeds the per-order limit of ${maxOrderQty}`,
            code: 'MAX_QTY_EXCEEDED',
            max: maxOrderQty,
          })
          continue
        }

        const stockQty = Number(locked.stock_quantity)
        if (stockQty < item.quantity) {
          failures.push({
            productId: item.productId,
            shopId,
            reason: `Only ${stockQty} units available`,
            code: 'INSUFFICIENT_STOCK',
            available: stockQty,
          })
          continue
        }

        verified.push({ item, locked })
      }

      if (failures.length > 0) {
        // Bail before any mutation — the caller's catch block will roll back
        // BEGIN. We do NOT continue to other shop groups: Requirement 5.9
        // demands an all-or-nothing checkout.
        const err = new Error('One or more items failed checkout validation')
        err.code = 'CHECKOUT_PARTIAL_FAIL'
        err.failures = failures
        throw err
      }

      // ─── 2. Compute fees per shop and insert order ────────────────────
      // Order creation happens BEFORE the stock decrement (moved ahead of
      // its historical position) because the centralized
      // applyStockChange() ledger write requires a real order_id to stamp
      // on the stock_movements row (Requirements 23.1, 23.4) — the order's
      // id only exists once INSERT ... RETURNING id has run. Fee
      // computation and order-item shaping below never depend on the
      // post-decrement stock values, so reordering is safe.
      const fees = await this.computeShopFees({ shopId, items, feeContext })

      const orderItems = items.map((item) => ({
        productId: item.productId,
        shopId,
        // Phase 3: track exact shop_product_id so order items can be
        // audited back to the precise per-shop SKU that was fulfilled.
        // Falls back to null for legacy callers (preserves backwards
        // compatibility — the column on order_items is nullable).
        shopProductId: item.shopProductId || null,
        // Phase 3: option/family/badge metadata propagated into the
        // order JSONB so customers and shop dashboards can see the
        // selected option ("Tomato 500g") without rejoining products.
        productFamilyId: item.productFamilyId || null,
        familyName: item.familyName || null,
        optionLabel: item.optionLabel || null,
        netQuantity: item.netQuantity || null,
        thumbnailUrl: item.thumbnailUrl || null,
        foodType: item.foodType || 'NONE',
        originTag: item.originTag || 'NONE',
        name: item.name,
        price: Number(item.salePrice ?? item.price ?? 0),
        quantity: item.quantity,
        unit: item.unit || null,
        total: Number(item.lineTotal ?? 0),
        // GSTR-1 HSN Summary snapshot: the product's own HSN/rate, else the
        // shop's effective GST rate at order time — stamped now so later
        // HSN/rate edits on the product don't retroactively change past
        // reports.
        hsnCodeSnapshot: item.hsnCode || null,
        gstRateSnapshot: item.gstRate ?? fees.effectiveGlobalGstRate ?? null,
      }))

      const orderNumber = await this.ordersRepo.generateOrderNumber(client)

      const initialStatus =
        payment?.method === 'COD' ? ORDER_STATUS.CONFIRMED : ORDER_STATUS.PENDING

      const order = await this.ordersRepo.create(
        client,
        {
          orderNumber,
          userId,
          shopId,
          status: initialStatus,
          items: orderItems,
          subtotal: fees.subtotal,
          discountAmount: fees.discountAmount || 0,
          deliveryFee: fees.deliveryFee,
          platformFee: fees.platformFee,
          taxAmount: fees.taxAmount || 0,
          totalAmount: fees.totalAmount,
          paymentMethod: payment?.method || 'COD',
          paymentStatus: payment?.status || 'PENDING',
          couponCode: checkoutMeta.couponCode || null,
          deliveryAddress,
          deliveryNotes: checkoutMeta.deliveryNotes || null,
          estimatedDelivery:
            checkoutMeta.estimatedDelivery ||
            new Date(Date.now() + 30 * 60 * 1000),
          handlingFee: fees.handlingFee || 0,
          lateNightFee: 0,
          tipAmount: fees.tipAmount || 0,
          deliveryInstructions: checkoutMeta.deliveryInstructions || null,
          savingsTotal: fees.savingsTotal || 0,
          feeBreakdown: fees.feeBreakdown || {},
          // Delivery slot fields
          deliveryMode: checkoutMeta.deliveryMode || 'ASAP',
          scheduledDeliveryAt: checkoutMeta.scheduledDeliveryAt || null,
          scheduledSlotStart: checkoutMeta.scheduledSlotStart || null,
          scheduledSlotEnd: checkoutMeta.scheduledSlotEnd || null,
          scheduledSlotLabel: checkoutMeta.scheduledSlotLabel || null,
          // Quick Delivery surcharge — snapshot of what was actually charged,
          // survives later config changes (same principle as scheduledSlotLabel).
          quickDeliverySelected: fees.quickDeliverySelected || false,
          quickDeliverySurchargeAmount: fees.quickDeliverySurchargeAmount || 0,
          // GST invoicing (src/utils/gstInvoiceGenerator.js) — point-in-time
          // snapshot of the buyer's business account, not a live re-read.
          buyerGstin: checkoutMeta.buyerGstin || null,
          buyerCompanyName: checkoutMeta.buyerCompanyName || null,
        },
        orderItems
      )

      // ─── 3. Apply stock decrement now that order.id exists ────────────
      // Goes through the centralized applyStockChange() so every order
      // deduction gets exactly one stock_movements ledger row (previously
      // this called the lower-level applyStockUpdate() directly, which
      // silently skipped the ledger and the post-commit cache
      // invalidation every other stock-mutating path relies on).
      //
      // Skipped entirely when deferStockDeduction is set (B2B "Place
      // Order") — availability was already checked in step 1 above, but
      // the actual decrement happens later, at admin approval, via
      // ShopProductsRepository#deductStockForApprovedOrder.
      if (!deferStockDeduction) {
        for (const { item, locked } of verified) {
          const prevQty = Number(locked.stock_quantity)
          const { stockProduct: updated } = await this.shopProductsRepo.applyStockChange(
            client,
            {
              shopProductId: item.shopProductId,
              delta: -item.quantity,
              type: STOCK_MOVEMENT_TYPES.ORDER_DEDUCTION,
              source: STOCK_MOVEMENT_SOURCES.ORDER,
              orderId: order.id,
              actor: null, // system write — no human actor for a customer checkout
            }
          )

          // Record the prev→new transition for post-commit fan-out. The
          // shopProduct object includes everything the side-effect helpers
          // need (id, product_id, stock_quantity, sold_out_at, threshold).
          stockTransitions.push({
            shopId,
            shopProduct: updated,
            prevQty,
            newQty: prevQty - item.quantity,
            lowStockThreshold: Number(updated.low_stock_threshold),
            productMeta: { product_name: item.name || null },
          })
        }
      }

      // Capture the road-route lookup inputs for this order — resolved
      // post-commit, not here, so a slow/failed external HTTP call never
      // holds the shop_products row locks this transaction is holding.
      const shopCoordsForRoute = feeContext.shopCoords?.get(shopId)
      if (
        Number.isFinite(shopCoordsForRoute?.lat) &&
        Number.isFinite(shopCoordsForRoute?.lng) &&
        Number.isFinite(deliveryAddress?.lat) &&
        Number.isFinite(deliveryAddress?.lng)
      ) {
        routeLookups.push({
          orderId: order.id,
          originLat: shopCoordsForRoute.lat,
          originLng: shopCoordsForRoute.lng,
          destLat: deliveryAddress.lat,
          destLng: deliveryAddress.lng,
        })
      }

      createdOrders.push(order)
    }

    logger.info(
      {
        userId,
        action: 'order_split',
        shopsCount: shopIds.length,
        orderIds: createdOrders.map((o) => o.id),
      },
      'Per-shop orders created from multi-vendor cart'
    )

    // Attach stock transitions as a non-enumerable property so existing
    // callers that destructure or iterate over the array keep their
    // contract (length, indexed access). Callers that need post-commit
    // side-effect fan-out can read `result.stockTransitions` and pass it
    // through to `firePostCommitSideEffects` AFTER COMMIT.
    Object.defineProperty(createdOrders, 'stockTransitions', {
      value: stockTransitions,
      enumerable: false,
      writable: false,
      configurable: false,
    })
    Object.defineProperty(createdOrders, 'routeLookups', {
      value: routeLookups,
      enumerable: false,
      writable: false,
      configurable: false,
    })

    return createdOrders
  }

  /**
   * Fan out post-commit stock-transition side effects collected during
   * `createOrders` (Requirements 11.1–11.4, 11.6, 11.9). The caller
   * MUST invoke this AFTER the outer transaction has committed so a
   * rolled-back checkout never emits user-facing events or queues jobs.
   *
   * Best-effort: per-transition errors are caught + logged. Individual
   * transition failures cannot affect the customer-facing checkout
   * response or other transitions in the same call.
   *
   * No-op when the splitter wasn't given a `shopProductsService`.
   *
   * @param {Array<{
   *   shopId: string,
   *   shopProduct: object,
   *   prevQty: number,
   *   newQty: number,
   *   lowStockThreshold: number,
   *   productMeta?: { product_name?: string|null }
   * }>} transitions
   */
  async firePostCommitSideEffects(transitions) {
    if (!this.shopProductsService?.handleStockTransitionSideEffects) return
    if (!Array.isArray(transitions) || transitions.length === 0) return

    for (const transition of transitions) {
      try {
        await this.shopProductsService.handleStockTransitionSideEffects(
          transition
        )
      } catch (err) {
        logger.error(
          {
            err: err.message,
            shopId: transition.shopId,
            shopProductId: transition.shopProduct?.id,
            action: 'order_stock_transition_side_effects',
          },
          'Order-driven stock transition side effects failed'
        )
      }
    }
  }

  /**
   * Resolve and permanently store the real road-route distance for each
   * newly-placed order, AFTER the caller's transaction has committed.
   * Calculated exactly once per order — the admin dashboard reads
   * `orders.route_distance_meters` directly and never recalculates it.
   *
   * Best-effort: a slow or failing routing API call must never affect the
   * checkout response or any other order in the batch. Per-order errors
   * are caught and logged; the order simply keeps `route_distance_meters`
   * null, which the admin dashboard renders as "unavailable" — never a
   * haversine fallback.
   *
   * @param {Array<{orderId:string, originLat:number, originLng:number, destLat:number, destLng:number}>} routeLookups
   */
  async fireRouteDistanceLookup(routeLookups) {
    if (!Array.isArray(routeLookups) || routeLookups.length === 0) return

    for (const lookup of routeLookups) {
      try {
        const result = await fetchRoadRouteDistanceMeters(lookup)
        if (result) {
          await this.ordersRepo.setRouteDistance(lookup.orderId, result)
        }
      } catch (err) {
        logger.warn(
          { err: err.message, orderId: lookup.orderId, action: 'order_route_distance_lookup' },
          'Road-route distance lookup failed (non-critical)'
        )
      }
    }
  }
}
