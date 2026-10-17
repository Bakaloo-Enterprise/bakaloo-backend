import { BusinessError } from '../../utils/business-error.js'
import { istDate, money } from '../../utils/business-period.js'
import { emitInTx } from '../../utils/audit-log.js'
import { withTransaction } from './procurement.repository.js'
import { checkDocument, checkPayment, settleBills } from './suppliers.rules.js'

/**
 * What we owe each supplier and what we paid, plus the supplier's papers (invoices, slips, credit notes).
 * Owed = received purchases − credit for goods sent back − payments not voided. Nothing here moves stock.
 */
export class SuppliersService {
  constructor({ repo, procurement, now = () => new Date() }) {
    Object.assign(this, { repo, procurement, now })
  }

  today() { return istDate(this.now()) }

  #bill(b) {
    return { entryId: b.id, entryNo: Number(b.entry_no), product: b.product_name, procuredOn: b.procured_on, total: money(b.total), credit: money(b.credit), invoiceRef: b.invoice_ref, hasInvoice: b.invoice_count > 0 }
  }

  /** Everyone we owe, biggest first, with the overdue part called out. */
  async payables() {
    const today = this.today()
    const [vendors, bills, paid, coming] = await Promise.all([this.repo.vendors({ includeInactive: true }), this.repo.bills(), this.repo.paymentTotals(), this.repo.onTheWay()])
    const paidBy = new Map(paid.map((p) => [p.vendor_id, Number(p.total)]))
    const comingBy = new Map(coming.map((c) => [c.vendor_id, c]))
    const rows = vendors.map((v) => {
      const mine = bills.filter((b) => b.vendor_id === v.id).map((b) => ({ ...this.#bill(b), vendorId: v.id }))
      const s = settleBills(mine, paidBy.get(v.id) ?? 0, { creditDays: v.credit_days, today })
      const c = comingBy.get(v.id)
      return { vendorId: v.id, name: v.name, phone: v.phone, paymentTerms: v.payment_terms, creditDays: v.credit_days, isActive: v.is_active, owed: s.owed, overdue: s.overdue, nextDue: s.nextDue, unpaidBills: s.bills.filter((b) => b.left > 0).length, onTheWay: c ? { count: c.n, value: money(c.value) } : null }
    })
    rows.sort((a, b) => b.overdue - a.overdue || b.owed - a.owed || a.name.localeCompare(b.name))
    return { totalOwed: money(rows.reduce((n, r) => n + r.owed, 0)), totalOverdue: money(rows.reduce((n, r) => n + r.overdue, 0)), vendors: rows, note: 'Owed = purchases that arrived − credit for goods sent back − payments. Goods still on the way are not owed yet.' }
  }

  /** One supplier: details, every bill with how much is paid, and the payments made. */
  async ledger(vendorId, canSeePay) {
    const v = await this.repo.vendorById(vendorId)
    if (!v) throw new BusinessError('Vendor not found.', 404, 'VENDOR_NOT_FOUND')
    const [bills, payments, coming] = await Promise.all([this.repo.bills(vendorId), this.repo.payments(vendorId), this.repo.onTheWay(vendorId)])
    const active = payments.filter((p) => !p.voided_at)
    const s = settleBills(bills.map((b) => this.#bill(b)), active.reduce((n, p) => n + Number(p.amount), 0), { creditDays: v.credit_days, today: this.today() })
    return {
      vendor: this.procurement.vendorShape(v, canSeePay), owed: s.owed, overdue: s.overdue, nextDue: s.nextDue,
      totalBilled: money(s.bills.reduce((n, b) => n + b.bill, 0)), totalPaid: money(active.reduce((n, p) => n + Number(p.amount), 0)),
      onTheWay: coming[0] ? { count: coming[0].n, value: money(coming[0].value) } : null,
      bills: s.bills.reverse(),
      payments: payments.map((p) => ({ id: p.id, amount: money(p.amount), method: p.method, paidOn: p.paid_on, reference: p.reference, note: p.note, by: p.actor_name, at: p.created_at, voided: Boolean(p.voided_at), voidReason: p.void_reason })),
    }
  }

  async pay(vendorId, input, actor) {
    const id = await withTransaction(async (client) => {
      const v = await this.repo.lockVendor(client, vendorId)
      if (!v) throw new BusinessError('Vendor not found.', 404, 'VENDOR_NOT_FOUND')
      const [bills, paid] = await Promise.all([this.repo.bills(vendorId), this.repo.paidTotal(client, vendorId)])
      const full = await this.repo.vendorById(vendorId, client)
      const s = settleBills(bills.map((b) => this.#bill(b)), Number(paid), { creditDays: full.credit_days, today: this.today() })
      const p = checkPayment(input, { balance: s.owed, today: this.today() })
      await this.periods?.assertOpen(p.paidOn, 'That payment date')
      const payId = await this.repo.insertPayment(client, { vendorId, ...p, reference: input.reference?.trim() || null, note: input.note?.trim() || null, actorId: actor.userId })
      await emitInTx(client, 'procurement.vendor.pay', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'vendor', target_id: vendorId, after: { paymentId: payId, ...p, owedBefore: s.owed } })
      return payId
    })
    return { id, ...(await this.ledger(vendorId, true)) }
  }

  /** A wrong payment is never deleted — it is crossed out with a reason, and the amount owed goes back up. */
  async voidPayment(paymentId, reason, actor) {
    const text = String(reason ?? '').trim()
    if (!text) throw new BusinessError('Say why this payment is being cancelled.', 400, 'VALIDATION', { reason: 'Required' })
    const vendorId = await withTransaction(async (client) => {
      const p = await this.repo.paymentById(client, paymentId)
      if (!p) throw new BusinessError('Payment not found.', 404, 'PAYMENT_NOT_FOUND')
      if (p.voided_at) throw new BusinessError('That payment was already cancelled.', 409, 'ALREADY_VOIDED')
      await this.periods?.assertOpen(p.paid_on, 'That payment')
      await this.repo.voidPayment(client, paymentId, { actorId: actor.userId, reason: text.slice(0, 200) })
      await emitInTx(client, 'procurement.vendor.pay.void', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'vendor', target_id: p.vendor_id, after: { paymentId, amount: p.amount, reason: text } })
      return p.vendor_id
    })
    return this.ledger(vendorId, true)
  }

  // ─── papers ───
  async addDocument(entryId, { kind = 'INVOICE', buffer, filename, mime }, actor) {
    checkDocument({ mime, size: buffer?.length ?? 0, kind })
    const id = await withTransaction(async (client) => {
      const e = await client.query(`SELECT id FROM procurement_entries WHERE id = $1 FOR UPDATE`, [entryId])
      if (!e.rows[0]) throw new BusinessError('Purchase not found.', 404, 'ENTRY_NOT_FOUND')
      const docId = await this.repo.insertDocument(client, { entryId, kind, fileName: String(filename || 'file').slice(0, 200), mime, size: buffer.length, data: buffer, actorId: actor.userId })
      await this.repo.logEvent(client, entryId, actor.userId, 'DOCUMENT_ADDED', { kind, fileName: filename })
      await emitInTx(client, 'procurement.document.add', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: entryId, after: { kind, fileName: filename, size: buffer.length } })
      return docId
    })
    return { id, entry: await this.procurement.detail(entryId) }
  }

  async file(documentId) {
    const d = await this.repo.documentFile(documentId)
    if (!d) throw new BusinessError('File not found.', 404, 'DOCUMENT_NOT_FOUND')
    return d
  }

  async removeDocument(documentId, actor) {
    const entryId = await withTransaction(async (client) => {
      const d = await this.repo.deleteDocument(client, documentId)
      if (!d) throw new BusinessError('File not found.', 404, 'DOCUMENT_NOT_FOUND')
      await this.repo.logEvent(client, d.entry_id, actor.userId, 'DOCUMENT_REMOVED', { kind: d.kind, fileName: d.file_name })
      await emitInTx(client, 'procurement.document.remove', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: d.entry_id, after: { kind: d.kind, fileName: d.file_name } })
      return d.entry_id
    })
    return this.procurement.detail(entryId)
  }
}
