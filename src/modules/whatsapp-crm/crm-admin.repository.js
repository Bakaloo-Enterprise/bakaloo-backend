import { query, getClient } from '../../config/database.js'

/** Labels, conversation ownership and workload (Phase 3). */
export class CrmAdminRepository {
  // ─── Labels ───────────────────────────────────────────────────────
  async listLabels() {
    const { rows } = await query(
      `SELECT l.id, l.name, l.color, l.description, COUNT(cl.contact_id)::int AS customer_count
         FROM wa_labels l LEFT JOIN wa_contact_labels cl ON cl.label_id = l.id
        GROUP BY l.id ORDER BY lower(l.name)`,
    )
    return rows
  }

  async createLabel({ name, color, description }, userId) {
    const { rows } = await query(
      `INSERT INTO wa_labels (name, color, description, created_by) VALUES ($1, COALESCE($2,'#64748B'), $3, $4) RETURNING *`,
      [name.trim(), color ?? null, description ?? null, userId],
    )
    return rows[0]
  }

  async updateLabel(id, { name, color, description }) {
    const { rows } = await query(
      `UPDATE wa_labels SET name = COALESCE($2, name), color = COALESCE($3, color),
              description = COALESCE($4, description), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, name?.trim() ?? null, color ?? null, description ?? null],
    )
    return rows[0] ?? null
  }

  async deleteLabel(id) {
    const { rowCount } = await query(`DELETE FROM wa_labels WHERE id = $1`, [id])
    return rowCount > 0
  }

  async labelExists(id) {
    const { rows } = await query(`SELECT 1 FROM wa_labels WHERE id = $1`, [id])
    return rows.length > 0
  }

  async addContactLabel(contactId, labelId, userId, source = 'MANUAL') {
    const { rowCount } = await query(
      `INSERT INTO wa_contact_labels (contact_id, label_id, added_by, source) VALUES ($1,$2,$3,$4)
       ON CONFLICT (contact_id, label_id) DO NOTHING`,
      [contactId, labelId, userId, source],
    )
    return rowCount > 0
  }

  async removeContactLabel(contactId, labelId) {
    const { rowCount } = await query(`DELETE FROM wa_contact_labels WHERE contact_id = $1 AND label_id = $2`, [contactId, labelId])
    return rowCount > 0
  }

  // ─── Agents & assignment ──────────────────────────────────────────
  /** Active team members who can work the inbox (HQ admins, or a role holding crm.inbox.view). */
  async listAgents() {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, r.name AS role_name
         FROM users u LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.role = 'ADMIN' AND u.is_active = true AND u.is_blocked = false
          AND ((u.platform_role IN ('SUPER_ADMIN','ADMIN') AND (u.role_id IS NULL OR r.is_system)) OR COALESCE(r.permissions,'[]'::jsonb) ? 'crm.inbox.view')
        ORDER BY lower(COALESCE(u.name, u.email))`,
    )
    return rows
  }

  async isEligibleAgent(userId) {
    return (await this.listAgents()).some((a) => a.id === userId)
  }

  /**
   * Move conversations to `toUserId` (null = unassign), logging each change.
   * Only conversations whose owner actually changes are touched / logged.
   * @returns {Promise<Array<{ id: string, from: string|null }>>} the changed ones
   */
  async assign(conversationIds, toUserId, changedBy, action) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows: current } = await client.query(
        `SELECT id, assigned_to FROM wa_conversations WHERE id = ANY($1::uuid[]) FOR UPDATE`,
        [conversationIds],
      )
      const changed = current.filter((c) => (c.assigned_to ?? null) !== (toUserId ?? null))
      if (changed.length) {
        const ids = changed.map((c) => c.id)
        await client.query(
          `UPDATE wa_conversations SET assigned_to = $2, assigned_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE NOW() END, updated_at = NOW()
            WHERE id = ANY($1::uuid[])`,
          [ids, toUserId ?? null],
        )
        for (const c of changed) {
          await client.query(
            `INSERT INTO wa_assignment_log (conversation_id, from_user_id, to_user_id, changed_by, action) VALUES ($1,$2,$3,$4,$5)`,
            [c.id, c.assigned_to, toUserId ?? null, changedBy, action],
          )
        }
      }
      await client.query('COMMIT')
      return changed.map((c) => ({ id: c.id, from: c.assigned_to }))
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async assignmentHistory(conversationId) {
    const { rows } = await query(
      `SELECT l.id, l.action, l.created_at, f.name AS from_name, t.name AS to_name, b.name AS by_name
         FROM wa_assignment_log l
         LEFT JOIN users f ON f.id = l.from_user_id LEFT JOIN users t ON t.id = l.to_user_id LEFT JOIN users b ON b.id = l.changed_by
        WHERE l.conversation_id = $1 ORDER BY l.created_at DESC LIMIT 50`,
      [conversationId],
    )
    return rows
  }

  // ─── Workload ─────────────────────────────────────────────────────
  /** Per agent: chats they own that are not resolved, unread total, and chats waiting for THEIR reply. */
  async workload() {
    const { rows } = await query(
      `SELECT a.id, COALESCE(a.name, a.email) AS name,
              COUNT(c.id) FILTER (WHERE c.status IN ('OPEN','PENDING'))::int AS active,
              COALESCE(SUM(c.unread_count) FILTER (WHERE c.status IN ('OPEN','PENDING')),0)::int AS unread,
              COUNT(c.id) FILTER (WHERE c.status IN ('OPEN','PENDING') AND c.last_message_direction = 'INBOUND')::int AS awaiting_reply,
              COUNT(c.id) FILTER (WHERE c.status IN ('OPEN','PENDING') AND c.last_message_direction = 'INBOUND'
                                    AND c.last_message_at < NOW() - INTERVAL '15 minutes')::int AS waiting_over_15m
         FROM users a
         LEFT JOIN roles r ON r.id = a.role_id
         LEFT JOIN wa_conversations c ON c.assigned_to = a.id
        WHERE a.role = 'ADMIN' AND a.is_active = true AND a.is_blocked = false
          AND ((a.platform_role IN ('SUPER_ADMIN','ADMIN') AND (a.role_id IS NULL OR r.is_system)) OR COALESCE(r.permissions,'[]'::jsonb) ? 'crm.inbox.view')
        GROUP BY a.id ORDER BY active DESC, name`,
    )
    const { rows: un } = await query(
      `SELECT COUNT(*)::int AS active, COALESCE(SUM(unread_count),0)::int AS unread,
              COUNT(*) FILTER (WHERE last_message_direction = 'INBOUND')::int AS awaiting_reply
         FROM wa_conversations WHERE assigned_to IS NULL AND status IN ('OPEN','PENDING')`,
    )
    return { agents: rows, unassigned: un[0] }
  }
}
