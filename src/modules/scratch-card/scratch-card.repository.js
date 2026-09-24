import { query, getClient } from '../../config/database.js'
import { env } from '../../config/env.js'

const PRIZE_COLUMNS = `
  id, type, icon_key, label, value, win_probability, display_order,
  is_active, linked_coupon_id, created_at, updated_at
`

const RULE_COLUMNS = `
  id, milestone_type, threshold, bonus_scratches, is_repeating, is_active, created_at, updated_at
`

export class ScratchCardRepository {
  // ─── Prizes ────────────────────────────────────────────────────────────

  async findActivePrizes() {
    const { rows } = await query(
      `SELECT ${PRIZE_COLUMNS} FROM scratch_prizes WHERE is_active = true ORDER BY display_order ASC`
    )
    return rows.map(this._formatPrize)
  }

  async findAllPrizes() {
    const { rows } = await query(
      `SELECT ${PRIZE_COLUMNS} FROM scratch_prizes ORDER BY display_order ASC, created_at ASC`
    )
    return rows.map(this._formatPrize)
  }

  async findPrizeById(id) {
    const { rows } = await query(`SELECT ${PRIZE_COLUMNS} FROM scratch_prizes WHERE id = $1`, [id])
    return rows[0] ? this._formatPrize(rows[0]) : null
  }

  /** Count of active prizes, optionally excluding one id (used when checking whether activating/editing a row would push the active set over the 8-prize cap). */
  async countActive(excludeId = null) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM scratch_prizes WHERE is_active = true AND ($1::uuid IS NULL OR id != $1)`,
      [excludeId]
    )
    return rows[0].count
  }

  async createPrize(data) {
    const { rows: [{ max: maxOrder }] } = await query('SELECT COALESCE(MAX(display_order), 0) AS max FROM scratch_prizes')
    const { rows } = await query(
      `INSERT INTO scratch_prizes (type, icon_key, label, value, win_probability, display_order, is_active, linked_coupon_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${PRIZE_COLUMNS}`,
      [
        data.type,
        data.iconKey || 'gift',
        data.label,
        data.value ?? null,
        data.winProbability ?? 0,
        (maxOrder || 0) + 1,
        data.isActive !== false,
        data.linkedCouponId ?? null,
      ]
    )
    return this._formatPrize(rows[0])
  }

  async updatePrize(id, data) {
    const fields = []
    const params = []
    let idx = 1
    const fieldMap = {
      type: 'type',
      iconKey: 'icon_key',
      label: 'label',
      value: 'value',
      winProbability: 'win_probability',
      isActive: 'is_active',
      linkedCouponId: 'linked_coupon_id',
    }
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey])
      }
    }
    if (fields.length === 0) return this.findPrizeById(id)
    fields.push('updated_at = NOW()')
    params.push(id)
    const { rows } = await query(
      `UPDATE scratch_prizes SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${PRIZE_COLUMNS}`,
      params
    )
    return rows[0] ? this._formatPrize(rows[0]) : null
  }

  async deletePrize(id) {
    const { rowCount } = await query('DELETE FROM scratch_prizes WHERE id = $1', [id])
    return rowCount > 0
  }

  /** Same loop-of-UPDATEs-in-a-transaction shape as SpinWheelRepository#reorderPrizes / AdminBannersRepository#reorder. */
  async reorderPrizes(orderedIds) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          'UPDATE scratch_prizes SET display_order = $1, updated_at = NOW() WHERE id = $2',
          [i + 1, orderedIds[i]]
        )
      }
      await client.query('COMMIT')
      return true
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // ─── First-time reward prizes ───────────────────────────────────────────
  // Same shape/queries as the regular prize CRUD above, just pointed at
  // scratch_first_time_prizes — see migration 139.

  async findActiveFirstTimePrizes() {
    const { rows } = await query(
      `SELECT ${PRIZE_COLUMNS} FROM scratch_first_time_prizes WHERE is_active = true ORDER BY display_order ASC`
    )
    return rows.map(this._formatPrize)
  }

  async findAllFirstTimePrizes() {
    const { rows } = await query(
      `SELECT ${PRIZE_COLUMNS} FROM scratch_first_time_prizes ORDER BY display_order ASC, created_at ASC`
    )
    return rows.map(this._formatPrize)
  }

  async findFirstTimePrizeById(id) {
    const { rows } = await query(`SELECT ${PRIZE_COLUMNS} FROM scratch_first_time_prizes WHERE id = $1`, [id])
    return rows[0] ? this._formatPrize(rows[0]) : null
  }

  async countActiveFirstTime(excludeId = null) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM scratch_first_time_prizes WHERE is_active = true AND ($1::uuid IS NULL OR id != $1)`,
      [excludeId]
    )
    return rows[0].count
  }

  async createFirstTimePrize(data) {
    const { rows: [{ max: maxOrder }] } = await query('SELECT COALESCE(MAX(display_order), 0) AS max FROM scratch_first_time_prizes')
    const { rows } = await query(
      `INSERT INTO scratch_first_time_prizes (type, icon_key, label, value, win_probability, display_order, is_active, linked_coupon_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${PRIZE_COLUMNS}`,
      [
        data.type,
        data.iconKey || 'gift',
        data.label,
        data.value ?? null,
        data.winProbability ?? 0,
        (maxOrder || 0) + 1,
        data.isActive !== false,
        data.linkedCouponId ?? null,
      ]
    )
    return this._formatPrize(rows[0])
  }

  async updateFirstTimePrize(id, data) {
    const fields = []
    const params = []
    let idx = 1
    const fieldMap = {
      type: 'type',
      iconKey: 'icon_key',
      label: 'label',
      value: 'value',
      winProbability: 'win_probability',
      isActive: 'is_active',
      linkedCouponId: 'linked_coupon_id',
    }
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey])
      }
    }
    if (fields.length === 0) return this.findFirstTimePrizeById(id)
    fields.push('updated_at = NOW()')
    params.push(id)
    const { rows } = await query(
      `UPDATE scratch_first_time_prizes SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${PRIZE_COLUMNS}`,
      params
    )
    return rows[0] ? this._formatPrize(rows[0]) : null
  }

  async deleteFirstTimePrize(id) {
    const { rowCount } = await query('DELETE FROM scratch_first_time_prizes WHERE id = $1', [id])
    return rowCount > 0
  }

  async reorderFirstTimePrizes(orderedIds) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          'UPDATE scratch_first_time_prizes SET display_order = $1, updated_at = NOW() WHERE id = $2',
          [i + 1, orderedIds[i]]
        )
      }
      await client.query('COMMIT')
      return true
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Whether this user has ever scratched before (any row at all in
   * scratch_history) — the sole signal for "is this their first-ever
   * scratch". Always called from inside scratch()'s transaction, after its
   * wallet row lock is already held, so two concurrent first scratches for
   * the same user can't both see "no history".
   */
  async hasScratchHistory(client, userId) {
    const runner = client ? client.query.bind(client) : query
    const { rows } = await runner(
      'SELECT EXISTS(SELECT 1 FROM scratch_history WHERE user_id = $1) AS has_history',
      [userId]
    )
    return rows[0].has_history === true
  }

  /**
   * Mirrors SpinWheelRepository#isEligibleAccountForFirstTimeReward — a
   * user only ever qualifies for the first-time reward pool if their
   * account was created on/after FIRST_TIME_REWARD_CUTOFF_AT, so an
   * account that predates migration 139 (and thus has no scratch_history
   * rows purely because the table didn't exist yet) never looks "first
   * ever" on its first post-update scratch.
   */
  async isEligibleAccountForFirstTimeReward(client, userId) {
    const runner = client ? client.query.bind(client) : query
    const { rows } = await runner(
      'SELECT created_at >= $2 AS is_new_account FROM users WHERE id = $1',
      [userId, env.FIRST_TIME_REWARD_CUTOFF_AT]
    )
    return rows[0]?.is_new_account === true
  }

  // ─── Settings (singleton) ──────────────────────────────────────────────

  async getSettings() {
    const { rows } = await query(
      `SELECT id, daily_free_scratches, trigger_mode, first_time_reward_enabled,
              cover_image_url, cover_image_public_id, updated_at
       FROM scratch_card_settings LIMIT 1`
    )
    return rows[0] ? this._formatSettings(rows[0]) : null
  }

  async updateSettings(data) {
    const fields = []
    const params = []
    let idx = 1
    const fieldMap = {
      dailyFreeScratches: 'daily_free_scratches',
      triggerMode: 'trigger_mode',
      firstTimeRewardEnabled: 'first_time_reward_enabled',
      coverImageUrl: 'cover_image_url',
      coverImagePublicId: 'cover_image_public_id',
    }
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey])
      }
    }
    if (fields.length === 0) return this.getSettings()
    fields.push('updated_at = NOW()')
    const { rows } = await query(
      `UPDATE scratch_card_settings SET ${fields.join(', ')}
       RETURNING id, daily_free_scratches, trigger_mode, first_time_reward_enabled,
                 cover_image_url, cover_image_public_id, updated_at`,
      params
    )
    return rows[0] ? this._formatSettings(rows[0]) : null
  }

  // ─── Milestone rules ────────────────────────────────────────────────────

  async findAllMilestoneRules() {
    const { rows } = await query(`SELECT ${RULE_COLUMNS} FROM scratch_milestone_rules ORDER BY threshold ASC`)
    return rows.map(this._formatRule)
  }

  async findActiveMilestoneRules() {
    const { rows } = await query(
      `SELECT ${RULE_COLUMNS} FROM scratch_milestone_rules WHERE is_active = true ORDER BY threshold ASC`
    )
    return rows.map(this._formatRule)
  }

  async findMilestoneRuleById(id) {
    const { rows } = await query(`SELECT ${RULE_COLUMNS} FROM scratch_milestone_rules WHERE id = $1`, [id])
    return rows[0] ? this._formatRule(rows[0]) : null
  }

  async createMilestoneRule(data) {
    const { rows } = await query(
      `INSERT INTO scratch_milestone_rules (milestone_type, threshold, bonus_scratches, is_repeating, is_active)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${RULE_COLUMNS}`,
      [data.milestoneType, data.threshold, data.bonusScratches ?? 1, !!data.isRepeating, data.isActive !== false]
    )
    return this._formatRule(rows[0])
  }

  async updateMilestoneRule(id, data) {
    const fields = []
    const params = []
    let idx = 1
    const fieldMap = {
      milestoneType: 'milestone_type',
      threshold: 'threshold',
      bonusScratches: 'bonus_scratches',
      isRepeating: 'is_repeating',
      isActive: 'is_active',
    }
    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = $${idx++}`)
        params.push(data[jsKey])
      }
    }
    if (fields.length === 0) return this.findMilestoneRuleById(id)
    fields.push('updated_at = NOW()')
    params.push(id)
    const { rows } = await query(
      `UPDATE scratch_milestone_rules SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${RULE_COLUMNS}`,
      params
    )
    return rows[0] ? this._formatRule(rows[0]) : null
  }

  async deleteMilestoneRule(id) {
    const { rowCount } = await query('DELETE FROM scratch_milestone_rules WHERE id = $1', [id])
    return rowCount > 0
  }

  // ─── Scratch wallet + grants (transactional — always called with a client already inside BEGIN) ──
  //
  // "Has today's daily scratch already been granted?" is resolved entirely
  // in SQL (`last_daily_grant_date = CURRENT_DATE`), same reasoning as
  // SpinWheelRepository — the app server and DB may not agree on "today"
  // near a timezone boundary if that comparison were done in JS.

  /** Locks (creating if missing) the user's scratch-wallet row for the duration of the caller's transaction. */
  async getOrCreateScratchWalletForUpdate(client, userId) {
    const { rows } = await client.query(
      `SELECT user_id, available_scratches, (last_daily_grant_date = CURRENT_DATE) AS granted_today
       FROM user_scratch_wallet WHERE user_id = $1 FOR UPDATE`,
      [userId]
    )
    if (rows[0]) return this._formatWallet(rows[0])
    const { rows: inserted } = await client.query(
      `INSERT INTO user_scratch_wallet (user_id, available_scratches) VALUES ($1, 0)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING user_id, available_scratches, (last_daily_grant_date = CURRENT_DATE) AS granted_today`,
      [userId]
    )
    return this._formatWallet(inserted[0])
  }

  /** Non-locking read for UI/eligibility peeks — never creates a row (a user who's never opened a card simply has 0 baseline + today's not-yet-granted daily allowance, computed by the caller). */
  async peekScratchWallet(userId) {
    const { rows } = await query(
      `SELECT available_scratches, (last_daily_grant_date = CURRENT_DATE) AS granted_today
       FROM user_scratch_wallet WHERE user_id = $1`,
      [userId]
    )
    if (!rows[0]) return { availableScratches: 0, grantedToday: false }
    return { availableScratches: rows[0].available_scratches, grantedToday: rows[0].granted_today === true }
  }

  /** @param {boolean} markDailyGranted - when true, also stamps last_daily_grant_date = CURRENT_DATE (today's lazy daily grant just happened this call). */
  async setScratchWallet(client, userId, { availableScratches, markDailyGranted = false }) {
    const { rows } = await client.query(
      `UPDATE user_scratch_wallet
       SET available_scratches = $2,
           last_daily_grant_date = CASE WHEN $3 THEN CURRENT_DATE ELSE last_daily_grant_date END,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id, available_scratches, (last_daily_grant_date = CURRENT_DATE) AS granted_today`,
      [userId, availableScratches, markDailyGranted]
    )
    return this._formatWallet(rows[0])
  }

  async insertGrant(client, { userId, amount, source, sourceRef, createdBy }) {
    await client.query(
      `INSERT INTO scratch_credit_grants (user_id, amount, source, source_ref, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, amount, source, sourceRef ?? null, createdBy ?? null]
    )
  }

  /** How many times this milestone rule has already granted this user a credit — dedupes one-time rules, and lets a repeating rule compute how many multiples remain unpaid. */
  async countGrantsForRule(userId, ruleId, client = null) {
    const runner = client ? client.query.bind(client) : query
    const { rows } = await runner(
      `SELECT COUNT(*)::int AS count FROM scratch_credit_grants WHERE source = 'MILESTONE' AND source_ref = $1 AND user_id = $2`,
      [ruleId, userId]
    )
    return rows[0].count
  }

  async listGrants({ userId, limit = 20, offset = 0 } = {}) {
    const { rows } = await query(
      `SELECT id, user_id, amount, source, source_ref, created_by, created_at FROM scratch_credit_grants
       WHERE ($1::uuid IS NULL OR user_id = $1) ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId ?? null, limit, offset]
    )
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      amount: r.amount,
      source: r.source,
      sourceRef: r.source_ref,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }))
  }

  // ─── History ────────────────────────────────────────────────────────────

  async insertHistory(client, { userId, prizeId, prizeType, prizeLabel, prizeValue, isWin, rewardStatus, isFirstTimeReward = false }) {
    const runner = client ? client.query.bind(client) : query
    const { rows } = await runner(
      `INSERT INTO scratch_history (user_id, prize_id, prize_type, prize_label, prize_value, is_win, reward_status, is_first_time_reward)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [userId, prizeId, prizeType, prizeLabel, prizeValue ?? null, isWin, rewardStatus || 'N_A', !!isFirstTimeReward]
    )
    return rows[0].id
  }

  async updateHistoryReward(id, { rewardStatus, rewardRef }) {
    await query(
      'UPDATE scratch_history SET reward_status = $2, reward_ref = $3 WHERE id = $1',
      [id, rewardStatus, rewardRef ?? null]
    )
  }

  async listHistory({ limit = 20, offset = 0, userId = null } = {}) {
    const { rows } = await query(
      `SELECT h.id, h.user_id, u.name AS user_name, u.phone AS user_phone,
              h.prize_type, h.prize_label, h.prize_value, h.is_win, h.reward_status, h.reward_ref,
              h.is_first_time_reward, h.scratched_at
       FROM scratch_history h
       LEFT JOIN users u ON u.id = h.user_id
       WHERE ($1::uuid IS NULL OR h.user_id = $1)
       ORDER BY h.scratched_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    )
    const { rows: [{ count }] } = await query(
      `SELECT COUNT(*)::int AS count FROM scratch_history WHERE ($1::uuid IS NULL OR user_id = $1)`,
      [userId]
    )
    return {
      total: count,
      entries: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        userName: r.user_name,
        userPhone: r.user_phone,
        prizeType: r.prize_type,
        prizeLabel: r.prize_label,
        prizeValue: r.prize_value != null ? parseFloat(r.prize_value) : null,
        isWin: r.is_win,
        rewardStatus: r.reward_status,
        rewardRef: r.reward_ref,
        isFirstTimeReward: r.is_first_time_reward === true,
        scratchedAt: r.scratched_at,
      })),
    }
  }

  // ─── Formatters ─────────────────────────────────────────────────────────

  _formatPrize(row) {
    return {
      id: row.id,
      type: row.type,
      iconKey: row.icon_key,
      label: row.label,
      value: row.value != null ? parseFloat(row.value) : null,
      winProbability: parseFloat(row.win_probability),
      displayOrder: row.display_order,
      isActive: row.is_active,
      linkedCouponId: row.linked_coupon_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  _formatSettings(row) {
    return {
      id: row.id,
      dailyFreeScratches: row.daily_free_scratches,
      triggerMode: row.trigger_mode,
      firstTimeRewardEnabled: row.first_time_reward_enabled,
      coverImageUrl: row.cover_image_url,
      coverImagePublicId: row.cover_image_public_id,
      updatedAt: row.updated_at,
    }
  }

  _formatRule(row) {
    return {
      id: row.id,
      milestoneType: row.milestone_type,
      threshold: parseFloat(row.threshold),
      bonusScratches: row.bonus_scratches,
      isRepeating: row.is_repeating,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  _formatWallet(row) {
    return {
      userId: row.user_id,
      availableScratches: row.available_scratches,
      grantedToday: row.granted_today === true,
    }
  }
}
