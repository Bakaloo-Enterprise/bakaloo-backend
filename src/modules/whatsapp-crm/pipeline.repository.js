import { query, getClient } from '../../config/database.js'

/** "Placed" order = confirmed or later. PENDING (unpaid, can expire), CANCELLED and REFUNDED do not count. */
const PLACED = `o.status NOT IN ('PENDING','CANCELLED','REFUNDED')`

/** One row per card with everything the board and the automation need. */
const CARD_SELECT = `
  SELECT ct.id AS contact_id, c.id AS conversation_id,
         ct.profile_name, ct.phone, ct.wa_username, ct.bsuid, ct.source, ct.stage_id, ct.stage_source, ct.stage_changed_at,
         COALESCE(ct.user_id, u.id) AS customer_id, u.name AS customer_name,
         c.assigned_to, a.name AS assigned_name, c.unread_count, c.last_message_at, c.last_message_direction,
         (c.last_inbound_at IS NOT NULL AND c.last_inbound_at > NOW() - INTERVAL '24 hours') AS window_open,
         COALESCE(os.order_count, 0) AS order_count, COALESCE(os.total_spend, 0) AS total_spend,
         COALESCE(ac.cart_value, 0) AS open_cart_value,
         (COALESCE(ba.is_b2b, false) OR EXISTS (
            SELECT 1 FROM wa_contact_labels cl JOIN wa_labels l ON l.id = cl.label_id
             WHERE cl.contact_id = ct.id AND lower(l.name) = 'b2b')) AS is_b2b,
         EXISTS (SELECT 1 FROM wa_contact_labels cl JOIN wa_labels l ON l.id = cl.label_id
                  WHERE cl.contact_id = ct.id AND lower(l.name) = 'vip') AS is_vip,
         COALESCE((SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color) ORDER BY lower(l.name))
                     FROM wa_contact_labels cl JOIN wa_labels l ON l.id = cl.label_id WHERE cl.contact_id = ct.id), '[]'::json) AS labels
    FROM wa_contacts ct
    JOIN wa_conversations c ON c.contact_id = ct.id
    LEFT JOIN users u ON u.id = ct.user_id OR (ct.user_id IS NULL AND ct.phone IS NOT NULL AND u.phone = ct.phone AND u.role = 'CUSTOMER')
    LEFT JOIN users a ON a.id = c.assigned_to
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS order_count, COALESCE(SUM(o.total_amount), 0)::float AS total_spend
        FROM orders o WHERE o.user_id = COALESCE(ct.user_id, u.id) AND ${PLACED}
    ) os ON true
    LEFT JOIN LATERAL (
      SELECT cart_value::float AS cart_value FROM abandoned_carts x
       WHERE x.user_id = COALESCE(ct.user_id, u.id) AND x.status = 'OPEN' ORDER BY x.abandoned_at DESC LIMIT 1
    ) ac ON true
    LEFT JOIN LATERAL (
      SELECT (b.status = 'APPROVED' AND b.b2b_enabled) AS is_b2b FROM business_accounts b WHERE b.user_id = COALESCE(ct.user_id, u.id) LIMIT 1
    ) ba ON true`

export class PipelineRepository {
  async listStages() {
    const { rows } = await query(`SELECT id, key, name, position, is_auto, color FROM crm_stages WHERE is_active ORDER BY position`)
    return rows
  }

  async getStage(id) {
    const { rows } = await query(`SELECT id, key, name, is_auto FROM crm_stages WHERE id = $1 AND is_active`, [id])
    return rows[0] ?? null
  }

  async getStageByKey(key) {
    const { rows } = await query(`SELECT id, key, name, is_auto FROM crm_stages WHERE key = $1`, [key])
    return rows[0] ?? null
  }

  /**
   * @param {{ visibleTo?: string, assignedTo?: string, labelId?: string, b2b?: 'B2B'|'B2C', search?: string, limit?: number }} f
   */
  async board({ visibleTo, assignedTo, labelId, b2b, search, limit = 500 }) {
    const where = []
    const params = []
    const add = (sql, v) => {
      params.push(v)
      where.push(sql.replace('$#', `$${params.length}`))
    }
    if (visibleTo) add('(c.assigned_to IS NULL OR c.assigned_to = $#)', visibleTo)
    if (assignedTo === 'unassigned') where.push('c.assigned_to IS NULL')
    else if (assignedTo) add('c.assigned_to = $#', assignedTo)
    if (labelId) add('EXISTS (SELECT 1 FROM wa_contact_labels x WHERE x.contact_id = ct.id AND x.label_id = $#)', labelId)
    if (search) {
      params.push(`%${search}%`)
      const i = params.length
      where.push(`(ct.profile_name ILIKE $${i} OR ct.phone ILIKE $${i} OR ct.wa_id ILIKE $${i} OR u.name ILIKE $${i})`)
    }
    params.push(limit + 1)
    const { rows } = await query(
      `SELECT * FROM (${CARD_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}) card
        ${b2b === 'B2B' ? 'WHERE card.is_b2b' : b2b === 'B2C' ? 'WHERE NOT card.is_b2b' : ''}
        ORDER BY card.last_message_at DESC NULLS LAST LIMIT $${params.length}`,
      params,
    )
    return rows
  }

  /** Cards the automation should (re)evaluate, with the facts it decides on. */
  async reconcileCandidates({ contactId, limit = 5000 } = {}) {
    const { rows } = await query(
      `SELECT ct.id AS contact_id, ct.stage_id, ct.stage_source, s.key AS stage_key, COALESCE(s.is_auto, false) AS stage_is_auto,
              (COALESCE(ct.user_id, u.id) IS NOT NULL) AS has_user,
              COALESCE((SELECT COUNT(*) FROM orders o WHERE o.user_id = COALESCE(ct.user_id, u.id) AND ${PLACED}), 0)::int AS order_count,
              EXISTS (SELECT 1 FROM wa_messages m WHERE m.contact_id = ct.id AND m.direction = 'OUTBOUND' AND NOT m.is_bot AND m.campaign_id IS NULL AND m.workflow_id IS NULL) AS has_outbound
         FROM wa_contacts ct
         LEFT JOIN crm_stages s ON s.id = ct.stage_id
         LEFT JOIN users u ON ct.user_id IS NULL AND ct.phone IS NOT NULL AND u.phone = ct.phone AND u.role = 'CUSTOMER'
        ${contactId ? 'WHERE ct.id = $2' : ''}
        ORDER BY ct.stage_changed_at NULLS FIRST LIMIT $1`,
      contactId ? [limit, contactId] : [limit],
    )
    return rows
  }

  /** A customer who registered later with the same phone gets linked automatically. */
  async linkContactsByPhone() {
    const { rowCount } = await query(
      `UPDATE wa_contacts ct SET user_id = u.id, updated_at = NOW()
         FROM users u
        WHERE ct.user_id IS NULL AND ct.phone IS NOT NULL AND u.phone = ct.phone AND u.role = 'CUSTOMER'`,
    )
    return rowCount
  }

  /**
   * Set a contact's stage and write history, atomically. No-op (returns null) if unchanged.
   * @returns {Promise<{ fromStageId: string|null, toStageId: string } | null>}
   */
  async setStage(contactId, toStageId, source, reason, changedBy = null) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const cur = await client.query(`SELECT stage_id FROM wa_contacts WHERE id = $1 FOR UPDATE`, [contactId])
      if (!cur.rows[0]) {
        await client.query('ROLLBACK')
        return null
      }
      const from = cur.rows[0].stage_id
      if (from === toStageId) {
        // Dragging a card onto the stage it is already in still records WHO owns the decision.
        if (source === 'MANUAL') await client.query(`UPDATE wa_contacts SET stage_source = 'MANUAL' WHERE id = $1`, [contactId])
        await client.query('COMMIT')
        return null
      }
      await client.query(`UPDATE wa_contacts SET stage_id = $2, stage_source = $3, stage_changed_at = NOW(), updated_at = NOW() WHERE id = $1`, [contactId, toStageId, source])
      await client.query(
        `INSERT INTO crm_stage_history (contact_id, from_stage_id, to_stage_id, source, reason, changed_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [contactId, from, toStageId, source, reason ?? null, changedBy],
      )
      await client.query('COMMIT')
      return { fromStageId: from, toStageId }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async history(contactId) {
    const { rows } = await query(
      `SELECT h.id, h.source, h.reason, h.created_at, f.name AS from_stage, t.name AS to_stage, u.name AS changed_by
         FROM crm_stage_history h
         LEFT JOIN crm_stages f ON f.id = h.from_stage_id LEFT JOIN crm_stages t ON t.id = h.to_stage_id
         LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.contact_id = $1 ORDER BY h.created_at DESC LIMIT 50`,
      [contactId],
    )
    return rows
  }

  async conversationForContact(contactId) {
    const { rows } = await query(`SELECT id, contact_id, assigned_to FROM wa_conversations WHERE contact_id = $1`, [contactId])
    return rows[0] ?? null
  }
}
