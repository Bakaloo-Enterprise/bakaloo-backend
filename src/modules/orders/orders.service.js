import { getClient } from '../../config/database.js'
import { query, pool } from '../../config/database.js'
import { orderQueue } from '../../config/bullmq.js'
import { logger } from '../../config/logger.js'
import { razorpay } from '../../config/razorpay.js'
import { PaymentsRepository } from '../payments/payments.repository.js'
import { PaymentsService } from '../payments/payments.service.js'
import { getOffsetLimit, buildPagination } from '../../utils/paginate.js'
import { ORDER_STATUS, ACTIVE_ORDER_STATUSES } from '../../constants/orderStatus.js'
import { generateInvoicePDF } from '../../utils/invoiceGenerator.js'
import { generateGstInvoicePDF } from '../../utils/gstInvoiceGenerator.js'
import { getActivePickupToken } from '../../utils/pickupTokens.js'
import { buildOrderBill } from '../../utils/orderBill.js'
import { normalizeCloudinaryDeliveryUrl } from '../../config/cloudinary.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { buildCustomerOrderEventNotification } from '../notifications/customer-order-event.helper.js'
import { FinalizeAssignmentRepository } from '../rider-assignment/finalize-assignment.repository.js'

// Lazy-loaded collaborator instances (avoids circular imports)
import { CartRepository } from '../cart/cart.repository.js'
import { CartService } from '../cart/cart.service.js'
import { AbandonedCartsRepository } from '../abandoned-carts/abandoned-carts.repository.js'
import { AddressesRepository } from '../addresses/addresses.repository.js'
import { AllocationRepository } from '../allocation/allocation.repository.js'
import { CouponsRepository } from '../coupons/coupons.repository.js'
import { CouponsService } from '../coupons/coupons.service.js'
import { ShopProductsRepository } from '../shop-products/shop-products.repository.js'
import { ShopProductsService } from '../shop-products/shop-products.service.js'
import { OrderSplitterService } from './order-splitter.service.js'
import { FeeSettingsService } from '../fee-settings/fee-settings.service.js'
import { TotalsEngine } from '../cart/totals-engine.service.js'
import { BillSummaryService } from '../cart/bill-summary.service.js'
import { PaymentSettingsService } from '../payment-settings/payment-settings.service.js'
import { FirstTimeOffersService } from '../first-time-offers/first-time-offers.service.js'
import { CashbackService } from '../cashback/cashback.service.js'
import { SpinWheelService } from '../spin-wheel/spin-wheel.service.js'
import { ScratchCardService } from '../scratch-card/scratch-card.service.js'
import { WalletService } from '../wallet/wallet.service.js'
import { WalletRepository } from '../wallet/wallet.repository.js'
import { LedgerService } from '../ledger/ledger.service.js'
import { BusinessAccountsRepository } from '../business-accounts/business-accounts.repository.js'
import { UsersRepository } from '../users/users.repository.js'
import { CartMilestonesService } from '../cart-milestones/cart-milestones.service.js'
import { PaymentOffersService } from '../payment-offers/payment-offers.service.js'
import { PurchaseLimitsService } from '../purchase-limits/purchase-limits.service.js'
import { getStoreStatusService } from '../store-status/store-status.routes.js'
import { getDeliveryCalendarService } from '../delivery-calendar/delivery-calendar.routes.js'

const DELIVERY_FEE = 25 // ₹25 flat delivery fee
const PLATFORM_FEE = 5 // ₹5 platform fee
const FREE_DELIVERY_THRESHOLD = 499 // Free delivery above ₹499
const INLINE_AUTO_ASSIGN_IN_NON_PROD =
  process.env.AUTO_ASSIGN_INLINE === 'true' ||
  process.env.NODE_ENV !== 'production'

/**
 * Orders service — business logic for order placement & management
 */
export class OrdersService {
  constructor(repository, fastify = null, options = {}) {
    this.repo = repository
    this.fastify = fastify

    // Collaborators
    this.cartRepo = options.cartRepository || new CartRepository()
    // Admin-configured category/product purchase caps — constructed before
    // cartService (below) so both it and orderSplitter (further down)
    // share this exact instance and always agree on the same rules.
    // Stateless (every call reads the DB fresh), so sharing is purely
    // about consistency, not correctness.
    this.purchaseLimitsService =
      options.purchaseLimitsService || new PurchaseLimitsService()
    this.cartService =
      options.cartService ||
      new CartService(this.cartRepo, { purchaseLimitsService: this.purchaseLimitsService })
    this.abandonedCartsRepo =
      options.abandonedCartsRepository || new AbandonedCartsRepository()
    this.addressRepo = options.addressesRepository || new AddressesRepository()
    // Used only to double-check with Razorpay before honoring a customer
    // cancel on a still-unpaid ONLINE order — see cancel()/_reconcileBeforeCancel().
    this.paymentsRepo = options.paymentsRepository || new PaymentsRepository()
    this.paymentsService =
      options.paymentsService || new PaymentsService(this.paymentsRepo, fastify)
    // Serviceable-area gate at order placement — see placeOrder() step 2c.
    this.allocationRepo = options.allocationRepository || new AllocationRepository()
    this.couponsRepo = options.couponsRepository || new CouponsRepository()
    this.couponsService =
      options.couponsService || new CouponsService(this.couponsRepo)
    this.shopProductsRepo =
      options.shopProductsRepository || new ShopProductsRepository()
    // Build a ShopProductsService for stock-transition side effects so that
    // order-driven stock decrements (Req 11.1–11.4, 11.6, 11.9) emit the
    // same Socket.IO + push notifications as manual stock updates.
    this.shopProductsService =
      options.shopProductsService ||
      new ShopProductsService(this.shopProductsRepo, {
        notificationsService: fastify
          ? new NotificationsService(new NotificationsRepository(), fastify)
          : null,
      })
    // Canonical fee engine — shared by cart summary and order creation so
    // the charged total always matches the displayed bill.
    this.feeSettingsService =
      options.feeSettingsService || new FeeSettingsService()
    this.totalsEngine =
      options.totalsEngine ||
      new TotalsEngine({ feeSettingsService: this.feeSettingsService })
    // Payment-method gating — same total-bill calculation the cart summary
    // shows the customer, so COD/Razorpay/Wallet enforcement at order
    // creation always agrees with what was displayed at checkout.
    this.paymentSettingsService =
      options.paymentSettingsService || new PaymentSettingsService()
    this.billSummaryService =
      options.billSummaryService ||
      new BillSummaryService({
        cartService: this.cartService,
        cartRepository: this.cartRepo,
        feeSettingsService: this.feeSettingsService,
        totalsEngine: this.totalsEngine,
        paymentSettingsService: this.paymentSettingsService,
      })
    this.orderSplitter =
      options.orderSplitter ||
      new OrderSplitterService({
        ordersRepository: this.repo,
        shopProductsRepository: this.shopProductsRepo,
        shopProductsService: this.shopProductsService,
        feeSettingsService: this.feeSettingsService,
        totalsEngine: this.totalsEngine,
        purchaseLimitsService: this.purchaseLimitsService,
        fees: {
          deliveryFee: DELIVERY_FEE,
          platformFee: PLATFORM_FEE,
          freeDeliveryThreshold: FREE_DELIVERY_THRESHOLD,
        },
      })
    this.notificationsService = fastify
      ? new NotificationsService(new NotificationsRepository(), fastify)
      : null
    this.firstTimeOffersService =
      options.firstTimeOffersService || new FirstTimeOffersService()
    this.cashbackService = options.cashbackService || new CashbackService()
    this.spinWheelService = options.spinWheelService || new SpinWheelService()
    this.scratchCardService = options.scratchCardService || new ScratchCardService()
    // Wallet-balance-toggle checkout feature — offsets an order's total
    // regardless of paymentMethod (COD/ONLINE). See placeOrder() step 4b
    // and cancel()'s wallet-refund-on-self-cancel block.
    this.walletRepo = options.walletRepository || new WalletRepository()
    this.walletService =
      options.walletService || new WalletService(this.walletRepo, fastify)
    // LEDGER payment method — B2B credit line, gated in
    // _checkPaymentMethodAllowed() and drawn via LedgerService#payFromLedger
    // (the same two-step create-PENDING-then-pay shape as ONLINE/legacy-WALLET).
    this.ledgerService = options.ledgerService || new LedgerService()
    // GST invoicing snapshot at order-placement time — see placeOrder()'s
    // buyerGstin/buyerCompanyName block.
    this.businessAccountsRepo =
      options.businessAccountsRepository || new BusinessAccountsRepository()
    // Used only by getGstInvoice() to attach the customer's name/phone —
    // neither is a column on `orders` itself.
    this.usersRepo = options.usersRepository || new UsersRepository()
    this.cartMilestonesService =
      options.cartMilestonesService || new CartMilestonesService()
    this.paymentOffersService =
      options.paymentOffersService || new PaymentOffersService()
    // Resolved lazily via the shared singleton getters (not `new`d here) so
    // every module reads/writes the same store-status/calendar state —
    // mirrors how getStoreStatusService()/getDeliveryCalendarService() are
    // consumed elsewhere (banners, the calendar's own public route).
    this.storeStatusService =
      options.storeStatusService || getStoreStatusService()
    this.deliveryCalendarService =
      options.deliveryCalendarService || getDeliveryCalendarService()
    this.finalizeAssignmentRepo =
      options.finalizeAssignmentRepository || new FinalizeAssignmentRepository()
  }

  /**
   * Place a multi-vendor order from the cart.
   *
   * Flow:
   *   1. Re-validate cart against current allocations + max_order_qty + stock
   *      (Requirements 12.3, 12.7). Any failure short-circuits with code
   *      CHECKOUT_PARTIAL_FAIL listing each `{ productId, shopId, reason }`.
   *   2. Validate the delivery address has coordinates.
   *   3. Open a single pg transaction.
   *   4. Delegate to OrderSplitter which:
   *        - groups items by shop_id (Req 5.6)
   *        - locks shop_products rows (SELECT FOR UPDATE) (Req 11.7)
   *        - re-checks max_order_qty + stock under the lock (Req 12.7)
   *        - decrements stock and inserts one order per shop with
   *          independently-computed fees (Req 5.7)
   *   5. COMMIT on success; ROLLBACK on any error (Req 5.9, 15.9, 15.10).
   *   6. Post-commit: clear cart + extras, enqueue per-order delivery
   *      assignments, and send customer notifications (Req 5.8).
   *
   * Coupons and tip are applied ONLY when the cart resolves to a single
   * shop. With multi-shop carts they are deferred to a later spec — applying
   * a single coupon code across multiple per-shop totals would require
   * platform-level coupon redistribution rules that are out of scope.
   */
  async placeOrder(userId, body, priceMode = 'retail') {
    const {
      addressId,
      paymentMethod,
      couponCode,
      deliveryNotes,
      tipAmount,
      deliveryInstructions,
      handlingFee,
      lateNightFee,
      savingsTotal,
      // Delivery slot fields
      deliveryMode,
      scheduledDeliveryAt,
      scheduledSlotStart,
      scheduledSlotEnd,
      scheduledSlotLabel,
      // Quick Delivery — explicit opt-in only, never a silent default fee.
      quickDeliverySelected,
      // Wallet-balance-toggle — explicit opt-in only, same convention as
      // Quick Delivery above. Ignored for the legacy paymentMethod:'WALLET'
      // (old published app), which keeps its own separate full-payment flow.
      useWallet,
    } = body

    // Name-mandatory gate: OTP-only signup never collects a name (see
    // auth.service.js), and until now nothing enforced it server-side —
    // the customer app's "What's your name?" popup was the ONLY place
    // that ever asked, and it could be skipped for real (app
    // backgrounded/killed mid-check, a flaky network on its one-shot
    // profile fetch, or any session that never happens to pass through
    // Home) with zero consequence: the order still went through and the
    // user row was left with name = NULL indefinitely. Blocking here, the
    // one choke point every order must pass through, closes that gap the
    // same way the address/store-hours gates below already do.
    const orderingUser = await this.usersRepo.findById(userId)
    if (!orderingUser || !(orderingUser.name || '').trim()) {
      return {
        success: false,
        message: 'Please add your name to your profile before placing an order',
        code: 'NAME_REQUIRED',
      }
    }

    // Validate delivery slot
    const resolvedDeliveryMode = (deliveryMode || 'ASAP').toUpperCase()
    if (!['ASAP', 'SCHEDULED'].includes(resolvedDeliveryMode)) {
      return {
        success: false,
        message: 'deliveryMode must be ASAP or SCHEDULED',
        code: 'INVALID_DELIVERY_MODE',
      }
    }
    if (resolvedDeliveryMode === 'SCHEDULED') {
      if (!scheduledSlotStart || !scheduledSlotEnd) {
        return {
          success: false,
          message: 'scheduledSlotStart and scheduledSlotEnd are required for SCHEDULED delivery',
          code: 'MISSING_SLOT_FIELDS',
        }
      }
      const slotStart = new Date(scheduledSlotStart)
      const slotEnd = new Date(scheduledSlotEnd)
      const now = new Date()
      if (!Number.isFinite(slotStart.getTime()) || !Number.isFinite(slotEnd.getTime())) {
        return {
          success: false,
          message: 'scheduledSlotStart and scheduledSlotEnd must be valid ISO timestamps',
          code: 'INVALID_SLOT_TIMESTAMPS',
        }
      }
      if (slotStart <= now) {
        return {
          success: false,
          message: 'Scheduled delivery time must be in the future',
          code: 'SLOT_IN_PAST',
        }
      }
      if (slotEnd <= slotStart) {
        return {
          success: false,
          message: 'Slot end time must be after slot start time',
          code: 'INVALID_SLOT_RANGE',
        }
      }
      // Max ahead = however far the admin has actually generated the
      // delivery calendar (was a hardcoded 7 days; the calendar now
      // genuinely extends forward, so this reflects that instead of
      // silently re-imposing the old cap).
      const maxAhead = await this._resolveMaxScheduledAhead(now)
      if (slotStart > maxAhead) {
        return {
          success: false,
          message: 'Scheduled delivery time is beyond the currently available calendar',
          code: 'SLOT_TOO_FAR_AHEAD',
        }
      }
    }

    // Closed-store gate: an ASAP order must not be accepted while the store
    // is closed (manual override or outside weekly hours) — the mobile app
    // steers customers to SCHEDULED before submit, but the API must not
    // trust the client alone. Scheduled orders are unaffected — a customer
    // can always book a future slot regardless of whether the store happens
    // to be closed at the moment they're checking out.
    if (resolvedDeliveryMode === 'ASAP') {
      const storeClosedFailure = await this._checkStoreOpenForAsap()
      if (storeClosedFailure) return storeClosedFailure
    }

    // 1. Validate cart (re-checks allocations, shop active, stock,
    //    max_order_qty per Req 12.3/12.7). priceMode flows through to every
    //    item's price/salePrice/lineTotal (cart.service.js#_formatLine) —
    //    OrderSplitterService trusts those fields as-is (computeShopFees
    //    sums item.lineTotal, orderItems snapshots item.salePrice/price),
    //    so this one call is what makes the entire downstream fee/order
    //    creation pipeline wholesale-correct for an approved, B2B-enabled
    //    customer with no other change needed there.
    const cartResult = await this.cartService.validateCart(userId, priceMode)
    if (!cartResult.valid || cartResult.items.length === 0) {
      const failed = cartResult.failed && cartResult.failed.length > 0
        ? cartResult.failed
        : []
      const message = failed.length > 0
        ? 'Some items in your cart cannot be ordered right now'
        : (cartResult.warnings && cartResult.warnings[0]) || 'Cart is empty'
      return {
        success: false,
        message,
        code: failed.length > 0 ? 'CHECKOUT_PARTIAL_FAIL' : 'EMPTY_CART',
        failures: failed,
      }
    }

    const { items: cartItems, subtotal, groupedByShop } = cartResult

    // GST invoicing snapshot (src/utils/gstInvoiceGenerator.js) — captured
    // independent of priceMode: a business-account holder's GSTIN is worth
    // stamping on the invoice regardless of which price tier this
    // particular order happened to use. Point-in-time snapshot, not a live
    // re-read at invoice-download time — the account's GSTIN or status can
    // change later.
    let buyerGstin = null
    let buyerCompanyName = null
    try {
      const businessAccount = await this.businessAccountsRepo.findByUserId(userId)
      if (businessAccount?.status === 'APPROVED') {
        buyerGstin = businessAccount.gst_number
        buyerCompanyName = businessAccount.company_name
      }
    } catch (err) {
      logger.warn({ err: err.message, userId }, 'Business account lookup for GST invoice snapshot failed (non-critical)')
    }

    // 2. Validate delivery address
    const address = await this.addressRepo.findByIdAndUser(addressId, userId)
    if (!address) {
      return { success: false, message: 'Delivery address not found', code: 'ADDRESS_NOT_FOUND' }
    }
    const addressLat = Number(address.lat)
    const addressLng = Number(address.lng)
    if (!Number.isFinite(addressLat) || !Number.isFinite(addressLng)) {
      return {
        success: false,
        message: 'Selected address is missing map pin. Please update address location.',
        code: 'ADDRESS_COORDINATES_REQUIRED',
      }
    }
    const deliveryAddress = {
      ...address,
      lat: addressLat,
      lng: addressLng,
    }

    // 2c. Serviceable-area gate — the cart's shop(s) were resolved against
    // user_shop_allocations, which reflects whichever address most
    // recently triggered a recompute (typically the customer's default
    // address), NOT necessarily the addressId chosen for this checkout.
    // Without this, a customer allocated via a serviceable home address
    // could switch to a completely different, unserviceable saved address
    // at this final step and still have the order go through — this is
    // the actual gap that let orders be placed from pincodes/locations
    // outside every shop's declared service area (serviceable_pincodes /
    // delivery_radius_km). Checked per-shop, not "any shop", since what
    // matters is whether THIS address is inside THIS order's fulfilling
    // shop's area.
    for (const shopId of groupedByShop.keys()) {
      const serviceable = await this.allocationRepo.isServiceable({
        shopId,
        pincode: deliveryAddress.pincode,
        lat: deliveryAddress.lat,
        lng: deliveryAddress.lng,
      })
      if (!serviceable) {
        return {
          success: false,
          message: 'This delivery address is outside the service area for your cart. Please choose a different address.',
          code: 'ADDRESS_NOT_SERVICEABLE',
        }
      }
    }

    // 2b. Payment-method gate — enforce the admin's COD/Razorpay/Wallet
    // toggles and the COD min/max amount server-side. Uses the same bill
    // calculation the cart summary shows the customer so the total this
    // gate checks against always matches what was displayed at checkout.
    const normalizedPaymentMethod = `${paymentMethod || 'COD'}`.toUpperCase()
    const paymentGateError = await this._checkPaymentMethodAllowed(
      userId,
      addressId,
      normalizedPaymentMethod,
      priceMode
    )
    if (paymentGateError) {
      return paymentGateError
    }

    // B2B_CREDIT ("Place Order") draws a single credit-line charge and
    // defers stock/approval as one unit — same single-shop restriction as
    // coupons/wallet-toggle/ledger-toggle below, so as not to introduce
    // multi-order credit-splitting complexity.
    if (normalizedPaymentMethod === 'B2B_CREDIT' && groupedByShop.size !== 1) {
      return {
        success: false,
        message: 'Placing an order on credit is not yet supported for multi-shop carts — check out each shop separately.',
        code: 'B2B_CREDIT_MULTI_SHOP_UNSUPPORTED',
      }
    }

    // 3. Apply coupon — only meaningful when the cart is single-shop. For
    //    multi-shop carts coupons are deferred (see method docstring).
    let appliedCouponCode = null
    let appliedCouponDiscount = 0
    let couponShopId = null
    let freeDeliveryOverride = false
    let freeDeliveryShopId = null
    let appliedCouponCashback = null // { amount, creditTrigger } for CASHBACK-type coupons
    // Who contributed to `appliedCouponDiscount` — the order row only stores
    // one summed discount_amount + coupon_code, so without this the printed
    // bill couldn't tell a coupon from a first-order offer or a milestone.
    // Persisted inside fee_breakdown.discounts (see order-splitter.service.js).
    const discountParts = []
    if (couponCode) {
      const isSingleShop = groupedByShop.size === 1
      if (!isSingleShop) {
        return {
          success: false,
          message: 'Coupons are not yet supported for multi-shop carts',
          code: 'COUPON_MULTI_SHOP_UNSUPPORTED',
        }
      }
      // Resolved before validate() so a category/product-scoped coupon can
      // be checked against this shop's actual cart lines (see
      // coupons.service.js#validateCouponEligibility) instead of just the
      // flat subtotal number — a Dairy-only coupon must not discount a
      // cart that's all vegetables just because the total happens to
      // clear min_order_amount.
      couponShopId = Array.from(groupedByShop.keys())[0]
      const couponResult = await this.couponsService.validate(
        userId, couponCode, subtotal, groupedByShop.get(couponShopId)
      )
      if (!couponResult.valid) {
        return { success: false, message: couponResult.message, code: 'INVALID_COUPON' }
      }
      appliedCouponCode = couponResult.code
      // Capture the discount amount so it is actually deducted from the order
      // total (previously the code was stored but the discount was dropped).
      appliedCouponDiscount = Number(couponResult.discount || 0)
      if (appliedCouponDiscount > 0) {
        discountParts.push({ code: 'COUPON', label: `Coupon (${couponResult.code})`, amount: appliedCouponDiscount })
      }
      if (couponResult.freeDelivery) {
        freeDeliveryOverride = true
        freeDeliveryShopId = couponShopId
      }
      if (couponResult.cashbackAmount) {
        appliedCouponCashback = {
          amount: couponResult.cashbackAmount,
          creditTrigger: couponResult.cashbackCreditTrigger,
          couponId: couponResult.couponId,
        }
      }
    }

    // 3b. First-time offer — auto-applies for eligible first-time customers
    // on single-shop carts. Backend validation is the final source of truth
    // here too: resolveForCheckout() re-checks "no prior order" itself, it
    // never trusts anything the client claims about first-order status.
    //
    // Discount-type rewards (FLAT_DISCOUNT/PERCENTAGE_DISCOUNT) yield to an
    // already-applied coupon — they'd otherwise stack two separate
    // order-level discounts through different mechanisms, which is hard to
    // reason about and not something the product spec asked for.
    // FREE_DELIVERY/WALLET_CASHBACK/COUPON_UNLOCK don't touch the coupon's
    // discount bill line at all, so those always apply when eligible.
    let firstTimeOffer = null
    let firstTimeReward = null
    if (groupedByShop.size === 1) {
      const onlinePayment = normalizedPaymentMethod === 'ONLINE'
      const resolvedOffer = await this.firstTimeOffersService.resolveForCheckout(userId, subtotal, {
        onlinePayment,
        cartItems: groupedByShop.get(Array.from(groupedByShop.keys())[0]),
      })
      if (resolvedOffer?.autoApply) {
        const reward = this.firstTimeOffersService.computeReward(resolvedOffer, subtotal)
        if (reward.discount && appliedCouponCode) {
          // Coupon already occupies the discount slot — skip the stack.
        } else {
          firstTimeOffer = resolvedOffer
          firstTimeReward = reward
          if (reward.discount) {
            appliedCouponDiscount += reward.discount
            couponShopId = couponShopId || Array.from(groupedByShop.keys())[0]
            discountParts.push({ code: 'FIRST_ORDER_OFFER', label: firstTimeOffer.name || firstTimeOffer.title || 'First-order offer', amount: Number(reward.discount) })
          }
          if (reward.freeDelivery) {
            freeDeliveryOverride = true
            freeDeliveryShopId = Array.from(groupedByShop.keys())[0]
          }
        }
      }
    }

    // 3c. Cart milestone — the highest cart-value tier this user is
    // eligible for and has already reached with this cart (applies to
    // every order, not just a customer's first). Resolved against the
    // WHOLE cart (every shop combined) — the same total the customer saw
    // promised in the live cart preview (bill-summary.service.js) —
    // regardless of how many shops it splits into at checkout.
    //
    // Reported bug: a milestone shown as "unlocked" while shopping
    // silently granted NOTHING once checkout actually split the cart
    // across 2+ shops, because this whole block used to be gated behind
    // `groupedByShop.size === 1` (like coupons/first-time-offers). That
    // single-shop restriction genuinely still applies to the DISCOUNT and
    // FREE_DELIVERY portions below — both need order-splitter.service.js's
    // shared fee slot, which only ever targets one shop's order — but
    // CASHBACK and COUPON_UNLOCK are per-user/per-order side effects with
    // no such dependency, so those now apply correctly no matter how many
    // shops the cart split into.
    //
    // `stackableWithCoupon` is a hard admin toggle: false means the
    // milestone is skipped outright whenever a coupon code was applied to
    // this order, of any reward type.
    let cartMilestone = null
    let cartMilestoneReward = null
    {
      const isSingleShop = groupedByShop.size === 1
      // Resolved with the actual cart lines across every shop (mirrors the
      // coupon and first-time-offer resolution above) so a category/
      // product-scoped milestone (103_cart_milestone_scope.sql) is checked
      // against the matching slice of the cart, not just the flat subtotal
      // number.
      const allCartItems = Array.from(groupedByShop.values()).flat()
      const milestone = await this.cartMilestonesService.resolveForCheckout(userId, subtotal, allCartItems)
      if (milestone && !(appliedCouponCode && !milestone.stackableWithCoupon)) {
        const reward = this.cartMilestonesService.computeReward(milestone, subtotal)
        const discountSlotTaken = !!(appliedCouponCode || firstTimeReward?.discount)
        // Only the discount portion yields to an already-applied
        // coupon/first-time discount (single discount slot, same rule as
        // first-time offers above) — free delivery, cashback, and
        // coupon-unlock are independent of that slot and must still apply.
        // Previously the discount collision skipped the ENTIRE reward, so a
        // milestone that both discounted AND granted free delivery (e.g.
        // "min ₹50 → free delivery") silently dropped the free delivery too
        // whenever a coupon happened to be applied.
        const discountApplied = isSingleShop && reward.discount && !discountSlotTaken
        if (discountApplied) {
          appliedCouponDiscount += reward.discount
          couponShopId = couponShopId || Array.from(groupedByShop.keys())[0]
          discountParts.push({ code: 'CART_MILESTONE', label: milestone.name || milestone.title || 'Cart milestone reward', amount: Number(reward.discount) })
        }
        const freeDeliveryApplied = isSingleShop && reward.freeDelivery
        if (freeDeliveryApplied) {
          freeDeliveryOverride = true
          freeDeliveryShopId = freeDeliveryShopId || Array.from(groupedByShop.keys())[0]
        }
        if (discountApplied || reward.cashbackAmount || freeDeliveryApplied || reward.unlockCouponId) {
          cartMilestone = milestone
          cartMilestoneReward = reward
        }
      }
    }

    // 3d. Payment offer — the best-fit admin-configured cashback offer this
    // cart qualifies for (e.g. "min order ₹50 → ₹50 cashback"). Payment
    // offers only ever produce cashback (never a discount), so unlike the
    // coupon/first-time-offer/milestone block above there's no discount-slot
    // contention to resolve here — this always stacks additively, exactly
    // like the CASHBACK-type coupon/milestone rewards already do.
    let paymentOfferMatch = null
    if (groupedByShop.size === 1) {
      paymentOfferMatch = await this.paymentOffersService.resolveForCheckout(userId, subtotal)
    }

    // 4. Resolve checkout extras (tip / instructions) — preserves the
    //    pre-multi-vendor behaviour for single-shop carts.
    const hasTipAmount = Object.prototype.hasOwnProperty.call(body, 'tipAmount')
    const normalizedInstructions = typeof deliveryInstructions === 'string'
      ? deliveryInstructions.trim()
      : deliveryInstructions
    const [tipFromRedis, instructionsFromRedis] = await Promise.all([
      hasTipAmount ? Promise.resolve(0) : this.cartRepo.getTip(userId),
      normalizedInstructions ? Promise.resolve(null) : this.cartRepo.getInstructions(userId),
    ])
    const orderTipAmount = hasTipAmount
      ? this._toNumber(tipAmount)
      : this._toNumber(tipFromRedis)
    const resolvedInstructions = normalizedInstructions || instructionsFromRedis || null

    const initialPaymentStatus = 'PENDING'

    // Resolve shop coordinates for distance-based delivery fees (one query
    // for every shop in the cart). Used by the splitter's fee engine.
    const shopCoords = new Map()
    try {
      const shopIdList = Array.from(groupedByShop.keys())
      if (shopIdList.length > 0) {
        const { rows } = await query(
          `SELECT id, name, lat, lng FROM shops WHERE id = ANY($1)`,
          [shopIdList]
        )
        for (const r of rows) {
          shopCoords.set(r.id, {
            name: r.name,
            lat: r.lat != null ? Number(r.lat) : NaN,
            lng: r.lng != null ? Number(r.lng) : NaN,
          })
        }
      }
    } catch (err) {
      logger.warn(
        { userId, err: err.message, action: 'order_shop_coords' },
        'Failed to resolve shop coordinates; delivery fee will use safe fallback'
      )
    }

    const feeContext = {
      deliveryCoords: { lat: addressLat, lng: addressLng },
      shopCoords,
      couponDiscount: appliedCouponDiscount,
      couponShopId,
      discountParts,
      freeDeliveryOverride,
      freeDeliveryShopId,
      // Tip applies to a single order only (single-shop checkouts).
      tipAmount: orderTipAmount,
      tipShopId: groupedByShop.size === 1 ? Array.from(groupedByShop.keys())[0] : null,
      // Quick Delivery surcharge — only meaningful for ASAP orders, same
      // single-shop assignment convention as tip.
      quickDeliverySelected: resolvedDeliveryMode === 'ASAP' && !!quickDeliverySelected,
      quickDeliveryShopId: groupedByShop.size === 1 ? Array.from(groupedByShop.keys())[0] : null,
    }

    // 5. Transaction: split + create orders + decrement stock atomically
    const client = await getClient()
    let createdOrders = []
    // Wallet-balance-toggle checkout feature — set inside the transaction
    // below, read afterward by the post-commit gates (cart-clear, coupon
    // usage, notification) so a fully-wallet-covered order is treated
    // exactly like a COD order (already confirmed, nothing deferred).
    let walletAmountUsed = 0
    let walletFullyCoversOrder = false
    try {
      await client.query('BEGIN')

      const groups = this.orderSplitter.splitCart(cartItems)
      createdOrders = await this.orderSplitter.createOrders({
        client,
        userId,
        groups,
        deliveryAddress,
        payment: { method: normalizedPaymentMethod, status: initialPaymentStatus },
        feeContext,
        deferStockDeduction: normalizedPaymentMethod === 'B2B_CREDIT',
        checkoutMeta: {
          couponCode: appliedCouponCode,
          deliveryNotes: deliveryNotes || null,
          deliveryInstructions: resolvedInstructions,
          buyerGstin,
          buyerCompanyName,
          // Delivery slot
          deliveryMode: resolvedDeliveryMode,
          scheduledDeliveryAt: resolvedDeliveryMode === 'SCHEDULED' ? (scheduledDeliveryAt || scheduledSlotStart) : null,
          scheduledSlotStart: resolvedDeliveryMode === 'SCHEDULED' ? scheduledSlotStart : null,
          scheduledSlotEnd: resolvedDeliveryMode === 'SCHEDULED' ? scheduledSlotEnd : null,
          scheduledSlotLabel: resolvedDeliveryMode === 'SCHEDULED' ? (scheduledSlotLabel || null) : null,
        },
      })

      // Wallet-balance-toggle — applies on top of COD or ONLINE, replacing
      // the old exclusive paymentMethod:'WALLET'. Restricted to
      // single-shop carts, same as coupons/tip/Quick Delivery above (see
      // method docstring) — no new multi-shop-splitting complexity
      // introduced. Skipped entirely for the legacy paymentMethod:'WALLET'
      // (old published app), which keeps using its own full-payment
      // payFromWallet() flow untouched — and for LEDGER/B2B_CREDIT, which
      // have no concept of a partial wallet offset on top.
      const singleShopOffsetEligible =
        groupedByShop.size === 1 &&
        normalizedPaymentMethod !== 'WALLET' &&
        normalizedPaymentMethod !== 'LEDGER' &&
        normalizedPaymentMethod !== 'B2B_CREDIT' &&
        createdOrders.length === 1

      if (useWallet && singleShopOffsetEligible) {
        const orderId = createdOrders[0].id
        const orderTotal = createdOrders[0].totalAmount
        // FOR UPDATE lock taken here, inside this same transaction — the
        // amount below is capped to the balance we just locked, so the
        // debit a few lines down can never race or fail against a balance
        // that's changed since.
        const wallet = await this.walletRepo.getForUpdate(client, userId)
        walletAmountUsed = Math.round(Math.min(wallet?.balance || 0, orderTotal) * 100) / 100
        walletFullyCoversOrder = walletAmountUsed > 0 && walletAmountUsed >= orderTotal

        if (walletFullyCoversOrder) {
          // Full coverage regardless of the chosen method — confirmed
          // immediately, nothing left to collect via COD cash or Razorpay.
          await this.walletService.debitForOrder(client, userId, {
            amount: walletAmountUsed, orderId, orderNumber: createdOrders[0].orderNumber,
          })
          await client.query(
            `UPDATE orders SET wallet_amount_used = $1, payment_status = 'PAID', status = 'CONFIRMED', updated_at = NOW() WHERE id = $2`,
            [walletAmountUsed, orderId]
          )
          createdOrders[0].walletAmountUsed = walletAmountUsed
          createdOrders[0].paymentStatus = 'PAID'
          createdOrders[0].status = 'CONFIRMED'
        } else if (walletAmountUsed > 0 && normalizedPaymentMethod === 'COD') {
          // COD partial — debit now (real money moves immediately, no
          // async gateway step to wait for); the remainder stays due in
          // cash at delivery (see delivery.service.js's collection-amount
          // validation, updated to account for wallet_amount_used).
          await this.walletService.debitForOrder(client, userId, {
            amount: walletAmountUsed, orderId, orderNumber: createdOrders[0].orderNumber,
          })
          await client.query(
            `UPDATE orders SET wallet_amount_used = $1, updated_at = NOW() WHERE id = $2`,
            [walletAmountUsed, orderId]
          )
          createdOrders[0].walletAmountUsed = walletAmountUsed
        } else if (walletAmountUsed > 0) {
          // ONLINE with a remainder — persist the intended amount only.
          // The actual debit is deliberately deferred to
          // PaymentsService#completeVerifiedPayment, atomically alongside
          // confirming the order, so a Razorpay payment that's abandoned
          // or fails never touches the wallet at all — no compensating
          // refund is ever needed. createPaymentOrder() reads this field
          // back to charge Razorpay only the remainder.
          await client.query(
            `UPDATE orders SET wallet_amount_used = $1, updated_at = NOW() WHERE id = $2`,
            [walletAmountUsed, orderId]
          )
          createdOrders[0].walletAmountUsed = walletAmountUsed
        }
      }

      // B2B_CREDIT ("Place Order") — deliberately has no credit-limit
      // concept at all (an approved B2B account may place an order of any
      // size on credit; the admin controls exposure entirely through
      // approval + manual collection, not a pre-set ceiling). No
      // ledger_accounts row is drawn against — "how much is owed" is
      // tracked directly on the order itself (total_amount minus
      // b2b_amount_settled, see the B2B Collections page), settled
      // per-order after delivery rather than against an account-level
      // running balance. Unlike every other method, this deliberately
      // does NOT confirm the order or queue rider auto-assignment —
      // b2b_approval_status='PENDING' holds it for an admin to approve
      // (which is also when stock, deferred above via
      // deferStockDeduction, actually gets deducted — see
      // AdminOrdersService#approveB2BOrder).
      if (normalizedPaymentMethod === 'B2B_CREDIT' && createdOrders.length === 1) {
        const orderId = createdOrders[0].id
        await client.query(
          `UPDATE orders SET payment_status = 'PAID', b2b_approval_status = 'PENDING', updated_at = NOW() WHERE id = $1`,
          [orderId]
        )
        createdOrders[0].paymentStatus = 'PAID'
        createdOrders[0].b2bApprovalStatus = 'PENDING'
      }

      await client.query('COMMIT')
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore rollback errors */
      }
      logger.error(
        {
          err: err.message,
          userId,
          code: err.code,
          failures: err.failures || null,
        },
        'Order placement failed; transaction rolled back'
      )
      if (err.code === 'CHECKOUT_PARTIAL_FAIL') {
        return {
          success: false,
          message: 'Some items in your cart cannot be ordered right now',
          code: 'CHECKOUT_PARTIAL_FAIL',
          failures: err.failures || [],
        }
      }
      return {
        success: false,
        message: err.message || 'Failed to place order',
        code: err.code || 'ORDER_FAILED',
      }
    } finally {
      client.release()
    }

    // 6. Post-commit cleanup + side effects (best-effort; do not fail the
    //    customer if any of these throw).
    // Each follow-through step below is independently isolated (its own
    // try/catch) rather than sharing one try block around all of them. They
    // used to share one — one early failure (e.g. the abandoned-cart flip)
    // silently skipped every step after it, including coupon-usage
    // recording and first-time-offer/milestone/payment-offer reward
    // granting, while checkout still reported success to the customer with
    // no trace beyond a single generic warning log. A logging helper keeps
    // each catch block one line.
    const logStepFailure = (step, err) =>
      logger.warn(
        { err: err.message, userId, orderIds: createdOrders.map((o) => o.id), step },
        'Post-order follow-through step failed'
      )

    // True for COD (always — no async gateway step ever sits between
    // creation and confirmation) and for an ONLINE order the wallet toggle
    // happened to cover in full (equally nothing left to wait on). False
    // for a genuine ONLINE payment (with or without a partial wallet
    // offset) and for the legacy paymentMethod:'WALLET', both of which
    // still defer cart-clear/coupon-usage/notification to their own
    // payment-confirmation step.
    const paymentAlreadyConfirmedAtCreation =
      normalizedPaymentMethod === 'COD' || walletFullyCoversOrder

    // Abandoned-cart conversion: fires the moment order rows exist,
    // regardless of payment method. Cart-clearing itself is deferred for
    // ONLINE/WALLET (see below) and for those methods happens later in
    // payments.service.js / wallet.service.js after payment confirms —
    // "order created" here is the one method-agnostic point common to
    // every payment path, so it's hooked here rather than at cart-clear.
    if (createdOrders.length > 0) {
      await this.abandonedCartsRepo
        .markConvertedByUserId(userId, createdOrders[0].id)
        .catch((err) => logStepFailure('abandoned_cart_conversion', err))
    }

    // For ONLINE and WALLET payments, do NOT clear cart yet — cart is only
    // cleared after successful payment verification / wallet deduction.
    // This prevents the "cart disappeared but payment failed" bug.
    if (paymentAlreadyConfirmedAtCreation) {
      try {
        // Scoped to the mode this order was actually placed under — a
        // COD order placed in retail must never clear out a pending
        // wholesale cart the customer hasn't checked out yet (or vice
        // versa). ONLINE/WALLET payments defer this to their own
        // confirmation step (payments.service.js / wallet.service.js),
        // which — lacking any persisted per-order price mode to recover
        // at that later, async point — still clears both modes there.
        await this.cartService.clearCart(userId, priceMode)
      } catch (err) {
        logStepFailure('clear_cart', err)
      }
    }

    // Coupon usage counts against the customer's per-coupon limit the
    // instant it's recorded — for ONLINE/WALLET, defer this to actual
    // payment confirmation (payments.service.js / wallet.service.js call
    // couponsService.recordUsageForOrder(orderId) there), same reasoning
    // as the cart-clear deferral just above. Recording it here
    // unconditionally meant a customer whose wallet/online payment never
    // completed still had their coupon burned against a limit they never
    // successfully used it under.
    if (
      appliedCouponCode &&
      createdOrders.length === 1 &&
      paymentAlreadyConfirmedAtCreation
    ) {
      try {
        await this.couponsService.recordUsage(
          appliedCouponCode,
          userId,
          createdOrders[0].id,
          { shopId: couponShopId, discountAmount: appliedCouponDiscount }
        )
      } catch (err) {
        logStepFailure('coupon_record_usage', err)
      }
    }

    // CASHBACK-type coupon follow-through: create the PENDING cashback
    // row, same as a first-time-offer's WALLET_CASHBACK reward.
    if (appliedCouponCashback && createdOrders.length === 1) {
      try {
        await this.cashbackService.createPending({
          orderId: createdOrders[0].id,
          userId,
          sourceType: 'COUPON',
          sourceId: appliedCouponCashback.couponId,
          amount: appliedCouponCashback.amount,
          creditTrigger: appliedCouponCashback.creditTrigger,
        })
      } catch (err) {
        logStepFailure('coupon_cashback_pending', err)
      }
    }

    // First-time offer follow-through: create the PENDING cashback row
    // (credited later by the matching order-lifecycle hook) or unlock the
    // reward coupon for this user. Nothing here touches the bill — that
    // was already applied via appliedCouponDiscount/freeDeliveryOverride
    // before the order was created.
    if (firstTimeOffer && firstTimeReward && createdOrders.length === 1) {
      try {
        if (firstTimeReward.cashbackAmount) {
          await this.cashbackService.createPending({
            orderId: createdOrders[0].id,
            userId,
            sourceType: 'FIRST_TIME_OFFER',
            sourceId: firstTimeOffer.id,
            amount: firstTimeReward.cashbackAmount,
            creditTrigger: firstTimeOffer.cashbackCreditTrigger,
          })
        }
        if (firstTimeReward.unlockCouponId) {
          await this.couponsRepo.addTargetUser(firstTimeReward.unlockCouponId, userId)
        }
      } catch (err) {
        logStepFailure('first_time_offer_follow_through', err)
      }
    }

    // Cart milestone follow-through — same pattern as first-time offers,
    // except gated on `createdOrders.length > 0` rather than `=== 1`: a
    // cart milestone can now resolve on a multi-shop cart (see above), and
    // cashback/usage-tracking simply anchor to the first resulting order
    // since the milestone itself isn't tied to any one shop's order.
    if (cartMilestone && cartMilestoneReward && createdOrders.length > 0) {
      try {
        if (cartMilestoneReward.cashbackAmount) {
          await this.cashbackService.createPending({
            orderId: createdOrders[0].id,
            userId,
            sourceType: 'CART_MILESTONE',
            sourceId: cartMilestone.id,
            amount: cartMilestoneReward.cashbackAmount,
            creditTrigger: cartMilestone.cashbackCreditTrigger,
          })
        }
        if (cartMilestoneReward.unlockCouponId) {
          await this.couponsRepo.addTargetUser(cartMilestoneReward.unlockCouponId, userId)
        }
        await this.cartMilestonesService.recordUsage(cartMilestone.id, userId, createdOrders[0].id)
      } catch (err) {
        logStepFailure('cart_milestone_follow_through', err)
      }
    }

    // Payment offer follow-through — was previously entirely missing;
    // getPublicOffers() only ever computed a lock/unlock display flag,
    // nothing here ever credited the cashback a customer actually earned.
    //
    // The PENDING cashback row is safe to create unconditionally (same as
    // the first-time-offer/cart-milestone/coupon-cashback blocks above) —
    // it's only ever actually credited later by a real order-lifecycle
    // event, so it's harmless if the order never gets there. recordUsage()
    // is different: it permanently consumes the offer's per-user cap the
    // instant it runs, so — mirroring the coupon-usage gate directly
    // above — it must wait for payment to actually be confirmed for
    // ONLINE/WALLET. The deferred call lives in
    // payments.service.js/wallet.service.js, same two places
    // couponsService.recordUsageForOrder() is called from.
    if (paymentOfferMatch && createdOrders.length === 1) {
      try {
        await this.cashbackService.createPending({
          orderId: createdOrders[0].id,
          userId,
          sourceType: 'PAYMENT_OFFER',
          sourceId: paymentOfferMatch.offerId,
          amount: paymentOfferMatch.cashbackAmount,
          creditTrigger: paymentOfferMatch.creditTrigger,
        })
        if (paymentAlreadyConfirmedAtCreation) {
          await this.paymentOffersService.recordUsage(paymentOfferMatch.offerId, userId, createdOrders[0].id)
        }
      } catch (err) {
        logStepFailure('payment_offer_follow_through', err)
      }
    }

    // Stock-transition side effects (Req 11.1–11.4, 11.6, 11.9). Fired AFTER
    // COMMIT so a rolled-back checkout never emits user-facing events.
    // Already wrapped in a try/catch inside the splitter, but we add an
    // outer guard here to defend against an exception escaping the helper.
    try {
      const transitions = createdOrders.stockTransitions || []
      await this.orderSplitter.firePostCommitSideEffects(transitions)
    } catch (err) {
      logger.warn(
        {
          err: err.message,
          userId,
          orderIds: createdOrders.map((o) => o.id),
          action: 'order_stock_transitions_fan_out',
        },
        'Order-driven stock transition fan-out failed'
      )
    }

    // Road-route distance (store -> customer), calculated ONCE and stored
    // permanently on the order. Deliberately NOT awaited — a routing API
    // call can take several seconds, and it must never delay the
    // customer's checkout response. Errors are caught inside the helper
    // itself; this outer catch only guards against something escaping it.
    const routeLookups = createdOrders.routeLookups || []
    if (routeLookups.length > 0) {
      this.orderSplitter.fireRouteDistanceLookup(routeLookups).catch((err) => {
        logger.warn(
          { err: err.message, userId, action: 'order_route_distance_fan_out' },
          'Road-route distance fan-out failed'
        )
      })
    }

    // Per-order delivery assignment + notifications (Req 5.8)
    for (const order of createdOrders) {
      logger.info(
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          shopId: order.shopId,
          userId,
          total: order.totalAmount,
          paymentMethod: normalizedPaymentMethod,
          status: order.status,
          action: 'order_placed',
        },
        'Per-shop order placed successfully'
      )

      // For ONLINE and WALLET payments, do NOT send "Order placed" notification yet.
      // - ONLINE: notification sent after Razorpay payment verification
      // - WALLET: notification sent after wallet deduction succeeds
      // This prevents false "Order placed" notifications when payment fails.
      if (paymentAlreadyConfirmedAtCreation) {
        await this._sendCustomerOrderNotification(
          userId,
          buildCustomerOrderEventNotification({
            orderId: order.id,
            orderNumber: order.orderNumber,
            timelineType: 'ORDER_PLACED',
            status: order.status,
          })
        )

        this.fastify?.emitDashboardNewOrder?.({
          id: order.id,
          order_number: order.orderNumber,
          total: order.totalAmount,
          payment_method: normalizedPaymentMethod,
          delivery_mode: order.deliveryMode,
          created_at: order.createdAt,
        })
      }

      if (order.status === ORDER_STATUS.CONFIRMED) {
        await this._queueAutoAssign(order.id, 'ORDER_PLACED_COD')
        // COD orders reach CONFIRMED right here (no separate payment webhook
        // exists for COD) — credit any cashback whose trigger is
        // ORDER_CONFIRMED now instead of waiting for a hook that will never fire.
        // Also fire PAYMENT_SUCCESS: COD has no distinct "payment succeeded"
        // event separate from order confirmation (the cash itself changes
        // hands at delivery), so confirmation is COD's stand-in for it —
        // otherwise an offer configured with that trigger would stay
        // PENDING forever for every COD order. Mirrors the same pair fired
        // together for ONLINE/WALLET checkouts (payments.service.js,
        // wallet.service.js).
        for (const trigger of ['ORDER_CONFIRMED', 'PAYMENT_SUCCESS']) {
          this.cashbackService.evaluateAndCredit(order.id, trigger).catch((err) => {
            logger.warn({ err: err.message, orderId: order.id, trigger }, 'Cashback evaluation failed (COD confirm)')
          })
        }
      }
    }

    // Apply delivery instructions only. Tip + all fees (handling/platform/
    // delivery/coupon discount/savings) are computed authoritatively by the
    // fee engine at order-creation time and persisted in the transaction, so
    // we must NOT overwrite them here from the client request body.
    if (createdOrders.length === 1 && resolvedInstructions) {
      try {
        await this.repo.updateExtras(createdOrders[0].id, {
          deliveryInstructions: resolvedInstructions,
        })
      } catch (err) {
        logger.warn(
          { err: err.message, orderId: createdOrders[0].id },
          'Failed to update order extras (non-critical)'
        )
      }
    }

    // Backwards-compatible response shape: callers that expect a single
    // `order` field still get the first order; new clients should read the
    // `orders` array.
    return {
      success: true,
      orders: createdOrders,
      order: createdOrders[0],
    }
  }

  _toNumber(value, fallback = 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  /**
   * The furthest a SCHEDULED slot may start — however far the admin has
   * actually generated the delivery calendar. Falls back to the old
   * hardcoded 7-day cap only if the calendar has genuinely never been
   * generated (defensive; the generation worker runs on every boot).
   */
  async _resolveMaxScheduledAhead(now) {
    const maxGeneratedDate = await this.deliveryCalendarService.getMaxGeneratedDate()
    if (!maxGeneratedDate) {
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    }
    const dateStr =
      maxGeneratedDate instanceof Date
        ? maxGeneratedDate.toISOString().slice(0, 10)
        : maxGeneratedDate
    return new Date(`${dateStr}T23:59:59.999Z`)
  }

  /**
   * Blocks ASAP ordering while the store is closed. Returns a
   * `{ success: false, ... }` payload (matching every other early-return
   * in `placeOrder`) when closed, or `null` when it's fine to proceed.
   */
  async _checkStoreOpenForAsap() {
    const { isOpen } = await this.storeStatusService.isOpen()
    if (isOpen) return null
    return {
      success: false,
      message: 'The store is currently closed. Please choose a scheduled delivery time instead.',
      code: 'STORE_CLOSED_ASAP_UNAVAILABLE',
    }
  }

  /**
   * Enforce the admin's COD/Razorpay/Wallet toggles + COD min/max amount
   * before an order is created. Returns a `{ success: false, ... }` payload
   * (matching every other early-return in `placeOrder`) when the requested
   * method isn't allowed, or `null` when it's fine to proceed.
   */
  async _checkPaymentMethodAllowed(userId, addressId, normalizedPaymentMethod, priceMode = 'retail') {
    const config = await this.paymentSettingsService.getConfig()

    if (normalizedPaymentMethod === 'ONLINE') {
      if (!config.razorpayEnabled) {
        return {
          success: false,
          message: 'Online payment is currently unavailable. Please choose another payment method.',
          code: 'RAZORPAY_DISABLED',
        }
      }
      return null
    }

    if (normalizedPaymentMethod === 'WALLET') {
      if (!config.walletEnabled) {
        return {
          success: false,
          message: 'Wallet payment is currently unavailable. Please choose another payment method.',
          code: 'WALLET_DISABLED',
        }
      }
      return null
    }

    // LEDGER — B2B credit line. Gated on both the platform-wide toggle
    // (payment_settings.ledger_enabled — an admin kill-switch, defaults on)
    // AND the customer actually having an ACTIVE ledger account, mirroring
    // bulk-orders.service.js#create's identical LEDGER_NOT_AVAILABLE check.
    if (normalizedPaymentMethod === 'LEDGER') {
      if (!config.ledgerEnabled) {
        return {
          success: false,
          message: 'Ledger payment is currently unavailable. Please choose another payment method.',
          code: 'LEDGER_DISABLED',
        }
      }
      const ledgerAccount = await this.ledgerService.getMine(userId)
      if (!ledgerAccount || ledgerAccount.status !== 'ACTIVE') {
        return {
          success: false,
          message: 'Ledger payment requires an active B2B credit line',
          code: 'LEDGER_NOT_AVAILABLE',
        }
      }
      return null
    }

    // B2B_CREDIT — "Place Order". Deliberately gated on the business
    // account itself (APPROVED + the customer's own b2b_enabled toggle),
    // not a ledger_accounts row — there's no credit-limit setup step an
    // admin needs to do first; any approved, currently-B2B-browsing
    // customer can place an order of any size on credit. The admin's
    // control point is approval + manual collection afterward, not a
    // pre-configured ceiling.
    if (normalizedPaymentMethod === 'B2B_CREDIT') {
      if (!config.ledgerEnabled) {
        return {
          success: false,
          message: 'Ordering on credit is currently unavailable. Please choose another payment method.',
          code: 'LEDGER_DISABLED',
        }
      }
      const businessAccount = await this.businessAccountsRepo.findByUserId(userId)
      if (!businessAccount || businessAccount.status !== 'APPROVED' || !businessAccount.b2b_enabled) {
        return {
          success: false,
          message: 'Placing an order on credit requires an approved, active B2B account',
          code: 'B2B_CREDIT_NOT_AVAILABLE',
        }
      }
      return null
    }

    // COD (default)
    if (!config.codEnabled) {
      return {
        success: false,
        message: 'Cash on Delivery is currently unavailable. Please choose another payment method.',
        code: 'COD_DISABLED',
      }
    }

    const { totalPayable } = await this.billSummaryService.getBillSummary(userId, addressId, { priceMode })
    if (totalPayable < config.codMinOrderAmount) {
      return {
        success: false,
        message: `Cash on Delivery is available for orders above ₹${config.codMinOrderAmount}.`,
        code: 'COD_BELOW_MIN',
      }
    }
    if (config.codMaxOrderAmount != null && totalPayable > config.codMaxOrderAmount) {
      return {
        success: false,
        message: `Cash on Delivery isn't available for orders above ₹${config.codMaxOrderAmount}. Please pay online.`,
        code: 'COD_ABOVE_MAX',
      }
    }
    return null
  }

  /**
   * List orders for the current user (paginated)
   */
  async listByUser(userId, filters) {
    const { offset, limit } = getOffsetLimit(filters)
    const page = Math.max(1, Math.floor(filters.page || 1))

    const { orders, total } = await this.repo.findByUser(userId, {
      limit,
      offset,
      status: filters.status,
      paymentFailed: filters.paymentFailed,
    })

    return {
      orders: await this._attachItemThumbnails(orders),
      pagination: buildPagination({ page, limit, total }),
    }
  }

  /**
   * Get active (in-progress) order for a user
   */
  async getActive(userId) {
    const order = await this.repo.findActiveByUser(userId)
    if (!order) {
      return null
    }
    return this._enrichCustomerOrder(order)
  }

  /**
   * Get a single order by ID (user-scoped)
   */
  async getById(userId, orderId) {
    const order = await this.repo.findByIdAndUser(orderId, userId)
    if (!order) {
      return null
    }
    return this._enrichCustomerOrder(order)
  }

  /**
   * Cancel an order (only if PENDING or CONFIRMED)
   */
  async cancel(userId, orderId, reason) {
    const order = await this.repo.findByIdAndUser(orderId, userId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    const cancellable = [ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED]
    if (!cancellable.includes(order.status)) {
      return {
        success: false,
        message: `Cannot cancel order in "${order.status}" status`,
      }
    }

    // Guard specifically for unpaid ONLINE orders — this endpoint is also
    // what the app calls the instant Razorpay Checkout reports ANY failure
    // (network error, timeout, unknown SDK error — not just a genuine user
    // cancel), often within seconds of order creation. Unlike the 15-minute
    // payment-expiry worker, this path had no check against Razorpay before
    // cancelling, so a payment Razorpay actually captured could get silently
    // orphaned: money taken, order cancelled, no refund, and — because the
    // order leaves PENDING status here — the worker's own reconciliation
    // query never revisits it either. Mirrors the worker's check.
    if (
      order.status === ORDER_STATUS.PENDING &&
      order.paymentMethod === 'ONLINE' &&
      order.paymentStatus === 'PENDING'
    ) {
      let confirmedOrder
      try {
        confirmedOrder = await this._reconcileBeforeCancel(order)
      } catch (err) {
        // Could not verify with Razorpay (network/API error) — do not cancel
        // blind. Same fail-safe as payment-expiry.worker.js: leave it PENDING
        // for the customer to retry or for the worker to resolve later.
        logger.warn(
          { err: err.message, orderId },
          'Order cancel: Razorpay verification check failed, refusing to cancel blind'
        )
        return {
          success: false,
          message: 'Unable to verify payment status right now. Please try again in a moment.',
        }
      }
      if (confirmedOrder) {
        return {
          success: false,
          paymentConfirmed: true,
          order: confirmedOrder,
          message: 'Payment was already confirmed for this order — it is being processed and cannot be cancelled.',
        }
      }
    }

    // Restore stock in a transaction — goes through the centralized
    // applyStockChange() so this gets a CANCELLATION_RESTORE stock_movements
    // ledger row (previously this used a raw UPDATE with no ledger entry
    // and no cache invalidation, unlike every other stock-mutating path).
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await this.shopProductsRepo.restoreStockForCancelledOrder(client, {
        orderId,
        items: order.items,
        source: 'API',
        actor: { userId, shopRole: null },
      })
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      logger.error({ err, orderId }, 'Stock restore failed during cancellation')
    } finally {
      client.release()
    }

    // Cache invalidation happens after COMMIT per applyStockChange()'s
    // contract — every other stock-mutating path does the same.
    try {
      const shopId = order.shopId || order.shop_id
      if (shopId) await this.shopProductsService.invalidateShopCache(shopId)
    } catch (err) {
      logger.warn({ err: err.message, orderId }, 'Cache invalidation failed after cancel (non-blocking)')
    }

    // Defense in depth against a non-Flutter API consumer sending a
    // whitespace-only reason — the Flutter datasource already trims and
    // omits empty reasons itself, but the schema alone (maxLength only,
    // kept optional for the currently-published app that never sends this
    // field at all) wouldn't catch "   ".
    const normalizedReason = typeof reason === 'string' ? reason.trim() : null
    const updated = await this.repo.updateStatus(orderId, ORDER_STATUS.CANCELLED, {
      cancelledReason: normalizedReason || 'Cancelled by customer',
    })

    // A rider can already be assigned by the time the order is cancelled
    // (e.g. admin assigned early on a still-CONFIRMED order) — without
    // this the assignment silently lingers as ACCEPTED forever and the
    // rider's app keeps showing a pickup for an order that's gone.
    this.finalizeAssignmentRepo
      .cancelOpenAssignment(pool, orderId, reason || 'Order cancelled by customer')
      .catch((err) => {
        logger.warn({ err: err.message, orderId }, 'Rider assignment cleanup failed after cancel (non-blocking)')
      })

    // Reverse any cashback tied to this order — PENDING rows are simply
    // cancelled, CREDITED rows (e.g. a PAYMENT_SUCCESS-triggered cashback
    // credited before the customer cancelled a still-CONFIRMED order) are
    // clawed back from the wallet. Best-effort, does not block the response.
    this.cashbackService.cancelForOrder(orderId).catch((err) => {
      logger.warn({ err: err.message, orderId }, 'Cashback cancellation failed (customer cancel)')
    })

    // Refund the wallet-balance-toggle portion of this order, if any and if
    // it was actually taken. This deliberately does NOT attempt to fix the
    // pre-existing, separate gap where a self-cancel never refunds COD cash
    // or a Razorpay remainder (out of scope here) — it only closes the
    // regression this feature would otherwise introduce: a COD order's
    // wallet portion is debited immediately at creation (see placeOrder),
    // so without this, cancelling before delivery would silently forfeit
    // that money. The condition excludes an ONLINE order whose wallet
    // portion was only ever *planned*, never actually debited — for
    // ONLINE, paymentStatus === 'PAID' is exactly when
    // completeVerifiedPayment ran and the debit actually happened.
    if (
      order.walletAmountUsed > 0 &&
      (order.paymentMethod === 'COD' || order.paymentStatus === 'PAID')
    ) {
      this.walletService.addMoney(userId, {
        amount: order.walletAmountUsed,
        description: `Refund of wallet payment for cancelled order ${order.orderNumber}`,
        referenceId: orderId,
        // 'REFUND' is the only value wallet_transactions' chk_wallet_tx_sub_type
        // CHECK constraint allows for this (migration
        // 068_first_time_offers_and_cashback.sql) — 'ORDER_CANCEL_REFUND'
        // isn't in that list and would fail this credit the same way
        // 'ORDER_PAYMENT' failed the debit in wallet.service.js#debitForOrder.
        subType: 'REFUND',
        orderId,
      }).catch((err) => {
        logger.warn({ err: err.message, orderId }, 'Wallet refund on cancel failed (customer cancel)')
      })
    }

    // Note: a B2B_CREDIT ("Place Order") order needs no reversal here on
    // self-cancel — it draws no ledger_accounts balance to reverse (see
    // placeOrder()'s B2B_CREDIT block); "amount owed" lives entirely on
    // the order's own total_amount/b2b_amount_settled, so a cancelled
    // order simply stops being collectible, with nothing external to undo.

    logger.info({ orderId, userId }, 'Order cancelled')
    return { success: true, order: updated }
  }

  /**
   * Checks Razorpay directly for a captured payment on this order before a
   * cancel is allowed to proceed — mirrors payment-expiry.worker.js's
   * _processOneExpiredPayment(). Returns the (now-confirmed) order if a
   * captured payment was found, so the caller must NOT cancel; returns null
   * when it's safe to proceed (no payment row yet, already resolved to
   * something other than PENDING, or Razorpay genuinely shows no capture).
   *
   * Throws on a Razorpay API/network failure — the caller decides how to
   * fail safe (never cancel without having actually verified).
   */
  async _reconcileBeforeCancel(order) {
    if (!razorpay) return null

    const payment = await this.paymentsRepo.findByOrderId(order.id)
    if (!payment || !payment.razorpayOrderId || payment.status !== 'PENDING') {
      return null
    }

    const result = await this.paymentsService.reconcileWithRazorpay(
      payment.razorpayOrderId,
      'ORDER_CANCEL_RECONCILE'
    )

    if (!result.captured || !result.success) return null

    logger.info(
      { orderId: order.id, needsManualReview: !!result.needsManualReview },
      'Order cancel blocked: Razorpay shows the payment was actually captured — order confirmed instead of cancelled'
    )

    return this.repo.findByIdAndUser(order.id, order.userId)
  }

  /**
   * Re-order: add items from a past order back to cart
   */
  async reorder(userId, orderId) {
    const order = await this.repo.findByIdAndUser(orderId, userId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    const warnings = []

    // cartService.addItem is delta-based (adds on top of whatever quantity
    // is already in the cart) — for ONLINE/WALLET orders the cart is
    // deliberately left populated until payment confirms (see create()'s
    // cart-clear deferral above), so calling reorder() right after a
    // cancelled/failed payment used to double every quantity instead of
    // leaving the still-present cart alone. Reported bug: customer backs
    // out of the Razorpay sheet, the app's cancel+reorder retry-safety-net
    // fires, and their cart quantity silently doubles.
    //
    // Topping up only the shortfall against the RAW current cart (not the
    // enriched/filtered one from cartService.getCart, which can silently
    // drop temporarily out-of-stock lines) makes this call idempotent for
    // that retry path, while still fully restoring a genuinely emptied
    // cart — e.g. reordering a past, already-cleared order — to the
    // ordered quantity rather than more.
    const existingCart = await this.cartRepo.getCart(userId)
    const existingQtyByKey = new Map(
      existingCart.map((item) => [`${item.productId}:${item.shopId}`, item.quantity])
    )

    for (const item of order.items) {
      const shopId = item.shopId || order.shopId || null
      const existingQty = existingQtyByKey.get(`${item.productId}:${shopId}`) || 0
      const topUp = item.quantity - existingQty
      if (topUp <= 0) continue

      const result = await this.cartService.addItem(userId, {
        productId: item.productId,
        shopId,
        quantity: topUp,
      })
      if (!result.success) {
        warnings.push(result.message)
      }
    }

    const cart = await this.cartService.getCart(userId)

    return {
      success: true,
      cart,
      warnings: warnings.length > 0 ? warnings : undefined,
    }
  }

  // ─── Admin methods ─────────────────────────────────────

  /**
   * Admin: list all orders (paginated, filterable)
   */
  async adminListAll(filters) {
    const { offset, limit } = getOffsetLimit(filters)
    const page = Math.max(1, Math.floor(filters.page || 1))

    const { orders, total } = await this.repo.findAll({
      limit,
      offset,
      status: filters.status,
      userId: filters.userId,
    })

    return {
      orders,
      pagination: buildPagination({ page, limit, total }),
    }
  }

  /**
   * Admin: update order status
   */
  async adminUpdateStatus(orderId, status) {
    const order = await this.repo.findById(orderId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    const extra = {}
    if (status === ORDER_STATUS.DELIVERED) {
      extra.deliveredAt = new Date()
      extra.paymentStatus = 'PAID'
    }
    if (status === ORDER_STATUS.CANCELLED) {
      extra.cancelledReason = 'Cancelled by admin'
      // Restore stock — goes through the centralized applyStockChange() so
      // this gets a CANCELLATION_RESTORE stock_movements ledger row (was a
      // raw UPDATE with no ledger entry and no cache invalidation).
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await this.shopProductsRepo.restoreStockForCancelledOrder(client, {
          orderId,
          items: order.items,
          source: 'DASHBOARD',
          actor: null,
        })
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        logger.error({ err, orderId }, 'Stock restore failed during admin cancellation')
      } finally {
        client.release()
      }
      try {
        const shopId = order.shopId || order.shop_id
        if (shopId) await this.shopProductsService.invalidateShopCache(shopId)
      } catch (err) {
        logger.warn({ err: err.message, orderId }, 'Cache invalidation failed after cancel (non-blocking)')
      }
    }

    const updated = await this.repo.updateStatus(orderId, status, extra)
    logger.info({ orderId, status }, 'Order status updated by admin')

    if (status === ORDER_STATUS.DELIVERED) {
      this.cashbackService.evaluateAndCredit(orderId, 'ORDER_DELIVERED').catch((err) => {
        logger.warn({ err: err.message, orderId }, 'Cashback evaluation failed (admin deliver)')
      })
      this.spinWheelService.evaluateMilestones(order.userId).catch((err) => {
        logger.warn({ err: err.message, orderId }, 'Spin milestone evaluation failed (admin deliver)')
      })
      this.scratchCardService.evaluateMilestones(order.userId).catch((err) => {
        logger.warn({ err: err.message, orderId }, 'Scratch milestone evaluation failed (admin deliver)')
      })
    }
    if (status === ORDER_STATUS.CANCELLED) {
      this.cashbackService.cancelForOrder(orderId).catch((err) => {
        logger.warn({ err: err.message, orderId }, 'Cashback cancellation failed (admin cancel)')
      })
      this.finalizeAssignmentRepo
        .cancelOpenAssignment(pool, orderId, 'Order cancelled by admin')
        .catch((err) => {
          logger.warn({ err: err.message, orderId }, 'Rider assignment cleanup failed after admin cancel (non-blocking)')
        })
    }
    return { success: true, order: updated }
  }

  /**
   * Admin: assign a rider to an order
   */
  async adminAssignRider(orderId, riderId) {
    const order = await this.repo.findById(orderId)
    if (!order) {
      return { success: false, message: 'Order not found' }
    }

    if (order.status === ORDER_STATUS.DELIVERED || order.status === ORDER_STATUS.CANCELLED) {
      return { success: false, message: 'Cannot assign rider to a completed/cancelled order' }
    }

    const updated = await this.repo.assignRider(orderId, riderId)
    logger.info({ orderId, riderId }, 'Rider assigned to order')
    return { success: true, order: updated }
  }

  /**
   * Generate PDF invoice for an order — the GST tax invoice for a B2B
   * order (non-null buyerGstin, or paid via the B2B-only LEDGER method),
   * the plain 80mm receipt otherwise. The mobile app only ever calls this
   * one route (it has no separate tax-invoice button), so a B2B customer
   * needs the right document to come back automatically rather than
   * always getting the retail-shaped receipt.
   */
  async getInvoice(userId, orderId) {
    const order = await this.repo.findById(orderId)
    if (!order) {
      return { success: false, statusCode: 404, message: 'Order not found' }
    }

    // Customers can only access their own invoices.
    // `findById` returns the camelCase shape from `_format()` (userId,
    // paymentStatus), not raw snake_case columns — these checks were
    // comparing against always-undefined fields, so every invoice request
    // failed with "Access denied" regardless of actual ownership.
    if (order.userId !== userId) {
      return { success: false, statusCode: 403, message: 'Access denied' }
    }

    if (order.paymentStatus !== 'PAID') {
      return { success: false, statusCode: 400, message: 'Invoice available only for paid orders' }
    }

    if (order.buyerGstin || order.paymentMethod === 'LEDGER') {
      return this._buildGstInvoiceResult(userId, order)
    }

    // Timeline enriches the CANCELLED/REFUNDED banner with a date + reason;
    // harmless no-op for any other status (generateInvoicePDF only reads it
    // when order.status is terminal-cancelled/refunded).
    const timeline = await this.repo.getStatusHistory(orderId)
    const rawToken = await getActivePickupToken(orderId)
    const pickupToken = rawToken
      ? { assignmentId: rawToken.delivery_assignment_id, token: rawToken.token, version: rawToken.version }
      : null
    const buffer = await generateInvoicePDF({ ...order, timeline, pickup_token: pickupToken })
    return {
      success: true,
      buffer,
      orderNumber: order.orderNumber,
    }
  }

  /**
   * Generate the A4 GST tax invoice PDF for an order — separate document
   * from getInvoice() above (an 80mm POS receipt). Same ownership/paid
   * gating; additionally attaches the customer's name/phone (not columns
   * on `orders` itself, so getInvoice()'s receipt has always rendered
   * those as "-" for the customer-facing route — a proper tax invoice
   * needs them, so this method does the one-off users lookup getInvoice()
   * never needed).
   */
  async getGstInvoice(userId, orderId) {
    const order = await this.repo.findById(orderId)
    if (!order) {
      return { success: false, statusCode: 404, message: 'Order not found' }
    }
    if (order.userId !== userId) {
      return { success: false, statusCode: 403, message: 'Access denied' }
    }
    if (order.paymentStatus !== 'PAID') {
      return { success: false, statusCode: 400, message: 'Invoice available only for paid orders' }
    }

    return this._buildGstInvoiceResult(userId, order)
  }

  /** Shared by getInvoice() (auto-routed) and getGstInvoice() (explicit route). */
  async _buildGstInvoiceResult(userId, order) {
    const customer = await this.usersRepo.findById(userId)
    const buffer = await generateGstInvoicePDF({
      ...order,
      customerName: customer?.name || null,
      customerPhone: customer?.phone || null,
    })
    return {
      success: true,
      buffer,
      orderNumber: order.orderNumber,
    }
  }

  async _queueAutoAssign(orderId, source = 'ORDERS_SERVICE') {
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

  async _enrichCustomerOrder(order) {
    const [statusHistory, riderLocation, deliveryOtp, b2bSettlements, cashback] = await Promise.all([
      this.repo.getStatusHistory(order.id),
      order.riderId && this.fastify?.getRiderLocation
        ? this.fastify.getRiderLocation(order.riderId).catch(() => null)
        : Promise.resolve(null),
      order.riderId ? this._getActiveDeliveryOtp(order.id) : Promise.resolve(null),
      // Only a "Place Order" B2B credit order (b2bApprovalStatus set) ever
      // has settlement rows — skip the query entirely for every other order.
      order.b2bApprovalStatus ? this.repo.getB2BSettlements(order.id) : Promise.resolve([]),
      query(
        `SELECT amount, status, source_type FROM cashback_transactions
          WHERE order_id = $1 AND status IN ('PENDING', 'CREDITED')`,
        [order.id]
      ).then((r) => r.rows).catch(() => []),
    ])

    const [enriched] = await this._attachItemThumbnails([order])

    return {
      ...enriched,
      // One itemised bill (discounts by source, every fee, GST split,
      // wallet / Razorpay / cash split) — same builder the receipt PDF and
      // the admin dashboard use, so all of them always agree.
      bill: buildOrderBill(order, { cashback }),
      deliveryOtp,
      timeline: this._buildCustomerTimeline(order, statusHistory || []),
      tracking: this._buildTrackingData(order, riderLocation),
      b2bSettlements,
    }
  }

  /**
   * Delivery OTP for the order's current rider assignment, or null once
   * there's no active (ACCEPTED/IN_TRANSIT) assignment — e.g. before a
   * rider has accepted, or after the order is delivered/cancelled.
   */
  async _getActiveDeliveryOtp(orderId) {
    const { rows } = await query(
      `SELECT delivery_otp FROM delivery_assignments
       WHERE order_id = $1 AND status IN ('ACCEPTED', 'IN_TRANSIT')
       ORDER BY assigned_at DESC LIMIT 1`,
      [orderId]
    )
    return rows[0]?.delivery_otp || null
  }

  /**
   * Enrich denormalized order items with the current product thumbnail.
   *
   * Order items are point-in-time snapshots without an image, so customer
   * order screens look thin. We batch-resolve thumbnails for every item across
   * all supplied orders in a single query (no N+1) and attach `thumbnailUrl`.
   * Failures are swallowed — a missing image must never break the orders list.
   *
   * @param {Array<object>} orders
   * @returns {Promise<Array<object>>}
   */
  async _attachItemThumbnails(orders) {
    if (!Array.isArray(orders) || orders.length === 0) {
      return orders || []
    }

    try {
      const productIds = []
      for (const order of orders) {
        for (const item of order.items || []) {
          if (item && item.productId) {
            productIds.push(item.productId)
          }
        }
      }

      if (productIds.length === 0) {
        return orders
      }

      const thumbnailMap = await this.repo.findThumbnailsByProductIds(productIds)

      return orders.map((order) => ({
        ...order,
        items: (order.items || []).map((item) => {
          const raw = thumbnailMap.get(item.productId) || null
          return {
            ...item,
            thumbnailUrl: raw
              ? normalizeCloudinaryDeliveryUrl(raw, 'thumb')
              : null,
          }
        }),
      }))
    } catch (err) {
      logger.warn(
        { err: err.message, action: 'attach_item_thumbnails' },
        'Failed to enrich order items with thumbnails'
      )
      return orders
    }
  }

  _buildCustomerTimeline(order, statusHistory) {
    const timeline = [
      {
        type: 'PENDING',
        status: 'PENDING',
        message: 'Order placed',
        timestamp: order.createdAt,
      },
    ]
    const seenTypes = new Set(['PENDING'])

    for (const entry of statusHistory) {
      const timelineType = this._normalizeTimelineType(entry.to_status)
      if (!timelineType || seenTypes.has(timelineType)) {
        continue
      }

      timeline.push({
        type: timelineType,
        status: this._timelineTypeToOrderStatus(timelineType),
        message: entry.note || this._timelineMessage(timelineType),
        timestamp: entry.changed_at,
      })
      seenTypes.add(timelineType)
    }

    const currentTimelineType = this._normalizeTimelineType(order.status)
    if (currentTimelineType && !seenTypes.has(currentTimelineType)) {
      timeline.push({
        type: currentTimelineType,
        status: this._timelineTypeToOrderStatus(currentTimelineType),
        message: this._timelineMessage(currentTimelineType),
        timestamp: order.deliveredAt || order.updatedAt || order.createdAt,
      })
    }

    return timeline.sort((left, right) => {
      const leftTime = new Date(left.timestamp).getTime()
      const rightTime = new Date(right.timestamp).getTime()
      return leftTime - rightTime
    })
  }

  _buildTrackingData(order, riderLocation) {
    const address = order.deliveryAddress || {}
    const destinationLat = Number(address.lat)
    const destinationLng = Number(address.lng)
    const riderLat = Number(riderLocation?.lat)
    const riderLng = Number(riderLocation?.lng)

    return {
      rider: order.riderId
        ? {
            id: order.riderId,
            name: order.riderName || 'Delivery partner',
            phone: order.riderPhone || '',
          }
        : null,
      riderLocation:
        Number.isFinite(riderLat) && Number.isFinite(riderLng)
          ? {
              lat: riderLat,
              lng: riderLng,
              timestamp: riderLocation?.updatedAt
                ? new Date(riderLocation.updatedAt).toISOString()
                : null,
            }
          : null,
      destination: {
        lat: Number.isFinite(destinationLat) ? destinationLat : null,
        lng: Number.isFinite(destinationLng) ? destinationLng : null,
        addressLine1: address.addressLine1 || address.address_line1 || '',
        addressLine2: address.addressLine2 || address.address_line2 || '',
        landmark: address.landmark || '',
        city: address.city || '',
        state: address.state || '',
        pincode: address.pincode || '',
      },
    }
  }

  _normalizeTimelineType(rawStatus) {
    const normalized = `${rawStatus || ''}`.trim().toUpperCase()
    if (!normalized) {
      return null
    }

    if (normalized === 'IN_TRANSIT') {
      return 'OUT_FOR_DELIVERY'
    }

    return normalized
  }

  _timelineTypeToOrderStatus(timelineType) {
    switch (timelineType) {
      case 'RIDER_ACCEPTED':
        return 'PACKED'
      case 'PICKED_UP':
      case 'OUT_FOR_DELIVERY':
        return 'OUT_FOR_DELIVERY'
      default:
        return timelineType
    }
  }

  _timelineMessage(timelineType) {
    switch (timelineType) {
      case 'PENDING':
        return 'Order placed'
      case 'CONFIRMED':
        return 'Store accepted your order'
      case 'PREPARING':
        return 'Store is preparing your order'
      case 'PACKED':
        return 'Order packed and ready for pickup'
      case 'RIDER_ACCEPTED':
        return 'Delivery partner accepted your order'
      case 'PICKED_UP':
        return 'Delivery partner picked up your order'
      case 'OUT_FOR_DELIVERY':
        return 'Your order is out for delivery'
      case 'DELIVERED':
        return 'Order delivered successfully'
      case 'CANCELLED':
        return 'Order cancelled'
      default:
        return 'Order updated'
    }
  }

  async _sendCustomerOrderNotification(userId, notification) {
    if (!this.notificationsService || !userId || !notification) {
      return
    }

    try {
      await this.notificationsService.sendNotification(userId, notification)
    } catch (err) {
      logger.warn(
        {
          err: err.message,
          userId,
          orderId: notification?.data?.orderId ?? null,
          timelineType: notification?.data?.timelineType ?? null,
        },
        'Customer order notification failed'
      )
    }
  }
}
