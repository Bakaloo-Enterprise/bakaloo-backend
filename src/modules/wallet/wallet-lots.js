/**
 * Shared constants/formatting for expiring wallet credits
 * (wallet_credit_lots — migration 158_wallet_credit_expiry.sql).
 */

export const LOT_SOURCES = ['SPIN', 'SCRATCH', 'COUPON', 'OFFER', 'ADMIN']

// Customer-facing name of each credit type, used in transaction history and
// notifications ("₹250 Spin & Win prize expired").
export const LOT_LABELS = {
  SPIN: 'Spin & Win prize',
  SCRATCH: 'Scratch Card prize',
  COUPON: 'Coupon cashback',
  OFFER: 'Offer cashback',
  ADMIN: 'Bonus credit',
}

const money = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

export function formatMoney(n) {
  return money(n)
}

export function formatDateIst(date) {
  return new Date(date).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  })
}

/**
 * Transaction-history line written when a lot expires. `remaining` is what
 * was still unspent; a partly-spent lot says so, so the customer can
 * reconcile it against what they remember using.
 */
export function expiryDescription({ sourceType, originalAmount, remaining, expiresAt }) {
  const label = LOT_LABELS[sourceType] || 'Cashback'
  const base =
    Number(remaining) < Number(originalAmount)
      ? `${money(remaining)} of your ${money(originalAmount)} ${label} expired unused`
      : `${money(remaining)} ${label} expired`
  return `${base} (valid till ${formatDateIst(expiresAt)})`
}
