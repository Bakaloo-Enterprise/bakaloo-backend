import { query, getClient } from '../../config/database.js'

/** SQL for the rule-based bot (migration 144). */
export class BotRepository {
  // ─── Settings ─────────────────────────────────────────────────────
  async getSettings() {
    const { rows } = await query(`SELECT enabled, human_pause_minutes, max_replies_per_hour, fallback_enabled, fallback_text, updated_at FROM wa_bot_settings WHERE id = 1`)
    return rows[0]
  }

  async updateSettings(p, userId) {
    const { rows } = await query(
      `UPDATE wa_bot_settings SET
         enabled = COALESCE($1, enabled), human_pause_minutes = COALESCE($2, human_pause_minutes),
         max_replies_per_hour = COALESCE($3, max_replies_per_hour), fallback_enabled = COALESCE($4, fallback_enabled),
         fallback_text = COALESCE($5, fallback_text), updated_by = $6, updated_at = NOW()
       WHERE id = 1
       RETURNING enabled, human_pause_minutes, max_replies_per_hour, fallback_enabled, fallback_text, updated_at`,
      [p.enabled ?? null, p.humanPauseMinutes ?? null, p.maxRepliesPerHour ?? null, p.fallbackEnabled ?? null, p.fallbackText ?? null, userId],
    )
    return rows[0]
  }

  // ─── Rules ────────────────────────────────────────────────────────
  async listRules() {
    const { rows } = await query(`SELECT * FROM wa_bot_rules ORDER BY position, created_at`)
    return rows
  }

  async getRule(id) {
    const { rows } = await query(`SELECT * FROM wa_bot_rules WHERE id = $1`, [id])
    return rows[0] ?? null
  }

  async createRule(r, userId) {
    const { rows } = await query(
      `INSERT INTO wa_bot_rules (name, position, is_active, match_type, keywords, exact_keywords, when_hours, action, reply_text, cooldown_minutes, created_by)
       VALUES ($1, COALESCE((SELECT MAX(position) FROM wa_bot_rules), 0) + 10, $2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [r.name, r.isActive ?? true, r.matchType, r.keywords ?? [], r.exactKeywords ?? [], r.whenHours ?? 'ANY', r.action ?? 'REPLY', r.replyText ?? null, r.cooldownMinutes ?? 0, userId],
    )
    return rows[0]
  }

  async updateRule(id, r) {
    const { rows } = await query(
      `UPDATE wa_bot_rules SET
         name = COALESCE($2, name), is_active = COALESCE($3, is_active), match_type = COALESCE($4, match_type),
         keywords = COALESCE($5, keywords), exact_keywords = COALESCE($6, exact_keywords), when_hours = COALESCE($7, when_hours),
         action = COALESCE($8, action), reply_text = CASE WHEN $9::boolean THEN $10 ELSE reply_text END,
         cooldown_minutes = COALESCE($11, cooldown_minutes), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, r.name ?? null, r.isActive ?? null, r.matchType ?? null, r.keywords ?? null, r.exactKeywords ?? null, r.whenHours ?? null, r.action ?? null, r.replyText !== undefined, r.replyText ?? null, r.cooldownMinutes ?? null],
    )
    return rows[0] ?? null
  }

  async deleteRule(id) {
    const { rowCount } = await query(`DELETE FROM wa_bot_rules WHERE id = $1`, [id])
    return rowCount > 0
  }

  /** Rewrites positions 10,20,30… in the given order. Unknown ids are ignored; omitted rules keep their relative order after. */
  async reorder(ids) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(`SELECT id FROM wa_bot_rules ORDER BY position, created_at FOR UPDATE`)
      const known = new Set(rows.map((r) => r.id))
      const first = [...new Set(ids)].filter((i) => known.has(i))
      const rest = rows.map((r) => r.id).filter((i) => !first.includes(i))
      let pos = 10
      for (const id of [...first, ...rest]) {
        await client.query(`UPDATE wa_bot_rules SET position = $2, updated_at = NOW() WHERE id = $1`, [id, pos])
        pos += 10
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  // ─── Conversation bot state & guards ──────────────────────────────
  async setBotState(conversationId, state, { pausedUntil = null, reason = null } = {}) {
    await query(`UPDATE wa_conversations SET bot_state = $2, bot_paused_until = $3, bot_handoff_reason = $4, updated_at = NOW() WHERE id = $1`, [conversationId, state, pausedUntil, reason])
  }

  async countBotMessagesSince(conversationId, minutes) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM wa_messages WHERE conversation_id = $1 AND is_bot AND created_at > NOW() - ($2 || ' minutes')::interval`,
      [conversationId, String(minutes)],
    )
    return rows[0].n
  }

  async lastRuleReplyAt(conversationId, ruleId) {
    const { rows } = await query(
      `SELECT created_at FROM wa_bot_events WHERE conversation_id = $1 AND rule_id = $2 AND outcome IN ('REPLIED','HANDOFF') ORDER BY created_at DESC LIMIT 1`,
      [conversationId, ruleId],
    )
    return rows[0]?.created_at ?? null
  }

  async logEvent({ conversationId, inboundWamid = null, ruleId = null, outcome, detail = null }) {
    await query(`INSERT INTO wa_bot_events (conversation_id, inbound_wamid, rule_id, outcome, detail) VALUES ($1,$2,$3,$4,$5)`, [conversationId, inboundWamid, ruleId, outcome, detail ? String(detail).slice(0, 200) : null])
  }

  async recentEvents(limit = 50) {
    const { rows } = await query(
      `SELECT e.id, e.outcome, e.detail, e.created_at, e.conversation_id, r.name AS rule_name,
              COALESCE(ct.profile_name, ct.phone, ct.wa_username, ct.bsuid) AS contact
         FROM wa_bot_events e
         LEFT JOIN wa_bot_rules r ON r.id = e.rule_id
         JOIN wa_conversations c ON c.id = e.conversation_id JOIN wa_contacts ct ON ct.id = c.contact_id
        ORDER BY e.created_at DESC LIMIT $1`,
      [limit],
    )
    return rows
  }

  async markConversationReadAndAnswered(conversationId) {
    await query(`UPDATE wa_conversations SET unread_count = 0, updated_at = NOW() WHERE id = $1`, [conversationId])
  }

  // ─── Facts the replies are built from ─────────────────────────────
  async lastOrder(customerId) {
    if (!customerId) return null
    const { rows } = await query(`SELECT order_number, status FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [customerId])
    return rows[0] ?? null
  }

  /** True only when an active shop LISTS this pincode. Radius coverage cannot be proven from a PIN alone. */
  async pincodeListed(pincode) {
    const { rows } = await query(
      `SELECT 1 FROM shops WHERE is_active = true AND deleted_at IS NULL AND ($1 = ANY(serviceable_pincodes) OR pincode = $1) LIMIT 1`,
      [pincode],
    )
    return rows.length > 0
  }

  async weeklyHours() {
    const { rows } = await query(`SELECT weekly_hours FROM store_status LIMIT 1`)
    return rows[0]?.weekly_hours ?? null
  }

  async setMarketingConsent(contactId, consent) {
    await query(`UPDATE wa_contacts SET marketing_consent = $2, consent_updated_at = NOW(), updated_at = NOW() WHERE id = $1`, [contactId, consent])
  }
}
