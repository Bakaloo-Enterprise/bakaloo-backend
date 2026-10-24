import { BusinessError } from '../../utils/business-error.js'
import { istDate, istDayStart, parsePeriod } from '../../utils/business-period.js'
import { KINDS } from './explorer.repository.js'
import { likePattern, maskPhone, toCsv } from './explorer.rules.js'

export const EXPORT_LIMIT = 20000

/** Look at the raw records behind every screen, filtered and downloadable. */
export class ExplorerService {
  constructor({ repo, now = () => new Date() }) {
    Object.assign(this, { repo, now })
  }

  #args(q) {
    const p = parsePeriod({ period: q.period ?? '7d', from: q.from, to: q.to }, this.now())
    return { p, args: [p.start, p.end, q.shopId ?? null, likePattern(q.q)] }
  }
  #kind(kind) {
    if (!KINDS[kind]) throw new BusinessError('Unknown record type.', 404, 'NOT_FOUND')
    return KINDS[kind]
  }
  #shape(k, rows) {
    return rows.map((r) => ({ ...r, ...(k.columns.some(([key]) => key === 'phone') ? { phone: maskPhone(r.phone) } : {}) }))
  }

  kinds() { return Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label })) }

  async list(kind, q = {}) {
    const k = this.#kind(kind)
    const { p, args } = this.#args(q)
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200)
    const offset = Math.max(Number(q.offset) || 0, 0)
    const { rows, total } = await this.repo.page(kind, args, { limit, offset })
    return { kind, label: k.label, from: p.from, to: p.to, total, limit, offset, columns: k.columns.map(([key, label, type]) => ({ key, label, type })), rows: this.#shape(k, rows) }
  }

  async exportCsv(kind, q = {}) {
    const k = this.#kind(kind)
    const { p, args } = this.#args(q)
    const { rows, total } = await this.repo.page(kind, args, { limit: EXPORT_LIMIT, offset: 0 })
    const columns = k.columns.map(([key, label]) => ({ key, label }))
    return { filename: `${kind}-${p.from}_to_${p.to}.csv`, csv: toCsv(columns, this.#shape(k, rows)), truncated: total > EXPORT_LIMIT, total }
  }
}
