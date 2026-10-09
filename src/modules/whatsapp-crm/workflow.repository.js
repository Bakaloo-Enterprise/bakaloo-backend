import { query } from '../../config/database.js'
import { ORDER_EVENT_MAX_AGE_MINUTES, STALE_EVENT_MINUTES } from './campaign.js'

const PLACED = `o.status NOT IN ('PENDING','CANCELLED','REFUNDED')`
const COLS = `id, name, description, trigger_type, trigger_config, conditions, actions, is_active, activated_at, created_by, created_at, updated_at`

/** Workflows (WHEN / IF / DO), their runs, and the event scans that feed them (Phase 7). */
export class WorkflowRepository {
  async list() {
    const { rows } = await query(
      `SELECT ${COLS},
              (SELECT COUNT(*)::int FROM wa_workflow_runs r WHERE r.workflow_id = w.id AND r.status = 'SENT') AS sent,
              (SELECT COUNT(*)::int FROM wa_workflow_runs r WHERE r.workflow_id = w.id AND r.status = 'SKIPPED') AS skipped,
              (SELECT COUNT(*)::int FROM wa_workflow_runs r WHERE r.workflow_id = w.id AND r.status IN ('FAILED','INTERRUPTED')) AS failed
         FROM wa_workflows w ORDER BY w.created_at DESC`,
    )
    return rows
  }

  async get(id) {
    const { rows } = await query(`SELECT ${COLS} FROM wa_workflows WHERE id = $1`, [id])
    return rows[0] ?? null
  }

  async insert(v, userId) {
    const { rows } = await query(
      `INSERT INTO wa_workflows (name, description, trigger_type, trigger_config, conditions, actions, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7) RETURNING ${COLS}`,
      [v.name, v.description ?? null, v.triggerType, JSON.stringify(v.triggerConfig), JSON.stringify(v.conditions ?? []), JSON.stringify(v.actions), userId],
    )
    return rows[0]
  }

  async update(id, v) {
    const { rows } = await query(
      `UPDATE wa_workflows SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
              trigger_config = COALESCE($5::jsonb, trigger_config), conditions = COALESCE($6::jsonb, conditions),
              actions = COALESCE($7::jsonb, actions), updated_at = NOW()
        WHERE id = $1 RETURNING ${COLS}`,
      [id, v.name ?? null, v.description !== undefined, v.description ?? null,
        v.triggerConfig ? JSON.stringify(v.triggerConfig) : null, v.conditions ? JSON.stringify(v.conditions) : null, v.actions ? JSON.stringify(v.actions) : null],
    )
    return rows[0] ?? null
  }

  /** Switching ON stamps activated_at: only events after that moment fire. */
  async setActive(id, active) {
    const { rows } = await query(
      `UPDATE wa_workflows SET is_active = $2, activated_at = CASE WHEN $2 THEN NOW() ELSE activated_at END, updated_at = NOW()
        WHERE id = $1 RETURNING ${COLS}`,
      [id, active],
    )
    return rows[0] ?? null
  }

  async remove(id) {
    const { rowCount } = await query(`DELETE FROM wa_workflows WHERE id = $1`, [id])
    return rowCount > 0
  }

  async activeByTrigger(triggerType) {
    const { rows } = await query(`SELECT ${COLS} FROM wa_workflows WHERE is_active AND trigger_type = $1`, [triggerType])
    return rows
  }

  async recentRuns(workflowId, limit = 30) {
    const { rows } = await query(
      `SELECT r.id, r.subject_type, r.subject_id, r.status, r.reason, r.created_at, r.finished_at,
              COALESCE(u.name, c.profile_name) AS customer
         FROM wa_workflow_runs r LEFT JOIN wa_contacts c ON c.id = r.contact_id LEFT JOIN users u ON u.id = r.user_id
        WHERE r.workflow_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
      [workflowId, limit],
    )
    return rows
  }

  // ─── Event scans: claim = insert the run row; whoever inserts it owns the event ─────────

  /** Abandoned carts that have waited long enough since this workflow was switched on. */
  async claimDueCarts(workflow, limit = 100) {
    const delay = Number(workflow.trigger_config?.delay_minutes ?? 5)
    const { rows } = await query(
      `INSERT INTO wa_workflow_runs (workflow_id, subject_type, subject_id, user_id)
       SELECT $1, 'ABANDONED_CART', ac.id, ac.user_id
         FROM abandoned_carts ac
        WHERE ac.status = 'OPEN'
          AND ac.detected_at >= $2
          AND ac.abandoned_at + $3::int * interval '1 minute' <= NOW()
          AND ac.abandoned_at + ($3::int + $4::int) * interval '1 minute' >= NOW()
        ORDER BY ac.abandoned_at LIMIT $5
       ON CONFLICT (workflow_id, subject_type, subject_id) DO NOTHING
       RETURNING id, subject_id, user_id`,
      [workflow.id, workflow.activated_at, delay, STALE_EVENT_MINUTES, limit],
    )
    return rows
  }

  /** Orders that just reached the workflow's status. Old events are never back-filled. */
  async claimDueOrderEvents(workflow, limit = 100) {
    const { rows } = await query(
      `INSERT INTO wa_workflow_runs (workflow_id, subject_type, subject_id, user_id)
       SELECT $1, 'ORDER_STATUS', h.id, o.user_id
         FROM order_status_history h JOIN orders o ON o.id = h.order_id
        WHERE h.to_status = $2 AND h.changed_at >= $3
          AND h.changed_at >= NOW() - ($4 || ' minutes')::interval
        ORDER BY h.changed_at LIMIT $5
       ON CONFLICT (workflow_id, subject_type, subject_id) DO NOTHING
       RETURNING id, subject_id, user_id`,
      [workflow.id, workflow.trigger_config?.status, workflow.activated_at, String(ORDER_EVENT_MAX_AGE_MINUTES), limit],
    )
    return rows
  }

  /** Give the event back (temporary Meta error): the next scan claims it again while it is still fresh. */
  async releaseRun(id) {
    await query(`DELETE FROM wa_workflow_runs WHERE id = $1 AND status = 'RUNNING'`, [id])
  }

  async finishRun(id, { status, reason = null, contactId = null, messageId = null }) {
    await query(
      `UPDATE wa_workflow_runs SET status = $2, reason = $3, contact_id = COALESCE($4, contact_id), message_id = COALESCE($5, message_id), finished_at = NOW() WHERE id = $1`,
      [id, status, reason, contactId, messageId],
    )
  }

  /** A worker died mid-run: we cannot know whether the message left, so never re-send. */
  async interruptStuckRuns(olderThanMinutes = 10) {
    const { rowCount } = await query(
      `UPDATE wa_workflow_runs SET status = 'INTERRUPTED', reason = 'WORKER_STOPPED', finished_at = NOW()
        WHERE status = 'RUNNING' AND created_at < NOW() - ($1 || ' minutes')::interval`,
      [String(olderThanMinutes)],
    )
    return rowCount
  }

  // ─── Facts about the event ─────────────────────────────────────────
  async cartContext(cartId) {
    const { rows } = await query(
      `SELECT ac.id, ac.user_id, ac.status, ac.cart_value::float AS cart_value, ac.item_count,
              (SELECT string_agg(i.product_name, ', ' ORDER BY i.line_total DESC) FROM (
                 SELECT product_name, line_total FROM abandoned_cart_items WHERE abandoned_cart_id = ac.id ORDER BY line_total DESC LIMIT 3) i) AS top_items,
              u.name AS customer_name, u.phone,
              (SELECT COUNT(*)::int FROM orders o WHERE o.user_id = ac.user_id AND ${PLACED}) AS order_count
         FROM abandoned_carts ac JOIN users u ON u.id = ac.user_id WHERE ac.id = $1`,
      [cartId],
    )
    return rows[0] ?? null
  }

  async orderContext(historyId) {
    const { rows } = await query(
      `SELECT h.id, h.to_status, o.id AS order_id, o.order_number, o.total_amount::float AS order_total, o.payment_method, o.user_id,
              u.name AS customer_name, u.phone,
              (SELECT COUNT(*)::int FROM orders x WHERE x.user_id = o.user_id AND x.status NOT IN ('PENDING','CANCELLED','REFUNDED')) AS order_count
         FROM order_status_history h JOIN orders o ON o.id = h.order_id JOIN users u ON u.id = o.user_id WHERE h.id = $1`,
      [historyId],
    )
    return rows[0] ?? null
  }

  /** The contact for a Bakaloo customer; created from the phone if they never messaged us (consent UNKNOWN). */
  async contactForUser(userId) {
    const found = await query(
      `SELECT c.id, c.wa_id, c.bsuid, c.phone, c.user_id, c.profile_name, c.marketing_consent AS consent,
              c.last_inbound_at IS NOT NULL AS has_messaged_us, c.last_inbound_at, c.bot_language, (s.contact_id IS NOT NULL) AS suppressed, u.name AS customer_name
         FROM wa_contacts c LEFT JOIN wa_suppression s ON s.contact_id = c.id LEFT JOIN users u ON u.id = c.user_id
        WHERE c.user_id = $1 OR c.phone = (SELECT phone FROM users WHERE id = $1)
        ORDER BY (c.user_id = $1) DESC, c.last_inbound_at DESC NULLS LAST LIMIT 1`,
      [userId],
    )
    if (found.rows[0]) return found.rows[0]
    await query(
      `INSERT INTO wa_contacts (wa_id, phone, user_id, profile_name, source)
       SELECT '91' || u.phone, u.phone, u.id, u.name, 'APP' FROM users u WHERE u.id = $1 AND u.phone ~ '^[6-9][0-9]{9}$'
       ON CONFLICT (wa_id) DO UPDATE SET user_id = COALESCE(wa_contacts.user_id, EXCLUDED.user_id)`,
      [userId],
    )
    const again = await query(
      `SELECT c.id, c.wa_id, c.bsuid, c.phone, c.user_id, c.profile_name, c.marketing_consent AS consent,
              c.last_inbound_at IS NOT NULL AS has_messaged_us, c.last_inbound_at, c.bot_language, (s.contact_id IS NOT NULL) AS suppressed, u.name AS customer_name
         FROM wa_contacts c LEFT JOIN wa_suppression s ON s.contact_id = c.id LEFT JOIN users u ON u.id = c.user_id WHERE c.user_id = $1 LIMIT 1`,
      [userId],
    )
    return again.rows[0] ?? null
  }

  /** A coupon is safe to put in a message only if ANYONE can redeem it right now. */
  async publicCoupon(couponId) {
    const { rows } = await query(
      `SELECT id, code FROM coupons
        WHERE id = $1 AND is_active = true AND target_type = 'ALL'
          AND (valid_from IS NULL OR valid_from <= NOW()) AND (valid_until IS NULL OR valid_until > NOW())
          AND (usage_limit IS NULL OR used_count < usage_limit)`,
      [couponId],
    )
    return rows[0] ?? null
  }

  /** The workflow run that sent this (template) message, with what is needed to try a normal message instead. */
  async runForMessage(messageId) {
    const { rows } = await query(
      `SELECT r.id, r.workflow_id, r.subject_type, r.subject_id, r.user_id, w.actions, m.template_id, m.created_at AS message_created_at
         FROM wa_workflow_runs r JOIN wa_workflows w ON w.id = r.workflow_id JOIN wa_messages m ON m.id = r.message_id
        WHERE r.message_id = $1 AND r.status = 'SENT'`,
      [messageId],
    )
    return rows[0] ?? null
  }

  /** Once per run: only the caller that flips the reason may send the fallback. */
  async claimFallback(runId) {
    const { rowCount } = await query(
      `UPDATE wa_workflow_runs SET reason = 'FALLBACK_PENDING' WHERE id = $1 AND status = 'SENT' AND (reason IS NULL OR reason NOT LIKE 'FALLBACK%')`,
      [runId],
    )
    return rowCount > 0
  }

  async setRunReason(runId, reason) {
    await query(`UPDATE wa_workflow_runs SET reason = $2 WHERE id = $1`, [runId, reason])
  }

  /**
   * Did this customer already get a cart reminder (from ANY cart-abandoned workflow) in the last N hours?
   * Counts only runs that really sent something, and never the run being processed.
   */
  async recentCartReminder(userId, hours, exceptRunId) {
    const { rows } = await query(
      `SELECT 1 FROM wa_workflow_runs r JOIN wa_workflows w ON w.id = r.workflow_id
        WHERE r.user_id = $1 AND w.trigger_type = 'CART_ABANDONED' AND r.status = 'SENT' AND r.message_id IS NOT NULL
          AND r.id <> $3 AND r.finished_at > NOW() - ($2 || ' hours')::interval LIMIT 1`,
      [userId, String(hours), exceptRunId],
    )
    return rows.length > 0
  }

  async cartStillOpen(cartId) {
    const { rows } = await query(`SELECT 1 FROM abandoned_carts WHERE id = $1 AND status = 'OPEN'`, [cartId])
    return rows.length > 0
  }

  async linkCartMessage({ cartId, messageId, runId, couponId }) {
    await query(`INSERT INTO abandoned_cart_wa_messages (abandoned_cart_id, message_id, workflow_run_id, coupon_id) VALUES ($1,$2,$3,$4)`, [cartId, messageId, runId, couponId ?? null])
    await query(`UPDATE abandoned_carts SET last_reminder_sent_at = NOW(), reminder_count = reminder_count + 1, updated_at = NOW() WHERE id = $1`, [cartId])
    if (couponId) {
      await query(`INSERT INTO abandoned_cart_coupons (abandoned_cart_id, coupon_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [cartId, couponId])
    }
  }

  async addLabel(contactId, labelId) {
    await query(
      `INSERT INTO wa_contact_labels (contact_id, label_id, source) SELECT $1, id, 'AUTO' FROM wa_labels WHERE id = $2 ON CONFLICT DO NOTHING`,
      [contactId, labelId],
    )
  }

  async labelExists(id) {
    const { rows } = await query(`SELECT 1 FROM wa_labels WHERE id = $1`, [id])
    return rows.length > 0
  }
}
