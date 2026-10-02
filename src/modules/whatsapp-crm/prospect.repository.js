import { query } from '../../config/database.js'
import { waIdToIndianPhone } from './phone.js'

/** Prospect imports and their rows (Phase 8). */
export class ProspectRepository {
  async list(limit = 50) {
    const { rows } = await query(
      `SELECT i.id, i.name, i.filename, i.status, i.total_rows, i.consent_source, i.include_existing, i.created_at, i.confirmed_at,
              ${COUNTS_SQL}
         FROM wa_prospect_imports i ORDER BY i.created_at DESC LIMIT $1`,
      [limit],
    )
    return rows
  }

  async get(id) {
    const { rows } = await query(
      `SELECT i.id, i.name, i.filename, i.status, i.total_rows, i.consent_source, i.include_existing, i.created_at, i.confirmed_at,
              ${COUNTS_SQL}
         FROM wa_prospect_imports i WHERE i.id = $1`,
      [id],
    )
    return rows[0] ?? null
  }

  async listRows(importId, { status, limit = 100, offset = 0 }) {
    const { rows } = await query(
      `SELECT id, row_number, name, business_name, phone_raw, wa_id, status, selected
         FROM wa_prospect_rows WHERE import_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY row_number LIMIT $3 OFFSET $4`,
      [importId, status ?? null, limit, offset],
    )
    return rows
  }

  /** What we already know about these numbers: customer? existing contact? consent? suppressed? */
  async lookup(waIds) {
    const known = new Map()
    if (!waIds.length) return known
    const phones = waIds.map((w) => waIdToIndianPhone(w)).filter(Boolean)
    const [contacts, customers] = await Promise.all([
      query(
        `SELECT c.wa_id, c.marketing_consent AS consent, (s.contact_id IS NOT NULL) AS suppressed
           FROM wa_contacts c LEFT JOIN wa_suppression s ON s.contact_id = c.id WHERE c.wa_id = ANY($1::text[])`,
        [waIds],
      ),
      query(`SELECT phone FROM users WHERE role = 'CUSTOMER' AND phone = ANY($1::text[])`, [phones]),
    ])
    for (const w of waIds) known.set(w, {})
    for (const c of contacts.rows) known.set(c.wa_id, { hasContact: true, consent: c.consent, suppressed: c.suppressed })
    const customerPhones = new Set(customers.rows.map((r) => r.phone))
    for (const w of waIds) {
      const p = waIdToIndianPhone(w)
      if (p && customerPhones.has(p)) known.set(w, { ...known.get(w), isCustomer: true })
    }
    return known
  }

  async createImport({ name, filename, userId, rows }) {
    const { rows: [imp] } = await query(
      `INSERT INTO wa_prospect_imports (name, filename, total_rows, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, filename ?? null, rows.length, userId],
    )
    if (rows.length) {
      await query(
        `INSERT INTO wa_prospect_rows (import_id, row_number, name, business_name, phone_raw, wa_id, status)
         SELECT $1, x.n, x.name, x.biz, x.phone, x.wa, x.st
           FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS x(n, name, biz, phone, wa, st)`,
        [imp.id, rows.map((r) => r.rowNumber), rows.map((r) => r.name), rows.map((r) => r.business), rows.map((r) => r.phoneRaw), rows.map((r) => r.waId), rows.map((r) => r.finalStatus)],
      )
    }
    return imp.id
  }

  /**
   * Make the usable rows reachable: create/refresh the contact, record the consent attestation, link the row.
   * An existing opt-out is never overridden (the preview already excluded those rows; this guards a race).
   * Returns the number of contacts now opted in.
   */
  async confirm(importId, { source, includeExisting, userId }) {
    const statuses = includeExisting ? ['NEW', 'EXISTING_CONTACT', 'EXISTING_CUSTOMER'] : ['NEW', 'EXISTING_CONTACT']
    const claimed = await query(
      `UPDATE wa_prospect_imports SET status = 'CONFIRMED', consent_source = $2, include_existing = $3, confirmed_by = $4, confirmed_at = NOW()
        WHERE id = $1 AND status = 'PREVIEW' RETURNING id`,
      [importId, source, includeExisting, userId],
    )
    if (!claimed.rows[0]) return null
    await query(
      `WITH src AS (
         SELECT r.id AS row_id, r.wa_id, COALESCE(r.name, r.business_name) AS pname, u.id AS user_id
           FROM wa_prospect_rows r LEFT JOIN users u ON u.role = 'CUSTOMER' AND u.phone = substr(r.wa_id, 3)
          WHERE r.import_id = $1 AND r.status = ANY($2::text[])
       ), up AS (
         INSERT INTO wa_contacts (wa_id, phone, user_id, profile_name, source, marketing_consent, consent_updated_at, consent_source)
         SELECT DISTINCT ON (wa_id) wa_id, CASE WHEN wa_id ~ '^91[6-9][0-9]{9}$' THEN substr(wa_id, 3) END, user_id, pname, 'IMPORT', 'OPTED_IN', NOW(), $3
           FROM src
         ON CONFLICT (wa_id) DO UPDATE SET
           marketing_consent = CASE WHEN wa_contacts.marketing_consent = 'OPTED_OUT' THEN 'OPTED_OUT' ELSE 'OPTED_IN' END,
           consent_updated_at = CASE WHEN wa_contacts.marketing_consent = 'OPTED_OUT' THEN wa_contacts.consent_updated_at ELSE NOW() END,
           consent_source = CASE WHEN wa_contacts.marketing_consent = 'OPTED_OUT' THEN wa_contacts.consent_source ELSE EXCLUDED.consent_source END,
           profile_name = COALESCE(wa_contacts.profile_name, EXCLUDED.profile_name),
           user_id = COALESCE(wa_contacts.user_id, EXCLUDED.user_id), updated_at = NOW()
         RETURNING id, wa_id, marketing_consent
       )
       UPDATE wa_prospect_rows r SET contact_id = up.id, selected = (up.marketing_consent = 'OPTED_IN')
         FROM src JOIN up ON up.wa_id = src.wa_id WHERE r.id = src.row_id`,
      [importId, statuses, source],
    )
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM wa_prospect_rows WHERE import_id = $1 AND selected`, [importId])
    return rows[0].n
  }

  /** A preview that was never confirmed can be thrown away; its rows (personal data) go with it. */
  async discard(importId) {
    const { rowCount } = await query(`DELETE FROM wa_prospect_imports WHERE id = $1 AND status = 'PREVIEW'`, [importId])
    return rowCount > 0
  }
}

const COUNTS_SQL = `(SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb) FROM (
                       SELECT status, COUNT(*)::int AS n FROM wa_prospect_rows WHERE import_id = i.id GROUP BY status) c) AS counts`
