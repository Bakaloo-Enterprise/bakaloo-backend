import { getClient, query } from '../../config/database.js'

const HQ_MANAGERS = ['SUPER_ADMIN', 'ADMIN']
const MSG_COLS = `m.id, m.seq, m.channel_id, m.sender_id, u.name AS sender_name, m.body, m.ref_type, m.ref_id, m.ref_label, m.mentions, m.deleted_at, m.created_at`

/** Internal team chat storage (Phase 9). Customer WhatsApp messages live elsewhere on purpose. */
export class ChatRepository {
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

  // ─── people & access ────────────────────────────────────────────
  /** Active dashboard user, with what chat needs to know about them. Null when not eligible. */
  async loadAccess(userId) {
    const { rows } = await query(
      `SELECT u.id, u.name, u.platform_role, COALESCE(r.permissions, '[]'::jsonb) AS permissions,
              COALESCE((SELECT array_agg(ss.shop_id) FROM shop_staff ss WHERE ss.user_id = u.id AND ss.is_active AND ss.deleted_at IS NULL), '{}') AS shop_ids
         FROM users u LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1 AND u.role = 'ADMIN' AND u.is_active = true`,
      [userId],
    )
    const u = rows[0]
    if (!u) return null
    const perms = Array.isArray(u.permissions) ? u.permissions : []
    return {
      userId: u.id,
      name: u.name,
      isHq: u.platform_role != null,
      canManage: HQ_MANAGERS.includes(u.platform_role) || perms.includes('chat.manage'),
      shopIds: u.shop_ids ?? [],
    }
  }

  /** Staff you can start a chat with. No phone or email is exposed. */
  async people(viewerId, { search, limit = 50 }) {
    const { rows } = await query(
      `SELECT u.id, u.name, u.platform_role,
              COALESCE((SELECT array_agg(s.name ORDER BY s.name) FROM shop_staff ss JOIN shops s ON s.id = ss.shop_id
                         WHERE ss.user_id = u.id AND ss.is_active AND ss.deleted_at IS NULL), '{}') AS shops
         FROM users u
        WHERE u.role = 'ADMIN' AND u.is_active = true AND u.id <> $1 AND u.name IS NOT NULL
          AND ($2::text IS NULL OR u.name ILIKE '%' || $2 || '%')
        ORDER BY u.name LIMIT $3`,
      [viewerId, search ? search.replace(/[%_\\]/g, '\\$&') : null, limit],
    )
    return rows
  }

  /** Which of these ids are active dashboard users? */
  async eligibleUsers(ids) {
    if (!ids.length) return []
    const { rows } = await query(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND role = 'ADMIN' AND is_active = true`, [ids])
    return rows.map((r) => r.id)
  }

  /** Everyone the audience describes right now: all HQ staff and/or the staff of the given shops. */
  async resolveAudience({ hq, shopIds }) {
    const { rows } = await query(
      `SELECT DISTINCT u.id FROM users u
        WHERE u.role = 'ADMIN' AND u.is_active = true
          AND (($1::boolean AND u.platform_role IS NOT NULL)
            OR EXISTS (SELECT 1 FROM shop_staff ss WHERE ss.user_id = u.id AND ss.is_active AND ss.deleted_at IS NULL AND ss.shop_id = ANY($2::uuid[])))`,
      [Boolean(hq), shopIds ?? []],
    )
    return rows.map((r) => r.id)
  }

  // ─── channels ────────────────────────────────────────────────────
  async listChannels(userId, { archived = false }) {
    const { rows } = await query(
      `SELECT c.id, c.kind, c.name, c.description, c.archived_at, c.last_message_at, c.created_at, m.role AS my_role,
              (SELECT COUNT(*)::int FROM chat_members x WHERE x.channel_id = c.id) AS member_count,
              (SELECT COUNT(*)::int FROM chat_messages g WHERE g.channel_id = c.id AND g.seq > m.last_read_seq AND g.deleted_at IS NULL AND g.sender_id IS DISTINCT FROM $1) AS unread,
              (SELECT COUNT(*)::int FROM chat_messages g WHERE g.channel_id = c.id AND g.seq > m.last_read_seq AND g.deleted_at IS NULL AND g.sender_id IS DISTINCT FROM $1 AND $1 = ANY(g.mentions)) AS unread_mentions,
              (SELECT jsonb_build_object('id', l.id, 'body', l.body, 'ref_label', l.ref_label, 'deleted_at', l.deleted_at, 'sender_id', l.sender_id, 'created_at', l.created_at)
                 FROM chat_messages l WHERE l.channel_id = c.id ORDER BY l.seq DESC LIMIT 1) AS last_message,
              CASE WHEN c.kind = 'DM' THEN (SELECT jsonb_build_object('id', pu.id, 'name', pu.name, 'active', pu.is_active)
                 FROM chat_members pm JOIN users pu ON pu.id = pm.user_id WHERE pm.channel_id = c.id AND pm.user_id <> $1 LIMIT 1) END AS peer
         FROM chat_channels c JOIN chat_members m ON m.channel_id = c.id AND m.user_id = $1
        WHERE (c.archived_at IS NOT NULL) = $2
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
      [userId, archived],
    )
    return rows
  }

  /** The channel, only if the user is a member (otherwise null — callers answer 404). */
  async getForMember(channelId, userId, client) {
    const { rows } = await (client ?? { query }).query(
      `SELECT c.*, m.role AS my_role, m.last_read_seq FROM chat_channels c
         JOIN chat_members m ON m.channel_id = c.id AND m.user_id = $2 WHERE c.id = $1`,
      [channelId, userId],
    )
    return rows[0] ?? null
  }

  async members(channelId) {
    const { rows } = await query(
      `SELECT m.user_id, m.role, m.joined_at, u.name, u.is_active, u.platform_role
         FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = $1
        ORDER BY (m.role = 'OWNER') DESC, u.name`,
      [channelId],
    )
    return rows
  }

  async memberIds(channelId, client) {
    const { rows } = await (client ?? { query }).query(`SELECT user_id FROM chat_members WHERE channel_id = $1`, [channelId])
    return rows.map((r) => r.user_id)
  }

  /** Create the DM or return the existing one. `created` tells which. */
  async upsertDm(key, a, b) {
    return this.withTransaction(async (client) => {
      const ins = await client.query(`INSERT INTO chat_channels (kind, dm_key, created_by) VALUES ('DM',$1,$2) ON CONFLICT (dm_key) DO NOTHING RETURNING id`, [key, a])
      let id = ins.rows[0]?.id
      const created = Boolean(id)
      if (!id) id = (await client.query(`SELECT id FROM chat_channels WHERE dm_key = $1`, [key])).rows[0].id
      if (created) await client.query(`INSERT INTO chat_members (channel_id, user_id) VALUES ($1,$2),($1,$3)`, [id, a, b])
      return { id, created }
    })
  }

  async createChannel({ kind, name, description, audience, creatorId, memberIds }) {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO chat_channels (kind, name, description, audience, created_by) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id`,
        [kind, name, description, audience ? JSON.stringify(audience) : null, creatorId],
      )
      const id = rows[0].id
      await client.query(
        `INSERT INTO chat_members (channel_id, user_id, role)
         SELECT $1, x, CASE WHEN x = $3::uuid THEN 'OWNER' ELSE 'MEMBER' END FROM unnest($2::uuid[]) AS x`,
        [id, [creatorId, ...memberIds.filter((m) => m !== creatorId)], creatorId],
      )
      return id
    })
  }

  async update(channelId, { name, description }) {
    await query(
      `UPDATE chat_channels SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END WHERE id = $1`,
      [channelId, name ?? null, description !== undefined, description ?? null],
    )
  }

  async setArchived(channelId, archived) {
    await query(`UPDATE chat_channels SET archived_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END WHERE id = $1`, [channelId, archived])
  }

  /** Adds people; existing members are left alone. Returns the ids actually added. */
  async addMembers(channelId, userIds) {
    if (!userIds.length) return []
    const { rows } = await query(
      `INSERT INTO chat_members (channel_id, user_id, last_read_seq)
       SELECT $1, x, COALESCE((SELECT MAX(seq) FROM chat_messages WHERE channel_id = $1), 0) FROM unnest($2::uuid[]) AS x
       ON CONFLICT DO NOTHING RETURNING user_id`,
      [channelId, userIds],
    )
    return rows.map((r) => r.user_id)
  }

  async removeMember(channelId, userId) {
    const { rowCount } = await query(`DELETE FROM chat_members WHERE channel_id = $1 AND user_id = $2`, [channelId, userId])
    return rowCount > 0
  }

  /** Ownership passes to the longest-standing member; with nobody left the group is archived. */
  async reassignOwner(channelId) {
    const { rows } = await query(
      `UPDATE chat_members SET role = 'OWNER'
        WHERE (channel_id, user_id) = (SELECT channel_id, user_id FROM chat_members WHERE channel_id = $1 ORDER BY joined_at LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM chat_members WHERE channel_id = $1 AND role = 'OWNER')
        RETURNING user_id`,
      [channelId],
    )
    if (!rows[0] && !(await this.memberIds(channelId)).length) await this.setArchived(channelId, true)
  }

  // ─── messages ────────────────────────────────────────────────────
  async recentCount(userId, seconds = 60) {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM chat_messages WHERE sender_id = $1 AND created_at > NOW() - make_interval(secs => $2)`, [userId, seconds])
    return rows[0].n
  }

  /** Inserts are serialised per channel so `seq` is also the commit order — unread/"read up to" stay exact. */
  async insertMessage({ channelId, senderId, body, ref, mentions }) {
    return this.withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [channelId])
      const { rows } = await client.query(
        `INSERT INTO chat_messages (channel_id, sender_id, body, ref_type, ref_id, ref_label, mentions)
         VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[]) RETURNING id`,
        [channelId, senderId, body, ref?.type ?? null, ref?.id ?? null, ref?.label ?? null, mentions],
      )
      await client.query(`UPDATE chat_channels SET last_message_at = NOW() WHERE id = $1`, [channelId])
      // the sender has, by definition, read up to their own message
      await client.query(
        `UPDATE chat_members SET last_read_seq = (SELECT seq FROM chat_messages WHERE id = $3) WHERE channel_id = $1 AND user_id = $2`,
        [channelId, senderId, rows[0].id],
      )
      const out = await client.query(`SELECT ${MSG_COLS} FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = $1`, [rows[0].id])
      return out.rows[0]
    })
  }

  async listMessages(channelId, { before, limit = 50 }) {
    const { rows } = await query(
      `SELECT ${MSG_COLS} FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.channel_id = $1 AND ($2::bigint IS NULL OR m.seq < $2) ORDER BY m.seq DESC LIMIT $3`,
      [channelId, before ?? null, limit],
    )
    return rows.reverse()
  }

  async getMessage(channelId, messageId) {
    const { rows } = await query(`SELECT ${MSG_COLS} FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.channel_id = $1 AND m.id = $2`, [channelId, messageId])
    return rows[0] ?? null
  }

  /** Soft delete: the text and the shared reference are removed; the "message deleted" marker stays. */
  async deleteMessage(messageId) {
    const { rows } = await query(
      `UPDATE chat_messages SET deleted_at = NOW(), body = '', ref_type = NULL, ref_id = NULL, ref_label = NULL, mentions = '{}'
        WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [messageId],
    )
    return rows.length > 0
  }

  async markRead(channelId, userId) {
    await query(
      `UPDATE chat_members SET last_read_seq = GREATEST(last_read_seq, COALESCE((SELECT MAX(seq) FROM chat_messages WHERE channel_id = $1), 0))
        WHERE channel_id = $1 AND user_id = $2`,
      [channelId, userId],
    )
  }

  async unreadTotals(userId) {
    const { rows } = await query(
      `SELECT COALESCE(SUM(u.n),0)::int AS unread, COALESCE(SUM(u.mn),0)::int AS mentions FROM (
         SELECT (SELECT COUNT(*) FROM chat_messages g WHERE g.channel_id = m.channel_id AND g.seq > m.last_read_seq AND g.deleted_at IS NULL AND g.sender_id IS DISTINCT FROM $1) AS n,
                (SELECT COUNT(*) FROM chat_messages g WHERE g.channel_id = m.channel_id AND g.seq > m.last_read_seq AND g.deleted_at IS NULL AND g.sender_id IS DISTINCT FROM $1 AND $1 = ANY(g.mentions)) AS mn
           FROM chat_members m JOIN chat_channels c ON c.id = m.channel_id AND c.archived_at IS NULL WHERE m.user_id = $1) u`,
      [userId],
    )
    return rows[0]
  }

  // ─── things a message can point at ───────────────────────────────
  /** Orders by number. Shop staff only ever see their own shops' orders. */
  async findOrders(access, q, limit = 8) {
    const { rows } = await query(
      `SELECT o.id, o.order_number, o.shop_id, o.status FROM orders o
        WHERE o.order_number ILIKE '%' || $1 || '%' AND ($2::boolean OR o.shop_id = ANY($3::uuid[]))
        ORDER BY o.created_at DESC LIMIT $4`,
      [q.replace(/[%_\\]/g, '\\$&'), access.isHq, access.shopIds, limit],
    )
    return rows.map((r) => ({ id: r.id, type: 'ORDER', label: `Order ${r.order_number}`, hint: r.status, shopId: r.shop_id }))
  }

  async getOrder(id) {
    const { rows } = await query(`SELECT id, order_number, shop_id, status FROM orders WHERE id = $1`, [id])
    return rows[0] ? { id: rows[0].id, type: 'ORDER', label: `Order ${rows[0].order_number}`, shopId: rows[0].shop_id } : null
  }

  async findProducts(q, limit = 8) {
    const { rows } = await query(
      `SELECT id, name, sku FROM products WHERE (name ILIKE '%' || $1 || '%' OR sku ILIKE '%' || $1 || '%') ORDER BY name LIMIT $2`,
      [q.replace(/[%_\\]/g, '\\$&'), limit],
    )
    return rows.map((r) => ({ id: r.id, type: 'PRODUCT', label: r.name, hint: r.sku }))
  }

  async getProduct(id) {
    const { rows } = await query(`SELECT id, name FROM products WHERE id = $1`, [id])
    return rows[0] ? { id: rows[0].id, type: 'PRODUCT', label: rows[0].name } : null
  }

  /** Customer name only — never the phone number. */
  async findCustomers(q, limit = 8) {
    const { rows } = await query(
      `SELECT id, name FROM users WHERE role = 'CUSTOMER' AND name IS NOT NULL AND name ILIKE '%' || $1 || '%' ORDER BY name LIMIT $2`,
      [q.replace(/[%_\\]/g, '\\$&'), limit],
    )
    return rows.map((r) => ({ id: r.id, type: 'CUSTOMER', label: r.name }))
  }

  async getCustomer(id) {
    const { rows } = await query(`SELECT id, name FROM users WHERE id = $1 AND role = 'CUSTOMER'`, [id])
    return rows[0]?.name ? { id: rows[0].id, type: 'CUSTOMER', label: rows[0].name } : null
  }
}
