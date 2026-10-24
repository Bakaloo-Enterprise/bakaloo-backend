import { BusinessError } from '../../utils/business-error.js'
import { istDate, istDayStart, money } from '../../utils/business-period.js'
import { emitInTx } from '../../utils/audit-log.js'
import { withTransaction } from '../procurement/procurement.repository.js'
import { monthWindow } from '../procurement/monthly.rules.js'
import { CASH_KINDS, EXPENSE_CATEGORIES, accountOfMethod, add, amountProblem, emptyBooks, flowOf, netOf, profitAndLoss, total } from './accounting.rules.js'

const DAY_MS = 86_400_000
const EARLIEST = '2020-01-01'
const DATE = /^\d{4}-\d{2}-\d{2}$/
const trim = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null }

export const ACCOUNTING_NOTES = Object.freeze([
  'This is a management view built from the records in the system, not a statutory book. Reconcile with your accountant before filing anything.',
  'Cash on delivery counts as cash on the day it is delivered. Cash still held by riders, and the lag before the gateway pays into the bank, are not tracked.',
  'Gateway fees, rider payouts, rent and the like only appear once you enter them as expenses.',
  'Balances start from the opening balance you enter for the cash box and the bank; without one only the month’s movement is shown.',
])

/** Expenses, the owner's cash book, monthly profit & loss and cash/bank position. Reads sales and purchases from where they already live. */
export class AccountingService {
  constructor({ repo, monthly, monthlyRepo, periods, now = () => new Date() }) {
    Object.assign(this, { repo, monthly, monthlyRepo, periods, now })
  }

  #day(v, field, { allowFuture = false } = {}) {
    if (!DATE.test(String(v ?? '')) || !istDayStart(v)) throw new BusinessError('Pick a real date like 2026-10-24.', 400, 'VALIDATION', { [field]: 'Invalid date' })
    if (v < EARLIEST) throw new BusinessError('That date is too far back.', 400, 'VALIDATION', { [field]: 'Too old' })
    if (!allowFuture && v > istDate(this.now())) throw new BusinessError('That date has not come yet.', 400, 'VALIDATION', { [field]: 'In the future' })
    return v
  }
  #range(q) {
    const to = q.to ?? istDate(this.now())
    const from = q.from ?? istDate(new Date(istDayStart(to).getTime() - 29 * DAY_MS))
    this.#day(from, 'from', { allowFuture: true }); this.#day(to, 'to', { allowFuture: true })
    if (from > to) throw new BusinessError('“From” must not be after “To”.', 400, 'VALIDATION', { from: 'After the end date' })
    return { from, to }
  }
  #actor(a) { return { actorId: a.userId } }

  // ── expenses ──
  async listExpenses(q = {}) {
    const r = this.#range(q)
    if (q.category && !EXPENSE_CATEGORIES[q.category]) throw new BusinessError('Unknown expense type.', 400, 'VALIDATION', { category: 'Invalid' })
    const rows = await this.repo.expenses({ ...r, category: q.category ?? null, shopId: q.shopId ?? null, includeVoided: q.includeVoided === true || q.includeVoided === 'true' })
    const live = rows.filter((x) => !x.voided_at)
    return {
      ...r,
      total: money(live.reduce((t, x) => t + Number(x.amount), 0)),
      items: rows.map((x) => ({
        id: x.id, date: x.spent_on, category: x.category, categoryLabel: EXPENSE_CATEGORIES[x.category]?.label ?? x.category, kind: x.kind, amount: money(x.amount), paidVia: x.paid_via, shopId: x.shop_id, shop: x.shop,
        party: x.party, note: x.note, createdBy: x.created_by_name, createdAt: x.created_at, voided: Boolean(x.voided_at), voidReason: x.void_reason, voidedBy: x.voided_by_name,
      })),
      categories: Object.entries(EXPENSE_CATEGORIES).map(([id, c]) => ({ id, label: c.label, kind: c.kind })),
    }
  }

  async createExpense(input, actor) {
    const spentOn = this.#day(input.spentOn, 'spentOn')
    const cat = EXPENSE_CATEGORIES[input.category]
    if (!cat) throw new BusinessError('Choose what the money was spent on.', 400, 'VALIDATION', { category: 'Required' })
    if (!['CASH', 'UPI', 'BANK'].includes(input.paidVia)) throw new BusinessError('Choose how it was paid: cash, UPI or bank.', 400, 'VALIDATION', { paidVia: 'Required' })
    const problem = amountProblem(input.amount)
    if (problem) throw new BusinessError(problem, 400, 'VALIDATION', { amount: problem })
    await this.periods.assertOpen(spentOn, 'This expense')
    try {
      return await withTransaction(async (client) => {
        const id = await this.repo.insertExpense(client, { spentOn, category: input.category, kind: cat.kind, amount: Number(input.amount), paidVia: input.paidVia, shopId: input.shopId ?? null, party: trim(input.party, 120), note: trim(input.note, 300), ...this.#actor(actor) })
        await emitInTx(client, 'erp.expense.create', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'erp_expense', target_id: id, after: { spentOn, category: input.category, amount: Number(input.amount), paidVia: input.paidVia } })
        return { id }
      })
    } catch (err) {
      if (err?.code === '23503') throw new BusinessError('That store does not exist.', 400, 'VALIDATION', { shopId: 'Unknown store' })
      throw err
    }
  }

  async voidExpense(id, reason, actor) {
    const why = trim(reason, 300)
    if (!why) throw new BusinessError('Say why this expense is being cancelled.', 400, 'VALIDATION', { reason: 'Required' })
    return withTransaction(async (client) => {
      const e = await this.repo.lockExpense(client, id)
      if (!e) throw new BusinessError('Expense not found.', 404, 'NOT_FOUND')
      if (e.voided_at) throw new BusinessError('This expense is already cancelled.', 409, 'ALREADY_VOIDED')
      await this.periods.assertOpen(e.spent_on, 'This expense')
      await this.repo.voidExpense(client, id, actor.userId, why)
      await emitInTx(client, 'erp.expense.void', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'erp_expense', target_id: id, after: { reason: why, amount: Number(e.amount), spentOn: e.spent_on } })
      return { id, voided: true }
    })
  }

  // ── owner's cash book ──
  async listCash(q = {}) {
    const r = this.#range(q)
    const rows = await this.repo.cashEntries({ ...r, includeVoided: q.includeVoided === true || q.includeVoided === 'true' })
    return {
      ...r,
      items: rows.map((x) => ({ id: x.id, date: x.entry_on, kind: x.kind, kindLabel: CASH_KINDS[x.kind]?.label ?? x.kind, account: x.account, amount: money(x.amount), note: x.note, createdBy: x.created_by_name, voided: Boolean(x.voided_at), voidReason: x.void_reason, voidedBy: x.voided_by_name })),
      kinds: Object.entries(CASH_KINDS).map(([id, k]) => ({ id, label: k.label, needsAccount: k.needsAccount })),
    }
  }

  async createCash(input, actor) {
    const entryOn = this.#day(input.entryOn, 'entryOn')
    const k = CASH_KINDS[input.kind]
    if (!k) throw new BusinessError('Choose what kind of entry this is.', 400, 'VALIDATION', { kind: 'Required' })
    if (k.needsAccount && !['CASH', 'BANK'].includes(input.account)) throw new BusinessError('Choose cash box or bank.', 400, 'VALIDATION', { account: 'Required' })
    const problem = amountProblem(input.amount)
    if (problem) throw new BusinessError(problem, 400, 'VALIDATION', { amount: problem })
    await this.periods.assertOpen(entryOn, 'This entry')
    return withTransaction(async (client) => {
      const id = await this.repo.insertCash(client, { entryOn, kind: input.kind, account: k.needsAccount ? input.account : null, amount: Number(input.amount), note: trim(input.note, 300), ...this.#actor(actor) })
      await emitInTx(client, 'erp.cash.create', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'erp_cash_entry', target_id: id, after: { entryOn, kind: input.kind, account: input.account ?? null, amount: Number(input.amount) } })
      return { id }
    })
  }

  async voidCash(id, reason, actor) {
    const why = trim(reason, 300)
    if (!why) throw new BusinessError('Say why this entry is being cancelled.', 400, 'VALIDATION', { reason: 'Required' })
    return withTransaction(async (client) => {
      const c = await this.repo.lockCash(client, id)
      if (!c) throw new BusinessError('Entry not found.', 404, 'NOT_FOUND')
      if (c.voided_at) throw new BusinessError('This entry is already cancelled.', 409, 'ALREADY_VOIDED')
      await this.periods.assertOpen(c.entry_on, 'This entry')
      await this.repo.voidCash(client, id, actor.userId, why)
      await emitInTx(client, 'erp.cash.void', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'erp_cash_entry', target_id: id, after: { reason: why, kind: c.kind, amount: Number(c.amount) } })
      return { id, voided: true }
    })
  }

  // ── money in and out of the two boxes ──
  /** Everything that moved cash or bank between two India dates (inclusive). Built from the real records, one line type per source. */
  async #books(from, to) {
    const start = istDayStart(from)
    const end = new Date(istDayStart(to).getTime() + DAY_MS)
    const [cod, gwIn, gwOut, collections, supplier, expenses, cash] = await Promise.all([
      this.monthlyRepo.codCash(start, end), this.repo.gatewayIn(start, end), this.repo.gatewayOut(start, end), this.monthlyRepo.collections(start, end),
      this.monthlyRepo.payments(from, to), this.repo.expenses({ from, to, limit: 100000 }), this.repo.cashEntries({ from, to, limit: 100000 }),
    ])
    const books = emptyBooks()
    add(books, 'CASH', 'in', 'Cash on delivery collected', cod.total)
    add(books, 'BANK', 'in', 'Online payments received', gwIn.total)
    add(books, 'BANK', 'out', 'Refunded through the payment gateway', gwOut.total)
    for (const c of collections) add(books, accountOfMethod(c.method), 'in', 'Business customers paid', c.amount)
    for (const p of supplier.filter((x) => !x.voided)) add(books, accountOfMethod(p.method), 'out', 'Paid to suppliers', p.amount)
    for (const e of expenses) add(books, accountOfMethod(e.paid_via), 'out', 'Running costs', e.amount)
    for (const c of cash) for (const f of flowOf(c)) add(books, f.account, f.delta > 0 ? 'in' : 'out', CASH_KINDS[c.kind].label, Math.abs(f.delta))
    return { books, parts: { cod, gwIn, gwOut, collections, supplier, expenses, cash } }
  }

  async #position(from, to) {
    const { books, parts } = await this.#books(from, to)
    const net = netOf(books)
    const out = {}
    for (const account of ['CASH', 'BANK']) {
      const opening = await this.repo.opening(account, to)
      let balance = null
      if (opening) {
        const since = (await this.#books(opening.on, to)).books
        balance = money(Number(opening.amount) + netOf(since)[account])
      }
      out[account] = { in: books[account].in, out: books[account].out, totalIn: total(books[account].in), totalOut: total(books[account].out), net: net[account], opening: opening ? { on: opening.on, amount: money(opening.amount) } : null, balance }
    }
    return { position: out, parts }
  }

  /** The month on one page: profit & loss and where the money moved. */
  async summary({ month, report: given } = {}) {
    const w = monthWindow(month ?? istDate(this.now()).slice(0, 7), this.now())
    const report = given ?? (await this.monthly.build(w.month))
    const [{ position, parts }, expenses, cash] = await Promise.all([this.#position(w.from, w.to), this.repo.expenses({ from: w.from, to: w.to, limit: 100000 }), this.repo.cashEntries({ from: w.from, to: w.to, limit: 100000 })])
    const otherIncome = cash.filter((c) => c.kind === 'OTHER_INCOME').reduce((t, c) => t + Number(c.amount), 0)
    const profit = report.summary.profit
    const pnl = profitAndLoss({ profit: { sales: profit.sales, cogs: profit.cogs, gross: profit.gross, loss: profit.loss, afterLoss: profit.afterLoss }, expenses, otherIncome })
    const warnings = []
    if (w.inProgress) warnings.push('This month is still running — figures keep moving.')
    if (report.closed) warnings.push(`${w.label} is closed: sales, purchases and stock are frozen as signed off. Expenses and cash entries can no longer be added or cancelled for it.`)
    if (!position.CASH.opening && !position.BANK.opening) warnings.push('No opening balance yet — add one under “Cash & bank” to see balances.')
    return {
      month: w.month, label: w.label, from: w.from, to: w.to, inProgress: w.inProgress, closed: report.closed ? { at: report.closed.at, by: report.closed.by } : null,
      pnl, position, counts: { expenses: expenses.length, cashEntries: cash.length, codOrders: parts.cod.n, gatewayPayments: parts.gwIn.n },
      stockChecks: { open: (report.exceptions ?? []).filter((e) => e.level === 'ERROR' || e.level === 'WARN').length },
      warnings, notes: ACCOUNTING_NOTES,
    }
  }

  /** Every money event of the month in date order — the audit trail behind the position. Lines add up to the position's in/out. */
  async journal({ month } = {}) {
    const w = monthWindow(month ?? istDate(this.now()).slice(0, 7), this.now())
    const start = w.start
    const end = w.end
    const [{ parts }, codDays, gwInDays, gwOutDays] = await Promise.all([this.#books(w.from, w.to), this.repo.codByDay(start, end), this.repo.gatewayInByDay(start, end), this.repo.gatewayOutByDay(start, end)])
    const rows = []
    const push = (date, account, direction, label, party, amount, source) => { if (Number(amount) > 0) rows.push({ date, account, direction, label, party: party ?? null, amount: money(amount), source }) }
    for (const d of codDays) push(d.day, 'CASH', 'in', `Cash on delivery collected (${d.n} order${d.n > 1 ? 's' : ''})`, null, d.total, 'ORDERS')
    for (const d of gwInDays) push(d.day, 'BANK', 'in', `Online payments received (${d.n})`, null, d.total, 'GATEWAY')
    for (const d of gwOutDays) push(d.day, 'BANK', 'out', `Refunded through the payment gateway (${d.n})`, null, d.total, 'GATEWAY')
    for (const c of parts.collections) push(istDate(new Date(c.created_at)), accountOfMethod(c.method), 'in', `Business customer paid — ${c.order_number}`, c.customer, c.amount, 'B2B')
    for (const p of parts.supplier.filter((x) => !x.voided)) push(p.date, accountOfMethod(p.method), 'out', 'Paid to supplier', p.vendor, p.amount, 'SUPPLIER')
    for (const e of parts.expenses) push(e.spent_on, accountOfMethod(e.paid_via), 'out', EXPENSE_CATEGORIES[e.category]?.label ?? e.category, e.party ?? e.note, e.amount, 'EXPENSE')
    for (const c of parts.cash) for (const f of flowOf(c)) push(c.entry_on, f.account, f.delta > 0 ? 'in' : 'out', CASH_KINDS[c.kind].label, c.note, Math.abs(f.delta), 'CASH_BOOK')
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.direction === b.direction ? 0 : a.direction === 'in' ? -1 : 1))
    const sum = (acct, dir) => money(rows.filter((r) => r.account === acct && r.direction === dir).reduce((t, r) => t + r.amount, 0))
    return { month: w.month, label: w.label, from: w.from, to: w.to, rows, totals: { CASH: { in: sum('CASH', 'in'), out: sum('CASH', 'out') }, BANK: { in: sum('BANK', 'in'), out: sum('BANK', 'out') } } }
  }
}
