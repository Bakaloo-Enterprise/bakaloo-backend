import { CrmError } from './errors.js'
import { collapseDeleted, fillDays, istDate, money, parseRange, pct, RATE_CATEGORIES, validateRateCard, withRates } from './analytics.js'

const ZERO_DAY = { sent: 0, delivered: 0, read: 0, replied: 0, cost: 0, orders: 0, revenue: 0 }
const SOURCES = ['CAMPAIGN', 'WORKFLOW', 'MANUAL']
const DELETED_LABEL = { campaign: 'Deleted campaigns', workflow: 'Deleted automatic messages', template: 'Deleted templates' }

/**
 * Analytics and cost reports (Phase 10). Everything is computed on demand from the CRM's own records.
 */
export class AnalyticsService {
  /** @param {{ repo: import('./analytics.repository.js').AnalyticsRepository, now?: () => Date }} deps */
  constructor({ repo, now = () => new Date() }) {
    Object.assign(this, { repo, now })
  }

  async overview(q = {}) {
    const r = parseRange(q, this.now())
    const [o, daily, cards] = await Promise.all([this.repo.overview(r.start, r.end, r.attributionDays), this.repo.daily(r.start, r.end, r.attributionDays), this.repo.listRateCards()])

    const src = Object.fromEntries(SOURCES.map((s) => [s, { sent: 0, delivered: 0, read: 0, failed: 0, replied: 0 }]))
    for (const row of o.bySource) src[row.source] = row
    const total = SOURCES.reduce((a, s) => ({ sent: a.sent + src[s].sent, delivered: a.delivered + src[s].delivered, read: a.read + src[s].read, failed: a.failed + src[s].failed, replied: a.replied + src[s].replied }), { sent: 0, delivered: 0, read: 0, failed: 0, replied: 0 })

    const credited = Object.fromEntries(o.orders.map((x) => [x.source, x]))
    const orders = (credited.CAMPAIGN?.orders ?? 0) + (credited.WORKFLOW?.orders ?? 0)
    const revenue = (credited.CAMPAIGN?.revenue ?? 0) + (credited.WORKFLOW?.revenue ?? 0)

    const cost = o.cost.reduce((a, c) => ({ total: a.total + c.cost, estimated: a.estimated + c.estimated_cost, messages: a.messages + c.messages, unpriced: a.unpriced + c.unpriced, estimatedMessages: a.estimatedMessages + c.estimated_messages }), { total: 0, estimated: 0, messages: 0, unpriced: 0, estimatedMessages: 0 })

    return {
      range: { from: r.from, to: r.to, days: r.days, attributionDays: r.attributionDays },
      totals: withRates({ ...total, orders, revenue: money(revenue), cost: money(cost.total) }),
      bySource: SOURCES.map((s) => withRates({ source: s, ...src[s], orders: credited[s]?.orders ?? 0, revenue: money(credited[s]?.revenue ?? 0) })),
      newContacts: o.newContacts,
      optedOut: o.optOuts,
      optOutRate: pct(o.optOuts, total.delivered),
      failures: o.failures.map((f) => ({ code: f.error_code, title: f.title, count: f.n })),
      cost: {
        total: money(cost.total),
        // part of the total that rests on the template's category rather than Meta's own billing record
        estimated: money(cost.estimated),
        billedMessages: cost.messages,
        estimatedMessages: cost.estimatedMessages,
        unpricedMessages: cost.unpriced,
        hasRates: cards.length > 0,
        byCategory: o.cost.map((c) => ({ category: c.category, messages: c.messages, unpriced: c.unpriced, cost: money(c.cost) })),
      },
      daily: fillDays(daily, r.start, r.days, ZERO_DAY).map((d) => ({ ...d, cost: money(d.cost), revenue: money(d.revenue) })),
    }
  }

  async breakdown(by, q = {}) {
    if (!['campaign', 'workflow', 'template'].includes(by)) throw new CrmError('Unknown report.', 400, 'VALIDATION')
    const r = parseRange(q, this.now())
    const rows = await this.repo.breakdown(by, r.start, r.end, r.attributionDays)
    const zero = { sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, cost: 0, unpriced: 0, orders: 0, revenue: 0 }
    return {
      range: { from: r.from, to: r.to, days: r.days, attributionDays: r.attributionDays },
      rows: collapseDeleted(rows, DELETED_LABEL[by])
        .map((x) => withRates({ ...zero, ...x, cost: money(x.cost ?? 0), revenue: money(x.revenue ?? 0) }))
        .sort((a, b) => b.sent - a.sent || b.revenue - a.revenue),
    }
  }

  async inbox(q = {}) {
    const r = parseRange(q, this.now())
    const d = await this.repo.inbox(r.start, r.end)
    const resp = d.responses
    const round = (n) => (n == null ? null : Math.round(n * 10) / 10)
    return {
      range: { from: r.from, to: r.to, days: r.days },
      volume: d.volume,
      responses: { ...resp, median_minutes: round(resp.median_minutes), p90_minutes: round(resp.p90_minutes), within_15_rate: pct(resp.within_15, resp.answered_by_people) },
      agents: d.agents.map((a) => ({ ...a, median_minutes: round(a.median_minutes) })),
      bot: d.bot,
    }
  }

  // ─── Rate cards ──────────────────────────────────────────────────
  async rateCards() {
    const cards = await this.repo.listRateCards()
    // "today" is the India calendar day — the same day the cost report and the removal rule use
    const today = istDate(this.now())
    const current = {}
    for (const c of cards) {
      if (c.effective_from <= today && !current[c.category]) current[c.category] = c.id // list is newest-first per category
    }
    return { categories: RATE_CATEGORIES, cards: cards.map((c) => ({ ...c, current: current[c.category] === c.id, future: c.effective_from > today })) }
  }

  async addRateCard(input, userId) {
    const v = validateRateCard(input, this.now())
    const id = await this.repo.addRateCard(v, userId)
    if (!id) throw new CrmError('That category already has a price from this date. Pick a later date to change it.', 409, 'RATE_EXISTS', { effectiveFrom: 'Already has a price' })
    return this.rateCards()
  }

  async removeRateCard(id) {
    if (await this.repo.removeFutureRateCard(id)) return this.rateCards()
    if (!(await this.repo.rateCardExists(id))) throw new CrmError('Price not found.', 404, 'RATE_NOT_FOUND')
    throw new CrmError('A price that is already in effect cannot be removed — add a newer one instead. This keeps past reports unchanged.', 409, 'RATE_IN_EFFECT')
  }
}
