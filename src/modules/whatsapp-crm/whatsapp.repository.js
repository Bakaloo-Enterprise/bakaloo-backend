import { query, getClient } from '../../config/database.js'
import { toWaId } from './phone.js'


/** Shared by the list and detail reads: conversation + contact + matched customer + owner + labels. */
const CONVERSATION_SELECT = `
  SELECT c.id, c.status, c.assigned_to, c.assigned_at, c.unread_count, c.last_message_at, c.last_message_preview,
         c.last_message_direction, c.last_inbound_at,
         (c.last_inbound_at IS NOT NULL AND c.last_inbound_at > NOW() - INTERVAL '24 hours') AS window_open,
         ct.id AS contact_id, ct.wa_id, ct.phone, ct.bsuid, ct.wa_username, ct.profile_name, ct.source, ct.referral,
         ct.marketing_consent,
         COALESCE(ct.user_id, u.id) AS customer_id, u.name AS customer_name,
         a.name AS assigned_name, c.bot_state, c.bot_paused_until, c.bot_handoff_reason,
         COALESCE((SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color) ORDER BY lower(l.name))
                     FROM wa_contact_labels cl JOIN wa_labels l ON l.id = cl.label_id WHERE cl.contact_id = ct.id), '[]'::json) AS labels
    FROM wa_conversations c
    JOIN wa_contacts ct ON ct.id = c.contact_id
    LEFT JOIN users u ON u.id = ct.user_id OR (ct.user_id IS NULL AND ct.phone IS NOT NULL AND u.phone = ct.phone AND u.role = 'CUSTOMER')
    LEFT JOIN users a ON a.id = c.assigned_to`

/**
 * SQL for the WhatsApp CRM (tables from migration 141).
 * Every write that must be atomic takes/uses a client inside a transaction.
 */
export class WhatsappRepository {
  // ─── Webhook event log ────────────────────────────────────────────

  /**
   * Store a raw webhook body. A retry of the same body (same hash) does not
   * create a second row; the existing one is returned so the caller can decide
   * whether it still needs processing.
   *
   * @returns {Promise<{ id: string, inserted: boolean, processedAt: Date | null }>}
   */
  async recordWebhookEvent(payloadHash, payload) {
    const { rows } = await query(
      `INSERT INTO wa_webhook_events (payload_hash, payload)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (payload_hash) DO UPDATE SET payload_hash = EXCLUDED.payload_hash
       RETURNING id, processed_at, (xmax = 0) AS inserted`,
      [payloadHash, JSON.stringify(payload)],
    )
    const r = rows[0]
    return { id: r.id, inserted: r.inserted, processedAt: r.processed_at }
  }

  async getWebhookEvent(id) {
    const { rows } = await query(`SELECT id, payload, received_at, processed_at FROM wa_webhook_events WHERE id = $1`, [id])
    return rows[0] ?? null
  }

  async markEventProcessed(id) {
    await query(`UPDATE wa_webhook_events SET processed_at = NOW(), last_error = NULL WHERE id = $1`, [id])
  }

  async markEventFailed(id, message) {
    await query(`UPDATE wa_webhook_events SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [id, String(message).slice(0, 1000)])
  }

  /** Events whose job was lost (crash between DB insert and enqueue) — re-enqueued by the sweeper. */
  async listStaleUnprocessedEvents({ olderThanSeconds = 120, maxAttempts = 10, limit = 100 } = {}) {
    const { rows } = await query(
      `SELECT id, attempts FROM wa_webhook_events
        WHERE processed_at IS NULL AND attempts < $2
          AND received_at < NOW() - ($1 || ' seconds')::interval
        ORDER BY received_at LIMIT $3`,
      [String(olderThanSeconds), maxAttempts, limit],
    )
    return rows
  }

  // ─── Customer matching ────────────────────────────────────────────

  /** Exact 10-digit match against Bakaloo customers (never a partial match). */
  async findCustomerIdByPhone(phone) {
    if (!phone) return null
    const { rows } = await query(`SELECT id FROM users WHERE phone = $1 AND role = 'CUSTOMER' LIMIT 1`, [phone])
    return rows[0]?.id ?? null
  }

  // ─── Contacts / conversations / inbound messages ──────────────────

  /**
   * Find-or-create the WhatsApp contact for an inbound sender, backfilling
   * whichever identity (phone / BSUID) we did not know before, and link it to
   * the Bakaloo customer when the phone matches.
   *
   * @param {object} c
   * @param {string|null} c.waId
   * @param {string|null} c.bsuid
   * @param {string|null} c.parentBsuid
   * @param {string|null} c.username
   * @param {string|null} c.profileName
   * @param {string|null} c.phone         normalised 10-digit, or null
   * @param {string|null} c.userId        matched Bakaloo customer id, or null
   * @param {object|null} c.referral      Click-to-WhatsApp ad info
   * @param {Date}        c.at
   * @param {import('pg').PoolClient} client
   * @returns {Promise<{ contact: object, created: boolean }>}
   */
  async upsertContact(c, client) {
    const found = await client.query(
      `SELECT * FROM wa_contacts
        WHERE ($1::text IS NOT NULL AND wa_id = $1) OR ($2::text IS NOT NULL AND bsuid = $2)
        ORDER BY (wa_id IS NOT NULL) DESC
        LIMIT 2
        FOR UPDATE`,
      [c.waId, c.bsuid],
    )

    if (found.rows.length === 0) {
      const { rows } = await client.query(
        `INSERT INTO wa_contacts
           (wa_id, bsuid, parent_bsuid, wa_username, phone, user_id, profile_name, source, referral, first_seen_at, last_inbound_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10)
         RETURNING *`,
        [
          c.waId,
          c.bsuid,
          c.parentBsuid,
          c.username,
          c.phone,
          c.userId,
          c.profileName,
          c.referral ? 'META_AD' : 'ORGANIC',
          c.referral ? JSON.stringify(c.referral) : null,
          c.at,
        ],
      )
      return { contact: rows[0], created: true }
    }

    // Two different rows matched (one by phone, one by BSUID) — a merge we do not
    // attempt automatically. Keep the phone-keyed row and do NOT write the BSUID
    // onto it (it would violate the unique index); the caller logs this.
    const existing = found.rows[0]
    const ambiguous = found.rows.length > 1
    const { rows } = await client.query(
      `UPDATE wa_contacts SET
         wa_id        = COALESCE(wa_id, $2),
         bsuid        = COALESCE(bsuid, $3),
         parent_bsuid = COALESCE($4, parent_bsuid),
         wa_username  = COALESCE($5, wa_username),
         phone        = COALESCE(phone, $6),
         user_id      = COALESCE(user_id, $7),
         profile_name = COALESCE($8, profile_name),
         -- ad attribution is captured once, from the conversation's first referral
         referral     = COALESCE(referral, $9::jsonb),
         source       = CASE WHEN referral IS NULL AND $9::jsonb IS NOT NULL THEN 'META_AD' ELSE source END,
         last_inbound_at = GREATEST(COALESCE(last_inbound_at, $10), $10),
         updated_at   = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        existing.id,
        c.waId,
        ambiguous ? null : c.bsuid,
        c.parentBsuid,
        c.username,
        c.phone,
        c.userId,
        c.profileName,
        c.referral ? JSON.stringify(c.referral) : null,
        c.at,
      ],
    )
    return { contact: { ...rows[0], _ambiguous: ambiguous }, created: false }
  }

  async ensureConversation(contactId, client) {
    const { rows } = await client.query(
      `INSERT INTO wa_conversations (contact_id) VALUES ($1)
       ON CONFLICT (contact_id) DO UPDATE SET contact_id = EXCLUDED.contact_id
       RETURNING *`,
      [contactId],
    )
    return rows[0]
  }

  /**
   * Insert an inbound customer message. Returns null if this wamid was already
   * stored (Meta retry) — nothing else must then be touched.
   */
  async insertInboundMessage(m, client) {
    const { rows } = await client.query(
      `INSERT INTO wa_messages
         (conversation_id, contact_id, direction, wamid, msg_type, body, media, interactive, reply_to_wamid, status, wa_timestamp)
       VALUES ($1,$2,'INBOUND',$3,$4,$5,$6::jsonb,$7::jsonb,$8,'RECEIVED',$9)
       ON CONFLICT (wamid) WHERE wamid IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        m.conversationId,
        m.contactId,
        m.wamid,
        m.type,
        m.body,
        m.media ? JSON.stringify(m.media) : null,
        m.interactive ? JSON.stringify(m.interactive) : null,
        m.replyToWamid,
        m.timestamp,
      ],
    )
    return rows[0] ?? null
  }

  /** A customer writing again reopens a RESOLVED conversation and bumps unread. */
  async bumpConversationForInbound(conversationId, preview, at, client) {
    const { rows } = await client.query(
      `UPDATE wa_conversations SET
         unread_count = unread_count + 1,
         last_message_at = GREATEST(COALESCE(last_message_at, $3), $3),
         last_inbound_at = GREATEST(COALESCE(last_inbound_at, $3), $3),
         last_message_preview = $2,
         last_message_direction = 'INBOUND',
         bot_state = CASE WHEN status = 'RESOLVED' THEN 'BOT' ELSE bot_state END,
         bot_paused_until = CASE WHEN status = 'RESOLVED' THEN NULL ELSE bot_paused_until END,
         status = CASE WHEN status = 'RESOLVED' THEN 'OPEN' ELSE status END,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [conversationId, preview, at],
    )
    return rows[0]
  }

  // ─── Outbound messages & delivery statuses ────────────────────────

  async insertOutboundQueued(m, client = null) {
    const run = client ? client.query.bind(client) : query
    const { rows } = await run(
      `INSERT INTO wa_messages
         (conversation_id, contact_id, direction, msg_type, body, template_name, template_language, reply_to_wamid, status, sent_by, is_bot, bot_rule_id, template_id, campaign_id, workflow_id, media)
       VALUES ($1,$2,'OUTBOUND',$3,$4,$5,$6,$7,'QUEUED',$8,$9,$10,$11,$12,$13,$14::jsonb)
       RETURNING *`,
      [m.conversationId, m.contactId, m.type, m.body, m.templateName ?? null, m.templateLanguage ?? null, m.replyToWamid ?? null, m.sentBy ?? null, m.isBot ?? false, m.botRuleId ?? null, m.templateId ?? null, m.campaignId ?? null, m.workflowId ?? null, m.media ? JSON.stringify(m.media) : null],
    )
    return rows[0]
  }

  async markOutboundSent(id, wamid) {
    const { rows } = await query(
      // A fast "delivered" webhook may already have advanced the row past SENT — never move it back.
      `UPDATE wa_messages SET wamid = $2,
         status = CASE WHEN status = 'QUEUED' THEN 'SENT' ELSE status END,
         sent_at = COALESCE(sent_at, NOW())
       WHERE id = $1 RETURNING *`,
      [id, wamid],
    )
    return rows[0]
  }

  /** Records the Meta media id of an outbound attachment once it is uploaded. */
  async setMessageMedia(id, media) {
    await query(`UPDATE wa_messages SET media = $2::jsonb WHERE id = $1`, [id, JSON.stringify(media)])
  }

  /** The attachment of one message of this conversation (null when the message has none). */
  async getMessageMedia(conversationId, messageId) {
    const { rows } = await query(
      `SELECT msg_type, media FROM wa_messages WHERE id = $1 AND conversation_id = $2`,
      [messageId, conversationId],
    )
    return rows[0] ?? null
  }

  async markOutboundFailed(id, err) {
    const { rows } = await query(
      `UPDATE wa_messages SET status = 'FAILED', error_code = $2, error_title = $3, error_details = $4
       WHERE id = $1 AND status IN ('QUEUED','SENT') RETURNING *`,
      [id, err.code ?? null, (err.message ?? '').slice(0, 500) || null, err.details ?? null],
    )
    return rows[0] ?? null
  }

  /**
   * @param {{ keepAwaiting?: boolean }} [opts] a bot acknowledgement on a chat that still needs a PERSON
   *        must not make the chat look "answered" — the direction stays INBOUND.
   */
  async bumpConversationForOutbound(conversationId, preview, client = null, { keepAwaiting = false } = {}) {
    const run = client ? client.query.bind(client) : query
    const { rows } = await run(
      `UPDATE wa_conversations SET
         last_message_at = NOW(), last_message_preview = $2,
         last_message_direction = CASE WHEN $3::boolean THEN last_message_direction ELSE 'OUTBOUND' END,
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [conversationId, preview, keepAwaiting],
    )
    return rows[0]
  }

  /** Locks the message row so concurrent status webhooks apply one at a time. */
  async getOutboundByWamidForUpdate(wamid, client) {
    const { rows } = await client.query(
      `SELECT id, conversation_id, contact_id, status FROM wa_messages WHERE wamid = $1 AND direction = 'OUTBOUND' FOR UPDATE`,
      [wamid],
    )
    return rows[0] ?? null
  }

  async applyStatus(id, status, at, error, client) {
    if (status === 'FAILED') {
      const { rows } = await client.query(
        `UPDATE wa_messages SET status = 'FAILED', error_code = $2, error_title = $3, error_details = $4
         WHERE id = $1 RETURNING *`,
        [id, error?.code ?? null, error?.title ?? null, error?.details ?? null],
      )
      return rows[0]
    }
    // Column name comes from this fixed map, never from input.
    const col = { SENT: 'sent_at', DELIVERED: 'delivered_at', READ: 'read_at' }[status]
    const { rows } = await client.query(
      `UPDATE wa_messages SET status = $2, ${col} = COALESCE(${col}, $3) WHERE id = $1 RETURNING *`,
      [id, status, at],
    )
    return rows[0]
  }

  /** Billing facts from Meta's delivery webhook (billable flag, billed category, type). Idempotent. */
  async recordPricing(wamid, pricing) {
    if (!pricing) return false
    const { rowCount } = await query(
      `UPDATE wa_messages SET billable = COALESCE($2, billable), billing_category = COALESCE($3, billing_category), billing_type = COALESCE($4, billing_type)
        WHERE wamid = $1 AND direction = 'OUTBOUND'`,
      [wamid, pricing.billable, pricing.category, pricing.type],
    )
    return rowCount > 0
  }

  /** Records an opt-out Meta reported (error 131050) so no marketing send is attempted again. */
  async setMarketingConsent(contactId, consent) {
    await query(
      `UPDATE wa_contacts SET marketing_consent = $2, consent_updated_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [contactId, consent],
    )
  }

  // ─── Reads for the dashboard ──────────────────────────────────────

  /**
   * @param {object} f
   * @param {string} [f.visibleTo] when set, only conversations owned by this user or unassigned
   *        (agents without crm.inbox.view_all)
   */
  async listConversations({ status, assignedTo, labelId, search, visibleTo, limit = 30, offset = 0 }) {
    const where = []
    const params = []
    const add = (sql, v) => {
      params.push(v)
      where.push(sql.replace('$#', `$${params.length}`))
    }
    if (status) add('c.status = $#', status)
    if (assignedTo === 'unassigned') where.push('c.assigned_to IS NULL')
    else if (assignedTo) add('c.assigned_to = $#', assignedTo)
    if (labelId) add('EXISTS (SELECT 1 FROM wa_contact_labels x WHERE x.contact_id = ct.id AND x.label_id = $#)', labelId)
    if (visibleTo) add('(c.assigned_to IS NULL OR c.assigned_to = $#)', visibleTo)
    if (search) {
      params.push(`%${search}%`)
      const i = params.length
      where.push(`(ct.profile_name ILIKE $${i} OR ct.phone ILIKE $${i} OR ct.wa_id ILIKE $${i} OR u.name ILIKE $${i})`)
    }
    params.push(limit, offset)
    const { rows } = await query(
      `${CONVERSATION_SELECT}
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )
    return rows
  }

  /** The conversation of an existing Bakaloo customer, if they already have one. Read-only. */
  async findCustomerConversationId(userId) {
    const { rows } = await query(
      `SELECT c.id FROM wa_conversations c JOIN wa_contacts ct ON ct.id = c.contact_id
         LEFT JOIN users u ON u.id = $1
        WHERE ct.user_id = $1 OR (ct.phone IS NOT NULL AND ct.phone = u.phone)
        ORDER BY (ct.user_id = $1) DESC NULLS LAST LIMIT 1`, [userId])
    return rows[0]?.id ?? null
  }

  /**
   * Find or create the WhatsApp contact + conversation for a Bakaloo customer so staff can message them from the
   * customer profile. Creating a contact opens NOTHING: last_inbound_at stays empty, so the 24-hour window is closed
   * until the customer actually writes to us (an approved template is then the only thing that can be sent).
   * @returns {Promise<string>} conversation id
   */
  async ensureCustomerConversation(userId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const u = (await client.query(`SELECT id, name, phone FROM users WHERE id = $1 AND role = 'CUSTOMER' AND is_active = true`, [userId])).rows[0]
      const waId = u?.phone ? toWaId(u.phone) : null
      if (!u || !waId) {
        await client.query('ROLLBACK')
        return null
      }
      const found = (await client.query(
        `SELECT * FROM wa_contacts WHERE user_id = $1 OR wa_id = $2 OR phone = $3 ORDER BY (user_id = $1) DESC NULLS LAST, (wa_id = $2) DESC NULLS LAST LIMIT 1 FOR UPDATE`,
        [userId, waId, u.phone])).rows[0]
      let contactId = found?.id
      if (!found) {
        contactId = (await client.query(
          `INSERT INTO wa_contacts (wa_id, phone, user_id, profile_name, source) VALUES ($1,$2,$3,$4,'APP') RETURNING id`, [waId, u.phone, userId, u.name])).rows[0].id
      } else if (!found.user_id || !found.phone || !found.wa_id) {
        await client.query(`UPDATE wa_contacts SET user_id = COALESCE(user_id, $2), phone = COALESCE(phone, $3), wa_id = COALESCE(wa_id, $4), updated_at = NOW() WHERE id = $1`, [contactId, userId, u.phone, waId])
      }
      const conv = await this.ensureConversation(contactId, client)
      await client.query('COMMIT')
      return conv.id
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async getConversation(id) {
    const { rows } = await query(`${CONVERSATION_SELECT} WHERE c.id = $1`, [id])
    return rows[0] ?? null
  }

  async listMessages(conversationId, { before, limit = 50 }) {
    const params = [conversationId, limit]
    let cursor = ''
    if (before) {
      params.push(before)
      cursor = `AND created_at < $3`
    }
    const { rows } = await query(
      `SELECT id, direction, wamid, msg_type, body, media, interactive, template_name, status,
              error_code, error_title, error_details, sent_by, is_bot, wa_timestamp, created_at, delivered_at, read_at
         FROM wa_messages WHERE conversation_id = $1 ${cursor}
        ORDER BY created_at DESC LIMIT $2`,
      params,
    )
    return rows.reverse()
  }

  async markConversationRead(id) {
    const { rows } = await query(`UPDATE wa_conversations SET unread_count = 0, updated_at = NOW() WHERE id = $1 RETURNING *`, [id])
    return rows[0] ?? null
  }

  async getLatestInboundWamid(conversationId) {
    const { rows } = await query(
      `SELECT wamid FROM wa_messages WHERE conversation_id = $1 AND direction = 'INBOUND' AND wamid IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [conversationId],
    )
    return rows[0]?.wamid ?? null
  }

  async withTransaction(fn) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const out = await fn(client)
      await client.query('COMMIT')
      return out
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }
}
