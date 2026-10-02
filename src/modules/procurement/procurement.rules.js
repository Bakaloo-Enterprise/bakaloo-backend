import { BusinessError } from '../../utils/business-error.js'

/**
 * Procurement rules — pure functions, no I/O. Money is handled in integer paise so a total never drifts.
 * Quantities are whole units of the product's selling unit (store stock is an INTEGER).
 */

export const PURPOSES = Object.freeze(['RETAIL', 'B2B_RESERVED'])
export const ADJUSTMENT_KINDS = Object.freeze({
  VENDOR_RETURN: { label: 'Returned to vendor', loss: false, stockType: 'MANUAL_ADJUSTMENT' },
  DAMAGE: { label: 'Damaged', loss: true, stockType: 'DAMAGED_STOCK' },
  WASTAGE: { label: 'Wasted / expired', loss: true, stockType: 'DAMAGED_STOCK' },
  AUTHORIZED_ADJUSTMENT: { label: 'Authorised adjustment', loss: true, stockType: 'MANUAL_ADJUSTMENT' },
  B2B_SUPPLY: { label: 'Supplied to a B2B order', loss: false, stockType: 'MANUAL_ADJUSTMENT' },
})
/** A vendor return is recovered cost and a B2B supply is a sale, so neither is a "tracked loss". */
export const isLossKind = (kind) => ADJUSTMENT_KINDS[kind]?.loss === true

const toPaise = (v) => Math.round(Number(v) * 100)
const fromPaise = (p) => p / 100

/** Rupees × quantity, exact to the paisa. */
export function lineTotal(qty, unitPrice) {
  return fromPaise(Math.round(qty * toPaise(unitPrice)))
}

/** Cost of `qty` units at an entry's unit price (used to value losses and returns). */
export const valueOf = lineTotal

function whole(label, v, { min = 0 } = {}) {
  if (!Number.isInteger(v) || v < min) throw new BusinessError(`${label} must be a whole number${min > 0 ? ` of at least ${min}` : ''}.`, 400, 'VALIDATION', { [label]: 'Invalid' })
  return v
}

/**
 * Validate + normalise a new purchase. `product` and `today` (India date) are supplied by the caller.
 * purchase_total defaults to received × unit price; an explicit total is allowed (invoice rounding, freight).
 */
export function normalizeEntry(input, { today }) {
  const received = whole('Received quantity', input.receivedQty ?? input.expectedQty, { min: 1 })
  const expected = whole('Expected quantity', input.expectedQty ?? received, { min: 1 })
  const damaged = whole('Damaged quantity', input.damagedQty ?? 0)
  if (damaged > received) throw new BusinessError('Damaged quantity cannot be more than what was received.', 400, 'VALIDATION', { damagedQty: 'More than received' })
  const unitPrice = Number(input.unitPrice)
  if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 99_999_999.99) throw new BusinessError('Purchase price must be 0 or more.', 400, 'VALIDATION', { unitPrice: 'Invalid' })
  let total = lineTotal(received, unitPrice)
  if (input.purchaseTotal !== undefined && input.purchaseTotal !== null) {
    const t = Number(input.purchaseTotal)
    if (!Number.isFinite(t) || t < 0) throw new BusinessError('Purchase total must be 0 or more.', 400, 'VALIDATION', { purchaseTotal: 'Invalid' })
    total = fromPaise(toPaise(t))
  }
  const purpose = input.purpose ?? 'RETAIL'
  if (!PURPOSES.includes(purpose)) throw new BusinessError('Purpose must be RETAIL or B2B_RESERVED.', 400, 'VALIDATION', { purpose: 'Invalid' })
  if (purpose === 'B2B_RESERVED' && !input.businessAccountId && !String(input.reservationNote ?? '').trim()) {
    throw new BusinessError('Say which business account (or note) this stock is reserved for.', 400, 'VALIDATION', { businessAccountId: 'Required for B2B stock' })
  }
  if (purpose === 'B2B_RESERVED' && input.destinationShopId) {
    throw new BusinessError('B2B-reserved stock is held centrally; it cannot also be tied to one store.', 400, 'VALIDATION', { destinationShopId: 'Not with B2B' })
  }
  const procuredOn = input.procuredOn ?? today
  if (!/^\d{4}-\d{2}-\d{2}$/.test(procuredOn)) throw new BusinessError('Date must look like 2026-10-02.', 400, 'VALIDATION', { procuredOn: 'Invalid' })
  if (procuredOn > today) throw new BusinessError('A purchase cannot be dated in the future.', 400, 'VALIDATION', { procuredOn: 'In the future' })
  return { expectedQty: expected, receivedQty: received, damagedQty: damaged, unitPrice: fromPaise(toPaise(unitPrice)), purchaseTotal: total, purpose, procuredOn }
}

/**
 * Where an entry's stock stands.
 *   usable    = received − damaged at the door
 *   available = usable − sent to stores (net of reversals) − taken out of central stock (returns, damage, B2B…)
 *   shortage  = expected − received (never negative)
 */
export function entryFigures({ expectedQty, receivedQty, damagedQty }, { allocated = 0, centralAdjusted = 0 } = {}) {
  const usable = receivedQty - damagedQty
  return {
    usable,
    shortage: Math.max(0, expectedQty - receivedQty),
    allocated,
    centralAdjusted,
    available: usable - allocated - centralAdjusted,
  }
}

/**
 * Validate a multi-store split against what is available. Returns the cleaned list or throws with a clear reason.
 * @param {{ available: number, purpose: string, destinationShopId: string|null, status: string }} entry
 */
export function checkSplit(entry, rows) {
  if (entry.status !== 'ACTIVE') throw new BusinessError('This purchase was cancelled.', 409, 'ENTRY_CANCELLED')
  if (entry.purpose === 'B2B_RESERVED') throw new BusinessError('This stock is reserved for B2B. Release the reservation first if it should go to stores.', 409, 'RESERVED_FOR_B2B')
  if (!Array.isArray(rows) || rows.length === 0) throw new BusinessError('Choose at least one store.', 400, 'VALIDATION', { allocations: 'Empty' })
  const seen = new Set()
  let total = 0
  const clean = rows.map((r, i) => {
    if (!r?.shopId) throw new BusinessError(`Row ${i + 1}: choose a store.`, 400, 'VALIDATION', { allocations: 'Missing store' })
    if (seen.has(r.shopId)) throw new BusinessError('A store appears twice in the split. Combine its quantities.', 400, 'DUPLICATE_STORE')
    seen.add(r.shopId)
    const q = whole(`Row ${i + 1} quantity`, r.quantity, { min: 1 })
    if (entry.destinationShopId && r.shopId !== entry.destinationShopId) throw new BusinessError('This purchase is dedicated to one store and cannot be sent to another.', 409, 'DEDICATED_STORE')
    total += q
    return { shopId: r.shopId, quantity: q }
  })
  if (total > entry.available) {
    throw new BusinessError(`You are sending ${total} but only ${Math.max(0, entry.available)} is available.`, 409, 'OVER_ALLOCATION', { requested: total, available: entry.available })
  }
  return clean
}

/**
 * Validate an adjustment. `shopHeld` = what that store still holds from THIS entry (allocated − already adjusted
 * there); `available` = the entry's central stock.
 */
export function checkAdjustment(entry, { kind, quantity, shopId, reason }, { available, shopHeld = 0 }) {
  if (!ADJUSTMENT_KINDS[kind]) throw new BusinessError('Unknown adjustment type.', 400, 'VALIDATION', { kind: 'Invalid' })
  if (entry.status !== 'ACTIVE') throw new BusinessError('This purchase was cancelled.', 409, 'ENTRY_CANCELLED')
  const q = whole('Quantity', quantity, { min: 1 })
  if (!String(reason ?? '').trim()) throw new BusinessError('Give a reason — the record has to explain the difference.', 400, 'VALIDATION', { reason: 'Required' })
  if (shopId && kind === 'B2B_SUPPLY') throw new BusinessError('B2B supply is taken from central stock, not from a store.', 400, 'VALIDATION', { shopId: 'Not for B2B supply' })
  if (shopId) {
    if (q > shopHeld) throw new BusinessError(`That store only has ${Math.max(0, shopHeld)} from this purchase.`, 409, 'OVER_STORE_QTY', { held: shopHeld })
  } else if (q > available) {
    throw new BusinessError(`Only ${Math.max(0, available)} is available in central stock.`, 409, 'OVER_ADJUSTMENT', { available })
  }
  return { kind, quantity: q, shopId: shopId ?? null, reason: String(reason).trim() }
}

/** Entry can be cancelled only while nothing was done with it. */
export function canCancel({ allocationCount, adjustmentCount }) {
  return allocationCount === 0 && adjustmentCount === 0
}
