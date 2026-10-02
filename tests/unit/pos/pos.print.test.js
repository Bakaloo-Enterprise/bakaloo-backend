import { describe, expect, it } from 'vitest'
import { signPickupPayload } from '../../../src/utils/qrToken.js'
import { buildPickupQrPayload, verifyPickupSignature } from '../../../src/utils/qrToken.js'
import { deliveryArea, esc, renderInvoice, renderLabel, renderTest } from '../../../src/modules/pos/pos.print.js'

const order = { order_number: 'ORD-1001', created_at: '2026-10-02T06:00:00Z', subtotal: 450, discount_amount: 50, delivery_fee: 20, platform_fee: 0, total_amount: 420, payment_method: 'COD', payment_status: 'PENDING', delivery_address: { addressLine1: '12 Flat 4B', addressLine2: 'Salt Lake Sector 5', city: 'Kolkata', pincode: '700091', receiverName: 'Priya Sharma', receiverPhone: '9876543210' }, delivery_notes: 'Ring twice' }
const shop = { name: 'Salt Lake Dark Store', address_line1: 'DB 12', city: 'Kolkata', phone: '033-1234' }

describe('esc', () => {
  it('neutralises markup and quotes', () => {
    expect(esc(`<script>alert("x")</script> & 'y'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;')
    expect(esc(null)).toBe('')
    expect(esc(5)).toBe('5')
  })
})

describe('deliveryArea — only what a rider needs to sort bags', () => {
  it('locality, city and pincode — never the house, name or phone', () => {
    const a = deliveryArea(order.delivery_address)
    expect(a).toBe('Salt Lake Sector 5, Kolkata 700091')
    expect(a).not.toMatch(/Flat|Priya|9876/)
  })
  it('understands snake_case, a landmark fallback and JSON strings', () => {
    expect(deliveryArea({ address_line2: 'Park St', city: 'Kolkata', pincode: '700016' })).toBe('Park St, Kolkata 700016')
    expect(deliveryArea({ landmark: 'Near Metro', city: 'Howrah' })).toBe('Near Metro, Howrah')
    expect(deliveryArea(JSON.stringify({ city: 'Kolkata', pincode: '700001' }))).toBe('Kolkata 700001')
  })
  it('says so when there is nothing', () => {
    expect(deliveryArea(null)).toBe('Delivery area not recorded')
    expect(deliveryArea('not json')).toBe('Delivery area not recorded')
  })
})

describe('renderInvoice', () => {
  const items = [{ name: 'Basmati <b>Rice</b> 5kg', quantity: 2, unit: '5kg', price: 225, total: 450 }]
  it('shows the order, items, fees and total, in India time', () => {
    const html = renderInvoice({ shop, order, items })
    expect(html).toContain('ORD-1001')
    expect(html).toContain('Salt Lake Dark Store')
    expect(html).toContain('2 × ₹225.00')
    expect(html).toContain('-₹50.00')
    expect(html).toContain('₹420.00')
    expect(html).toContain('Salt Lake Sector 5, Kolkata 700091')
    expect(html).toContain('11:30') // 06:00 UTC
    expect(html).not.toContain('Platform fee') // zero fees are left out
  })
  it('escapes customer-influenced text (item names, notes)', () => {
    const html = renderInvoice({ shop, order: { ...order, delivery_notes: '<img src=x onerror=alert(1)>' }, items })
    expect(html).not.toContain('<b>Rice</b>')
    expect(html).toContain('Basmati &lt;b&gt;Rice&lt;/b&gt; 5kg')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
  it('sizes the page for the paper', () => {
    expect(renderInvoice({ shop, order, items, paperMm: 58 })).toContain('size: 58mm auto')
    expect(renderInvoice({ shop, order, items, paperMm: 80 })).toContain('size: 80mm auto')
    expect(renderInvoice({ shop, order, items, paperMm: 210 })).toContain('size: A5')
  })
})

describe('renderLabel', () => {
  it('with a rider: package number, area and a pickup QR the rider app can verify', async () => {
    const html = await renderLabel({ shop, order, packageNo: 2, packageTotal: 3, riderName: 'Ravi', token: { token: 'abcDEF12345', version: 1 } })
    expect(html).toContain('Package 2 of 3')
    expect(html).toContain('Salt Lake Sector 5, Kolkata 700091')
    expect(html).toMatch(/<img class="qr" alt="Pickup QR" src="data:image\/png;base64,/)
    expect(html).toContain('Rider: Ravi')
  })
  it('carries no customer name, phone or house number', async () => {
    const html = await renderLabel({ shop, order, packageNo: 1, packageTotal: 1, token: { token: 'abc', version: 1 } })
    expect(html).not.toMatch(/Priya|9876543210|Flat 4B/)
  })
  it('without a rider there is no QR — a QR for nobody would be worthless', async () => {
    const html = await renderLabel({ shop, order, packageNo: 1, packageTotal: 1, token: null })
    expect(html).not.toContain('<img')
    expect(html).toContain('No rider assigned yet')
  })
  it('the rider name is escaped', async () => {
    const html = await renderLabel({ shop, order, riderName: '<script>x</script>', token: { token: 't', version: 1 } })
    expect(html).not.toContain('<script>x')
  })
})

describe('pickup QR payload', () => {
  it('is version.token.signature and verifies with the rider-side check', () => {
    const p = buildPickupQrPayload({ token: 'tok123', version: 1 })
    const [v, token, sig] = p.split('.')
    expect(v).toBe('1')
    expect(token).toBe('tok123')
    expect(sig).toBe(signPickupPayload({ token: 'tok123', version: 1 }))
    expect(verifyPickupSignature({ token, version: Number(v), signature: sig })).toBe(true)
    expect(verifyPickupSignature({ token: 'other', version: 1, signature: sig })).toBe(false)
  })
})

describe('renderTest', () => {
  it('names the printer and paper', () => {
    const html = renderTest({ shopName: 'Store', printerName: 'Counter <1>', paperMm: 58 })
    expect(html).toContain('Counter &lt;1&gt;')
    expect(html).toContain('58 mm')
  })
})
