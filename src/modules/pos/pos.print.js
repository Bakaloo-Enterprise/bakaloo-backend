import QRCode from 'qrcode'
import { buildPickupQrPayload } from '../../utils/qrToken.js'

/**
 * Printable documents for the store printer (Phase 11): an order slip ("invoice") and a package label with the
 * rider's pickup QR. Output is a small self-contained HTML page sized for thermal paper (58 / 80 mm) or A4/A5.
 * Everything that comes from an order (item names, notes, addresses) is customer-influenced text and is escaped.
 */

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const pick = (o, ...keys) => {
  for (const k of keys) if (o?.[k]) return String(o[k]).trim()
  return ''
}

/**
 * Where the package is going — enough for a rider to sort bags, nothing more. No name, no phone, no house
 * number (agreement §12: "only necessary customer information").
 */
export function deliveryArea(address) {
  const a = typeof address === 'string' ? safeJson(address) : address
  const locality = pick(a, 'addressLine2', 'address_line2', 'landmark')
  const city = pick(a, 'city')
  const pin = pick(a, 'pincode')
  return [locality, [city, pin].filter(Boolean).join(' ')].filter(Boolean).join(', ') || 'Delivery area not recorded'
}

function safeJson(s) {
  try { return JSON.parse(s) } catch { return {} }
}

const rupees = (n) => `₹${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const when = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

function page(title, body, paperMm) {
  const width = paperMm === 210 ? '190mm' : `${paperMm - 6}mm`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page { size: ${paperMm === 210 ? 'A5' : `${paperMm}mm auto`}; margin: 3mm; }
* { box-sizing: border-box; }
body { font: 12px/1.35 'Courier New', monospace; width: ${width}; margin: 0 auto; color: #000; }
h1 { font-size: 15px; margin: 0 0 2px; text-align: center; }
.c { text-align: center; } .r { text-align: right; } .b { font-weight: 700; }
.hr { border-top: 1px dashed #000; margin: 5px 0; }
table { width: 100%; border-collapse: collapse; } td { vertical-align: top; padding: 1px 0; }
.big { font-size: 22px; font-weight: 700; text-align: center; letter-spacing: 1px; }
.qr { display: block; margin: 4px auto; width: ${paperMm === 58 ? '38mm' : '46mm'}; height: auto; }
.note { font-size: 10px; text-align: center; }
</style></head><body>${body}</body></html>`
}

export function renderInvoice({ shop, order, items, paperMm = 80 }) {
  const lines = items.map((i) => `<tr><td>${esc(i.name)}${i.unit ? ` <span>(${esc(i.unit)})</span>` : ''}</td><td class="r">${esc(i.quantity)} × ${esc(rupees(i.price))}</td></tr>`).join('')
  const fee = (label, v) => (Number(v) ? `<tr><td>${esc(label)}</td><td class="r">${esc(rupees(v))}</td></tr>` : '')
  const discount = Number(order.discount_amount) ? `<tr><td>Discount</td><td class="r">-${esc(rupees(order.discount_amount))}</td></tr>` : ''
  return page(`Order ${order.order_number}`, `
<h1>${esc(shop?.name ?? 'Bakaloo')}</h1>
<div class="c">${esc([shop?.address_line1, shop?.city].filter(Boolean).join(', '))}${shop?.phone ? `<br>${esc(shop.phone)}` : ''}</div>
<div class="hr"></div>
<div class="big">${esc(order.order_number)}</div>
<div class="c">${esc(when(order.created_at))}${order.scheduled_slot_label ? `<br>Slot: ${esc(order.scheduled_slot_label)}` : ''}</div>
<div class="hr"></div>
<table>${lines}</table>
<div class="hr"></div>
<table>
<tr><td>Subtotal</td><td class="r">${esc(rupees(order.subtotal))}</td></tr>
${discount}${fee('Delivery', order.delivery_fee)}${fee('Platform fee', order.platform_fee)}${fee('Handling', order.handling_fee)}${fee('Late-night', order.late_night_fee)}${fee('Tax', order.tax_amount)}${fee('Tip', order.tip_amount)}
<tr class="b"><td>Total</td><td class="r">${esc(rupees(order.total_amount))}</td></tr>
</table>
<div class="hr"></div>
<div>${esc(order.payment_method ?? '')} · ${esc(order.payment_status ?? '')}</div>
<div>Deliver to: ${esc(deliveryArea(order.delivery_address))}</div>
${order.delivery_notes ? `<div>Note: ${esc(order.delivery_notes)}</div>` : ''}
<div class="hr"></div><div class="note">Thank you for shopping with Bakaloo</div>`, paperMm)
}

/**
 * Package label. Prints order number, package k of n, store, delivery area and — when a rider is assigned — the
 * pickup QR. Without a rider there is no QR (it would be worthless: pickup tokens belong to one rider).
 */
export async function renderLabel({ shop, order, packageNo, packageTotal, riderName, token, paperMm = 80 }) {
  let qr = ''
  if (token) {
    const payload = buildPickupQrPayload({ token: token.token, version: token.version })
    const url = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'H', margin: 2, width: 360 })
    qr = `<img class="qr" alt="Pickup QR" src="${url}">`
  }
  return page(`Label ${order.order_number}`, `
<h1>${esc(shop?.name ?? 'Bakaloo')}</h1>
<div class="big">${esc(order.order_number)}</div>
<div class="c b">Package ${esc(packageNo ?? 1)} of ${esc(packageTotal ?? 1)}</div>
<div class="hr"></div>
<div class="c">${esc(deliveryArea(order.delivery_address))}</div>
${order.scheduled_slot_label ? `<div class="c">Slot: ${esc(order.scheduled_slot_label)}</div>` : ''}
<div class="hr"></div>
${qr || '<div class="c b">No rider assigned yet</div>'}
<div class="note">${token ? `Rider${riderName ? `: ${esc(riderName)}` : ''} — scan to collect` : 'A pickup QR prints when a rider is assigned'}</div>`, paperMm)
}

export function renderTest({ shopName, printerName, paperMm = 80 }) {
  return page('Test print', `<h1>${esc(shopName ?? 'Bakaloo')}</h1><div class="c">Test print</div><div class="hr"></div><div class="c">${esc(printerName ?? '')}</div><div class="c">${esc(paperMm)} mm</div><div class="c">${esc(when(new Date()))}</div>`, paperMm)
}
