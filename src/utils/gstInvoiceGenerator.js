import PDFDocument from 'pdfkit'
import { STORE_INFO } from '../config/storeInfo.js'
import { buildOrderBill } from './orderBill.js'
import { drawWrappedMultiScriptText, measureWrappedMultiScriptTextHeight } from './multiScriptText.js'

// A4 tax invoice — deliberately separate from invoiceGenerator.js (an 80mm
// POS receipt/packing-slip). Auto-paginates natively via PDFKit instead of
// the receipt's two-pass exact-height measurement trick — an A4 document
// doesn't need to be trimmed to content the way a thermal roll does.
const PAGE_MARGIN = 40
const PAGE_WIDTH = 595.28 - PAGE_MARGIN * 2 // A4 points, minus margins

const CURRENCY_FONT = 'currency'

/**
 * First 2 digits of a GSTIN encode the state code — the standard method
 * for determining CGST+SGST (intra-state) vs IGST (inter-state).
 */
function gstStateCode(gstin) {
  return gstin && gstin.length >= 2 ? gstin.slice(0, 2) : null
}

/**
 * Resolve the tax split for an order. Reconstructs the taxable value from
 * the order's own stored totals (totalAmount - taxAmount - tipAmount —
 * tip is a voluntary gratuity, never part of the taxable consideration,
 * same formula totals-engine.service.js uses to compute totalPayable) and
 * the effective rate from taxAmount/taxableValue, rather than re-reading
 * the current (possibly since-changed) fee_settings.gst_rate — a tax
 * invoice must reflect what was actually charged on this transaction.
 *
 * B2C orders (no buyerGstin) default to CGST+SGST — Bakaloo only delivers
 * within Gujarat, so an inter-state supply only happens for a B2B buyer
 * registered in a different state.
 */
function resolveGstSplit(order) {
  const totalAmount = Number(order.totalAmount || 0)
  const taxAmount = Number(order.taxAmount || 0)
  const tipAmount = Number(order.tipAmount || 0)
  const taxableValue = Math.max(0, totalAmount - taxAmount - tipAmount)
  const effectiveRate = taxableValue > 0 ? (taxAmount / taxableValue) * 100 : 0

  const sellerState = gstStateCode(STORE_INFO.gstNo)
  const buyerState = gstStateCode(order.buyerGstin)
  const isInterState = !!(buyerState && sellerState && buyerState !== sellerState)

  if (isInterState) {
    return {
      isInterState: true,
      taxableValue,
      igstRate: effectiveRate,
      igstAmount: taxAmount,
      cgstRate: 0, cgstAmount: 0, sgstRate: 0, sgstAmount: 0,
    }
  }

  const halfRate = effectiveRate / 2
  const halfAmount = Math.round((taxAmount / 2) * 100) / 100
  return {
    isInterState: false,
    taxableValue,
    cgstRate: halfRate,
    cgstAmount: halfAmount,
    sgstRate: halfRate,
    // Remainder (not simply halfAmount again) so CGST+SGST always sums to
    // exactly taxAmount even when taxAmount has an odd paise value.
    sgstAmount: Math.round((taxAmount - halfAmount) * 100) / 100,
    igstRate: 0, igstAmount: 0,
  }
}

/**
 * Normalize either order shape this generator can receive into one
 * canonical camelCase object — the customer-facing route passes
 * OrdersRepository#_format()'s camelCase shape, the admin route passes
 * admin/orders repository's raw snake_case row (with a customer_name/
 * customer_phone user join already applied). Same dual-fallback
 * convention invoiceGenerator.js uses throughout (e.g.
 * `order.customer_name || order.customerName`), centralized here once
 * instead of repeated at every field access below.
 */
function normalizeOrder(order) {
  const rawAddress = order.deliveryAddress ?? order.delivery_address
  const deliveryAddress = typeof rawAddress === 'string' ? JSON.parse(rawAddress) : rawAddress || {}

  const rawItems = order.items
  const items = typeof rawItems === 'string' ? JSON.parse(rawItems) : (Array.isArray(rawItems) ? rawItems : [])

  return {
    orderNumber: order.orderNumber ?? order.order_number,
    createdAt: order.createdAt ?? order.created_at,
    paymentMethod: order.paymentMethod ?? order.payment_method,
    totalAmount: Number(order.totalAmount ?? order.total_amount ?? 0),
    taxAmount: Number(order.taxAmount ?? order.tax_amount ?? 0),
    tipAmount: Number(order.tipAmount ?? order.tip_amount ?? 0),
    buyerGstin: order.buyerGstin ?? order.buyer_gstin ?? null,
    buyerCompanyName: order.buyerCompanyName ?? order.buyer_company_name ?? null,
    customerName: order.customerName ?? order.customer_name ?? null,
    customerPhone: order.customerPhone ?? order.customer_phone ?? null,
    deliveryAddress,
    items,
  }
}

function formatDate(date) {
  const d = new Date(date)
  const day = String(d.getDate()).padStart(2, '0')
  const month = d.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase()
  return `${day}-${month}-${d.getFullYear()}`
}

function formatAddressLines(address) {
  if (!address) return []
  const line1 = address.addressLine1 || address.address_line
  return [
    address.label,
    line1,
    address.addressLine2,
    [address.city, address.pincode].filter(Boolean).join(' - '),
    address.state,
  ].filter(Boolean)
}

/** Right-aligned currency text drawn independently of the text cursor. */
function drawAmountAt(doc, amount, x, y, width, { size = 9, bold = false } = {}) {
  doc.font(CURRENCY_FONT).fontSize(bold ? size + 0.5 : size)
  doc.text(`₹${Number(amount || 0).toFixed(2)}`, x, y, { width, align: 'right', lineBreak: false })
}

function drawHeader(doc, order) {
  doc.font('Helvetica-Bold').fontSize(18).text('TAX INVOICE', PAGE_MARGIN, doc.y, { width: PAGE_WIDTH, align: 'center' })
  doc.moveDown(0.6)
  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + PAGE_WIDTH, doc.y).stroke()
  doc.moveDown(0.6)

  const colWidth = PAGE_WIDTH / 2 - 10
  const topY = doc.y

  // Seller (left column)
  doc.font('Helvetica-Bold').fontSize(11).text(STORE_INFO.name, PAGE_MARGIN, topY, { width: colWidth })
  doc.font('Helvetica').fontSize(8.5)
  doc.text(STORE_INFO.addressLines.join(', '), PAGE_MARGIN, doc.y, { width: colWidth })
  doc.text(`GSTIN: ${STORE_INFO.gstNo}`, PAGE_MARGIN, doc.y, { width: colWidth })
  doc.text(`Phone: ${STORE_INFO.phone}`, PAGE_MARGIN, doc.y, { width: colWidth })
  const leftBottom = doc.y

  // Invoice meta (right column)
  const rightX = PAGE_MARGIN + colWidth + 20
  doc.font('Helvetica-Bold').fontSize(9)
  const metaRow = (label, value, y) => {
    doc.font('Helvetica-Bold').fontSize(8.5).text(`${label}: `, rightX, y, { continued: true, width: colWidth })
    doc.font('Helvetica').text(value || '-')
  }
  metaRow('Invoice No', order.orderNumber, topY)
  metaRow('Invoice Date', formatDate(order.createdAt), doc.y)
  metaRow('Payment Method', order.paymentMethod || '-', doc.y)
  metaRow('Place of Supply', order.deliveryAddress?.state || '-', doc.y)
  const rightBottom = doc.y

  doc.y = Math.max(leftBottom, rightBottom) + 12
}

function drawBuyerBlock(doc, order) {
  const y = doc.y
  doc.font('Helvetica-Bold').fontSize(10).text('Bill To', PAGE_MARGIN, y)
  doc.moveDown(0.3)

  // Company/customer name and address are customer-typed free text — can be
  // Hindi, Marathi, Bengali, or Gujarati script, which plain Helvetica
  // can't render (see multiScriptText.js).
  drawWrappedMultiScriptText(doc, order.buyerCompanyName || order.customerName || 'Customer', PAGE_MARGIN, doc.y, PAGE_WIDTH, { size: 9, font: 'Helvetica-Bold' })
  doc.font('Helvetica').fontSize(8.5)
  if (order.buyerGstin) {
    doc.text(`GSTIN: ${order.buyerGstin}`, PAGE_MARGIN, doc.y, { width: PAGE_WIDTH })
  }
  if (order.customerPhone) {
    doc.text(`Phone: ${order.customerPhone}`, PAGE_MARGIN, doc.y, { width: PAGE_WIDTH })
  }
  const addressLines = formatAddressLines(order.deliveryAddress)
  if (addressLines.length > 0) {
    drawWrappedMultiScriptText(doc, addressLines.join(', '), PAGE_MARGIN, doc.y, PAGE_WIDTH, { size: 8.5, font: 'Helvetica' })
  }

  doc.moveDown(0.6)
  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + PAGE_WIDTH, doc.y).stroke()
  doc.moveDown(0.5)
}

// Column layout for the items table — widths sum to PAGE_WIDTH.
const COLS = [
  { key: 'sr', label: '#', width: 20, align: 'left' },
  { key: 'item', label: 'Item', width: 125, align: 'left' },
  { key: 'hsn', label: 'HSN', width: 45, align: 'left' },
  { key: 'qty', label: 'Qty', width: 30, align: 'right' },
  { key: 'rate', label: 'Rate', width: 55, align: 'right' },
  { key: 'taxable', label: 'Taxable Val.', width: 65, align: 'right' },
  { key: 'taxRate', label: 'Tax %', width: 40, align: 'right' },
  { key: 'taxAmt', label: 'Tax Amt', width: 55, align: 'right' },
  { key: 'total', label: 'Total', width: 20, align: 'right' },
]
// Last column absorbs rounding so the row always fits PAGE_WIDTH exactly.
COLS[COLS.length - 1].width = PAGE_WIDTH - COLS.slice(0, -1).reduce((s, c) => s + c.width, 0)

function colX(index) {
  let x = PAGE_MARGIN
  for (let i = 0; i < index; i++) x += COLS[i].width
  return x
}

function drawTableHeader(doc) {
  const y = doc.y
  doc.rect(PAGE_MARGIN, y, PAGE_WIDTH, 18).fillAndStroke('#F3F4F6', '#D1D5DB')
  doc.fillColor('black').font('Helvetica-Bold').fontSize(7.5)
  COLS.forEach((col, i) => {
    doc.text(col.label, colX(i) + 3, y + 5, { width: col.width - 6, align: col.align, lineBreak: false })
  })
  doc.y = y + 18
}

/**
 * One item row. Returns the row height so the caller can decide whether a
 * page break is needed before drawing (PDFKit auto-paginates text, but the
 * header row + shaded background need to be re-drawn per page manually).
 */
function drawItemRow(doc, item, index, split) {
  const name = item.name || 'Product'
  // order.items (JSONB, camelCase) vs order_items (table, snake_case) —
  // the admin route's findById() sources items from the table, not the
  // JSONB blob (see admin/orders/orders.repository.js#getOrderItems) —
  // this is the one field name that actually differs between the two.
  const hsn = item.hsnCodeSnapshot ?? item.hsn_code_snapshot ?? '-'
  const qty = item.quantity || 0
  const price = Number(item.price || 0)
  const lineTotal = Number(item.total ?? qty * price)
  // Back out this line's share of tax proportionally to its share of the
  // order's taxable value — order_items doesn't store a per-line tax
  // amount, only the order-level total, so this is an allocation for
  // display, same "notional per-item allocation" the GSTR-1 report
  // already documents (see migration 099's own comment).
  const rate = split.isInterState ? split.igstRate : split.cgstRate + split.sgstRate
  const taxAmt = split.taxableValue > 0 ? (lineTotal / split.taxableValue) * (split.igstAmount || split.cgstAmount + split.sgstAmount) : 0

  const y = doc.y
  // Catalog item names are admin-authored and can be typed in a native
  // script just like a customer name/address (see multiScriptText.js).
  const rowHeight = Math.max(
    measureWrappedMultiScriptTextHeight(doc, name, COLS[1].width - 6, { size: 7.5, font: 'Helvetica' }),
    14
  ) + 6

  doc.font('Helvetica').fontSize(7.5)
  doc.text(String(index + 1), colX(0) + 3, y + 3, { width: COLS[0].width - 6 })
  drawWrappedMultiScriptText(doc, name, colX(1) + 3, y + 3, COLS[1].width - 6, { size: 7.5, font: 'Helvetica' })
  doc.text(hsn, colX(2) + 3, y + 3, { width: COLS[2].width - 6 })
  doc.text(String(qty), colX(3) + 3, y + 3, { width: COLS[3].width - 6, align: 'right' })
  drawAmountAt(doc, price, colX(4) + 3, y + 3, COLS[4].width - 6, { size: 7.5 })
  drawAmountAt(doc, lineTotal, colX(5) + 3, y + 3, COLS[5].width - 6, { size: 7.5 })
  doc.font('Helvetica').fontSize(7.5).text(`${rate.toFixed(1)}%`, colX(6) + 3, y + 3, { width: COLS[6].width - 6, align: 'right' })
  drawAmountAt(doc, taxAmt, colX(7) + 3, y + 3, COLS[7].width - 6, { size: 7.5 })
  drawAmountAt(doc, lineTotal + taxAmt, colX(8) + 3, y + 3, COLS[8].width - 6, { size: 7.5 })

  doc.y = y + rowHeight
  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + PAGE_WIDTH, doc.y).strokeColor('#E5E7EB').stroke().strokeColor('black')
}

function drawItemsTable(doc, items, split) {
  drawTableHeader(doc)
  for (let i = 0; i < items.length; i++) {
    // Leave room for the header + at least one row before the page bottom;
    // PDFKit's own text() calls auto-paginate mid-row otherwise, which
    // would split a row's cells across two pages.
    if (doc.y > doc.page.height - PAGE_MARGIN - 40) {
      doc.addPage()
      drawTableHeader(doc)
    }
    drawItemRow(doc, items[i], i, split)
  }
  doc.moveDown(0.4)
}

function drawTotals(doc, order, split, bill) {
  if (doc.y > doc.page.height - PAGE_MARGIN - 240) doc.addPage()

  const labelX = PAGE_MARGIN + PAGE_WIDTH - 220
  const valueWidth = 220
  const line = (label, amount, bold = false) => {
    const y = doc.y
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 9.5 : 8.5)
    doc.text(label, labelX, y, { width: valueWidth - 90, lineBreak: false })
    drawAmountAt(doc, amount, labelX + valueWidth - 90, y, 90, { size: bold ? 9.5 : 8.5, bold })
    doc.y = y + (bold ? 15 : 13)
  }

  doc.moveDown(0.3)
  // How the taxable value is made up — items, discounts and every fee are
  // all inside it (tax is charged on "delivery and everything"), so show
  // them instead of one unexplained number.
  for (const l of bill.lines.filter((x) => ['items', 'discount', 'charge', 'adjustment'].includes(x.kind))) {
    line(l.waived ? `${l.label} (waived)` : l.label, l.waived ? 0 : l.amount)
  }
  doc.moveTo(labelX, doc.y).lineTo(PAGE_MARGIN + PAGE_WIDTH, doc.y).stroke()
  doc.y += 4
  line('Taxable Value', split.taxableValue)
  if (split.isInterState) {
    line(`IGST @ ${split.igstRate.toFixed(1)}%`, split.igstAmount)
  } else {
    line(`CGST @ ${split.cgstRate.toFixed(1)}%`, split.cgstAmount)
    line(`SGST @ ${split.sgstRate.toFixed(1)}%`, split.sgstAmount)
  }
  if (Number(order.tipAmount) > 0) line('Tip (no GST)', order.tipAmount)

  doc.moveTo(labelX, doc.y).lineTo(PAGE_MARGIN + PAGE_WIDTH, doc.y).stroke()
  doc.y += 6
  line('Grand Total', order.totalAmount, true)

  doc.moveDown(0.4)
  doc.font('Helvetica-Bold').fontSize(8.5).text('Payment', labelX, doc.y)
  doc.y += 2
  const stateText = { PAID: 'Paid', DUE: 'Due on delivery', PENDING: 'Pending', FAILED: 'Failed' }
  for (const p of bill.payment.parts) line(`${p.label} (${stateText[p.state] || p.state})`, p.amount)

  doc.moveDown(1)
  doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#6B7280')
    .text('This is a computer-generated invoice and does not require a physical signature.', PAGE_MARGIN, doc.y, { width: PAGE_WIDTH, align: 'center' })
  doc.fillColor('black')
}

/**
 * Generate an A4 GST tax invoice PDF buffer for an order.
 *
 * @param {object} rawOrder - Either OrdersRepository#_format()'s camelCase
 *   shape (customer-facing route) or the admin route's raw snake_case row
 *   (with a customer_name/customer_phone user join already applied) —
 *   see normalizeOrder() above.
 * @returns {Promise<Buffer>}
 */
export function generateGstInvoicePDF(rawOrder) {
  const order = normalizeOrder(rawOrder)

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN })
    doc.registerFont(CURRENCY_FONT, STORE_INFO.currencyFontPath)

    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const split = resolveGstSplit(order)

    drawHeader(doc, order)
    drawBuyerBlock(doc, order)
    drawItemsTable(doc, order.items, split)
    drawTotals(doc, order, split, buildOrderBill(rawOrder))

    doc.end()
  })
}
