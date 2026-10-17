import { BusinessError } from '../../utils/business-error.js'

/** B2B requirements + purchase plan — pure functions, no I/O. */

export const SOURCES = Object.freeze({
  WHATSAPP_META: { label: 'Business WhatsApp (CRM inbox)' },
  WHATSAPP_PERSONAL: { label: 'Normal WhatsApp' },
  PHONE_CALL: { label: 'Phone call' },
  WALK_IN: { label: 'Walk-in' },
  OTHER: { label: 'Other' },
})
export const PAYMENT_TERMS = Object.freeze(['COD', 'UPI', 'ADVANCE_PAID', 'CREDIT', 'PARTIAL'])
const TRANSITIONS = { INQUIRY: ['CONFIRMED', 'CANCELLED'], CONFIRMED: ['DELIVERED', 'CANCELLED', 'INQUIRY'], DELIVERED: [], CANCELLED: [] }

const whole = (label, v) => {
  if (!Number.isInteger(v) || v < 1) throw new BusinessError(`${label} must be a whole number of at least 1.`, 400, 'VALIDATION', { [label]: 'Invalid' })
  return v
}

/** Keep digits only; Indian numbers are stored as the 10-digit mobile. */
export function cleanPhone(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  let d = String(raw).replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2)
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  if (d.length < 8 || d.length > 15) throw new BusinessError('That phone number does not look right.', 400, 'VALIDATION', { customerPhone: 'Invalid' })
  return d
}

/** Validate a new requirement. `today` is the India date. Returns clean values. */
export function normalizeRequirement(input, { today }) {
  const name = String(input.customerName ?? '').trim()
  if (name.length < 2) throw new BusinessError('Write who is asking — the customer or restaurant name.', 400, 'VALIDATION', { customerName: 'Required' })
  if (!SOURCES[input.source]) throw new BusinessError('Choose how this request came in.', 400, 'VALIDATION', { source: 'Invalid' })
  const terms = input.paymentTerms ?? 'COD'
  if (!PAYMENT_TERMS.includes(terms)) throw new BusinessError('Choose a payment type.', 400, 'VALIDATION', { paymentTerms: 'Invalid' })
  if (!Array.isArray(input.items) || input.items.length === 0) throw new BusinessError('Add at least one product.', 400, 'VALIDATION', { items: 'Empty' })
  const seen = new Set()
  const items = input.items.map((it, i) => {
    if (!it?.productId) throw new BusinessError(`Line ${i + 1}: choose a product.`, 400, 'VALIDATION', { items: 'Missing product' })
    if (seen.has(it.productId)) throw new BusinessError('A product is listed twice. Combine the quantities.', 400, 'DUPLICATE_PRODUCT')
    seen.add(it.productId)
    let unitPrice = null
    if (it.unitPrice !== undefined && it.unitPrice !== null && it.unitPrice !== '') {
      unitPrice = Number(it.unitPrice)
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new BusinessError(`Line ${i + 1}: price must be 0 or more.`, 400, 'VALIDATION', { items: 'Bad price' })
      unitPrice = Math.round(unitPrice * 100) / 100
    }
    return { productId: it.productId, quantity: whole(`Line ${i + 1} quantity`, it.quantity), unitPrice }
  })
  if (input.deliveryDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.deliveryDate)) throw new BusinessError('Delivery date must look like 2026-10-18.', 400, 'VALIDATION', { deliveryDate: 'Invalid' })
    if (input.deliveryDate < today) throw new BusinessError('Delivery date cannot be in the past.', 400, 'VALIDATION', { deliveryDate: 'In the past' })
  }
  return {
    customerName: name, customerPhone: cleanPhone(input.customerPhone), source: input.source, paymentTerms: terms,
    deliveryDate: input.deliveryDate ?? null, note: String(input.note ?? '').trim() || null,
    status: input.confirmed ? 'CONFIRMED' : 'INQUIRY', items,
  }
}

export function checkTransition(from, to) {
  if (!TRANSITIONS[from]?.includes(to)) throw new BusinessError(`A ${from.toLowerCase()} request cannot become ${to.toLowerCase()}.`, 409, 'BAD_TRANSITION')
}

/**
 * The purchase plan for ONE product.
 *   committed = confirmed requests + approved-pending app orders  (promised to customers)
 *   projected = inquiries (might need; shown but never bought automatically)
 *   shopLow   = how far the stores are below their own low-stock line
 *   have      = stock sitting in stores + stock bought but not yet sent to a store
 *   incoming  = ordered but not arrived yet, plus what suppliers still owe — so the same need is never bought twice
 *   toBuy     = what is still missing for the promises and the shelves
 */
export function planFor({ confirmed = 0, appOrders = 0, inquiry = 0, shopLow = 0, storeStock = 0, centralStock = 0, incoming = 0 }) {
  const committed = confirmed + appOrders
  const have = storeStock + centralStock
  const need = committed + shopLow
  const toBuy = Math.max(0, need - have - incoming)
  const status = toBuy > 0 ? 'BUY' : committed + inquiry > 0 && have + incoming < committed + inquiry ? 'WATCH' : 'OK'
  return { committed, projected: inquiry, shopLow, have, incoming, need, toBuy, status }
}
