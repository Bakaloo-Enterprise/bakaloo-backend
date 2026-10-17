import { BusinessError } from '../../utils/business-error.js'
import { emitInTx } from '../../utils/audit-log.js'
import { withTransaction } from './procurement.repository.js'
import { monthBefore, monthOf, monthWindow } from './monthly.rules.js'

/** Problems that make a month's numbers untrustworthy. Everything else is shown to the person closing, but does not block. */
export const BLOCKING = Object.freeze(['LEDGER_MISMATCH', 'STOCK_LEDGER_MISMATCH', 'TRANSFER_MISMATCH', 'ROLL_FORWARD'])

/**
 * Closing a month = a person confirms the numbers. From then on that month's report and Excel are frozen, records dated in
 * it can no longer be added or undone, and its closing stock becomes the next month's opening stock.
 */
export class PeriodsService {
  constructor({ repo, monthly, now = () => new Date() }) {
    Object.assign(this, { repo, monthly, now })
  }

  /** Refuse to change something dated inside a closed month. */
  async assertOpen(ymd, what = 'This') {
    if (!ymd) return
    const month = monthOf(ymd)
    if (await this.repo.isClosed(month)) throw new BusinessError(`${what} falls in ${month}, which is closed. Use a date in an open month, or ask for ${month} to be reopened.`, 409, 'PERIOD_CLOSED', { month })
  }

  /** Where a month stands and what stops it being closed. `report` is the live report (pass it to avoid building twice). */
  async status(month, report = null) {
    const w = monthWindow(month, this.now())
    const closed = await this.repo.get(month)
    const months = await this.repo.closedMonths()
    const latest = months.length ? months[months.length - 1] : null
    if (closed) {
      return { state: 'CLOSED', month, closedAt: closed.closed_at, closedBy: closed.closed_by_name, note: closed.note, canClose: false, canReopen: month === latest, reasons: month === latest ? [] : [`${latest} is closed after it — reopen ${latest} first.`], blockers: [] }
    }
    const reasons = []
    if (w.inProgress) reasons.push('This month is not finished yet.')
    if (months.some((m) => m > month)) reasons.push(`${months[months.length - 1]} is already closed. Months are closed in order.`)
    const prev = monthBefore(month)
    if (months.some((m) => m < month) && !months.includes(prev)) reasons.push(`Close ${prev} first. Months are closed in order.`)
    let blockers = []
    if (!w.inProgress && reasons.length === 0) {
      const live = report ?? (await this.monthly.buildLive(month))
      blockers = live.exceptions.filter((e) => BLOCKING.includes(e.code)).map((e) => e.text)
    }
    return { state: w.inProgress ? 'RUNNING' : 'OPEN', month, canClose: reasons.length === 0 && blockers.length === 0, canReopen: false, reasons, blockers }
  }

  async close(month, { note }, actor) {
    const report = await this.monthly.buildLive(month)
    const st = await this.status(month, report)
    if (st.state === 'CLOSED') throw new BusinessError(`${month} is already closed.`, 409, 'ALREADY_CLOSED')
    if (st.reasons.length) throw new BusinessError(st.reasons[0], 409, 'CANNOT_CLOSE', { reasons: st.reasons })
    if (st.blockers.length) throw new BusinessError(`${st.blockers[0]} Fix this before closing the month.`, 409, 'CLOSE_BLOCKED', { blockers: st.blockers })
    const stockRows = report.valuation.closingSnapshot
    const snapshot = { ...report, valuation: { ...report.valuation, closingSnapshot: undefined } }
    await withTransaction(async (client) => {
      await this.repo.lock(client, month)
      if (await this.repo.isClosed(month)) throw new BusinessError(`${month} is already closed.`, 409, 'ALREADY_CLOSED')
      await this.repo.insert(client, { month, actorId: actor.userId, note: note?.trim() || null, snapshot, stockRows })
      await this.repo.log(client, { month, action: 'CLOSED', actorId: actor.userId, note: note?.trim() || null, totals: report.summary })
      await emitInTx(client, 'procurement.period.close', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'accounting_period', target_id: null, after: { month, note, exceptions: report.exceptions.map((e) => e.code) } })
    })
    return this.status(month)
  }

  async reopen(month, { reason }, actor) {
    const why = String(reason ?? '').trim()
    if (!why) throw new BusinessError('Say why this month is being reopened.', 400, 'VALIDATION', { reason: 'Required' })
    await withTransaction(async (client) => {
      await this.repo.lock(client, month)
      const months = await this.repo.closedMonths()
      if (!months.includes(month)) throw new BusinessError(`${month} is not closed.`, 409, 'NOT_CLOSED')
      if (months[months.length - 1] !== month) throw new BusinessError(`${months[months.length - 1]} is closed after it. Reopen the latest month first.`, 409, 'NOT_LATEST')
      await this.repo.remove(client, month)
      await this.repo.log(client, { month, action: 'REOPENED', actorId: actor.userId, note: why })
      await emitInTx(client, 'procurement.period.reopen', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'accounting_period', target_id: null, after: { month, reason: why } })
    })
    return this.status(month)
  }

  history() { return this.repo.history() }
}
