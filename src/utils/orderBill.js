/**
 * Single source of truth for "what is on this order's bill".
 *
 * The 80mm receipt PDF, the POS slip, the A4 tax invoice, the admin order
 * detail and the customer order screen used to each add up the order's
 * columns on their own, and each forgot different lines (platform fee,
 * small-cart / surge / packaging / quick-delivery fees, tip, which coupon,
 * how the payment was split between wallet / Razorpay / cash). This module
 * turns one order row (snake_case DB shape OR the camelCase repository
 * shape) into an ordered list of bill lines plus a payment split, so every
 * surface prints exactly the same thing.
 *
 * Amounts: `amount` on a line is always the signed effect on the payable
 * total (discounts negative). Scalar order columns are authoritative for
 * money (same rule as migration 056); `fee_breakdown` only supplies labels,
 * waived-fee info and the itemised discount sources. Whatever the pieces do
 * not explain is surfaced as an explicit "Other adjustments" line, so a bill
 * can never silently fail to add up.
 */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const pick = (o, snake, camel) => (o?.[snake] !== undefined && o?.[snake] !== null ? o[snake] : o?.[camel])

export const PAYMENT_METHOD_LABELS = Object.freeze({
  COD: 'Cash on Delivery',
  ONLINE: 'Online (Razorpay)',
  WALLET: 'Wallet',
  LEDGER: 'Ledger',
  B2B_CREDIT: 'On credit (B2B)',
  MANUAL: 'Manual',
})

export function paymentMethodLabel(raw) {
  return PAYMENT_METHOD_LABELS[raw] || raw || '-'
}

function parseJson(v, fallback) {
  if (v == null) return fallback
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return fallback }
}

const FEE_ORDER = [
  'DELIVERY_FEE', 'PLATFORM_FEE', 'HANDLING_FEE', 'SMALL_CART_FEE',
  'SURGE_FEE', 'PACKAGING_FEE', 'QUICK_DELIVERY_SURCHARGE',
]

/** Charges (delivery, platform, handling, small-cart, ...) as bill lines. */
function feeLines(order, breakdown) {
  const stored = {
    DELIVERY_FEE: num(pick(order, 'delivery_fee', 'deliveryFee')),
    PLATFORM_FEE: num(pick(order, 'platform_fee', 'platformFee')),
    HANDLING_FEE: num(pick(order, 'handling_fee', 'handlingFee')),
    QUICK_DELIVERY_SURCHARGE: num(pick(order, 'quick_delivery_surcharge_amount', 'quickDeliverySurchargeAmount')),
  }
  const lateNight = num(pick(order, 'late_night_fee', 'lateNightFee'))
  const snapshot = Array.isArray(breakdown?.fees)
    ? breakdown.fees.filter((f) => f && f.code !== 'GST')
    : []

  const lines = []
  const seen = new Set()

  // Snapshot first: it carries the labels the customer saw at checkout and
  // waived fees (e.g. delivery ₹30 → FREE) that scalar columns can't.
  for (const f of snapshot) {
    const code = f.code
    seen.add(code)
    const amount = r2(f.amount)
    const original = r2(f.originalAmount ?? f.amount)
    if (amount === 0 && !(f.waived && original > 0)) continue
    lines.push({
      code,
      kind: 'charge',
      label: f.label || code,
      amount,
      waived: !!f.waived && amount === 0,
      originalAmount: original,
      note: f.waived ? (f.description || 'Waived') : null,
    })
  }

  // Older orders (no snapshot) and any scalar the snapshot didn't carry.
  const fallbackLabels = {
    DELIVERY_FEE: 'Delivery fee',
    PLATFORM_FEE: 'Platform fee',
    HANDLING_FEE: 'Handling fee',
    QUICK_DELIVERY_SURCHARGE: 'Quick delivery fee',
  }
  for (const [code, amount] of Object.entries(stored)) {
    if (seen.has(code) || amount <= 0) continue
    lines.push({ code, kind: 'charge', label: fallbackLabels[code], amount: r2(amount), waived: false, originalAmount: r2(amount), note: null })
  }
  if (lateNight > 0) {
    lines.push({ code: 'LATE_NIGHT_FEE', kind: 'charge', label: 'Late night fee', amount: r2(lateNight), waived: false, originalAmount: r2(lateNight), note: null })
  }

  const rank = (c) => {
    const i = FEE_ORDER.indexOf(c)
    return i === -1 ? FEE_ORDER.length : i
  }
  return lines.sort((a, b) => rank(a.code) - rank(b.code))
}

/** Discounts, named by source when the order recorded them. */
function discountLines(order, breakdown) {
  const total = r2(num(pick(order, 'discount_amount', 'discountAmount')))
  if (total <= 0) return []

  const couponCode = pick(order, 'coupon_code', 'couponCode')
  const parts = Array.isArray(breakdown?.discounts)
    ? breakdown.discounts.filter((d) => num(d?.amount) > 0)
    : []

  const lines = parts.map((d) => ({
    code: d.code || 'DISCOUNT',
    kind: 'discount',
    label: d.label || 'Discount',
    amount: -r2(d.amount),
    note: null,
  }))
  const explained = r2(lines.reduce((s, l) => s - l.amount, 0))

  if (lines.length === 0) {
    // Orders placed before discount sources were recorded: only the summed
    // amount (and maybe a coupon code) exists.
    return [{
      code: couponCode ? 'COUPON' : 'DISCOUNT',
      kind: 'discount',
      label: couponCode ? `Coupon (${couponCode})` : 'Discount',
      amount: -total,
      note: null,
    }]
  }
  // Recorded parts were clamped/rounded differently from the stored total.
  if (Math.abs(total - explained) >= 0.01) {
    lines.push({ code: 'DISCOUNT', kind: 'discount', label: 'Other discount', amount: -r2(total - explained), note: null })
  }
  return lines
}

/**
 * GST split. Tax is exclusive and computed on (items - discount + fees);
 * Bakaloo ships inside Gujarat so a B2C order is CGST + SGST, and a B2B
 * buyer whose GSTIN is from another state gets IGST (same rule as
 * gstInvoiceGenerator.js).
 */
function taxLines(order, taxableBase) {
  const tax = r2(num(pick(order, 'tax_amount', 'taxAmount')))
  if (tax <= 0) return []
  const rate = taxableBase > 0 ? Math.round((tax / taxableBase) * 1000) / 10 : 0
  const buyerGstin = pick(order, 'buyer_gstin', 'buyerGstin')
  const sellerState = '24'
  const interState = !!(buyerGstin && buyerGstin.length >= 2 && buyerGstin.slice(0, 2) !== sellerState)
  if (interState) {
    return [{ code: 'IGST', kind: 'tax', label: `IGST (${rate}%)`, amount: tax, note: null }]
  }
  const half = r2(tax / 2)
  return [
    { code: 'CGST', kind: 'tax', label: `CGST (${r2(rate / 2)}%)`, amount: half, note: null },
    { code: 'SGST', kind: 'tax', label: `SGST (${r2(rate / 2)}%)`, amount: r2(tax - half), note: null },
  ]
}

/**
 * Who pays what. Wallet is always debited first (toggle at checkout); the
 * rest is Razorpay (ONLINE), cash (COD), a ledger/credit line, or nothing.
 */
function paymentSplit(order, grandTotal, payment) {
  const method = pick(order, 'payment_method', 'paymentMethod') || 'COD'
  const status = pick(order, 'payment_status', 'paymentStatus') || 'PENDING'
  const walletUsed = Math.min(r2(num(pick(order, 'wallet_amount_used', 'walletAmountUsed'))), grandTotal)
  const paid = status === 'PAID'
  const refunded = ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(status)
  const remainder = r2(Math.max(0, grandTotal - walletUsed))
  const refundAmount = payment?.refund_amount != null ? r2(num(payment.refund_amount)) : 0

  const parts = []
  if (method === 'WALLET' && walletUsed === 0) {
    // Legacy full-wallet payment: no wallet_amount_used was recorded.
    parts.push({ code: 'WALLET', label: 'Wallet', amount: grandTotal, state: paid ? 'PAID' : 'PENDING' })
  } else {
    if (walletUsed > 0) {
      parts.push({ code: 'WALLET', label: 'Wallet', amount: walletUsed, state: 'PAID' })
    }
    if (remainder > 0) {
      if (method === 'ONLINE') {
        parts.push({
          code: 'RAZORPAY', label: 'Razorpay (online)', amount: remainder,
          state: paid || refunded ? 'PAID' : status === 'FAILED' ? 'FAILED' : 'PENDING',
          reference: payment?.razorpay_payment_id || null,
        })
      } else if (method === 'COD') {
        parts.push({
          code: 'COD', label: paid ? 'Cash on Delivery (collected)' : 'Cash on Delivery', amount: remainder,
          state: paid || refunded ? 'PAID' : 'DUE',
        })
      } else {
        parts.push({
          code: method, label: paymentMethodLabel(method), amount: remainder,
          state: paid ? 'PAID' : 'PENDING',
        })
      }
    }
  }

  const codDue = parts.find((p) => p.code === 'COD' && p.state === 'DUE')?.amount || 0
  return {
    method,
    methodLabel: paymentMethodLabel(method),
    status,
    parts,
    walletUsed,
    gatewayAmount: parts.find((p) => p.code === 'RAZORPAY')?.amount || 0,
    codDue,
    // What the rider must collect in cash right now (0 once paid / prepaid).
    collectOnDelivery: codDue,
    refundAmount,
    isFullyPrepaid: remainder === 0 || (paid && method !== 'COD'),
  }
}

/**
 * @param {object} order   snake_case or camelCase order (admin findById / OrdersRepository._format)
 * @param {object} [extra]
 * @param {object} [extra.payment]   latest payments row (razorpay_payment_id, refund_amount)
 * @param {Array}  [extra.cashback]  cashback_transactions rows for the order ({amount,status,source_type})
 */
export function buildOrderBill(order, extra = {}) {
  const breakdown = parseJson(pick(order, 'fee_breakdown', 'feeBreakdown'), {}) || {}
  const payment = extra.payment ?? order.payment ?? null

  const items = parseJson(order.items, []) || []
  const itemCount = items.reduce((s, i) => s + num(i.quantity ?? i.qty), 0)
  const subtotal = r2(num(pick(order, 'subtotal', 'subtotal')))
  const tip = r2(num(pick(order, 'tip_amount', 'tipAmount')))
  const storedTotal = r2(num(pick(order, 'total_amount', 'totalAmount')))

  const discounts = discountLines(order, breakdown)
  const fees = feeLines(order, breakdown)
  const discountSum = r2(discounts.reduce((s, l) => s + l.amount, 0))
  const feeSum = r2(fees.reduce((s, l) => s + l.amount, 0))
  const taxableBase = r2(Math.max(0, subtotal + discountSum + feeSum))
  const taxes = taxLines(order, taxableBase)
  const taxSum = r2(taxes.reduce((s, l) => s + l.amount, 0))

  const lines = [
    { code: 'ITEMS', kind: 'items', label: `Item total${itemCount ? ` (${itemCount} ${itemCount === 1 ? 'item' : 'items'})` : ''}`, amount: subtotal, note: null },
    ...discounts,
    ...fees,
    ...taxes,
  ]
  if (tip > 0) lines.push({ code: 'TIP', kind: 'tip', label: 'Rider tip', amount: tip, note: null })

  const computed = r2(subtotal + discountSum + feeSum + taxSum + tip)
  const gap = r2(storedTotal - computed)
  // Money the columns can't explain (legacy rounding, manual edits): show it
  // instead of printing a bill whose lines don't reach the total.
  if (Math.abs(gap) >= 0.01) {
    lines.push({ code: 'ADJUSTMENT', kind: 'adjustment', label: 'Other adjustments', amount: gap, note: null })
  }

  const waivedDelivery = fees.find((f) => f.code === 'DELIVERY_FEE' && f.waived)
  const savingsParts = discounts.map((d) => ({ label: d.label, amount: -d.amount }))
  if (waivedDelivery) savingsParts.push({ label: 'Free delivery', amount: waivedDelivery.originalAmount })
  const savingsStored = r2(num(pick(order, 'savings_total', 'savingsTotal')))
  const savingsTotal = savingsStored > 0 ? savingsStored : r2(savingsParts.reduce((s, p) => s + p.amount, 0))

  const cashback = (extra.cashback || [])
    .filter((c) => c && c.status !== 'CANCELLED' && num(c.amount) > 0)
    .map((c) => ({
      amount: r2(c.amount),
      status: c.status,
      source: c.source_type ?? c.sourceType ?? null,
    }))

  return {
    currency: 'INR',
    itemCount,
    lines,
    grandTotal: storedTotal,
    reconciled: Math.abs(gap) < 0.01,
    savings: { total: savingsTotal, parts: savingsParts },
    payment: paymentSplit(order, storedTotal, payment),
    cashback,
    buyerGstin: pick(order, 'buyer_gstin', 'buyerGstin') || null,
  }
}
