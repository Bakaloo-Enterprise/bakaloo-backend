import { query } from '../../config/database.js'

const CAMPAIGN_COLS = `c.id, c.name, c.template_id, c.template_values, c.header_media_url, c.header_image_source, c.audience, c.status, c.pause_reason,
  c.scheduled_at, c.started_at, c.completed_at, c.rate_per_minute, c.total_recipients, c.created_by, c.created_at, c.updated_at`

/** Campaigns, their recipients, audiences, consent and the do-not-contact list (Phase 7). */
export class CampaignRepository {
  // ─── Campaigns ─────────────────────────────────────────────────────
  async list({ status, limit = 50, offset = 0 } = {}) {
    const { rows } = await query(
      `SELECT ${CAMPAIGN_COLS}, t.name AS template_name, t.status AS template_status, t.meta_category AS template_category
         FROM wa_campaigns c JOIN wa_templates t ON t.id = c.template_id
        WHERE ($1::text IS NULL OR c.status = $1)
        ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`,
      [status ?? null, limit, offset],
    )
    return rows
  }

  async get(id) {
    const { rows } = await query(
      `SELECT ${CAMPAIGN_COLS}, t.name AS template_name, t.status AS template_status, t.meta_category AS template_category
         FROM wa_campaigns c JOIN wa_templates t ON t.id = c.template_id WHERE c.id = $1`,
      [id],
    )
    return rows[0] ?? null
  }

  async insert(v, userId) {
    const { rows } = await query(
      `INSERT INTO wa_campaigns (name, template_id, template_values, header_media_url, header_image_source, audience, rate_per_minute, created_by)
       VALUES ($1,$2,$3::jsonb,$4,$8::jsonb,$5::jsonb,COALESCE($6,60),$7) RETURNING id`,
      [v.name, v.templateId, JSON.stringify(v.templateValues ?? {}), v.headerMediaUrl ?? null, JSON.stringify(v.audience), v.ratePerMinute ?? null, userId, v.headerImageSource ? JSON.stringify(v.headerImageSource) : null],
    )
    return this.get(rows[0].id)
  }

  /** Only a DRAFT may be edited. Returns null when it is not a draft any more. */
  async updateDraft(id, v) {
    const { rows } = await query(
      `UPDATE wa_campaigns SET
         name = COALESCE($2, name), template_id = COALESCE($3, template_id),
         template_values = COALESCE($4::jsonb, template_values),
         header_media_url = CASE WHEN $5::boolean THEN $6 ELSE header_media_url END,
         header_image_source = CASE WHEN $9::boolean THEN $10::jsonb ELSE header_image_source END,
         audience = COALESCE($7::jsonb, audience), rate_per_minute = COALESCE($8, rate_per_minute), updated_at = NOW()
       WHERE id = $1 AND status = 'DRAFT' RETURNING id`,
      [id, v.name ?? null, v.templateId ?? null, v.templateValues ? JSON.stringify(v.templateValues) : null,
        v.headerMediaUrl !== undefined, v.headerMediaUrl ?? null, v.audience ? JSON.stringify(v.audience) : null, v.ratePerMinute ?? null,
        v.headerImageSource !== undefined, v.headerImageSource ? JSON.stringify(v.headerImageSource) : null],
    )
    return rows[0] ? this.get(id) : null
  }

  async deleteDraft(id) {
    const { rowCount } = await query(`DELETE FROM wa_campaigns WHERE id = $1 AND status = 'DRAFT'`, [id])
    return rowCount > 0
  }

  /** Atomic status change: only from one of `from`. Returns the row, or null if the state moved on. */
  async transition(id, from, to, extra = {}) {
    const { rows } = await query(
      `UPDATE wa_campaigns SET status = $3::text, pause_reason = $4,
              scheduled_at = COALESCE($5, scheduled_at),
              started_at = CASE WHEN $3::text = 'SENDING' THEN COALESCE(started_at, NOW()) ELSE started_at END,
              completed_at = CASE WHEN $3::text IN ('COMPLETED','CANCELLED') THEN NOW() ELSE completed_at END,
              total_recipients = COALESCE($6, total_recipients), updated_at = NOW()
        WHERE id = $1 AND status = ANY($2::text[]) RETURNING id`,
      [id, Array.isArray(from) ? from : [from], to, extra.pauseReason ?? null, extra.scheduledAt ?? null, extra.total ?? null],
    )
    return rows[0] ? this.get(id) : null
  }

  /** Scheduled campaigns that are due, flipped to SENDING (one worker wins). */
  async startDueScheduled() {
    const { rows } = await query(
      `UPDATE wa_campaigns SET status = 'SENDING', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
        WHERE status = 'SCHEDULED' AND scheduled_at <= NOW() RETURNING id`,
    )
    return rows.map((r) => r.id)
  }

  async listSending() {
    const { rows } = await query(`SELECT id FROM wa_campaigns WHERE status = 'SENDING' ORDER BY started_at`)
    return rows.map((r) => r.id)
  }

  // ─── Audience ──────────────────────────────────────────────────────
  /**
   * The contacts an audience resolves to, with the facts the consent rule needs.
   * Customers (segments) who have never messaged us get a contact created from their phone,
   * with consent UNKNOWN — they are then skipped, never silently messaged.
   */
  async resolveAudience(audience) {
    const { type, ids = [] } = audience
    let contactIds
    if (type === 'SEGMENT') {
      await query(
        `INSERT INTO wa_contacts (wa_id, phone, user_id, profile_name, source)
         SELECT '91' || u.phone, u.phone, u.id, u.name, 'APP'
           FROM customer_segment_members m JOIN users u ON u.id = m.user_id
          WHERE m.segment_id = ANY($1::uuid[]) AND u.role = 'CUSTOMER' AND u.is_active = true AND u.phone ~ '^[6-9][0-9]{9}$'
         ON CONFLICT (wa_id) DO UPDATE SET user_id = COALESCE(wa_contacts.user_id, EXCLUDED.user_id)`,
        [ids],
      )
      const { rows } = await query(
        `SELECT DISTINCT c.id FROM customer_segment_members m
           JOIN users u ON u.id = m.user_id JOIN wa_contacts c ON c.user_id = u.id OR c.phone = u.phone
          WHERE m.segment_id = ANY($1::uuid[]) AND u.role = 'CUSTOMER'`,
        [ids],
      )
      contactIds = rows.map((r) => r.id)
    } else if (type === 'LABEL') {
      const { rows } = await query(`SELECT DISTINCT contact_id AS id FROM wa_contact_labels WHERE label_id = ANY($1::uuid[])`, [ids])
      contactIds = rows.map((r) => r.id)
    } else if (type === 'IMPORT') {
      // Only confirmed prospect lists; only rows that were usable at confirmation.
      const { rows } = await query(
        `SELECT DISTINCT r.contact_id AS id FROM wa_prospect_rows r JOIN wa_prospect_imports i ON i.id = r.import_id
          WHERE i.id = ANY($1::uuid[]) AND i.status = 'CONFIRMED' AND r.selected AND r.contact_id IS NOT NULL`,
        [ids],
      )
      contactIds = rows.map((r) => r.id)
    } else if (type === 'STAGE') {
      const { rows } = await query(`SELECT id FROM wa_contacts WHERE stage_id = ANY($1::uuid[])`, [ids])
      contactIds = rows.map((r) => r.id)
    } else {
      const { rows } = await query(`SELECT id FROM wa_contacts WHERE marketing_consent = 'OPTED_IN'`)
      contactIds = rows.map((r) => r.id)
    }
    if (!contactIds.length) return []
    const { rows } = await query(
      `SELECT c.id, c.wa_id, c.bsuid, c.marketing_consent AS consent, c.last_inbound_at IS NOT NULL AS has_messaged_us,
              (s.contact_id IS NOT NULL) AS suppressed
         FROM wa_contacts c LEFT JOIN wa_suppression s ON s.contact_id = c.id
        WHERE c.id = ANY($1::uuid[])`,
      [contactIds],
    )
    return rows
  }

  /** Snapshot the audience: one row per contact; skipped ones carry the reason. */
  async replaceRecipients(campaignId, entries) {
    await query(`DELETE FROM wa_campaign_recipients WHERE campaign_id = $1`, [campaignId])
    if (!entries.length) return
    await query(
      `INSERT INTO wa_campaign_recipients (campaign_id, contact_id, status, skip_reason)
       SELECT $1, x.contact_id, x.status, x.reason
         FROM unnest($2::uuid[], $3::text[], $4::text[]) AS x(contact_id, status, reason)
       ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
      [campaignId, entries.map((e) => e.contactId), entries.map((e) => e.status), entries.map((e) => e.reason ?? null)],
    )
  }

  // ─── Sending ───────────────────────────────────────────────────────
  /** Claim up to `limit` pending recipients (several workers never take the same one). */
  async claimRecipients(campaignId, limit) {
    const { rows } = await query(
      `UPDATE wa_campaign_recipients SET status = 'SENDING', claimed_at = NOW(), attempts = attempts + 1
        WHERE id IN (SELECT id FROM wa_campaign_recipients WHERE campaign_id = $1 AND status = 'PENDING'
                      ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING id, contact_id, attempts, message_id`,
      [campaignId, limit],
    )
    return rows
  }

  async setRecipient(id, fields) {
    const { rows } = await query(
      `UPDATE wa_campaign_recipients SET status = $2::text, skip_reason = $3, error_code = $4, error_text = $5,
              message_id = COALESCE($6, message_id), sent_at = CASE WHEN $2::text = 'SENT' THEN NOW() ELSE sent_at END
        WHERE id = $1 RETURNING id`,
      [id, fields.status, fields.reason ?? null, fields.errorCode ?? null, fields.errorText ? String(fields.errorText).slice(0, 300) : null, fields.messageId ?? null],
    )
    return rows[0] ?? null
  }

  async requeueRecipient(id) {
    await query(`UPDATE wa_campaign_recipients SET status = 'PENDING', claimed_at = NULL WHERE id = $1 AND status = 'SENDING'`, [id])
  }

  /**
   * A worker died after claiming. If a message was already created we cannot know whether Meta got
   * it, so it is marked FAILED (UNKNOWN_OUTCOME) rather than risk a double send; otherwise it goes back in the queue.
   */
  async recoverStuckRecipients(olderThanMinutes = 5) {
    await query(
      `UPDATE wa_campaign_recipients SET status = 'FAILED', skip_reason = 'UNKNOWN_OUTCOME', error_text = 'Worker stopped while sending — not retried to avoid a duplicate'
        WHERE status = 'SENDING' AND message_id IS NOT NULL AND claimed_at < NOW() - ($1 || ' minutes')::interval`,
      [String(olderThanMinutes)],
    )
    const { rowCount } = await query(
      `UPDATE wa_campaign_recipients SET status = 'PENDING', claimed_at = NULL
        WHERE status = 'SENDING' AND message_id IS NULL AND claimed_at < NOW() - ($1 || ' minutes')::interval`,
      [String(olderThanMinutes)],
    )
    return rowCount
  }

  async skipPending(campaignId, reason) {
    await query(
      `UPDATE wa_campaign_recipients SET status = 'SKIPPED', skip_reason = $2 WHERE campaign_id = $1 AND status = 'PENDING'`,
      [campaignId, reason],
    )
  }

  async pendingCount(campaignId) {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM wa_campaign_recipients WHERE campaign_id = $1 AND status IN ('PENDING','SENDING')`, [campaignId])
    return rows[0].n
  }

  async getContactForSend(contactId) {
    const { rows } = await query(
      `SELECT c.id, c.wa_id, c.bsuid, c.phone, c.user_id, c.profile_name, c.marketing_consent AS consent,
              c.last_inbound_at IS NOT NULL AS has_messaged_us, (s.contact_id IS NOT NULL) AS suppressed,
              u.name AS customer_name
         FROM wa_contacts c LEFT JOIN wa_suppression s ON s.contact_id = c.id LEFT JOIN users u ON u.id = c.user_id
        WHERE c.id = $1`,
      [contactId],
    )
    return rows[0] ?? null
  }

  // ─── Results ───────────────────────────────────────────────────────
  /** Counts per recipient state plus delivery state read from the real messages. */
  async stats(campaignId) {
    const { rows } = await query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE r.status = 'PENDING' OR r.status = 'SENDING')::int AS waiting,
         COUNT(*) FILTER (WHERE r.status = 'SKIPPED')::int AS skipped,
         COUNT(*) FILTER (WHERE r.status = 'FAILED' OR m.status = 'FAILED')::int AS failed,
         COUNT(*) FILTER (WHERE r.status = 'SENT' AND m.status IN ('SENT','DELIVERED','READ'))::int AS sent,
         COUNT(*) FILTER (WHERE m.status IN ('DELIVERED','READ'))::int AS delivered,
         COUNT(*) FILTER (WHERE m.status = 'READ')::int AS read
       FROM wa_campaign_recipients r LEFT JOIN wa_messages m ON m.id = r.message_id
       WHERE r.campaign_id = $1`,
      [campaignId],
    )
    const { rows: skips } = await query(
      `SELECT skip_reason AS reason, COUNT(*)::int AS n FROM wa_campaign_recipients
        WHERE campaign_id = $1 AND skip_reason IS NOT NULL GROUP BY skip_reason ORDER BY n DESC`,
      [campaignId],
    )
    return { ...rows[0], skipReasons: skips }
  }

  async listRecipients(campaignId, { status, limit = 50, offset = 0 }) {
    const { rows } = await query(
      `SELECT r.id, r.contact_id, r.status, r.skip_reason, r.error_code, r.error_text, r.sent_at,
              c.profile_name, c.phone, m.status AS message_status,
              COALESCE(u.name, c.profile_name) AS name
         FROM wa_campaign_recipients r JOIN wa_contacts c ON c.id = r.contact_id
         LEFT JOIN users u ON u.id = c.user_id LEFT JOIN wa_messages m ON m.id = r.message_id
        WHERE r.campaign_id = $1 AND ($2::text IS NULL OR r.status = $2)
        ORDER BY r.created_at, r.id LIMIT $3 OFFSET $4`,
      [campaignId, status ?? null, limit, offset],
    )
    return rows
  }

  // ─── Consent & suppression ─────────────────────────────────────────
  /**
   * Record that these customers agreed to WhatsApp messages (e.g. a checkout checkbox).
   * Creates the contact from the phone when needed. Never overrides an OPTED_OUT.
   */
  async recordConsentForPhones(phones, source) {
    const { rows } = await query(
      `INSERT INTO wa_contacts (wa_id, phone, user_id, profile_name, source, marketing_consent, consent_updated_at, consent_source)
       SELECT '91' || p.phone, p.phone, u.id, u.name, 'IMPORT', 'OPTED_IN', NOW(), $2
         FROM (SELECT DISTINCT unnest($1::text[]) AS phone) p
         LEFT JOIN users u ON u.phone = p.phone AND u.role = 'CUSTOMER'
        WHERE p.phone ~ '^[6-9][0-9]{9}$'
       ON CONFLICT (wa_id) DO UPDATE SET
         user_id = COALESCE(wa_contacts.user_id, EXCLUDED.user_id),
         marketing_consent = CASE WHEN wa_contacts.marketing_consent = 'OPTED_OUT' THEN 'OPTED_OUT' ELSE 'OPTED_IN' END,
         consent_updated_at = CASE WHEN wa_contacts.marketing_consent = 'OPTED_OUT' THEN wa_contacts.consent_updated_at ELSE NOW() END,
         consent_source = CASE WHEN wa_contacts.marketing_consent = 'OPTED_OUT' THEN wa_contacts.consent_source ELSE EXCLUDED.consent_source END,
         updated_at = NOW()
       RETURNING marketing_consent`,
      [phones, source],
    )
    return rows.filter((r) => r.marketing_consent === 'OPTED_IN').length
  }

  async listSuppressed({ limit = 100, offset = 0 } = {}) {
    const { rows } = await query(
      `SELECT s.contact_id, s.reason, s.created_at, c.phone, COALESCE(u.name, c.profile_name) AS name
         FROM wa_suppression s JOIN wa_contacts c ON c.id = s.contact_id LEFT JOIN users u ON u.id = c.user_id
        ORDER BY s.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    )
    return rows
  }

  async suppress(contactId, reason, userId) {
    const { rowCount } = await query(
      `INSERT INTO wa_suppression (contact_id, reason, created_by) SELECT id, $2, $3 FROM wa_contacts WHERE id = $1
       ON CONFLICT (contact_id) DO UPDATE SET reason = EXCLUDED.reason`,
      [contactId, reason ?? null, userId],
    )
    return rowCount > 0
  }

  async unsuppress(contactId) {
    const { rowCount } = await query(`DELETE FROM wa_suppression WHERE contact_id = $1`, [contactId])
    return rowCount > 0
  }

  // ─── Picklists for the builder ─────────────────────────────────────
  async audienceOptions() {
    const [segments, stages, imports] = await Promise.all([
      query(`SELECT s.id, s.name, COUNT(m.id)::int AS members FROM customer_segments s LEFT JOIN customer_segment_members m ON m.segment_id = s.id WHERE s.is_active GROUP BY s.id ORDER BY s.name`),
      query(`SELECT id, name FROM crm_stages ORDER BY position`),
      query(`SELECT i.id, i.name, COUNT(r.id) FILTER (WHERE r.selected)::int AS members
               FROM wa_prospect_imports i LEFT JOIN wa_prospect_rows r ON r.import_id = i.id
              WHERE i.status = 'CONFIRMED' GROUP BY i.id ORDER BY i.confirmed_at DESC LIMIT 100`),
    ])
    return { segments: segments.rows, stages: stages.rows, imports: imports.rows }
  }
}
