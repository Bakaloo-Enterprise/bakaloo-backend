import { describe, it, expect } from 'vitest'
import { buildOrderBill } from '../../../src/utils/orderBill.js'
import { renderInvoice } from '../../../src/modules/pos/pos.print.js'
import { generateInvoicePDF } from '../../../src/utils/invoiceGenerator.js'

const fee = (code, label, amount, extra = {}) => ({ code, label, amount, originalAmount: amount, waived: false, ...extra })

// subtotal 400 - coupon 50 + delivery 0 (waived 30) + platform 5 + handling 10 + small-cart 0
// + packaging 4 = 369 pre-tax; GST 5% = 18.45; tip 10 -> 397.45
function fullOrder(overrides = {}) {
  return {
    order_number: 'BKLOO-1', created_at: '2026-10-09T10:00:00Z', status: 'CONFIRMED',
    items: [{ name: 'Rice', quantity: 4, price: 100, total: 400 }],
    subtotal: 400, discount_amount: 50, coupon_code: 'SAVE50',
    delivery_fee: 0, platform_fee: 5, handling_fee: 10, tax_amount: 18.45, tip_amount: 10,
    total_amount: 397.45, savings_total: 80, wallet_amount_used: 100,
    payment_method: 'COD', payment_status: 'PENDING',
    delivery_address: { city: 'Surat' },
    fee_breakdown: {
      discounts: [{ code: 'COUPON', label: 'Coupon (SAVE50)', amount: 30 }, { code: 'FIRST_ORDER_OFFER', label: 'First order offer', amount: 20 }],
      fees: [
        fee('DELIVERY_FEE', 'Delivery fee', 0, { originalAmount: 30, waived: true, description: 'Free above ₹300' }),
        fee('PLATFORM_FEE', 'Platform fee', 5), fee('HANDLING_FEE', 'Handling fee', 10), fee('PACKAGING_FEE', 'Packaging fee', 4),
        { code: 'GST', label: 'GST', amount: 18.45 },
      ],
    },
    ...overrides,
  }
}

describe('buildOrderBill', () => {
  it('itemises discounts by source, every fee, GST split, tip and sums to the total', () => {
    const bill = buildOrderBill(fullOrder())
    const labels = bill.lines.map((l) => l.label)
    expect(labels).toEqual(expect.arrayContaining([
      'Coupon (SAVE50)', 'First order offer', 'Delivery fee', 'Platform fee', 'Handling fee', 'Packaging fee', 'Rider tip',
    ]))
    expect(labels.some((l) => l.startsWith('CGST'))).toBe(true)
    expect(labels.some((l) => l.startsWith('SGST'))).toBe(true)
    expect(bill.lines.find((l) => l.code === 'DELIVERY_FEE').waived).toBe(true)
    const sum = bill.lines.reduce((s, l) => s + l.amount, 0)
    expect(Math.round(sum * 100) / 100).toBe(bill.grandTotal)
    expect(bill.reconciled).toBe(true)
  })

  it('splits payment: wallet paid, remainder is cash to collect', () => {
    const { payment } = buildOrderBill(fullOrder())
    expect(payment.walletUsed).toBe(100)
    expect(payment.collectOnDelivery).toBe(297.45)
    expect(payment.parts.map((p) => [p.code, p.state])).toEqual([['WALLET', 'PAID'], ['COD', 'DUE']])
  })

  it('wallet + Razorpay', () => {
    const { payment } = buildOrderBill(fullOrder({ payment_method: 'ONLINE', payment_status: 'PAID' }), { payment: { razorpay_payment_id: 'pay_1' } })
    expect(payment.parts.map((p) => [p.code, p.amount, p.state])).toEqual([['WALLET', 100, 'PAID'], ['RAZORPAY', 297.45, 'PAID']])
    expect(payment.collectOnDelivery).toBe(0)
  })

  it('names a legacy coupon-only order and falls back to scalar fee columns', () => {
    const bill = buildOrderBill({
      items: [], subtotal: 200, discount_amount: 20, coupon_code: 'OLD20', delivery_fee: 25, platform_fee: 3,
      tax_amount: 0, total_amount: 208, payment_method: 'COD', payment_status: 'PENDING', fee_breakdown: {},
    })
    expect(bill.lines.map((l) => l.label)).toEqual(['Item total', 'Coupon (OLD20)', 'Delivery fee', 'Platform fee'])
    expect(bill.reconciled).toBe(true)
  })

  it('surfaces unexplained money as an adjustment instead of hiding it', () => {
    const bill = buildOrderBill({ subtotal: 100, total_amount: 107, payment_method: 'COD', fee_breakdown: {} })
    expect(bill.reconciled).toBe(false)
    expect(bill.lines.at(-1)).toMatchObject({ code: 'ADJUSTMENT', amount: 7 })
  })

  it('uses IGST for an out-of-state GSTIN', () => {
    const bill = buildOrderBill(fullOrder({ buyer_gstin: '27ABCDE1234F1Z5' }))
    expect(bill.lines.some((l) => l.code === 'IGST')).toBe(true)
    expect(bill.lines.some((l) => l.code === 'CGST')).toBe(false)
  })

  it('lists cashback separately from the payable total', () => {
    const bill = buildOrderBill(fullOrder(), { cashback: [{ amount: 15, status: 'PENDING', source_type: 'COUPON' }] })
    expect(bill.cashback).toEqual([{ amount: 15, status: 'PENDING', source: 'COUPON' }])
  })
})

describe('printed surfaces use the bill', () => {
  it('POS slip shows platform fee, coupon, GST, wallet and cash to collect', () => {
    const o = fullOrder()
    const html = renderInvoice({ shop: { name: 'Bakaloo' }, order: o, items: o.items })
    for (const text of ['Coupon (SAVE50)', 'Platform fee', 'Packaging fee', 'CGST', 'Rider tip', 'FREE', 'Wallet - Paid', 'COLLECT IN CASH']) {
      expect(html).toContain(text)
    }
  })

  it('receipt PDF still renders for a full order', async () => {
    const buf = await generateInvoicePDF(fullOrder())
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })
})
