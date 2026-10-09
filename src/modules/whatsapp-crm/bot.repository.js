import { query, getClient } from '../../config/database.js'

/** SQL for the rule-based bot (migration 144). */
export class BotRepository {
  // ─── Settings ─────────────────────────────────────────────────────
  async getSettings() {
    const { rows } = await query(`SELECT enabled, human_pause_minutes, max_replies_per_hour, fallback_enabled, fallback_text, fallback_text_gu, fallback_text_gl, play_store_url, app_store_url, website_url, quote_prices, updated_at FROM wa_bot_settings WHERE id = 1`)
    return rows[0]
  }

  async updateSettings(p, userId) {
    const { rows } = await query(
      `UPDATE wa_bot_settings SET
         enabled = COALESCE($1, enabled), human_pause_minutes = COALESCE($2, human_pause_minutes),
         max_replies_per_hour = COALESCE($3, max_replies_per_hour), fallback_enabled = COALESCE($4, fallback_enabled),
         fallback_text = COALESCE($5, fallback_text),
         fallback_text_gu = COALESCE($7, fallback_text_gu), fallback_text_gl = COALESCE($8, fallback_text_gl),
         play_store_url = COALESCE($9, play_store_url), app_store_url = COALESCE($10, app_store_url),
         website_url = COALESCE($11, website_url), quote_prices = COALESCE($12, quote_prices),
         updated_by = $6, updated_at = NOW()
       WHERE id = 1
       RETURNING enabled, human_pause_minutes, max_replies_per_hour, fallback_enabled, fallback_text, fallback_text_gu, fallback_text_gl,
                 play_store_url, app_store_url, website_url, quote_prices, updated_at`,
      [
        p.enabled ?? null, p.humanPauseMinutes ?? null, p.maxRepliesPerHour ?? null, p.fallbackEnabled ?? null, p.fallbackText ?? null, userId,
        p.fallbackTextGu ?? null, p.fallbackTextGl ?? null, p.playStoreUrl ?? null, p.appStoreUrl ?? null, p.websiteUrl ?? null, p.quotePrices ?? null,
      ],
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
      `INSERT INTO wa_bot_rules (name, position, is_active, match_type, keywords, exact_keywords, when_hours, action, reply_text, cooldown_minutes, created_by, reply_text_gu, reply_text_gl, asks_area)
       VALUES ($1, COALESCE((SELECT MAX(position) FROM wa_bot_rules), 0) + 10, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [r.name, r.isActive ?? true, r.matchType, r.keywords ?? [], r.exactKeywords ?? [], r.whenHours ?? 'ANY', r.action ?? 'REPLY', r.replyText ?? null, r.cooldownMinutes ?? 0, userId, r.replyTextGu ?? null, r.replyTextGl ?? null, r.asksArea ?? false],
    )
    return rows[0]
  }

  async updateRule(id, r) {
    const { rows } = await query(
      `UPDATE wa_bot_rules SET
         name = COALESCE($2, name), is_active = COALESCE($3, is_active), match_type = COALESCE($4, match_type),
         keywords = COALESCE($5, keywords), exact_keywords = COALESCE($6, exact_keywords), when_hours = COALESCE($7, when_hours),
         action = COALESCE($8, action), reply_text = CASE WHEN $9::boolean THEN $10 ELSE reply_text END,
         cooldown_minutes = COALESCE($11, cooldown_minutes),
         reply_text_gu = CASE WHEN $12::boolean THEN $13 ELSE reply_text_gu END,
         reply_text_gl = CASE WHEN $14::boolean THEN $15 ELSE reply_text_gl END,
         asks_area = COALESCE($16, asks_area), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, r.name ?? null, r.isActive ?? null, r.matchType ?? null, r.keywords ?? null, r.exactKeywords ?? null, r.whenHours ?? null, r.action ?? null, r.replyText !== undefined, r.replyText ?? null, r.cooldownMinutes ?? null,
        r.replyTextGu !== undefined, r.replyTextGu ?? null, r.replyTextGl !== undefined, r.replyTextGl ?? null, r.asksArea ?? null],
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

  // ─── Bot v2: areas, product words, what we know about the customer ──
  async listAreas({ onlyActive = true } = {}) {
    const { rows } = await query(
      `SELECT id, name, name_gu, aliases, is_serviceable, is_active, position FROM wa_service_areas ${onlyActive ? 'WHERE is_active' : ''} ORDER BY position, name`,
    )
    return rows
  }

  async createArea(a) {
    const { rows } = await query(
      `INSERT INTO wa_service_areas (name, name_gu, aliases, is_serviceable, is_active, position)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [a.name, a.nameGu ?? null, a.aliases ?? [], a.isServiceable ?? false, a.isActive ?? true, a.position ?? 100],
    )
    return rows[0]
  }

  async updateArea(id, a) {
    const { rows } = await query(
      `UPDATE wa_service_areas SET
         name = COALESCE($2, name), name_gu = CASE WHEN $3::boolean THEN $4 ELSE name_gu END,
         aliases = COALESCE($5, aliases), is_serviceable = COALESCE($6, is_serviceable),
         is_active = COALESCE($7, is_active), position = COALESCE($8, position), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, a.name ?? null, a.nameGu !== undefined, a.nameGu ?? null, a.aliases ?? null, a.isServiceable ?? null, a.isActive ?? null, a.position ?? null],
    )
    return rows[0] ?? null
  }

  async deleteArea(id) {
    const { rowCount } = await query(`DELETE FROM wa_service_areas WHERE id = $1`, [id])
    return rowCount > 0
  }

  /** People waiting for us: customers who named an area we do not serve yet (or one we could not recognise). */
  async waitingList(limit = 200) {
    const { rows } = await query(
      `SELECT a.id AS area_id, COALESCE(a.name, c.area_text) AS area, a.is_serviceable, COUNT(*)::int AS people,
              COUNT(*) FILTER (WHERE c.marketing_consent = 'OPTED_IN')::int AS opted_in
         FROM wa_contacts c LEFT JOIN wa_service_areas a ON a.id = c.service_area_id
        WHERE c.service_area_id IS NOT NULL OR c.area_text IS NOT NULL
        GROUP BY a.id, COALESCE(a.name, c.area_text), a.is_serviceable
        ORDER BY people DESC LIMIT $1`,
      [limit],
    )
    return rows
  }

  async listProductAliases() {
    const { rows } = await query(`SELECT id, alias, search_term FROM wa_product_aliases ORDER BY search_term, alias`)
    return rows
  }

  async addProductAlias(alias, searchTerm) {
    const { rows } = await query(
      `INSERT INTO wa_product_aliases (alias, search_term) VALUES (lower($1), lower($2))
       ON CONFLICT (lower(alias)) DO UPDATE SET search_term = EXCLUDED.search_term RETURNING *`,
      [alias, searchTerm],
    )
    return rows[0]
  }

  async deleteProductAlias(id) {
    const { rowCount } = await query(`DELETE FROM wa_product_aliases WHERE id = $1`, [id])
    return rowCount > 0
  }

  /**
   * Active catalog items whose name contains the search term, with the lowest/highest price currently on
   * sale in any active shop (shop price, else product price; sale price wins). Items nobody sells right now
   * are NOT returned: the bot must never say "yes we have it" about something that is out of stock.
   */
  async findProducts(term, limit = 3) {
    const { rows } = await query(
      `SELECT p.id, p.name, p.unit,
              MIN(COALESCE(sp.sale_price, sp.price, p.sale_price, p.price))::numeric AS min_price,
              MAX(COALESCE(sp.sale_price, sp.price, p.sale_price, p.price))::numeric AS max_price
         FROM products p
         JOIN shop_products sp ON sp.product_id = p.id AND sp.deleted_at IS NULL AND sp.is_available = true AND sp.stock_quantity > 0
         JOIN shops s ON s.id = sp.shop_id AND s.is_active = true AND s.deleted_at IS NULL
        WHERE p.is_active = true AND p.name ILIKE $1
        GROUP BY p.id, p.name, p.unit, p.total_sold
        ORDER BY p.total_sold DESC NULLS LAST, p.name
        LIMIT $2`,
      [`%${String(term).replace(/[%_\\]/g, '')}%`, limit],
    )
    return rows
  }

  /** Remember the customer's language and (when known) their area. Never throws into the bot. */
  async rememberCustomer(contactId, { language = null, areaId = null, areaText = null } = {}) {
    await query(
      `UPDATE wa_contacts SET bot_language = COALESCE($2, bot_language),
              service_area_id = CASE WHEN $3::uuid IS NOT NULL THEN $3 WHEN $4::text IS NOT NULL THEN NULL ELSE service_area_id END,
              area_text = CASE WHEN $3::uuid IS NOT NULL THEN NULL WHEN $4::text IS NOT NULL THEN $4 ELSE area_text END,
              updated_at = NOW()
        WHERE id = $1`,
      [contactId, language, areaId, areaText],
    )
  }

  /** Did the bot's most recent message (last 3 hours) end with "which area are you in?" */
  async awaitingArea(conversationId) {
    const { rows } = await query(
      `SELECT r.asks_area
         FROM wa_messages m LEFT JOIN wa_bot_rules r ON r.id = m.bot_rule_id
        WHERE m.conversation_id = $1 AND m.direction = 'OUTBOUND' AND m.created_at > NOW() - INTERVAL '3 hours'
        ORDER BY m.created_at DESC LIMIT 1`,
      [conversationId],
    )
    return Boolean(rows[0]?.asks_area)
  }
}
