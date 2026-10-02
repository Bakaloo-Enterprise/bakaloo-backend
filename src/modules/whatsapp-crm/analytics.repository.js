import { query } from '../../config/database.js'

/**
 * Read-only reports over the CRM's own records (Phase 10). Nothing is stored here except rate cards.
 *
 * Shared definitions (mirrored by the pure rules in analytics.js):
 *  - a "template message" is an outbound message with a template name; its source is CAMPAIGN, WORKFLOW
 *    or MANUAL (a person sent a template from the inbox)
 *  - sent = left us (SENT/DELIVERED/READ); delivered = DELIVERED/READ; read = READ
 *  - replied = the customer wrote back within 24 hours
 *  - cost = DELIVERED messages × the rate card in force on the send date, India time. Meta's billing record can only
 *    make a delivered message free (billable = false) or fix its category; a message that never arrived costs nothing
 *    even if Meta's pricing block (which also rides on the earlier "sent" status) says billable
 *  - an order is credited to the LAST campaign message or cart reminder sent to that customer within the
 *    order window before it was placed ("placed" = not PENDING / CANCELLED / REFUNDED). Order-status
 *    updates are never credited with revenue: they follow an order, they don't cause one.
 *
 * $1 = start (inclusive), $2 = end (exclusive), $3 = order window in days.
 */

const MSGS_CTE = `
msgs AS (
  SELECT m.id, m.contact_id, m.created_at, m.status, m.campaign_id, m.workflow_id, m.template_id,
         CASE WHEN m.campaign_id IS NOT NULL THEN 'CAMPAIGN' WHEN m.workflow_id IS NOT NULL THEN 'WORKFLOW' ELSE 'MANUAL' END AS source,
         COALESCE(m.billing_category, t.meta_category) AS category,
         (m.status IN ('DELIVERED','READ') AND m.billable IS NOT FALSE) AS counted,
         (m.billable IS NULL) AS estimated,
         EXISTS (SELECT 1 FROM wa_messages i WHERE i.contact_id = m.contact_id AND i.direction = 'INBOUND'
                    AND i.created_at > m.created_at AND i.created_at <= m.created_at + interval '24 hours') AS replied
    FROM wa_messages m LEFT JOIN wa_templates t ON t.id = m.template_id
   WHERE m.direction = 'OUTBOUND' AND m.template_name IS NOT NULL AND m.created_at >= $1 AND m.created_at < $2
),
priced AS (
  SELECT x.*, r.rate,
         (x.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day
    FROM msgs x
    LEFT JOIN LATERAL (
      SELECT c.rate FROM wa_rate_cards c
       WHERE c.category = x.category AND c.effective_from <= (x.created_at AT TIME ZONE 'Asia/Kolkata')::date
       ORDER BY c.effective_from DESC LIMIT 1
    ) r ON TRUE
)`

const ATTRIBUTION_CTE = `
touches AS (
  SELECT m.id AS msg_id, m.campaign_id, m.workflow_id, m.template_id, c.user_id, m.created_at AS touch_at,
         (m.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day
    FROM wa_messages m
    JOIN wa_contacts c ON c.id = m.contact_id
    LEFT JOIN wa_workflows w ON w.id = m.workflow_id
   WHERE m.direction = 'OUTBOUND' AND m.status IN ('SENT','DELIVERED','READ') AND c.user_id IS NOT NULL
     AND (m.campaign_id IS NOT NULL OR w.trigger_type = 'CART_ABANDONED')
     AND m.created_at >= $1::timestamptz - ($3::int * interval '1 day') AND m.created_at < $2::timestamptz + ($3::int * interval '1 day')
),
attributed AS (
  SELECT DISTINCT ON (o.id) o.id AS order_id, o.total_amount, t.campaign_id, t.workflow_id, t.template_id, t.touch_at, t.day
    FROM touches t
    JOIN orders o ON o.user_id = t.user_id AND o.created_at > t.touch_at
                 AND o.created_at <= t.touch_at + ($3::int * interval '1 day')
                 AND o.status NOT IN ('PENDING','CANCELLED','REFUNDED')
   ORDER BY o.id, t.touch_at DESC
),
credited AS (
  SELECT * FROM attributed WHERE touch_at >= $1 AND touch_at < $2
)`

const DIMENSIONS = {
  campaign: { msgKey: 'campaign_id', attrKey: 'campaign_id', table: 'wa_campaigns', name: 'k.name', extra: `(SELECT t.name FROM wa_templates t WHERE t.id = k.template_id) AS template_name, k.status AS campaign_status` },
  workflow: { msgKey: 'workflow_id', attrKey: 'workflow_id', table: 'wa_workflows', name: 'k.name', extra: `k.trigger_type AS trigger_type` },
  template: { msgKey: 'template_id', attrKey: 'template_id', table: 'wa_templates', name: 'k.name', extra: `k.meta_category AS category, k.status AS template_status` },
}

export class AnalyticsRepository {
  /** Funnel, replies, cost and credited orders for the window. */
  async overview(start, end, attributionDays) {
    const p = [start, end, attributionDays]
    const [bySource, cost, failures, orders, optOuts, contacts] = await Promise.all([
      query(
        `WITH ${MSGS_CTE}
         SELECT source,
                COUNT(*) FILTER (WHERE status IN ('SENT','DELIVERED','READ'))::int AS sent,
                COUNT(*) FILTER (WHERE status IN ('DELIVERED','READ'))::int AS delivered,
                COUNT(*) FILTER (WHERE status = 'READ')::int AS read,
                COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
                COUNT(*) FILTER (WHERE status IN ('DELIVERED','READ') AND replied)::int AS replied
           FROM msgs GROUP BY source`,
        p.slice(0, 2),
      ),
      query(
        `WITH ${MSGS_CTE}
         SELECT COALESCE(category, 'UNKNOWN') AS category,
                COUNT(*) FILTER (WHERE counted)::int AS messages,
                COUNT(*) FILTER (WHERE counted AND estimated)::int AS estimated_messages,
                COUNT(*) FILTER (WHERE counted AND rate IS NULL)::int AS unpriced,
                COALESCE(SUM(rate) FILTER (WHERE counted), 0)::float8 AS cost,
                COALESCE(SUM(rate) FILTER (WHERE counted AND estimated), 0)::float8 AS estimated_cost
           FROM priced GROUP BY 1 HAVING COUNT(*) FILTER (WHERE counted) > 0 ORDER BY 1`,
        p.slice(0, 2),
      ),
      query(
        `SELECT m.error_code, MAX(m.error_title) AS title, COUNT(*)::int AS n
           FROM wa_messages m
          WHERE m.direction = 'OUTBOUND' AND m.template_name IS NOT NULL AND m.status = 'FAILED' AND m.created_at >= $1 AND m.created_at < $2
          GROUP BY m.error_code ORDER BY n DESC LIMIT 5`,
        p.slice(0, 2),
      ),
      query(
        `WITH ${ATTRIBUTION_CTE}
         SELECT (CASE WHEN campaign_id IS NOT NULL THEN 'CAMPAIGN' ELSE 'WORKFLOW' END) AS source,
                COUNT(*)::int AS orders, COALESCE(SUM(total_amount), 0)::float8 AS revenue
           FROM credited GROUP BY 1`,
        p,
      ),
      query(
        `SELECT COUNT(*)::int AS n FROM wa_contacts WHERE marketing_consent = 'OPTED_OUT' AND consent_updated_at >= $1 AND consent_updated_at < $2`,
        p.slice(0, 2),
      ),
      query(`SELECT COUNT(*)::int AS n FROM wa_contacts WHERE created_at >= $1 AND created_at < $2`, p.slice(0, 2)),
    ])
    return { bySource: bySource.rows, cost: cost.rows, failures: failures.rows, orders: orders.rows, optOuts: optOuts.rows[0].n, newContacts: contacts.rows[0].n }
  }

  /** One row per day (India time) by the day the message was sent. */
  async daily(start, end, attributionDays) {
    const p = [start, end, attributionDays]
    const [msgs, orders] = await Promise.all([
      query(
        `WITH ${MSGS_CTE}
         SELECT day::text AS day,
                COUNT(*) FILTER (WHERE status IN ('SENT','DELIVERED','READ'))::int AS sent,
                COUNT(*) FILTER (WHERE status IN ('DELIVERED','READ'))::int AS delivered,
                COUNT(*) FILTER (WHERE status = 'READ')::int AS read,
                COUNT(*) FILTER (WHERE status IN ('DELIVERED','READ') AND replied)::int AS replied,
                COALESCE(SUM(rate) FILTER (WHERE counted), 0)::float8 AS cost
           FROM priced GROUP BY day ORDER BY day`,
        p.slice(0, 2),
      ),
      query(
        `WITH ${ATTRIBUTION_CTE}
         SELECT day::text AS day, COUNT(*)::int AS orders, COALESCE(SUM(total_amount), 0)::float8 AS revenue FROM credited GROUP BY day`,
        p,
      ),
    ])
    const ord = new Map(orders.rows.map((r) => [r.day, r]))
    const days = new Set([...msgs.rows.map((r) => r.day), ...ord.keys()])
    const msgBy = new Map(msgs.rows.map((r) => [r.day, r]))
    return [...days].sort().map((day) => ({ ...(msgBy.get(day) ?? {}), ...(ord.get(day) ?? {}), day }))
  }

  /** Campaigns, workflows or templates side by side. */
  async breakdown(by, start, end, attributionDays) {
    const d = DIMENSIONS[by]
    const p = [start, end, attributionDays]
    const [msgs, orders] = await Promise.all([
      query(
        `WITH ${MSGS_CTE}
         SELECT ${d.msgKey} AS id,
                COUNT(*) FILTER (WHERE status IN ('SENT','DELIVERED','READ'))::int AS sent,
                COUNT(*) FILTER (WHERE status IN ('DELIVERED','READ'))::int AS delivered,
                COUNT(*) FILTER (WHERE status = 'READ')::int AS read,
                COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
                COUNT(*) FILTER (WHERE status IN ('DELIVERED','READ') AND replied)::int AS replied,
                COALESCE(SUM(rate) FILTER (WHERE counted), 0)::float8 AS cost,
                COUNT(*) FILTER (WHERE counted AND rate IS NULL)::int AS unpriced
           FROM priced WHERE ${d.msgKey} IS NOT NULL GROUP BY ${d.msgKey}`,
        p.slice(0, 2),
      ),
      query(
        `WITH ${ATTRIBUTION_CTE}
         SELECT ${d.attrKey} AS id, COUNT(*)::int AS orders, COALESCE(SUM(total_amount), 0)::float8 AS revenue
           FROM credited WHERE ${d.attrKey} IS NOT NULL GROUP BY ${d.attrKey}`,
        p,
      ),
    ])
    const ids = [...new Set([...msgs.rows.map((r) => r.id), ...orders.rows.map((r) => r.id)])]
    if (!ids.length) return []
    const { rows: names } = await query(`SELECT k.id, ${d.name} AS name, ${d.extra} FROM ${d.table} k WHERE k.id = ANY($1::uuid[])`, [ids])
    const nameBy = new Map(names.map((r) => [r.id, r]))
    const msgBy = new Map(msgs.rows.map((r) => [r.id, r]))
    const ordBy = new Map(orders.rows.map((r) => [r.id, r]))
    return ids.map((id) => ({ ...(nameBy.get(id) ?? { name: null, deleted: true }), ...(msgBy.get(id) ?? {}), ...(ordBy.get(id) ?? {}), id }))
  }

  /** How quickly people answer customers, plus who sent what. */
  async inbox(start, end) {
    const p = [start, end]
    const [volume, starts, perAgent, bot] = await Promise.all([
      query(
        `SELECT COUNT(*) FILTER (WHERE direction = 'INBOUND')::int AS inbound,
                COUNT(*) FILTER (WHERE direction = 'OUTBOUND' AND sent_by IS NOT NULL AND NOT is_bot AND campaign_id IS NULL AND workflow_id IS NULL)::int AS by_people,
                COUNT(*) FILTER (WHERE direction = 'OUTBOUND' AND is_bot)::int AS by_bot,
                COUNT(*) FILTER (WHERE direction = 'OUTBOUND' AND (campaign_id IS NOT NULL OR workflow_id IS NOT NULL))::int AS automated
           FROM wa_messages WHERE created_at >= $1 AND created_at < $2`,
        p,
      ),
      query(
        `WITH ordered AS (
           SELECT id, conversation_id, direction, created_at,
                  LAG(direction) OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS prev
             FROM wa_messages WHERE created_at >= $1::timestamptz - interval '1 day' AND created_at < $2::timestamptz
         ), s AS (
           SELECT o.id, o.conversation_id, o.created_at FROM ordered o
            WHERE o.direction = 'INBOUND' AND (o.prev IS NULL OR o.prev = 'OUTBOUND') AND o.created_at >= $1
         ), r AS (
           SELECT s.id, f.is_bot, f.sent_by, EXTRACT(EPOCH FROM (f.created_at - s.created_at)) / 60.0 AS minutes
             FROM s LEFT JOIN LATERAL (
               SELECT x.created_at, x.is_bot, x.sent_by FROM wa_messages x
                WHERE x.conversation_id = s.conversation_id AND x.direction = 'OUTBOUND' AND x.created_at > s.created_at
                  AND x.campaign_id IS NULL AND x.workflow_id IS NULL
                ORDER BY x.created_at LIMIT 1) f ON TRUE
         )
         SELECT COUNT(*)::int AS waiting_starts,
                COUNT(*) FILTER (WHERE is_bot IS FALSE)::int AS answered_by_people,
                COUNT(*) FILTER (WHERE is_bot IS TRUE)::int AS answered_by_bot,
                COUNT(*) FILTER (WHERE is_bot IS NULL)::int AS unanswered,
                COUNT(*) FILTER (WHERE is_bot IS FALSE AND minutes <= 15)::int AS within_15,
                (percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes) FILTER (WHERE is_bot IS FALSE))::float8 AS median_minutes,
                (percentile_cont(0.9) WITHIN GROUP (ORDER BY minutes) FILTER (WHERE is_bot IS FALSE))::float8 AS p90_minutes
           FROM r`,
        p,
      ),
      query(
        `WITH ordered AS (
           SELECT id, conversation_id, direction, created_at,
                  LAG(direction) OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS prev
             FROM wa_messages WHERE created_at >= $1::timestamptz - interval '1 day' AND created_at < $2::timestamptz
         ), s AS (
           SELECT o.conversation_id, o.created_at FROM ordered o
            WHERE o.direction = 'INBOUND' AND (o.prev IS NULL OR o.prev = 'OUTBOUND') AND o.created_at >= $1
         ), f AS (
           SELECT x.sent_by, EXTRACT(EPOCH FROM (x.created_at - s.created_at)) / 60.0 AS minutes
             FROM s JOIN LATERAL (
               SELECT y.created_at, y.sent_by, y.is_bot FROM wa_messages y
                WHERE y.conversation_id = s.conversation_id AND y.direction = 'OUTBOUND' AND y.created_at > s.created_at
                  AND y.campaign_id IS NULL AND y.workflow_id IS NULL
                ORDER BY y.created_at LIMIT 1) x ON NOT x.is_bot AND x.sent_by IS NOT NULL
         ), sent AS (
           SELECT sent_by, COUNT(*)::int AS messages, COUNT(DISTINCT conversation_id)::int AS conversations
             FROM wa_messages WHERE direction = 'OUTBOUND' AND sent_by IS NOT NULL AND NOT is_bot AND campaign_id IS NULL AND workflow_id IS NULL
              AND created_at >= $1 AND created_at < $2 GROUP BY sent_by
         )
         SELECT u.id, u.name, sent.messages, sent.conversations,
                (SELECT COUNT(*)::int FROM f WHERE f.sent_by = u.id) AS first_replies,
                (SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes))::float8 FROM f WHERE f.sent_by = u.id) AS median_minutes
           FROM sent JOIN users u ON u.id = sent.sent_by ORDER BY sent.messages DESC LIMIT 50`,
        p,
      ),
      query(`SELECT outcome, COUNT(*)::int AS n FROM wa_bot_events WHERE created_at >= $1 AND created_at < $2 GROUP BY outcome ORDER BY n DESC`, p),
    ])
    return { volume: volume.rows[0], responses: starts.rows[0], agents: perAgent.rows, bot: bot.rows }
  }

  // ─── Rate cards ──────────────────────────────────────────────────
  async listRateCards() {
    const { rows } = await query(
      `SELECT c.id, c.category, c.rate::float8 AS rate, c.effective_from::text AS effective_from, c.note, c.created_at, u.name AS created_by_name
         FROM wa_rate_cards c LEFT JOIN users u ON u.id = c.created_by
        ORDER BY c.category, c.effective_from DESC`,
    )
    return rows
  }

  /** Returns null when this category already has a version on that date. */
  async addRateCard({ category, rate, effectiveFrom, note }, userId) {
    const { rows } = await query(
      `INSERT INTO wa_rate_cards (category, rate, effective_from, note, created_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (category, effective_from) DO NOTHING RETURNING id`,
      [category, rate, effectiveFrom, note, userId],
    )
    return rows[0]?.id ?? null
  }

  /** Only a version that has not taken effect yet can be removed: history must not change under old reports. */
  async removeFutureRateCard(id) {
    const { rowCount } = await query(`DELETE FROM wa_rate_cards WHERE id = $1 AND effective_from > (NOW() AT TIME ZONE 'Asia/Kolkata')::date`, [id])
    return rowCount > 0
  }

  async rateCardExists(id) {
    const { rowCount } = await query(`SELECT 1 FROM wa_rate_cards WHERE id = $1`, [id])
    return rowCount > 0
  }
}
