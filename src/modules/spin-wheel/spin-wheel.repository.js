import { query, getClient } from '../../config/database.js'
import { env } from '../../config/env.js'

const PRIZE_COLUMNS = `
  id, type, icon_key, label, value, win_probability, display_order,
  is_active, linked_coupon_id, created_at, updated_at
`

const RULE_COLUMNS = `
  id, milestone_type, threshold, bonus_spins, is_repeating, is_active, created_at, updated_at
`

export class SpinWheelRepository {
  // ─── Prizes ────────────────────────────────────────────────────────────

  async findActivePrizes() {
    const { rows } = await query(
      `SELECT ${PRIZE_COLUMNS} FROM spin_prizes WHERE is_active = true ORDER BY display_order ASC`
    )
    return rows.map(this._formatPrize)
  }

  async findAllPrizes() {
    const { rows } = await query(
      `SELECT ${PRIZE_COLUMNS} FROM spin_prizes ORDER BY display_order ASC, created_at ASC`
    )
    return rows.map(this._formatPrize)
  }

  async findPrizeById(id) {
    const { rows } = await query(`SELECT ${PRIZE_COLUMNS} FROM spin_prizes WHERE id = $1`, [id])
    return rows[0] ? this._formatPrize(rows[0]) : null
  }

  /** Count of active prizes, optionally excluding one id (used when checking whether activating/editing a row would push the active set over the 8-prize cap). */
  async countActive(excludeId = null) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM spin_prizes WHERE is_active = true AND ($1::uuid IS NULL OR id != $1)`,
      [excludeId]
    )
    return rows[0].count
  }

  async createPrize(data) {
    const { rows: [{ max: maxOrder }] } = await query('SELECT COALESCE(MAX(display_order), 0) AS max FROM spin_prizes')
    const { rows } = await query(
      `INSERT INTO spin_prizes (type, icon_key, label, value, win_probability, display_order, is_active, linked_coupon_id)
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
      `UPDATE spin_prizes SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${PRIZE_COLUMNS}`,
      params
    )
    return rows[0] ? this._formatPrize(rows[0]) : null
  }

  async deletePrize(id) {
    const { rowCount } = await query('DELETE FROM spin_prizes WHERE id = $1', [id])
    return rowCount > 0
  }

  /** Same loop-of-UPDATEs-in-a-transaction shape as AdminBannersRepository#reorder. */
  async reorderPrizes(orderedIds) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          'UPDATE spin_prizes SET display_order = $1, updated_at = NOW() WHERE id = $2',
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
  // spin_first_time_prizes — see migration 139.

  async findActiveFirstTimePrizes() {
    const { rows } = await query(
      `SELECT ${PRIZE_COLUMNS} FROM spin_first_time_prizes WHERE is_active = true ORDER BY display_order ASC`
    )
    return rows.map(this._formatPrize)
  }

  async findAllFirstTimePrizes() {
    const { rows } = await query(
      `SELECT ${PRIZE_COLUMNS} FROM spin_first_time_prizes ORDER BY display_order ASC, created_at ASC`
    )
    return rows.map(this._formatPrize)
  }

  async findFirstTimePrizeById(id) {
    const { rows } = await query(`SELECT ${PRIZE_COLUMNS} FROM spin_first_time_prizes WHERE id = $1`, [id])
    return rows[0] ? this._formatPrize(rows[0]) : null
  }

  async countActiveFirstTime(excludeId = null) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count FROM spin_first_time_prizes WHERE is_active = true AND ($1::uuid IS NULL OR id != $1)`,
      [excludeId]
    )
    return rows[0].count
  }

  async createFirstTimePrize(data) {
    const { rows: [{ max: maxOrder }] } = await query('SELECT COALESCE(MAX(display_order), 0) AS max FROM spin_first_time_prizes')
    const { rows } = await query(
      `INSERT INTO spin_first_time_prizes (type, icon_key, label, value, win_probability, display_order, is_active, linked_coupon_id)
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
      `UPDATE spin_first_time_prizes SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${PRIZE_COLUMNS}`,
      params
    )
    return rows[0] ? this._formatPrize(rows[0]) : null
  }

  async deleteFirstTimePrize(id) {
    const { rowCount } = await query('DELETE FROM spin_first_time_prizes WHERE id = $1', [id])
    return rowCount > 0
  }

  async reorderFirstTimePrizes(orderedIds) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          'UPDATE spin_first_time_prizes SET display_order = $1, updated_at = NOW() WHERE id = $2',
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
   * Whether this user has ever spun before (any row at all in spin_history)
   * — the sole signal for "is this their first-ever spin". Always called
   * from inside spin()'s transaction, after its wallet row lock is already
   * held, so two concurrent first spins for the same user can't both see
   * "no history" (the second is blocked until the first's spin_history
   * insert commits).
   */
  async hasSpinHistory(client, userId) {
    const runner = client ? client.query.bind(client) : query
    const { rows } = await runner(
      'SELECT EXISTS(SELECT 1 FROM spin_history WHERE user_id = $1) AS has_history',
      [userId]
    )
    return rows[0].has_history === true
  }

  /**
   * A user only ever qualifies for the first-time reward pool if their
   * account was created on/after FIRST_TIME_REWARD_CUTOFF_AT — see
   * env.js's comment. Without this, an account that existed before
   * migration 139 shipped has no spin_history rows purely because the
   * table didn't exist yet, and would otherwise look "first ever" on its
   * first post-update spin.
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
      `SELECT id, daily_free_spins, trigger_mode, first_time_reward_enabled,
              background_image_url, background_image_public_id,
              banner_title, banner_subtitle, banner_tagline, updated_at
       FROM spin_wheel_settings LIMIT 1`
    )
    return rows[0] ? this._formatSettings(rows[0]) : null
  }

  async updateSettings(data) {
    const fields = []
    const params = []
    let idx = 1
    const fieldMap = {
      dailyFreeSpins: 'daily_free_spins',
      triggerMode: 'trigger_mode',
      firstTimeRewardEnabled: 'first_time_reward_enabled',
      backgroundImageUrl: 'background_image_url',
      backgroundImagePublicId: 'background_image_public_id',
      bannerTitle: 'banner_title',
      bannerSubtitle: 'banner_subtitle',
      bannerTagline: 'banner_tagline',
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
      `UPDATE spin_wheel_settings SET ${fields.join(', ')}
       RETURNING id, daily_free_spins, trigger_mode, first_time_reward_enabled,
                 background_image_url, background_image_public_id,
                 banner_title, banner_subtitle, banner_tagline, updated_at`,
      params
    )
    return rows[0] ? this._formatSettings(rows[0]) : null
  }

  // ─── Milestone rules ────────────────────────────────────────────────────

  async findAllMilestoneRules() {
    const { rows } = await query(`SELECT ${RULE_COLUMNS} FROM spin_milestone_rules ORDER BY threshold ASC`)
    return rows.map(this._formatRule)
  }

  async findActiveMilestoneRules() {
    const { rows } = await query(
      `SELECT ${RULE_COLUMNS} FROM spin_milestone_rules WHERE is_active = true ORDER BY threshold ASC`
    )
    return rows.map(this._formatRule)
  }

  async findMilestoneRuleById(id) {
    const { rows } = await query(`SELECT ${RULE_COLUMNS} FROM spin_milestone_rules WHERE id = $1`, [id])
    return rows[0] ? this._formatRule(rows[0]) : null
  }

  async createMilestoneRule(data) {
    const { rows } = await query(
      `INSERT INTO spin_milestone_rules (milestone_type, threshold, bonus_spins, is_repeating, is_active)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${RULE_COLUMNS}`,
      [data.milestoneType, data.threshold, data.bonusSpins ?? 1, !!data.isRepeating, data.isActive !== false]
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
      bonusSpins: 'bonus_spins',
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
      `UPDATE spin_milestone_rules SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${RULE_COLUMNS}`,
      params
    )
    return rows[0] ? this._formatRule(rows[0]) : null
  }

  async deleteMilestoneRule(id) {
    const { rowCount } = await query('DELETE FROM spin_milestone_rules WHERE id = $1', [id])
    return rowCount > 0
  }

  // ─── Spin wallet + grants (transactional — always called with a client already inside BEGIN) ──
  //
  // "Has today's daily spin already been granted?" is resolved entirely in
  // SQL (`last_daily_grant_date = CURRENT_DATE`) rather than comparing a
  // JS-computed date string — the app server and the DB may not agree on
  // "today" near a timezone boundary if that comparison were done in JS;
  // letting Postgres own both sides of the comparison sidesteps that
  // entirely. A brand-new row's `last_daily_grant_date` is NULL, so the
  // comparison evaluates to SQL NULL, read here as `false` (not yet
  // granted) — exactly the semantics a fresh wallet needs.

  /** Locks (creating if missing) the user's spin-wallet row for the duration of the caller's transaction. */
  async getOrCreateSpinWalletForUpdate(client, userId) {
    const { rows } = await client.query(
      `SELECT user_id, available_spins, (last_daily_grant_date = CURRENT_DATE) AS granted_today
       FROM user_spin_wallet WHERE user_id = $1 FOR UPDATE`,
      [userId]
    )
    if (rows[0]) return this._formatWallet(rows[0])
    const { rows: inserted } = await client.query(
      `INSERT INTO user_spin_wallet (user_id, available_spins) VALUES ($1, 0)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING user_id, available_spins, (last_daily_grant_date = CURRENT_DATE) AS granted_today`,
      [userId]
    )
    return this._formatWallet(inserted[0])
  }

  /** Non-locking read for UI/eligibility peeks — never creates a row (a user who's never opened the wheel simply has 0 baseline + today's not-yet-granted daily allowance, computed by the caller). */
  async peekSpinWallet(userId) {
    const { rows } = await query(
      `SELECT available_spins, (last_daily_grant_date = CURRENT_DATE) AS granted_today
       FROM user_spin_wallet WHERE user_id = $1`,
      [userId]
    )
    if (!rows[0]) return { availableSpins: 0, grantedToday: false }
    return { availableSpins: rows[0].available_spins, grantedToday: rows[0].granted_today === true }
  }

  /** @param {boolean} markDailyGranted - when true, also stamps last_daily_grant_date = CURRENT_DATE (today's lazy daily grant just happened this call). */
  async setSpinWallet(client, userId, { availableSpins, markDailyGranted = false }) {
    const { rows } = await client.query(
      `UPDATE user_spin_wallet
       SET available_spins = $2,
           last_daily_grant_date = CASE WHEN $3 THEN CURRENT_DATE ELSE last_daily_grant_date END,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id, available_spins, (last_daily_grant_date = CURRENT_DATE) AS granted_today`,
      [userId, availableSpins, markDailyGranted]
    )
    return this._formatWallet(rows[0])
  }

  async insertGrant(client, { userId, amount, source, sourceRef, createdBy }) {
    await client.query(
      `INSERT INTO spin_credit_grants (user_id, amount, source, source_ref, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, amount, source, sourceRef ?? null, createdBy ?? null]
    )
  }

  /** How many times this milestone rule has already granted this user a credit — dedupes one-time rules, and lets a repeating rule compute how many multiples remain unpaid. */
  async countGrantsForRule(userId, ruleId, client = null) {
    const runner = client ? client.query.bind(client) : query
    const { rows } = await runner(
      `SELECT COUNT(*)::int AS count FROM spin_credit_grants WHERE source = 'MILESTONE' AND source_ref = $1 AND user_id = $2`,
      [ruleId, userId]
    )
    return rows[0].count
  }

  async listGrants({ userId, limit = 20, offset = 0 } = {}) {
    const { rows } = await query(
      `SELECT id, user_id, amount, source, source_ref, created_by, created_at FROM spin_credit_grants
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
      `INSERT INTO spin_history (user_id, prize_id, prize_type, prize_label, prize_value, is_win, reward_status, is_first_time_reward)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [userId, prizeId, prizeType, prizeLabel, prizeValue ?? null, isWin, rewardStatus || 'N_A', !!isFirstTimeReward]
    )
    return rows[0].id
  }

  async updateHistoryReward(id, { rewardStatus, rewardRef }) {
    await query(
      'UPDATE spin_history SET reward_status = $2, reward_ref = $3 WHERE id = $1',
      [id, rewardStatus, rewardRef ?? null]
    )
  }

  async listHistory({ limit = 20, offset = 0, userId = null } = {}) {
    const { rows } = await query(
      `SELECT h.id, h.user_id, u.name AS user_name, u.phone AS user_phone,
              h.prize_type, h.prize_label, h.prize_value, h.is_win, h.reward_status, h.reward_ref,
              h.is_first_time_reward, h.spun_at
       FROM spin_history h
       LEFT JOIN users u ON u.id = h.user_id
       WHERE ($1::uuid IS NULL OR h.user_id = $1)
       ORDER BY h.spun_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    )
    const { rows: [{ count }] } = await query(
      `SELECT COUNT(*)::int AS count FROM spin_history WHERE ($1::uuid IS NULL OR user_id = $1)`,
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
        spunAt: r.spun_at,
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
      dailyFreeSpins: row.daily_free_spins,
      triggerMode: row.trigger_mode,
      firstTimeRewardEnabled: row.first_time_reward_enabled,
      backgroundImageUrl: row.background_image_url,
      backgroundImagePublicId: row.background_image_public_id,
      bannerTitle: row.banner_title,
      bannerSubtitle: row.banner_subtitle,
      bannerTagline: row.banner_tagline,
      updatedAt: row.updated_at,
    }
  }

  _formatRule(row) {
    return {
      id: row.id,
      milestoneType: row.milestone_type,
      threshold: parseFloat(row.threshold),
      bonusSpins: row.bonus_spins,
      isRepeating: row.is_repeating,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  _formatWallet(row) {
    return {
      userId: row.user_id,
      availableSpins: row.available_spins,
      grantedToday: row.granted_today === true,
    }
  }
}
