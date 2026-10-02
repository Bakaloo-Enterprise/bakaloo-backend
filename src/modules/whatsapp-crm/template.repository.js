import { query, getClient } from '../../config/database.js'

const COLUMNS = `id, name, language, meta_category, purpose, parameter_format, status, components, body_text, header_format, variables,
  allow_category_change, meta_template_id, rejection_reason, rejection_detail, quality_score, pending_category, pending_category_at,
  flagged, locked, submitted_at, last_status_at, last_synced_at, created_at, updated_at`

/** Columns a generic patch may touch (never id / created_*). */
const PATCHABLE = new Set([
  'name', 'language', 'meta_category', 'purpose', 'parameter_format', 'status', 'components', 'body_text', 'header_format', 'variables',
  'allow_category_change', 'meta_template_id', 'rejection_reason', 'rejection_detail', 'quality_score', 'pending_category',
  'pending_category_at', 'flagged', 'locked', 'submitted_at', 'last_status_at', 'last_synced_at',
])
const JSONB = new Set(['components', 'variables'])

export class TemplateRepository {
  async list({ status, metaCategory, purpose, search, includeDeleted = false } = {}) {
    const where = []
    const params = []
    const push = (v) => {
      params.push(v)
      return `$${params.length}`
    }
    if (status) where.push(`status = ${push(status)}`)
    else if (!includeDeleted) where.push(`status <> 'DELETED'`)
    if (metaCategory) where.push(`meta_category = ${push(metaCategory)}`)
    if (purpose) where.push(`purpose = ${push(purpose)}`)
    if (search) {
      const p = push(`%${search}%`)
      where.push(`(name ILIKE ${p} OR body_text ILIKE ${p})`)
    }
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM wa_templates ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 500`,
      params,
    )
    return rows
  }

  async get(id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM wa_templates WHERE id = $1`, [id])
    return rows[0] ?? null
  }

  async findByIdent({ metaId, name, language }) {
    if (metaId) {
      const { rows } = await query(`SELECT ${COLUMNS} FROM wa_templates WHERE meta_template_id = $1`, [metaId])
      if (rows[0]) return rows[0]
    }
    if (name && language) {
      const { rows } = await query(`SELECT ${COLUMNS} FROM wa_templates WHERE name = $1 AND language = $2 AND status <> 'DELETED'`, [name, language])
      return rows[0] ?? null
    }
    return null
  }

  async insert(v, userId = null) {
    const { rows } = await query(
      `INSERT INTO wa_templates (name, language, meta_category, purpose, parameter_format, status, components, body_text, header_format, variables, allow_category_change, created_by)
       VALUES ($1,$2,$3,$4,$5,'DRAFT',$6::jsonb,$7,$8,$9::jsonb,$10,$11) RETURNING ${COLUMNS}`,
      [v.name, v.language, v.metaCategory, v.purpose, v.parameterFormat, JSON.stringify(v.components), v.bodyText, v.headerFormat, JSON.stringify(v.variables), v.allowCategoryChange, userId],
    )
    return rows[0]
  }

  /** A template that exists at Meta but not here (created in WhatsApp Manager) — adopted as-is. */
  async insertSynced(v) {
    const { rows } = await query(
      `INSERT INTO wa_templates (name, language, meta_category, purpose, parameter_format, status, components, body_text, header_format, variables,
                                 allow_category_change, meta_template_id, rejection_reason, quality_score, pending_category, submitted_at, last_status_at, last_synced_at)
       VALUES ($1,$2,$3,'custom',$4,$5,$6::jsonb,$7,$8,$9::jsonb,TRUE,$10,$11,$12,$13,NOW(),$14,$14) RETURNING ${COLUMNS}`,
      [v.name, v.language, v.meta_category, v.parameter_format, v.status, JSON.stringify(v.components), v.body_text, v.header_format, JSON.stringify(v.variables), v.meta_template_id, v.rejection_reason, v.quality_score, v.pending_category, v.last_status_at],
    )
    return rows[0]
  }

  /** Atomically move DRAFT -> PENDING so a double-click can never submit the same template twice. */
  async claimForSubmit(id) {
    const { rows } = await query(`UPDATE wa_templates SET status = 'PENDING', submitted_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'DRAFT' RETURNING ${COLUMNS}`, [id])
    return rows[0] ?? null
  }

  async revertToDraft(id) {
    await query(`UPDATE wa_templates SET status = 'DRAFT', submitted_at = NULL, updated_at = NOW() WHERE id = $1 AND status = 'PENDING' AND meta_template_id IS NULL`, [id])
  }

  /** Whitelisted partial update. */
  async patch(id, fields) {
    const keys = Object.keys(fields).filter((k) => PATCHABLE.has(k))
    if (!keys.length) return this.get(id)
    const sets = keys.map((k, i) => `${k} = $${i + 2}${JSONB.has(k) ? '::jsonb' : ''}`)
    const vals = keys.map((k) => (JSONB.has(k) ? JSON.stringify(fields[k]) : fields[k]))
    const { rows } = await query(`UPDATE wa_templates SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING ${COLUMNS}`, [id, ...vals])
    return rows[0] ?? null
  }

  /**
   * Apply a webhook status change only if it is not OLDER than what we already know
   * (Meta webhooks and syncs can arrive out of order). Returns the row, or null if stale.
   */
  async patchStatusIfNewer(id, fields, eventTime) {
    const keys = Object.keys(fields).filter((k) => PATCHABLE.has(k))
    const sets = keys.map((k, i) => `${k} = $${i + 3}`)
    const { rows } = await query(
      `UPDATE wa_templates SET ${sets.length ? sets.join(', ') + ',' : ''} last_status_at = GREATEST(COALESCE(last_status_at, $2), $2), updated_at = NOW()
        WHERE id = $1 AND (last_status_at IS NULL OR last_status_at <= $2) RETURNING ${COLUMNS}`,
      [id, eventTime, ...keys.map((k) => fields[k])],
    )
    return rows[0] ?? null
  }

  async deleteRow(id) {
    const { rowCount } = await query(`DELETE FROM wa_templates WHERE id = $1 AND status = 'DRAFT'`, [id])
    return rowCount > 0
  }

  async addEvent(templateId, event, detail, source) {
    await query(`INSERT INTO wa_template_events (template_id, event, detail, source) VALUES ($1,$2,$3,$4)`, [templateId, event, detail ? String(detail).slice(0, 400) : null, source])
  }

  async events(templateId, limit = 30) {
    const { rows } = await query(`SELECT id, event, detail, source, created_at FROM wa_template_events WHERE template_id = $1 ORDER BY created_at DESC LIMIT $2`, [templateId, limit])
    return rows
  }

  async counts() {
    const { rows } = await query(`SELECT status, COUNT(*)::int AS n FROM wa_templates WHERE status <> 'DELETED' GROUP BY status`)
    return Object.fromEntries(rows.map((r) => [r.status, r.n]))
  }

  async lastSyncedAt() {
    const { rows } = await query(`SELECT MAX(last_synced_at) AS t FROM wa_templates`)
    return rows[0]?.t ?? null
  }

  /** Rows with a Meta id that are still live locally — what a sync compares against. */
  async liveMetaRows() {
    const { rows } = await query(`SELECT id, meta_template_id, name, language, status FROM wa_templates WHERE meta_template_id IS NOT NULL AND status NOT IN ('DRAFT','DELETED')`)
    return rows
  }

  /** Single-flight guard for sync: a Postgres advisory lock held for the duration of fn. */
  async withSyncLock(fn) {
    const client = await getClient()
    try {
      const { rows } = await client.query(`SELECT pg_try_advisory_lock(7770145) AS ok`)
      if (!rows[0].ok) return { locked: false }
      try {
        return { locked: true, result: await fn() }
      } finally {
        await client.query(`SELECT pg_advisory_unlock(7770145)`)
      }
    } finally {
      client.release()
    }
  }

  // ─── Facts used to pre-fill variables when sending ─────────────────
  async lastOrder(customerId) {
    if (!customerId) return null
    const { rows } = await query(`SELECT order_number, status FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [customerId])
    return rows[0] ?? null
  }

  async openCartValue(customerId) {
    if (!customerId) return null
    const { rows } = await query(`SELECT cart_value::float AS v FROM abandoned_carts WHERE user_id = $1 AND status = 'OPEN' ORDER BY abandoned_at DESC LIMIT 1`, [customerId])
    return rows[0]?.v ?? null
  }

  async setConsent(contactId, consent) {
    await query(`UPDATE wa_contacts SET marketing_consent = $2, consent_updated_at = NOW(), updated_at = NOW() WHERE id = $1`, [contactId, consent])
  }
}
