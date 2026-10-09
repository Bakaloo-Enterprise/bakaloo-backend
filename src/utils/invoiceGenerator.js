import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import { STORE_INFO } from '../config/storeInfo.js'
import { signPickupPayload, QR_TOKEN_VERSION } from './qrToken.js'
import { drawWrappedMultiScriptText, measureWrappedMultiScriptTextHeight } from './multiScriptText.js'
import { buildOrderBill } from './orderBill.js'

const TERMINAL_BANNER_STATUS = new Set(['CANCELLED', 'REFUNDED'])

// POS thermal roll size (80mm) rather than A4 — this renders as a receipt,
// not a printed page. Height isn't fixed: every generate call renders once
// against a throwaway tall document purely to measure how much vertical
// space the content needs, then renders again for real at that exact
// height, so the PDF is always trimmed to its content (no trailing
// whitespace, no pagination).
const RECEIPT_WIDTH = 227
const RECEIPT_MARGIN = 10
const PAGE_LEFT = RECEIPT_MARGIN
const PAGE_RIGHT = RECEIPT_WIDTH - RECEIPT_MARGIN
const PAGE_WIDTH = PAGE_RIGHT - PAGE_LEFT

// PDFKit's standard 14 fonts can't render ₹ — any text with a rupee amount
// must use this embedded font instead (see STORE_INFO.currencyFontPath).
const CURRENCY_FONT = 'currency'

/**
 * Find the timeline entry that moved the order INTO its current terminal
 * status (CANCELLED/REFUNDED), if a timeline was supplied. Reversed search
 * because an order can bounce CANCELLED -> REFUNDED — we want the most
 * recent transition into the current status, not the first.
 */
function findStatusTransition(timeline, status) {
  if (!Array.isArray(timeline)) return null
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].to_status === status) return timeline[i]
  }
  return null
}

function parseOrderShape(order) {
  const rawAddress = order.delivery_address ?? order.deliveryAddress
  const address = typeof rawAddress === 'string'
    ? JSON.parse(rawAddress)
    : rawAddress || {}

  const items = typeof order.items === 'string'
    ? JSON.parse(order.items)
    : order.items || []

  return { address, items }
}

function formatOrderDate(date) {
  const d = new Date(date)
  const day = String(d.getDate()).padStart(2, '0')
  const month = d.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase()
  return `${day}-${month}-${d.getFullYear()}`
}

function formatDeliveryTime(date) {
  return new Date(date).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function formatAddress(address) {
  const addressLine = address.addressLine1 || address.address_line
  return [address.label, addressLine, address.addressLine2, address.city, address.pincode]
    .filter(Boolean)
    .join(', ')
}

/**
 * The "pack size" shoppers see under a product name (e.g. "500 g", "1 kg",
 * "6 pieces") — admin-authored free text on the product, snapshotted onto
 * the order item as `net_quantity` (see ProductForm's "Pack Size" field).
 * `unit` is a coarser base-measure classification (kg/g/piece/...) used
 * for catalog filtering, not what a picker needs on a packing slip, so it's
 * only a last-resort fallback here.
 */
function itemPackSize(item) {
  return item.net_quantity || item.netQuantity || item.unit || ''
}

/**
 * Right-aligned currency amount, drawn independently of the text cursor
 * (`lineBreak: false`) so it can share a row with a left-aligned fragment
 * drawn at the same y. Returns nothing — callers advance doc.y themselves.
 */
function drawAmount(doc, amount, y, { size = 8, bold = false } = {}) {
  const sign = amount < 0 ? '-' : ''
  doc.font(CURRENCY_FONT).fontSize(bold ? size + 1 : size)
  doc.text(`${sign}₹${Math.abs(amount).toFixed(2)}`, PAGE_LEFT, y, {
    width: PAGE_WIDTH, align: 'right', lineBreak: false,
  })
}

/**
 * Store logo + registration details, shared by the invoice and the packing
 * slip so both documents carry identical branding.
 */
function drawStoreHeader(doc, title) {
  const logoWidth = 140
  try {
    doc.image(STORE_INFO.logoPath, (RECEIPT_WIDTH - logoWidth) / 2, doc.y, { width: logoWidth })
    doc.y += logoWidth / 2.71 + 8
  } catch {
    // Missing/unreadable logo file must never break invoice generation.
    doc.fontSize(16).font('Helvetica-Bold').text(STORE_INFO.name, PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
    doc.moveDown(0.3)
  }

  doc.font('Helvetica-Bold').fontSize(8).text(`GST No: ${STORE_INFO.gstNo}`, PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
  doc.moveDown(0.25)

  doc.font('Helvetica').fontSize(7.5)
  doc.text(STORE_INFO.addressLines.join(' '), PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
  doc.text(STORE_INFO.phone, PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
  doc.moveDown(0.4)

  if (title) {
    doc.font('Helvetica-Bold').fontSize(11).text(title, PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
    doc.moveDown(0.3)
  }

  doc.moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke()
  doc.moveDown(0.6)
}

/**
 * One "Label: value" line, wrapped to `PAGE_WIDTH` and height-measured so a
 * long value (e.g. an address) never overlaps the line drawn after it.
 */
function detailRow(doc, label, value) {
  const y = doc.y
  const labelText = `${label}: `
  doc.font('Helvetica-Bold').fontSize(8).text(labelText, PAGE_LEFT, y, { lineBreak: false })
  const labelWidth = doc.widthOfString(labelText)
  const valueWidth = PAGE_WIDTH - labelWidth
  const valueText = value || '-'

  // A customer-typed name/address can be in Hindi, Marathi, Bengali, or
  // Gujarati script — plain Helvetica can't render those codepoints at
  // all (see multiScriptText.js), so this switches fonts per run instead
  // of a single doc.text() call.
  const height = drawWrappedMultiScriptText(doc, valueText, PAGE_LEFT + labelWidth, y, valueWidth, { size: 8, font: 'Helvetica' })

  doc.y = y + Math.max(height, 10) + 3
}

/**
 * Single-column "Customer Details" block — narrow receipt width has no room
 * for the two-column layout an A4 invoice would use.
 */
function drawCustomerDetails(doc, order, address) {
  doc.font('Helvetica-Bold').fontSize(10).text('Customer Details', PAGE_LEFT, doc.y)
  doc.moveDown(0.4)

  detailRow(doc, 'Name', order.customer_name || order.customerName)
  detailRow(doc, 'Phone', order.customer_phone || order.customerPhone)
  detailRow(doc, 'Address', formatAddress(address))
  detailRow(doc, 'Order ID', order.order_number || order.orderNumber)
  detailRow(doc, 'Order Date', formatOrderDate(order.created_at || order.createdAt))
  const deliveredAt = order.delivered_at || order.deliveredAt
  detailRow(doc, 'Delivery Time', deliveredAt ? formatDeliveryTime(deliveredAt) : '-')

  doc.moveDown(0.3)
}

function drawTerminalBanner(doc, order) {
  const isRefunded = order.status === 'REFUNDED'
  const bannerColor = isRefunded ? '#B45309' : '#B91C1C' // amber-700 / red-700
  const transition = findStatusTransition(order.timeline, order.status)
  const refundAmount = order.payment?.refund_amount
    ? parseFloat(order.payment.refund_amount)
    : null

  const bannerTop = doc.y
  const innerLeft = PAGE_LEFT + 8
  const innerWidth = PAGE_WIDTH - 16

  // Measure first (heightOfString only, no drawing) so the box can be
  // painted before the text — otherwise fillAndStroke, drawn after, would
  // paint over whatever text came first.
  let contentHeight = 8 + 15
  let noteHeight = 0
  if (transition?.changed_at) contentHeight += 12
  if (transition?.note) {
    // Staff-typed reason — same non-Latin-script risk as a customer name.
    noteHeight = measureWrappedMultiScriptTextHeight(doc, `Reason: ${transition.note}`, innerWidth, { size: 7.5, font: 'Helvetica' })
    contentHeight += noteHeight + 2
  }
  if (refundAmount) contentHeight += 12
  contentHeight += 6

  doc.rect(PAGE_LEFT, bannerTop, PAGE_WIDTH, contentHeight).fillAndStroke('#FEF2F2', bannerColor)

  let y = bannerTop + 8
  doc.fillColor(bannerColor).font('Helvetica-Bold').fontSize(10)
    .text(isRefunded ? 'ORDER REFUNDED' : 'ORDER CANCELLED', innerLeft, y, { width: innerWidth })
  y += 15

  doc.font('Helvetica').fontSize(7.5)
  if (transition?.changed_at) {
    const label = isRefunded ? 'Refunded on' : 'Cancelled on'
    doc.text(`${label} ${formatOrderDate(transition.changed_at)}`, innerLeft, y, { width: innerWidth })
    y += 12
  }
  if (transition?.note) {
    drawWrappedMultiScriptText(doc, `Reason: ${transition.note}`, innerLeft, y, innerWidth, { size: 7.5, font: 'Helvetica' })
    y += noteHeight + 2
  }
  if (refundAmount) {
    doc.font(CURRENCY_FONT).text(`Refund amount: ₹${refundAmount.toFixed(2)}`, innerLeft, y, { width: innerWidth })
    y += 12
  }

  // Reset both fill and stroke — .fillAndStroke() above leaves the banner's
  // red/amber as the active color, which would otherwise bleed into every
  // table line and box border drawn after a cancelled/refunded order.
  doc.fillColor('black').strokeColor('black')
  doc.y = bannerTop + contentHeight + 10
}

/**
 * Items list, POS-receipt style: each item gets two lines — the name (with
 * its pack size, e.g. "Onion (Kanda) (1 kg)") on its own full-width line so
 * long names simply wrap, then "qty x unit price ... line total" underneath.
 */
function drawItemsTable(doc, items) {
  doc.font('Helvetica-Bold').fontSize(9).text('Items', PAGE_LEFT, doc.y)
  doc.moveDown(0.2)
  doc.moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke()
  doc.moveDown(0.35)

  for (const item of items) {
    const name = item.name || item.productName || 'Product'
    const packSize = itemPackSize(item)
    const label = packSize ? `${name} (${packSize})` : name
    const qty = item.quantity || item.qty || 0
    const price = parseFloat(item.price || 0)
    const total = parseFloat(item.total ?? qty * price)

    drawWrappedMultiScriptText(doc, label, PAGE_LEFT, doc.y, PAGE_WIDTH, { size: 8.5, font: 'Helvetica-Bold' })
    doc.moveDown(0.1)

    const rowY = doc.y
    const qtyText = `${qty} x `
    doc.font('Helvetica').fontSize(8)
    doc.text(qtyText, PAGE_LEFT, rowY, { lineBreak: false })
    const qtyTextWidth = doc.widthOfString(qtyText) // measure before switching fonts below
    doc.font(CURRENCY_FONT).fontSize(8)
    doc.text(`₹${price.toFixed(2)}`, PAGE_LEFT + qtyTextWidth, rowY, { lineBreak: false })
    drawAmount(doc, total, rowY)

    doc.y = rowY + 12
    doc.moveDown(0.3)
  }

  doc.moveTo(PAGE_LEFT, doc.y).lineTo(PAGE_RIGHT, doc.y).stroke()
  doc.moveDown(0.5)
}

/**
 * "Bill Details": every line the customer was actually charged or credited
 * (item total, each named discount, each fee, GST split, tip), the grand
 * total, then exactly how it is being paid (wallet / Razorpay / cash due).
 * All numbers come from utils/orderBill.js so this slip, the POS slip, the
 * admin order screen and the customer app can never disagree.
 */
function drawTotals(doc, order) {
  const bill = buildOrderBill(order, { cashback: order.cashback })

  doc.font('Helvetica-Bold').fontSize(9).text('Bill Details', PAGE_LEFT, doc.y, { width: PAGE_WIDTH })
  doc.moveDown(0.3)

  // Label (wrapped, left) + right-aligned amount on the first line. Waived
  // fees print "FREE" with the original amount in the label's note line.
  const printLine = (label, amountText, { bold = false, size = 8, note = null, amount = null } = {}) => {
    const y = doc.y
    const fontSize = bold ? 9.5 : size
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize)
    doc.text(label, PAGE_LEFT, y, { width: PAGE_WIDTH - 62, lineBreak: true })
    const labelBottom = doc.y
    if (amount !== null) {
      drawAmount(doc, amount, y, { size: fontSize, bold })
    } else if (amountText) {
      doc.font('Helvetica-Bold').fontSize(fontSize)
        .text(amountText, PAGE_LEFT, y, { width: PAGE_WIDTH, align: 'right', lineBreak: false })
    }
    doc.y = Math.max(labelBottom, y + (bold ? 13 : 11)) + 2
    if (note) {
      doc.font(CURRENCY_FONT).fontSize(6.5).text(note, PAGE_LEFT + 6, doc.y - 1, { width: PAGE_WIDTH - 6 })
      doc.y += 1
    }
  }

  for (const line of bill.lines) {
    if (line.waived) {
      printLine(line.label, 'FREE', {
        note: `Worth ₹${line.originalAmount.toFixed(2)} — waived`,
      })
      continue
    }
    printLine(line.label, null, { amount: line.amount })
  }

  doc.moveTo(PAGE_LEFT, doc.y + 2).lineTo(PAGE_RIGHT, doc.y + 2).stroke()
  doc.y += 8
  printLine('Grand Total', null, { bold: true, amount: bill.grandTotal })
  doc.moveDown(0.3)

  // How it is paid. A wallet-partial order used to show only the bare
  // payment method, so a COD slip for ₹120 with ₹20 already paid from the
  // wallet hid that only ₹100 is still owed in cash.
  const pay = bill.payment
  doc.font('Helvetica-Bold').fontSize(9).text('Payment', PAGE_LEFT, doc.y, { width: PAGE_WIDTH })
  doc.moveDown(0.25)
  const stateText = { PAID: 'Paid', DUE: 'Due', PENDING: 'Pending', FAILED: 'Failed' }
  for (const part of pay.parts) {
    printLine(`${part.label} - ${stateText[part.state] || part.state}`, null, { amount: part.amount })
  }
  if (pay.parts.length === 0) {
    printLine(pay.methodLabel, pay.status)
  }
  if (pay.collectOnDelivery > 0) {
    doc.moveDown(0.1)
    const y = doc.y
    doc.rect(PAGE_LEFT, y, PAGE_WIDTH, 20).stroke()
    doc.font('Helvetica-Bold').fontSize(8.5)
      .text('COLLECT IN CASH', PAGE_LEFT + 6, y + 6, { lineBreak: false })
    drawAmount(doc, pay.collectOnDelivery, y + 6, { size: 8.5, bold: true })
    doc.y = y + 26
  }
  if (pay.refundAmount > 0) {
    printLine('Refunded to customer', null, { amount: pay.refundAmount })
  }
  doc.moveDown(0.4)

  for (const cb of bill.cashback) {
    const when = cb.status === 'CREDITED' ? 'credited to wallet' : 'will be credited to wallet'
    printLine(`Cashback ${when}`, null, { amount: cb.amount })
  }

  const savings = bill.savings.total
  if (savings > 0) {
    const y = doc.y
    doc.rect(PAGE_LEFT, y, PAGE_WIDTH, 22).stroke()

    // Mixed-font sentence (₹ needs CURRENCY_FONT, the rest stays Helvetica) —
    // pdfkit can't mix fonts within one text() call, so each fragment is
    // measured and positioned manually to read as one centered line.
    const before = 'Saved '
    const amount = `₹${savings.toFixed(2)}`
    const after = ' on this order'
    doc.font('Helvetica-Bold').fontSize(8)
    const beforeWidth = doc.widthOfString(before)
    const afterWidth = doc.widthOfString(after)
    doc.font(CURRENCY_FONT).fontSize(8)
    const amountWidth = doc.widthOfString(amount)

    let x = PAGE_LEFT + (PAGE_WIDTH - beforeWidth - amountWidth - afterWidth) / 2
    const textY = y + 7
    doc.font('Helvetica-Bold').text(before, x, textY, { lineBreak: false })
    x += beforeWidth
    doc.font(CURRENCY_FONT).text(amount, x, textY, { lineBreak: false })
    x += amountWidth
    doc.font('Helvetica-Bold').text(after, x, textY, { lineBreak: false })

    doc.y = y + 30
  }
}

/**
 * A minimal signed reference only — deliberately does NOT embed customer
 * name/phone/address/items, or even the order id: that descriptive data
 * (including which order this is) is loaded from the backend only after a
 * rider authenticates AND this QR verifies (see
 * delivery.service.js#verifyScan), which looks the token up by value and
 * reads order_id/delivery_assignment_id straight off the DB row — nothing
 * about which order or assignment this token belongs to is trusted from
 * the QR itself. `order.pickup_token` is attached by the caller
 * (orders.service.js, both admin and customer) from the order's current
 * ACTIVE order_pickup_tokens row — absent when no rider is assigned yet,
 * or once the token's been scanned/revoked/expired, in which case no QR
 * is drawn at all (see drawQRCode).
 *
 * Compact dot-delimited wire format (`version.token.sig`) instead of
 * JSON or a payload embedding the order id: every character here shows
 * up as printed ink, and this keeps the QR small enough to stay at the
 * lowest practical QR version (big, blocky modules), which is what
 * actually makes it print and scan reliably on ordinary printers. Neither
 * field can contain '.', so a plain split is unambiguous.
 */
function buildQrPayload(order) {
  const pt = order.pickup_token
  if (!pt || !pt.token) return null

  const version = pt.version || QR_TOKEN_VERSION
  const sig = signPickupPayload({ token: pt.token, version })

  return `${version}.${pt.token}.${sig}`
}

async function generateQrCodeBuffer(order) {
  const payload = buildQrPayload(order)
  if (!payload) return null
  // High raster resolution (source bitmap, downscaled by PDFKit to the
  // printed size) keeps module edges crisp instead of blurry when
  // shrunk. 'H' error correction (~30% recovery) gives real printers
  // headroom for ink smudging, thermal fade, and creases — affordable
  // now that the payload above is short enough to stay at a low QR
  // version even at the highest correction tier.
  return QRCode.toBuffer(payload, { width: 480, margin: 3, errorCorrectionLevel: 'H' })
}

/**
 * QR block, printed as the last element on the receipt (after totals, before
 * the thank-you footer). `qrBuffer` is generated once up front by the caller
 * (QRCode.toBuffer is async; everything else in this file's render pass is
 * deliberately synchronous for the two-pass height measurement to work) and
 * threaded through both the measure and real render calls.
 */
function drawQRCode(doc, qrBuffer) {
  if (!qrBuffer) return
  // Printed footprint, not raster resolution (see generateQrCodeBuffer) —
  // bigger physical modules on the receipt itself, on top of the fewer
  // modules the shorter payload already produces.
  const qrSize = 130
  const x = PAGE_LEFT + (PAGE_WIDTH - qrSize) / 2
  doc.moveDown(0.5)
  const y = doc.y
  doc.image(qrBuffer, x, y, { width: qrSize, height: qrSize })
  doc.y = y + qrSize + 4
  doc.font('Helvetica').fontSize(7)
    .text('Scan for delivery details', PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
  doc.moveDown(0.3)
}

function drawFooter(doc) {
  // Explicit x/width rather than a flowing text() call — a preceding section
  // can leave doc.x parked mid-page, which would otherwise narrow the
  // "centered" width and wrap this one-line sentence across two lines.
  doc.y += 10
  doc.font('Helvetica-Oblique').fontSize(8.5)
    .text(`— Thank you for shopping with ${STORE_INFO.name}! —`, PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
  doc.moveDown(0.5)
  doc.font('Helvetica').fontSize(7.5)
    .text('We hope to serve you again soon.', PAGE_LEFT, doc.y, { width: PAGE_WIDTH, align: 'center' })
}

function renderReceipt(doc, order, address, items, { title, qrBuffer }) {
  doc.registerFont(CURRENCY_FONT, STORE_INFO.currencyFontPath)

  drawStoreHeader(doc, title)
  drawCustomerDetails(doc, order, address)

  if (TERMINAL_BANNER_STATUS.has(order.status)) {
    drawTerminalBanner(doc, order)
  } else {
    doc.moveDown(0.3)
  }

  drawItemsTable(doc, items)
  drawTotals(doc, order)
  drawQRCode(doc, qrBuffer)
  drawFooter(doc)

  return doc.y
}

/**
 * PDFKit fixes a page's height at creation time, so trimming a receipt PDF
 * to its content means rendering once to learn the final y position. This
 * throwaway document (tall enough for any realistic order) is never piped
 * anywhere — it exists purely so `renderReceipt`'s real drawing/measuring
 * calls (heightOfString, image, text wrapping, ...) tell us exactly how
 * tall the real page needs to be.
 */
function measureReceiptHeight(order, address, items, opts) {
  const measurer = new PDFDocument({ size: [RECEIPT_WIDTH, 5000], margin: RECEIPT_MARGIN })
  measurer.on('error', () => {})
  const finalY = renderReceipt(measurer, order, address, items, opts)
  measurer.end()
  return Math.ceil(finalY) + RECEIPT_MARGIN
}

async function generateReceiptPDF(order, opts) {
  const { address, items } = parseOrderShape(order)

  // Generated once, up front — QRCode.toBuffer is async, unlike every other
  // render step in this file, so it can't happen inside the synchronous
  // measure/render pair below.
  const qrBuffer = await generateQrCodeBuffer(order)
  const renderOpts = { ...opts, qrBuffer }

  return new Promise((resolve, reject) => {
    const height = measureReceiptHeight(order, address, items, renderOpts)

    const doc = new PDFDocument({ size: [RECEIPT_WIDTH, height], margin: RECEIPT_MARGIN })
    const chunks = []

    doc.on('data', chunk => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    renderReceipt(doc, order, address, items, renderOpts)
    doc.end()
  })
}

/**
 * Generate a PDF invoice buffer for an order, sized as an 80mm POS receipt.
 * @param {Object} order - Order object with items, delivery_address, etc.
 *   Optional `order.timeline` (order_status_history rows) and
 *   `order.payment` (latest payments row) enrich the CANCELLED/REFUNDED
 *   banner with a date, reason, and refund amount when available — the
 *   invoice still renders correctly without them, just with a plainer
 *   banner (no date/reason line).
 * @returns {Promise<Buffer>} PDF buffer
 */
export function generateInvoicePDF(order) {
  return generateReceiptPDF(order, { title: null })
}

/**
 * Generate a PDF packing slip buffer for an order — same branding, customer
 * details, itemized pricing and totals as the invoice (per business request,
 * the slip that ships with the order should be a complete receipt too), just
 * labelled "PACKING SLIP" instead of carrying no title.
 * @param {Object} order
 * @returns {Promise<Buffer>} PDF buffer
 */
export function generatePackingSlipPDF(order) {
  return generateReceiptPDF(order, { title: 'PACKING SLIP' })
}
