import { CrmError } from './errors.js'
import { buildRows, classifyKnown, isUsable, MAX_PROSPECT_ROWS, readSheet } from './prospect-import.js'

/**
 * Prospect outreach, step one: get a sheet of numbers into the CRM safely.
 *
 *   upload → validate + match (preview, nothing is created) → confirm with a consent attestation
 *
 * Confirming does NOT send anything. The prospects are then reached with an ordinary campaign
 * (audience "Prospect list"), so approved-template, opt-out, suppression, quiet-hours and pacing
 * rules all still apply, and consent is re-checked on every message.
 */
export class ProspectService {
  /** @param {{ repo: import('./prospect.repository.js').ProspectRepository, logger: { info: Function } }} deps */
  constructor({ repo, logger }) {
    Object.assign(this, { repo, logger })
  }

  list() {
    return this.repo.list()
  }

  async get(id) {
    const imp = await this.repo.get(id)
    if (!imp) throw new CrmError('Import not found', 404, 'IMPORT_NOT_FOUND')
    return imp
  }

  async rows(id, q) {
    await this.get(id)
    return this.repo.listRows(id, q)
  }

  async preview({ buffer, filename, name, userId }) {
    const label = String(name ?? '').trim() || String(filename ?? '').replace(/\.[^.]+$/, '').slice(0, 120) || 'Prospect list'
    let records
    try {
      records = await readSheet(buffer, filename)
    } catch (err) {
      throw new CrmError(`Could not read that file: ${err.message}`, 400, 'BAD_FILE')
    }
    if (!records.length) throw new CrmError('That file has no rows.', 400, 'EMPTY_FILE')
    if (records.length > MAX_PROSPECT_ROWS) throw new CrmError(`Too many rows (${records.length}). Upload at most ${MAX_PROSPECT_ROWS} at a time.`, 400, 'TOO_MANY_ROWS')

    const { rows, columns } = buildRows(records)
    if (!columns.phone) {
      throw new CrmError(`No phone column found. Name a column “Phone” or “Mobile”. Columns in your file: ${columns.headers.join(', ') || 'none'}.`, 400, 'NO_PHONE_COLUMN')
    }
    const known = await this.repo.lookup([...new Set(rows.filter((r) => r.status === 'PENDING').map((r) => r.waId))])
    const finalRows = rows.map((r) => ({ ...r, finalStatus: classifyKnown(r, known.get(r.waId) ?? {}) }))

    const id = await this.repo.createImport({ name: label.slice(0, 120), filename: filename?.slice(0, 200), userId, rows: finalRows })
    this.logger.info({ importId: id, rows: finalRows.length }, 'Prospect import previewed')
    return { ...(await this.get(id)), columns: { phone: columns.phone, name: columns.name, business: columns.business } }
  }

  /**
   * @param {{ confirm: boolean, source: string, includeExisting?: boolean }} input
   * The attestation is the uploader's responsibility; it is recorded with the contacts so it can be audited.
   */
  async confirm(id, { confirm, source, includeExisting = false }, userId) {
    if (confirm !== true) throw new CrmError('Please confirm that these people agreed to be contacted on WhatsApp by Bakaloo.', 400, 'CONFIRM_REQUIRED')
    const src = String(source ?? '').trim()
    if (src.length < 3 || src.length > 30) throw new CrmError('Say how they agreed (3–30 characters), e.g. “trade show form”.', 400, 'VALIDATION', { source: 'Required' })
    const imp = await this.get(id)
    if (imp.status !== 'PREVIEW') throw new CrmError('This list has already been confirmed.', 409, 'ALREADY_CONFIRMED')

    const usable = Object.entries(imp.counts).reduce((n, [st, c]) => n + (isUsable(st, includeExisting) ? c : 0), 0)
    if (usable === 0) throw new CrmError('There is nobody to add — every row was invalid, repeated, opted out or already a customer.', 409, 'NOTHING_TO_ADD')

    const optedIn = await this.repo.confirm(id, { source: `PROSPECT_${src.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`.slice(0, 40), includeExisting, userId })
    if (optedIn == null) throw new CrmError('This list has already been confirmed.', 409, 'ALREADY_CONFIRMED')
    return { ...(await this.get(id)), reachable: optedIn }
  }

  async discard(id) {
    if (!(await this.repo.discard(id))) throw new CrmError('Only a list that has not been confirmed can be discarded.', 409, 'NOT_DISCARDABLE')
  }
}
