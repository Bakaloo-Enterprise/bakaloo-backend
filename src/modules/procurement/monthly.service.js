import ExcelJS from 'exceljs'
import { money, istDate } from '../../utils/business-period.js'
import { isLossKind, ADJUSTMENT_KINDS, valueOf } from './procurement.rules.js'
import { settleBills } from './suppliers.rules.js'
import { AGE_BUCKETS, ageBucket, daysBetween, findExceptions, monthWindow, sumMoney } from './monthly.rules.js'

const DEFINITIONS = [
  ['Purchases', 'Every purchase dated in the month that was not cancelled, valued at the agreed total. Goods still “on the way” are listed but are not owed yet.'],
  ['We owe suppliers', 'Purchases that arrived − credit for goods sent back − payments made. Oldest bills are settled first. Opening + bills − returns − paid = closing; any supplier where this does not add up is listed in Exceptions.'],
  ['Wastage and loss', 'Goods thrown away (at the door or later), damaged or written off, valued at the price we paid. Goods sent back to the supplier are recovered cost, not a loss; goods the supplier replaces carry no credit.'],
  ['B2B collected', 'Money recorded against B2B orders (cash, UPI, Razorpay, other) in the month. It comes from the recorded payments, not from the order’s “paid” flag, because credit orders show as paid when placed.'],
  ['Customers owe us', 'Approved B2B bills minus the payments recorded up to the last day of the month. Late = past the due date set on the order.'],
  ['Money received', 'Counts only money that really changed hands: payments recorded against B2B orders, COD cash on delivered orders, and online payments the gateway captured. An order marked “paid” is not enough on its own for B2B credit orders.'],
  ['GST', 'GST numbers are only checked for the right shape, not verified. This report does not claim input tax credit.'],
]

/** The month-end report: one build, two outputs (a screen preview and an Excel workbook), so they cannot disagree. */
export class MonthlyService {
  constructor({ repo, now = () => new Date() }) {
    Object.assign(this, { repo, now })
  }

  async build(month) {
    const w = monthWindow(month, this.now())
    const [purchRows, vendors, billsStart, billsEnd, paidStart, paidEnd, credits, payRows, adjRows, doorRows, collRows, salesRows, recvRows, cod, gateway, manualRows] = await Promise.all([
      this.repo.purchases(w.from, w.to), this.repo.vendors(), this.repo.billsAsOf(w.dayBefore, w.start), this.repo.billsAsOf(w.asOf, w.end), this.repo.paidAsOf(w.dayBefore), this.repo.paidAsOf(w.asOf),
      this.repo.creditsInWindow(w.start, w.end), this.repo.payments(w.from, w.to), this.repo.adjustments(w.start, w.end), this.repo.doorDamage(w.start, w.end),
      this.repo.collections(w.start, w.end), this.repo.b2bSales(w.start, w.end), this.repo.receivablesAt(w.end),
      this.repo.codCash(w.start, w.end), this.repo.gatewayCaptured(w.start, w.end), this.repo.manualUnpaid(w.end),
    ])

    const purchases = purchRows.map((r) => ({
      entryNo: Number(r.entry_no), date: r.date, vendor: r.vendor, product: r.product, ordered: r.expected_qty, received: r.received_qty, bad: r.damaged_qty, accepted: Math.max(0, r.received_qty - r.damaged_qty),
      short: r.status === 'ACTIVE' ? Math.max(0, r.expected_qty - r.received_qty) : 0, owedQty: r.owed_qty, unitPrice: money(r.unit_price), total: money(r.total), status: r.status, invoices: r.invoices, invoiceRef: r.invoice_ref,
    }))

    // ── supplier accounts ──
    const paidBy = (rows) => new Map(rows.map((p) => [p.vendor_id, Number(p.total)]))
    const [pStart, pEnd, cr] = [paidBy(paidStart), paidBy(paidEnd), new Map(credits.map((c) => [c.vendor_id, Number(c.total)]))]
    const billing = (rows, vid) => rows.filter((b) => b.vendor_id === vid).map((b) => ({ entryNo: Number(b.entry_no), procuredOn: b.procured_on, total: b.total, credit: b.credit }))
    const payments = payRows.map((p) => ({ date: p.date, vendor: p.vendor, amount: money(p.amount), method: p.method, reference: p.reference, note: p.note, by: p.by, voided: p.voided, voidReason: p.void_reason }))
    const paidInMonth = new Map()
    for (const p of payRows.filter((x) => !x.voided)) paidInMonth.set(p.vendor, (paidInMonth.get(p.vendor) ?? 0) + Number(p.amount))
    const payables = vendors.map((v) => {
      const opening = settleBills(billing(billsStart, v.id), pStart.get(v.id) ?? 0, { creditDays: v.credit_days, today: w.dayBefore })
      const closing = settleBills(billing(billsEnd, v.id), pEnd.get(v.id) ?? 0, { creditDays: v.credit_days, today: w.asOf })
      const billed = sumMoney(purchRows.filter((p) => p.status === 'ACTIVE' && p.vendor === v.name), (p) => p.total)
      const credit = money(cr.get(v.id) ?? 0)
      const paid = money(paidInMonth.get(v.name) ?? 0)
      const expected = Math.round((opening.owed + billed - credit - paid) * 100) / 100
      return { vendorId: v.id, vendor: v.name, terms: v.payment_terms, creditDays: v.credit_days, opening: opening.owed, billed, credits: credit, paid, closing: closing.owed, overdue: closing.overdue, advance: closing.advance, difference: Math.round((closing.owed - expected) * 100) / 100 }
    }).filter((v) => v.opening || v.billed || v.credits || v.paid || v.closing || v.advance)

    // ── wastage, returns ──
    const adj = adjRows.map((a) => ({ date: istDate(new Date(a.created_at)), kind: a.kind, label: ADJUSTMENT_KINDS[a.kind]?.label ?? a.kind, loss: isLossKind(a.kind), entryNo: Number(a.entry_no), vendor: a.vendor, product: a.product, shop: a.shop, quantity: a.quantity, value: valueOf(a.quantity, a.unit_cost), reason: a.reason, by: a.by }))
    const door = doorRows.map((a) => ({ date: istDate(new Date(a.created_at)), kind: 'DAMAGED_AT_DOOR', label: 'Bad on arrival (thrown away)', loss: true, entryNo: Number(a.entry_no), vendor: a.vendor, product: a.product, shop: null, quantity: a.quantity, value: valueOf(a.quantity, a.unit_cost), reason: 'Failed the quality check when received', by: null }))
    const losses = [...door, ...adj].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const lossValue = sumMoney(losses.filter((l) => l.loss), (l) => l.value)
    const recovered = sumMoney(losses.filter((l) => l.kind === 'VENDOR_RETURN'), (l) => l.value)

    // ── B2B ──
    const collections = collRows.map((c) => ({ date: istDate(new Date(c.created_at)), order: c.order_number, customer: c.customer, method: c.method, amount: money(c.amount), note: c.note, by: c.by }))
    const byMethod = (m) => sumMoney(collections.filter((c) => c.method === m), (c) => c.amount)
    const sales = salesRows.map((s) => ({ date: istDate(new Date(s.approved_at)), order: s.order_number, customer: s.customer, total: money(s.total), settledByEnd: money(s.settled_by_end), left: Math.max(0, Math.round((Number(s.total) - Number(s.settled_by_end)) * 100) / 100) }))
    const aging = recvRows.map((r) => {
      const outstanding = Math.round((Number(r.total) - Number(r.settled)) * 100) / 100
      const due = r.due_on ?? r.billed_on
      const daysLate = daysBetween(due, w.asOf)
      return { order: r.order_number, customer: r.customer, billedOn: r.billed_on, dueOn: due, total: money(r.total), paid: money(r.settled), outstanding, daysLate: Math.max(0, daysLate), bucket: ageBucket(daysLate) }
    }).filter((a) => a.outstanding >= 0.01).sort((a, b) => b.daysLate - a.daysLate)
    const agingTotals = AGE_BUCKETS.map((bucket) => ({ bucket, orders: aging.filter((a) => a.bucket === bucket).length, amount: sumMoney(aging.filter((a) => a.bucket === bucket), (a) => a.outstanding) }))

    const manualUnpaid = manualRows.map((m) => ({ order: m.order_number, customer: m.customer, date: m.on, total: money(m.total) }))
    const data = { manualUnpaid, window: { month: w.month, label: w.label, from: w.from, to: w.to, asOf: w.asOf, inProgress: w.inProgress }, purchases, payables, payments, losses, collections, sales, aging, agingTotals }
    const summary = {
      purchases: { count: purchases.length, value: sumMoney(purchases, (p) => p.total), onTheWay: purchases.filter((p) => p.status === 'ORDERED').length, receivedUnits: purchases.reduce((n, p) => n + p.received, 0), acceptedUnits: purchases.reduce((n, p) => n + p.accepted, 0) },
      suppliers: { opening: sumMoney(payables, (v) => v.opening), billed: sumMoney(payables, (v) => v.billed), returned: sumMoney(payables, (v) => v.credits), paid: sumMoney(payables, (v) => v.paid), closing: sumMoney(payables, (v) => v.closing), overdue: sumMoney(payables, (v) => v.overdue) },
      loss: { wastage: lossValue, recovered, units: losses.filter((l) => l.loss).reduce((n, l) => n + l.quantity, 0) },
      b2b: { billed: sumMoney(sales, (s) => s.total), collected: sumMoney(collections, (c) => c.amount), cash: byMethod('CASH'), upi: byMethod('UPI'), razorpay: byMethod('RAZORPAY'), other: byMethod('OTHER'), outstanding: sumMoney(aging, (a) => a.outstanding), overdue: sumMoney(aging.filter((a) => a.daysLate > 0), (a) => a.outstanding) },
    }
    const moneyIn = { b2b: summary.b2b.collected, cod: money(cod.total), codOrders: cod.n, gateway: money(gateway.total), gatewayPayments: gateway.n }
    moneyIn.total = Math.round((moneyIn.b2b + moneyIn.cod + moneyIn.gateway) * 100) / 100
    summary.moneyIn = moneyIn
    const exceptions = findExceptions(data)
    return { ...data, summary, exceptions, definitions: DEFINITIONS.map(([term, text]) => ({ term, text })) }
  }

  /** Small version for the screen: the numbers and what needs attention, without every row. */
  async preview(month) {
    const d = await this.build(month)
    return {
      window: d.window, summary: d.summary, agingTotals: d.agingTotals, definitions: d.definitions,
      exceptions: d.exceptions.map((e) => ({ code: e.code, level: e.level, text: e.text, count: e.rows.length })),
      counts: { purchases: d.purchases.length, payments: d.payments.length, losses: d.losses.length, collections: d.collections.length, receivables: d.aging.length },
    }
  }

  async workbook(month) {
    const d = await this.build(month)
    const wb = new ExcelJS.Workbook()
    wb.creator = 'Bakaloo'
    wb.created = this.now()
    const INR = '"₹"#,##0.00'
    const sheet = (name, columns, rows, { totals = [] } = {}) => {
      const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] })
      ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 16, style: c.fmt ? { numFmt: c.fmt } : {} }))
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF166534' } }
      ws.getRow(1).alignment = { vertical: 'middle', wrapText: true }
      rows.forEach((r) => ws.addRow(r))
      if (rows.length && totals.length) {
        const t = { [columns[0].key]: 'Total' }
        for (const k of totals) t[k] = Math.round(rows.reduce((n, r) => n + (Number(r[k]) || 0) * 100, 0)) / 100
        const row = ws.addRow(t)
        row.font = { bold: true }
        row.border = { top: { style: 'thin' } }
      }
      if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } }
      return ws
    }
    const s = d.summary
    const ws = wb.addWorksheet('Summary')
    ws.columns = [{ width: 44 }, { width: 20 }, { width: 70 }]
    ws.addRow([`Bakaloo — month-end report: ${d.window.label}`]).font = { bold: true, size: 14 }
    ws.addRow([`Period ${d.window.from} to ${d.window.to}${d.window.inProgress ? ' (month still running — figures are to date)' : ''}. Generated ${istDate(this.now())}.`])
    ws.addRow([])
    const block = (title, rows) => {
      const h = ws.addRow([title])
      h.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      h.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF166534' } } })
      for (const [label, value, note, fmt] of rows) { const r = ws.addRow([label, value, note ?? '']); if (fmt !== false && typeof value === 'number') r.getCell(2).numFmt = fmt ?? INR }
      ws.addRow([])
    }
    block('PURCHASES', [['Purchases (count)', s.purchases.count, '', '0'], ['Purchase value', s.purchases.value], ['Still on the way (count)', s.purchases.onTheWay, 'Not owed yet', '0'], ['Units received', s.purchases.receivedUnits, '', '0'], ['Units accepted after the quality check', s.purchases.acceptedUnits, '', '0']])
    block('SUPPLIERS', [['We owed at the start of the month', s.suppliers.opening], ['+ Bills received this month', s.suppliers.billed], ['− Credit for goods sent back', s.suppliers.returned], ['− Paid to suppliers', s.suppliers.paid], ['= We owe at the end of the month', s.suppliers.closing], ['  of which late', s.suppliers.overdue]])
    block('WASTAGE AND LOSS', [['Loss (thrown away, damaged, written off)', s.loss.wastage, `${s.loss.units} units`], ['Recovered by sending goods back', s.loss.recovered, 'Not a loss']])
    block('MONEY ACTUALLY RECEIVED (all customers)', [['B2B customers (recorded payments)', s.moneyIn.b2b], ['Cash taken on delivery (COD)', s.moneyIn.cod, `${s.moneyIn.codOrders} orders`], ['Online payments captured by the gateway', s.moneyIn.gateway, `${s.moneyIn.gatewayPayments} payments. Refunds are not taken off.`], ['Total received', s.moneyIn.total, 'Wallet credit is not counted — it is not cash']])
    block('B2B CUSTOMERS', [['Billed this month (approved B2B orders)', s.b2b.billed], ['Collected this month', s.b2b.collected], ['   Cash', s.b2b.cash], ['   UPI', s.b2b.upi], ['   Razorpay', s.b2b.razorpay], ['   Other', s.b2b.other], ['Customers owe us at the end of the month', s.b2b.outstanding], ['  of which late', s.b2b.overdue]])
    const ex = ws.addRow(['NEEDS ATTENTION']); ex.font = { bold: true, color: { argb: 'FFFFFFFF' } }; ex.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB91C1C' } } })
    if (d.exceptions.length === 0) ws.addRow(['Nothing — all checks passed.'])
    for (const e of d.exceptions) ws.addRow([e.text, '', 'See the Exceptions sheet'])
    ws.addRow([])
    const df = ws.addRow(['HOW THE NUMBERS ARE WORKED OUT']); df.font = { bold: true }
    for (const x of d.definitions) { const r = ws.addRow([x.term, '', x.text]); r.alignment = { wrapText: true, vertical: 'top' } }

    sheet('Purchases', [
      { header: 'No.', key: 'entryNo', width: 8 }, { header: 'Date', key: 'date', width: 12 }, { header: 'Supplier', key: 'vendor', width: 24 }, { header: 'Product', key: 'product', width: 28 },
      { header: 'Ordered', key: 'ordered', width: 10 }, { header: 'Received', key: 'received', width: 10 }, { header: 'Bad', key: 'bad', width: 8 }, { header: 'Accepted', key: 'accepted', width: 10 }, { header: 'Short', key: 'short', width: 8 },
      { header: 'Supplier owes (units)', key: 'owedQty', width: 12 }, { header: 'Price each', key: 'unitPrice', fmt: INR }, { header: 'Total', key: 'total', fmt: INR }, { header: 'Status', key: 'status', width: 12 }, { header: 'Invoice files', key: 'invoices', width: 10 }, { header: 'Invoice ref', key: 'invoiceRef', width: 16 },
    ], d.purchases, { totals: ['ordered', 'received', 'bad', 'accepted', 'total'] })
    sheet('Supplier payables', [
      { header: 'Supplier', key: 'vendor', width: 28 }, { header: 'Terms', key: 'terms', width: 9 }, { header: 'Credit days', key: 'creditDays', width: 11 }, { header: 'Owed at start', key: 'opening', fmt: INR }, { header: '+ Bills', key: 'billed', fmt: INR },
      { header: '− Goods sent back', key: 'credits', fmt: INR }, { header: '− Paid', key: 'paid', fmt: INR }, { header: '= Owed at end', key: 'closing', fmt: INR }, { header: 'Late', key: 'overdue', fmt: INR }, { header: 'Paid ahead', key: 'advance', fmt: INR }, { header: 'Does not add up by', key: 'difference', fmt: INR },
    ], d.payables, { totals: ['opening', 'billed', 'credits', 'paid', 'closing', 'overdue'] })
    sheet('Supplier payments', [
      { header: 'Date', key: 'date', width: 12 }, { header: 'Supplier', key: 'vendor', width: 28 }, { header: 'Amount', key: 'amount', fmt: INR }, { header: 'Paid by', key: 'method', width: 9 }, { header: 'Reference', key: 'reference', width: 20 },
      { header: 'Recorded by', key: 'by', width: 18 }, { header: 'Cancelled', key: 'voided', width: 10 }, { header: 'Why cancelled', key: 'voidReason', width: 30 },
    ], d.payments.map((p) => ({ ...p, voided: p.voided ? 'Yes' : '' })))
    sheet('Wastage and returns', [
      { header: 'Date', key: 'date', width: 12 }, { header: 'What happened', key: 'label', width: 30 }, { header: 'Loss?', key: 'lossText', width: 8 }, { header: 'Purchase no.', key: 'entryNo', width: 10 }, { header: 'Supplier', key: 'vendor', width: 24 },
      { header: 'Product', key: 'product', width: 28 }, { header: 'Store', key: 'shop', width: 18 }, { header: 'Units', key: 'quantity', width: 8 }, { header: 'Value', key: 'value', fmt: INR }, { header: 'Reason', key: 'reason', width: 40 }, { header: 'By', key: 'by', width: 16 },
    ], d.losses.map((l) => ({ ...l, lossText: l.loss ? 'Yes' : 'No' })), { totals: ['quantity', 'value'] })
    sheet('B2B billed', [
      { header: 'Approved on', key: 'date', width: 12 }, { header: 'Order', key: 'order', width: 16 }, { header: 'Customer', key: 'customer', width: 28 }, { header: 'Bill', key: 'total', fmt: INR }, { header: 'Paid by month end', key: 'settledByEnd', fmt: INR }, { header: 'Left', key: 'left', fmt: INR },
    ], d.sales, { totals: ['total', 'settledByEnd', 'left'] })
    sheet('B2B collections', [
      { header: 'Date', key: 'date', width: 12 }, { header: 'Order', key: 'order', width: 16 }, { header: 'Customer', key: 'customer', width: 28 }, { header: 'Paid by', key: 'method', width: 10 }, { header: 'Amount', key: 'amount', fmt: INR }, { header: 'Note', key: 'note', width: 30 }, { header: 'Recorded by', key: 'by', width: 18 },
    ], d.collections, { totals: ['amount'] })
    sheet('Customers owe us', [
      { header: 'Order', key: 'order', width: 16 }, { header: 'Customer', key: 'customer', width: 28 }, { header: 'Billed on', key: 'billedOn', width: 12 }, { header: 'Due on', key: 'dueOn', width: 12 }, { header: 'Bill', key: 'total', fmt: INR },
      { header: 'Paid', key: 'paid', fmt: INR }, { header: 'Still owed', key: 'outstanding', fmt: INR }, { header: 'Days late', key: 'daysLate', width: 10 }, { header: 'How late', key: 'bucket', width: 20 },
    ], d.aging, { totals: ['total', 'paid', 'outstanding'] })
    sheet('Manual orders unpaid', [{ header: 'Order', key: 'order', width: 16 }, { header: 'Customer', key: 'customer', width: 28 }, { header: 'Ordered on', key: 'date', width: 12 }, { header: 'Amount', key: 'total', fmt: INR }], d.manualUnpaid, { totals: ['total'] })
    sheet('Exceptions', [{ header: 'Check', key: 'check', width: 60 }, { header: 'Where', key: 'ref', width: 22 }, { header: 'Who', key: 'who', width: 26 }, { header: 'Detail', key: 'detail', width: 50 }],
      d.exceptions.flatMap((e) => e.rows.map((r) => ({ check: e.text, ...r }))))
    return Buffer.from(await wb.xlsx.writeBuffer())
  }
}
