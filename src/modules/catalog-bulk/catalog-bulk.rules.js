import { BusinessError } from '../../utils/business-error.js'

/**
 * Bulk catalog rules — pure functions. A blank cell means "leave as is"; "-" / "clear" empties a price field
 * (the store then inherits the product's price again). Nothing here touches the database.
 */

export const MAX_ROWS = 5000
export const PRICE_FIELDS = Object.freeze(['price', 'sale_price', 'wholesale_price', 'cost_price'])
export const FIELD_LABEL = Object.freeze({
  stock: 'Stock', price: 'Retail price', sale_price: 'Sale price', wholesale_price: 'Wholesale price', cost_price: 'Cost price',
  available: 'Available', max_order_qty: 'Max per order', low_stock_threshold: 'Low-stock alert at',
})
export const FIELDS = Object.freeze(Object.keys(FIELD_LABEL))

const PRICE_MIN = 0.01
const PRICE_MAX = 99_999_999.99

const ALIASES = {
  sku: ['sku', 'productsku', 'itemcode'],
  barcode: ['barcode', 'ean', 'upc', 'gtin'],
  product_id: ['productid'],
  branch_code: ['branchcode', 'storecode', 'shopcode', 'branch', 'store', 'shop'],
  shop_id: ['shopid', 'storeid'],
  stock: ['stock', 'stockquantity', 'stockqty', 'quantity', 'qty'],
  price: ['price', 'retailprice', 'sellingprice'],
  sale_price: ['saleprice', 'offerprice', 'discountprice'],
  wholesale_price: ['wholesaleprice', 'b2bprice'],
  cost_price: ['costprice', 'purchaseprice', 'cost', 'buyingprice'],
  available: ['available', 'availability', 'isavailable', 'enabled', 'active'],
  max_order_qty: ['maxorderqty', 'maxorderquantity', 'maxperorder', 'maxqty'],
  low_stock_threshold: ['lowstockthreshold', 'lowstock', 'lowstockalert', 'reorderlevel'],
}
const norm = (h) => String(h ?? '').trim().toLowerCase().replace(/[\s_\-.]/g, '')

/**
 * Match the sheet's headers to our columns. Throws a plain-language error when the sheet cannot identify a product,
 * a store, or has nothing to change.
 * @returns {{ map: Record<string,string>, unknown: string[] }}
 */
export function mapHeaders(headers) {
  const map = {}
  const used = new Set()
  for (const [canon, names] of Object.entries(ALIASES)) {
    const h = headers.find((x) => !used.has(x) && names.includes(norm(x)))
    if (h) { map[canon] = h; used.add(h) }
  }
  if (!map.sku && !map.barcode && !map.product_id) throw new BusinessError('The sheet needs a SKU, Barcode or Product ID column to know which product each row is.', 400, 'MISSING_PRODUCT_COLUMN')
  if (!map.branch_code && !map.shop_id) throw new BusinessError('The sheet needs a Branch Code (or Shop ID) column to know which store each row is for.', 400, 'MISSING_STORE_COLUMN')
  if (!FIELDS.some((f) => map[f])) throw new BusinessError('The sheet has no column to change (stock, price, sale price, wholesale price, cost price, available…).', 400, 'NOTHING_TO_CHANGE')
  return { map, unknown: headers.filter((h) => !used.has(h) && h) }
}

const CLEAR = new Set(['-', 'clear', 'none', 'null', 'n/a'])
const YES = new Set(['yes', 'y', 'true', '1', 'available', 'active', 'on', 'enabled'])
const NO = new Set(['no', 'n', 'false', '0', 'unavailable', 'inactive', 'off', 'disabled'])

function number(raw) {
  const t = String(raw).replace(/[₹,\s]|^rs\.?/gi, '')
  if (!/^-?\d+(\.\d+)?$/.test(t)) return NaN
  return Number(t)
}

/**
 * Read one cell for a field. undefined = no change, null = clear (price fields only), otherwise the new value.
 * @returns {{ value?: number|boolean|null, error?: string }}
 */
export function parseCell(field, raw) {
  const t = String(raw ?? '').trim()
  if (t === '') return {}
  const label = FIELD_LABEL[field]
  if (CLEAR.has(t.toLowerCase())) {
    return PRICE_FIELDS.includes(field) ? { value: null } : { error: `${label} cannot be cleared.` }
  }
  if (field === 'available') {
    const k = t.toLowerCase()
    if (YES.has(k)) return { value: true }
    if (NO.has(k)) return { value: false }
    return { error: `${label} must be yes or no.` }
  }
  const n = number(t)
  if (!Number.isFinite(n)) return { error: `${label} “${t}” is not a number.` }
  if (PRICE_FIELDS.includes(field)) {
    const min = field === 'cost_price' ? 0 : PRICE_MIN
    if (n < min || n > PRICE_MAX) return { error: `${label} must be between ${min === 0 ? '0' : PRICE_MIN} and ${PRICE_MAX}.` }
    return { value: Math.round(n * 100) / 100 }
  }
  if (!Number.isInteger(n)) return { error: `${label} must be a whole number.` }
  if (field === 'stock' && (n < 0 || n > 10_000_000)) return { error: 'Stock must be 0 or more.' }
  if (field === 'max_order_qty' && (n < 1 || n > 10_000)) return { error: 'Max per order must be between 1 and 10000.' }
  if (field === 'low_stock_threshold' && (n < 0 || n > 10_000_000)) return { error: 'Low-stock alert must be 0 or more.' }
  return { value: n }
}

const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.round(Number(a) * 100) === Math.round(Number(b) * 100))

/**
 * Compare the sheet row with what the store has now.
 * @param {object} current shop_products row (+ productPrice): price, sale_price, wholesale_price, cost_price, stock_quantity, is_available, max_order_qty, low_stock_threshold
 * @param {Record<string, string>} cells the row's values by our column names
 * @returns {{ errors: string[], changes: Record<string, { from: any, to: any }> }}
 */
export function diffRow(current, cells) {
  const errors = []
  const wanted = {}
  for (const f of FIELDS) {
    const r = parseCell(f, cells[f])
    if (r.error) errors.push(r.error)
    else if (r.value !== undefined) wanted[f] = r.value
  }
  const have = {
    stock: current.stock_quantity, price: current.price, sale_price: current.sale_price, wholesale_price: current.wholesale_price, cost_price: current.cost_price,
    available: current.is_available, max_order_qty: current.max_order_qty, low_stock_threshold: current.low_stock_threshold,
  }
  const changes = {}
  for (const [f, to] of Object.entries(wanted)) {
    const from = have[f]
    const equal = typeof to === 'boolean' ? Boolean(from) === to : same(from, to)
    if (!equal) changes[f] = { from: from ?? null, to }
  }
  if (errors.length === 0) {
    const price = 'price' in wanted ? wanted.price : current.price
    const effectivePrice = price ?? current.productPrice
    const sale = 'sale_price' in wanted ? wanted.sale_price : current.sale_price
    if (('price' in wanted || 'sale_price' in wanted) && sale != null && effectivePrice != null && Number(sale) >= Number(effectivePrice)) {
      errors.push(`Sale price (${Number(sale)}) must be lower than the retail price (${Number(effectivePrice)}).`)
    }
    const finalStock = 'stock' in wanted ? wanted.stock : current.stock_quantity
    if (wanted.available === true && Number(finalStock) === 0) errors.push('Cannot be made available with 0 stock.')
  }
  return { errors, changes: errors.length ? {} : changes }
}

/** Identify the product cell. A product is found by id, then SKU, then barcode. */
export function productKey(cells) {
  if (cells.product_id) return { by: 'id', value: String(cells.product_id).trim() }
  if (cells.sku) return { by: 'sku', value: String(cells.sku).trim() }
  if (cells.barcode) return { by: 'barcode', value: String(cells.barcode).trim() }
  return null
}

/** Lines of text shown when a sheet row fails before it can be compared (unknown store / product). */
export const LOOKUP_ERROR = Object.freeze({
  NO_PRODUCT: 'This row has no SKU, barcode or product ID.',
  NO_STORE: 'This row has no branch code.',
  UNKNOWN_PRODUCT: (v) => `No product found for “${v}”.`,
  AMBIGUOUS_PRODUCT: (v) => `More than one product matches “${v}”. Use the product ID.`,
  UNKNOWN_STORE: (v) => `No store with branch code “${v}”.`,
  INACTIVE_STORE: (v) => `Store “${v}” is not active.`,
  NOT_ASSIGNED: 'This product is not assigned to that store yet. Use “Assign to stores” first.',
  DUPLICATE: (n) => `Same product and store as row ${n}. Keep one row per product and store.`,
})

/** Human summary of a change set, e.g. "Stock 4 → 10, Sale price — → 35". */
export function describeChanges(changes) {
  const fmt = (v) => (v == null ? '—' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v))
  // JSONB does not keep key order, so list the fields in the sheet's own order.
  return FIELDS.filter((f) => changes[f]).map((f) => [f, changes[f]]).map(([f, c]) => `${FIELD_LABEL[f]} ${fmt(c.from)} → ${fmt(c.to)}`).join(', ')
}
