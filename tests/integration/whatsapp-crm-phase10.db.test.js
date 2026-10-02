/**
 * WhatsApp CRM Phase 10 — analytics and cost. Real Postgres, opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/whatsapp-crm-phase10.db.test.js
 * Every figure is checked against a small dataset worked out by hand (see the comment on `seed`).
 * Data lives in March/April 2026 so it cannot mix with other suites' "now" data. The suite owns the
 * rate cards it adds (note 'T10'); it assumes no other price covers March 2026 on this database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PH = (n) => `9999012${String(n).padStart(3, '0')}`
const Z = (s) => new Date(`2026-${s}Z`) // '03-10T05:00:00' → that UTC instant

describe.skipIf(!enabled)('WhatsApp CRM — analytics & cost', () => {
  let query, closePool, svc, aRepo, waRepo, inbound
  let ids = {}
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  const MARCH = { from: '2026-03-10', to: '2026-03-12' }
  const APRIL = { from: '2026-04-10', to: '2026-04-10' }

  async function cleanup() {
    await query(`DELETE FROM wa_campaigns WHERE name LIKE 'T10 %'`)
    await query(`DELETE FROM wa_workflows WHERE name LIKE 'T10 %'`)
    await query(`DELETE FROM wa_contacts WHERE phone LIKE '9999012%'`)
    await query(`DELETE FROM wa_templates WHERE name LIKE 't10\\_%'`)
    await query(`DELETE FROM wa_rate_cards WHERE note LIKE 'T10%'`)
    await query(`DELETE FROM orders WHERE order_number LIKE 'T10-%'`)
    await query(`DELETE FROM users WHERE phone LIKE '9999012%'`)
  }

  const mkTemplate = async (name, category) =>
    (await query(
      `INSERT INTO wa_templates (name, language, meta_category, status, components, body_text, parameter_format, meta_template_id)
       VALUES ($1,'en',$2,'APPROVED','[{"type":"BODY","text":"Hello there friend"}]'::jsonb,'Hello there friend','NAMED',$3) RETURNING id`,
      [name, category, String(Math.floor(Math.random() * 1e12))],
    )).rows[0].id

  /** A customer with a WhatsApp contact + conversation. */
  async function person(n) {
    const userId = (await query(`INSERT INTO users (phone,name) VALUES ($1,$2) RETURNING id`, [PH(n), `T10 Cust ${n}`])).rows[0].id
    const contactId = (await query(`INSERT INTO wa_contacts (wa_id, phone, user_id, source, marketing_consent) VALUES ($1,$2,$3,'APP','OPTED_IN') RETURNING id`, ['91' + PH(n), PH(n), userId])).rows[0].id
    const convId = (await query(`INSERT INTO wa_conversations (contact_id) VALUES ($1) RETURNING id`, [contactId])).rows[0].id
    return { userId, contactId, convId }
  }

  let wamidN = 0
  /** An outbound template message with an explicit time and state. */
  async function out(p, at, status, o = {}) {
    return (await query(
      `INSERT INTO wa_messages (conversation_id, contact_id, direction, wamid, msg_type, body, template_name, status, created_at, campaign_id, workflow_id, template_id, billable, billing_category, error_code, sent_by, is_bot)
       VALUES ($1,$2,'OUTBOUND',$3,$4,'x',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, wamid`,
      [p.convId, p.contactId, `wamid.T10.${++wamidN}`, o.template === false ? 'text' : 'template', o.template === false ? null : 't10_x', status, at,
        o.campaign ?? null, o.workflow ?? null, o.tpl ?? null, o.billable ?? null, o.cat ?? null, o.err ?? null, o.by ?? null, o.bot ?? false],
    )).rows[0]
  }
  const inn = (p, at) => query(`INSERT INTO wa_messages (conversation_id, contact_id, direction, msg_type, body, status, created_at) VALUES ($1,$2,'INBOUND','text','hi','RECEIVED',$3)`, [p.convId, p.contactId, at])
  let orderN = 0
  const order = (p, at, status, total) =>
    query(`INSERT INTO orders (order_number, user_id, status, items, subtotal, total_amount, delivery_address, payment_method, created_at) VALUES ($1,$2,$3::order_status,'[]'::jsonb,$4,$4,'{}'::jsonb,'COD',$5)`, [`T10-${Date.now() % 1e6}-${++orderN}`, p.userId, status, total, at])

  /**
   * MARCH dataset (prices: MARKETING 0.80 until 10 Mar… 0.90 from 11 Mar; UTILITY 0.10), India days 10–12 Mar.
   * Campaign C1 (marketing tpl): m1 c1 DELIVERED (estimate), m2 c2 READ + Meta billable, m3 c3 DELIVERED (11th→0.90),
   *   m4 c4 FAILED, m5 c5 SENT only, m6 c1 DELIVERED but Meta says free.   Campaign C2: m7 c1 DELIVERED (12th).
   * Workflow W1 (cart reminder): m8 c4 DELIVERED.  Workflow W2 (order status, utility): m9 c5 DELIVERED.  Manual: m10 c2 utility.
   * Replies: c1 writes 1h after m1; c2 3h after m2; c3 30h after m3 (too late).
   * Orders: c2 500 PACKED 2d after m2 → C1; c3 300 8d after m3 → none (outside 7d); c1 200 CANCELLED → none;
   *   c1 100 CONFIRMED after m7 → C2 (last touch beats m1/m6); c4 250 PACKED 1d after m8 → W1; c5 400 before any campaign msg → none.
   */
  async function seedMarch() {
    const [c1, c2, c3, c4, c5] = await Promise.all([1, 2, 3, 4, 5].map(person)).then((x) => x)
    const tM = await mkTemplate('t10_marketing', 'MARKETING')
    const tU = await mkTemplate('t10_utility', 'UTILITY')
    const C1 = (await query(`INSERT INTO wa_campaigns (name, template_id, audience) VALUES ('T10 C1',$1,'{"type":"ALL_OPTED_IN","ids":[]}') RETURNING id`, [tM])).rows[0].id
    const C2 = (await query(`INSERT INTO wa_campaigns (name, template_id, audience) VALUES ('T10 C2',$1,'{"type":"ALL_OPTED_IN","ids":[]}') RETURNING id`, [tM])).rows[0].id
    const W1 = (await query(`INSERT INTO wa_workflows (name, trigger_type) VALUES ('T10 Cart','CART_ABANDONED') RETURNING id`)).rows[0].id
    const W2 = (await query(`INSERT INTO wa_workflows (name, trigger_type) VALUES ('T10 Status','ORDER_STATUS') RETURNING id`)).rows[0].id
    await query(`INSERT INTO wa_rate_cards (category, rate, effective_from, note) VALUES ('MARKETING',0.80,'2026-02-01','T10 a'),('MARKETING',0.90,'2026-03-11','T10 b'),('UTILITY',0.10,'2026-02-01','T10 c')`)

    const m1 = await out(c1, Z('03-10T05:00:00'), 'DELIVERED', { campaign: C1, tpl: tM })
    await out(c2, Z('03-10T05:00:00'), 'READ', { campaign: C1, tpl: tM, billable: true, cat: 'MARKETING' })
    await out(c3, Z('03-11T05:00:00'), 'DELIVERED', { campaign: C1, tpl: tM })
    await out(c4, Z('03-11T05:00:00'), 'FAILED', { campaign: C1, tpl: tM, err: 131049 })
    await out(c5, Z('03-11T05:00:00'), 'SENT', { campaign: C1, tpl: tM })
    await out(c1, Z('03-11T05:00:00'), 'DELIVERED', { campaign: C1, tpl: tM, billable: false, cat: 'SERVICE' })
    await out(c1, Z('03-12T03:00:00'), 'DELIVERED', { campaign: C2, tpl: tM })
    await out(c4, Z('03-10T05:00:00'), 'DELIVERED', { workflow: W1, tpl: tM })
    await out(c5, Z('03-10T05:00:00'), 'DELIVERED', { workflow: W2, tpl: tU })
    await out(c2, Z('03-12T05:00:00'), 'DELIVERED', { tpl: tU }) // manual

    await inn(c1, Z('03-10T06:00:00')); await inn(c2, Z('03-10T08:00:00')); await inn(c3, Z('03-12T11:00:00'))
    await order(c2, Z('03-12T05:00:00'), 'PACKED', 500)
    await order(c3, Z('03-19T05:00:00'), 'DELIVERED', 300)
    await order(c1, Z('03-11T12:00:00'), 'CANCELLED', 200)
    await order(c1, Z('03-12T08:00:00'), 'CONFIRMED', 100)
    await order(c4, Z('03-11T05:00:00'), 'PACKED', 250)
    await order(c5, Z('03-10T20:00:00'), 'DELIVERED', 400)
    ids = { C1, C2, W1, W2, tM, tU, m1: m1.id }
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { AnalyticsRepository } = await import('../../src/modules/whatsapp-crm/analytics.repository.js')
    const { AnalyticsService } = await import('../../src/modules/whatsapp-crm/analytics.service.js')
    const { WhatsappRepository } = await import('../../src/modules/whatsapp-crm/whatsapp.repository.js')
    const { InboundService } = await import('../../src/modules/whatsapp-crm/inbound.service.js')
    aRepo = new AnalyticsRepository()
    svc = new AnalyticsService({ repo: aRepo, now: () => new Date() })
    waRepo = new WhatsappRepository()
    inbound = new InboundService({ repo: waRepo, emit: vi.fn(), logger, phoneNumberId: 'pn1' })
  })
  beforeEach(async () => { await cleanup() })
  afterAll(async () => { await cleanup(); await closePool() })

  describe('overview — the funnel, replies, cost and orders', () => {
    it('adds up exactly like the hand-worked dataset', async () => {
      await seedMarch()
      const o = await svc.overview(MARCH)

      expect(o.range).toEqual({ from: '2026-03-10', to: '2026-03-12', days: 3, attributionDays: 7 })
      expect(Object.fromEntries(o.bySource.map((s) => [s.source, [s.sent, s.delivered, s.read, s.failed, s.replied]]))).toEqual({
        CAMPAIGN: [6, 5, 1, 1, 2], WORKFLOW: [2, 2, 0, 0, 0], MANUAL: [1, 1, 0, 0, 0],
      })
      expect(o.totals).toMatchObject({ sent: 9, delivered: 8, read: 1, failed: 1, replied: 2, orders: 3, revenue: 850, cost: 4.4 })
      expect(o.totals).toMatchObject({ delivery_rate: 88.9, read_rate: 12.5, reply_rate: 25 })

      // credited orders: C1 500 + C2 100 are campaign orders, 250 comes from the cart reminder
      const by = Object.fromEntries(o.bySource.map((s) => [s.source, [s.orders, s.revenue]]))
      expect(by).toEqual({ CAMPAIGN: [2, 600], WORKFLOW: [1, 250], MANUAL: [0, 0] })

      expect(o.failures).toEqual([{ code: 131049, title: null, count: 1 }])
    })

    it('cost: Meta’s record wins, a free message costs nothing, the price in force on the send day is used', async () => {
      await seedMarch()
      const { cost } = await svc.overview(MARCH)
      // 0.80 (m1) + 0.80 (m2) + 0.90 (m3, new price from the 11th) + 0.90 (m7) + 0.80 (m8) + 0.10 + 0.10
      expect(cost).toMatchObject({ total: 4.4, estimated: 3.6, billedMessages: 7, estimatedMessages: 6, unpricedMessages: 0, hasRates: true })
      expect(cost.byCategory).toEqual([
        { category: 'MARKETING', messages: 5, unpriced: 0, cost: 4.2 },
        { category: 'UTILITY', messages: 2, unpriced: 0, cost: 0.2 },
      ])
    })

    it('with no price entered, delivered messages are counted but flagged unpriced (never silently ₹0)', async () => {
      await seedMarch()
      await query(`DELETE FROM wa_rate_cards WHERE note LIKE 'T10%'`)
      const { cost, totals } = await svc.overview(MARCH)
      expect(cost).toMatchObject({ total: 0, unpricedMessages: 7 }) // (hasRates is global: other prices on this database would flip it)
      expect(totals.cost_per_order).toBeNull()
      expect(totals.revenue_per_rupee).toBeNull()
    })

    it('a price change takes effect on its date and old reports do not move', async () => {
      await seedMarch()
      const before = (await svc.overview({ from: '2026-03-10', to: '2026-03-10' })).cost.total
      await svc.addRateCard({ category: 'marketing', rate: 5, effectiveFrom: '2026-03-12', note: 'T10 d' }, null)
      expect((await svc.overview({ from: '2026-03-10', to: '2026-03-10' })).cost.total).toBe(before)
      const after = await svc.overview({ from: '2026-03-12', to: '2026-03-12' })
      expect(after.cost.total).toBe(5.1) // m7 now 5.00 + manual utility 0.10
    })

    it('the daily series has every day, with sends by send day and orders by the day of the message that earned them', async () => {
      await seedMarch()
      const { daily } = await svc.overview(MARCH)
      expect(daily.map((d) => d.day)).toEqual(['2026-03-10', '2026-03-11', '2026-03-12'])
      expect(daily.map((d) => [d.sent, d.delivered, d.read, d.replied, d.cost, d.orders, d.revenue])).toEqual([
        [4, 4, 1, 2, 2.5, 2, 750],
        [3, 2, 0, 0, 0.9, 0, 0],
        [2, 2, 0, 0, 1, 1, 100],
      ])
    })

    it('an empty range is all zeros, not an error', async () => {
      const o = await svc.overview({ from: '2024-01-01', to: '2024-01-03' })
      expect(o.daily).toHaveLength(3)
      expect(o.totals).toMatchObject({ sent: 0, delivered: 0, orders: 0, delivery_rate: null })
    })

    it('replies count only within 24 hours', async () => {
      await seedMarch()
      const c3 = (await query(`SELECT id FROM wa_contacts WHERE phone = $1`, [PH(3)])).rows[0].id
      expect(c3).toBeTruthy()
      const { rows } = await query(`SELECT 1 FROM wa_messages WHERE contact_id = $1 AND direction = 'INBOUND'`, [c3])
      expect(rows).toHaveLength(1) // the late reply exists…
      const o = await svc.breakdown('campaign', MARCH)
      expect(o.rows.find((r) => r.id === ids.C1).replied).toBe(2) // …but is not counted (m1, m2 only)
    })
  })

  describe('order credit (last touch within the window)', () => {
    it('credits each order once, to the latest campaign message or cart reminder before it', async () => {
      await seedMarch()
      const { rows } = await svc.breakdown('campaign', MARCH)
      const c1 = rows.find((r) => r.id === ids.C1), c2 = rows.find((r) => r.id === ids.C2)
      expect([c1.orders, c1.revenue]).toEqual([1, 500]) // c2's 500 order; c1's later order went to C2
      expect([c2.orders, c2.revenue]).toEqual([1, 100])
      const wf = (await svc.breakdown('workflow', MARCH)).rows
      expect([wf.find((r) => r.id === ids.W1).orders, wf.find((r) => r.id === ids.W1).revenue]).toEqual([1, 250])
      expect(wf.find((r) => r.id === ids.W2).orders).toBe(0) // order-status messages never earn revenue
      const total = rows.reduce((n, r) => n + r.orders, 0) + wf.reduce((n, r) => n + r.orders, 0)
      expect(total).toBe(3)
    })

    it('a shorter window drops orders that came too late; a longer one picks them up', async () => {
      await seedMarch()
      const one = await svc.overview({ ...MARCH, attributionDays: 1 })
      expect(one.totals.orders).toBe(2) // C2's 100 (5h) and W1's 250 (24h); c2's 500 came after 2 days
      const ten = await svc.overview({ ...MARCH, attributionDays: 10 })
      expect(ten.totals.orders).toBe(4) // + c3's 300 at 8 days
      expect(ten.totals.revenue).toBe(1150)
    })

    it('cancelled, refunded and unpaid-pending orders are never credited', async () => {
      await seedMarch()
      const c1 = (await query(`SELECT user_id FROM wa_contacts WHERE phone = $1`, [PH(1)])).rows[0].user_id
      for (const st of ['CANCELLED', 'REFUNDED', 'PENDING']) {
        await query(`INSERT INTO orders (order_number, user_id, status, items, subtotal, total_amount, delivery_address, payment_method, created_at) VALUES ($1,$2,$3::order_status,'[]'::jsonb,50,50,'{}'::jsonb,'COD',$4)`, [`T10-x-${st}`, c1, st, Z('03-12T09:00:00')])
      }
      expect((await svc.overview(MARCH)).totals.orders).toBe(3)
    })

    it('a customer we cannot link to an account earns no credit', async () => {
      await seedMarch()
      await query(`UPDATE wa_contacts SET user_id = NULL WHERE phone = $1`, [PH(2)])
      expect((await svc.overview(MARCH)).totals.orders).toBe(2)
    })
  })

  describe('breakdowns', () => {
    it('templates: all messages using a template, including manual sends', async () => {
      await seedMarch()
      const { rows } = await svc.breakdown('template', MARCH)
      const m = rows.find((r) => r.id === ids.tM), u = rows.find((r) => r.id === ids.tU)
      expect(m).toMatchObject({ name: 't10_marketing', category: 'MARKETING', sent: 7, delivered: 6, read: 1, failed: 1, orders: 3, revenue: 850, cost: 4.2 })
      expect(u).toMatchObject({ name: 't10_utility', sent: 2, delivered: 2, orders: 0, cost: 0.2 })
    })
    it('campaigns carry cost per order and revenue per rupee', async () => {
      await seedMarch()
      const c1 = (await svc.breakdown('campaign', MARCH)).rows.find((r) => r.id === ids.C1)
      expect(c1).toMatchObject({ name: 'T10 C1', sent: 5, delivered: 4, read: 1, failed: 1, replied: 2, cost: 2.5, orders: 1, revenue: 500, cost_per_order: 2.5, revenue_per_rupee: 200 })
      expect(c1.delivery_rate).toBe(80)
    })
    it('only things with activity in the range are listed', async () => {
      await seedMarch()
      expect((await svc.breakdown('campaign', { from: '2026-05-01', to: '2026-05-02' })).rows.filter((r) => r.name?.startsWith('T10 '))).toEqual([])
    })
    it('history from a deleted workflow is kept, folded into a single row', async () => {
      await seedMarch()
      const p = await person(6)
      for (const ghost of ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002']) await out(p, Z('03-11T05:00:00'), 'DELIVERED', { workflow: ghost, tpl: ids.tU })
      const { rows } = await svc.breakdown('workflow', MARCH)
      expect(rows.filter((r) => r.name === 'Deleted automatic messages')).toHaveLength(1)
      expect(rows.find((r) => r.id === 'deleted')).toMatchObject({ sent: 2, delivered: 2 })
      expect(rows.some((r) => r.name === '(deleted)' || r.name === null)).toBe(false)
    })
    it('an unknown report is refused', async () => {
      await expect(svc.breakdown('everything', MARCH)).rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })

  describe('inbox performance', () => {
    async function seedApril() {
      const [a, b, c, d, e] = await Promise.all([1, 2, 3, 4, 5].map(person))
      const ag1 = (await query(`INSERT INTO users (phone,name,email,role) VALUES ($1,'T10 Agent One',$2,'ADMIN') RETURNING id`, [PH(10), 't10a1@t.local'])).rows[0].id
      const ag2 = (await query(`INSERT INTO users (phone,name,email,role) VALUES ($1,'T10 Agent Two',$2,'ADMIN') RETURNING id`, [PH(11), 't10a2@t.local'])).rows[0].id
      const T = (hhmm) => Z(`04-10T${hhmm}:00`)
      const tpl = await mkTemplate('t10_apr', 'MARKETING')
      const camp = (await query(`INSERT INTO wa_campaigns (name, template_id, audience) VALUES ('T10 April',$1,'{"type":"ALL_OPTED_IN","ids":[]}') RETURNING id`, [tpl])).rows[0].id
      await out(a, T('03:30'), 'DELIVERED', { campaign: camp, tpl })               // campaign message first: not an answer
      await inn(a, T('04:30')); await out(a, T('04:35'), 'SENT', { template: false, by: ag1 })  // 5 min
      await inn(b, T('05:30')); await out(b, T('06:00'), 'SENT', { template: false, by: ag2 })  // 30 min
      await inn(c, T('06:30')); await out(c, T('06:31'), 'SENT', { template: false, bot: true })  // bot
      await inn(d, T('07:30'))                                                           // nobody
      await inn(e, T('08:30')); await inn(e, T('08:32')); await out(e, T('08:50'), 'SENT', { template: false, by: ag1 }) // 20 min from the first
      return { ag1, ag2 }
    }
    it('measures how fast people answer, separating bot and unanswered', async () => {
      const { ag1 } = await seedApril()
      const r = await svc.inbox(APRIL)
      expect(r.volume).toMatchObject({ inbound: 6, by_people: 3, by_bot: 1, automated: 1 })
      expect(r.responses).toMatchObject({ waiting_starts: 5, answered_by_people: 3, answered_by_bot: 1, unanswered: 1, within_15: 1, median_minutes: 20, p90_minutes: 28, within_15_rate: 33.3 })
      const a1 = r.agents.find((x) => x.id === ag1)
      expect(a1).toMatchObject({ name: 'T10 Agent One', messages: 2, conversations: 2, first_replies: 2, median_minutes: 12.5 })
    })
    it('a second message from the same customer does not start a new wait', async () => {
      await seedApril()
      expect((await svc.inbox(APRIL)).responses.waiting_starts).toBe(5) // six inbound messages, five waits
    })
  })

  describe('Meta billing record (pricing on delivery webhooks)', () => {
    async function sentMessage() {
      const p = await person(1)
      return out(p, new Date(), 'SENT', { tpl: await mkTemplate('t10_p', 'UTILITY') })
    }
    const st = (wamid, status, pricing) => ({ wamid, status, timestamp: new Date(), recipientId: null, error: null, pricing })
    const row = async (wamid) => (await query(`SELECT status, billable, billing_category, billing_type FROM wa_messages WHERE wamid = $1`, [wamid])).rows[0]

    it('stores billable, category and type from the delivered status', async () => {
      const m = await sentMessage()
      expect(await inbound.handleStatus(st(m.wamid, 'delivered', { billable: true, pricing_model: 'PMP', category: 'marketing', type: 'regular' }))).toBe(true)
      expect(await row(m.wamid)).toEqual({ status: 'DELIVERED', billable: true, billing_category: 'MARKETING', billing_type: 'regular' })
    })
    it('a free-in-window message is recorded as not billable', async () => {
      const m = await sentMessage()
      await inbound.handleStatus(st(m.wamid, 'delivered', { billable: false, category: 'utility', type: 'free_customer_service' }))
      expect(await row(m.wamid)).toMatchObject({ billable: false, billing_category: 'UTILITY', billing_type: 'free_customer_service' })
    })
    it('a late or repeated status still keeps the billing facts, and the status never goes backwards', async () => {
      const m = await sentMessage()
      await inbound.handleStatus(st(m.wamid, 'read', null))
      await inbound.handleStatus(st(m.wamid, 'sent', { billable: true, category: 'utility', type: 'regular' })) // arrives after "read"
      expect(await row(m.wamid)).toMatchObject({ status: 'READ', billable: true, billing_category: 'UTILITY' })
    })
    it('a status without pricing leaves what is already recorded alone', async () => {
      const m = await sentMessage()
      await inbound.handleStatus(st(m.wamid, 'delivered', { billable: true, category: 'marketing', type: 'regular' }))
      await inbound.handleStatus(st(m.wamid, 'read', null))
      expect(await row(m.wamid)).toMatchObject({ status: 'READ', billable: true, billing_category: 'MARKETING' })
    })
    it('a status for a message we do not have yet asks for a retry and does not crash', async () => {
      expect(await inbound.handleStatus(st('wamid.T10.nope', 'delivered', { billable: true, category: 'marketing' }))).toBe(false)
    })
    it('a message Meta flagged billable but that never arrived costs nothing (the flag also rides on "sent")', async () => {
      const p = await person(1)
      await query(`INSERT INTO wa_rate_cards (category, rate, effective_from, note) VALUES ('MARKETING',0.80,'2026-02-01','T10 a')`)
      const t = await mkTemplate('t10_nb', 'MARKETING')
      await out(p, Z('03-10T05:00:00'), 'SENT', { tpl: t, billable: true, cat: 'MARKETING' })
      await out(p, Z('03-10T06:00:00'), 'FAILED', { tpl: t, billable: true, cat: 'MARKETING', err: 131049 })
      await out(p, Z('03-10T07:00:00'), 'DELIVERED', { tpl: t, billable: true, cat: 'MARKETING' })
      expect((await svc.overview({ from: '2026-03-10', to: '2026-03-10' })).cost).toMatchObject({ total: 0.8, billedMessages: 1, estimatedMessages: 0 })
    })
    it('the stored billing category decides the cost, over what the template says', async () => {
      const p = await person(1)
      await query(`INSERT INTO wa_rate_cards (category, rate, effective_from, note) VALUES ('MARKETING',0.80,'2026-02-01','T10 a'),('UTILITY',0.10,'2026-02-01','T10 c')`)
      const tU = await mkTemplate('t10_u2', 'UTILITY')
      // approved as UTILITY, but Meta billed it as MARKETING (re-categorised)
      await out(p, Z('03-10T05:00:00'), 'DELIVERED', { tpl: tU, billable: true, cat: 'MARKETING' })
      expect((await svc.overview({ from: '2026-03-10', to: '2026-03-10' })).cost).toMatchObject({ total: 0.8, estimated: 0 })
    })
  })

  describe('prices (rate cards)', () => {
    it('lists newest first per category and says which one is in force and which is still to come', async () => {
      const future = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)
      await svc.addRateCard({ category: 'AUTHENTICATION', rate: 0.8, effectiveFrom: '2026-02-01', note: 'T10 a' }, null)
      await svc.addRateCard({ category: 'AUTHENTICATION', rate: 0.9, effectiveFrom: '2026-03-11', note: 'T10 b' }, null)
      const r = await svc.addRateCard({ category: 'AUTHENTICATION', rate: 1.2, effectiveFrom: future, note: 'T10 c' }, null)
      const m = r.cards.filter((c) => c.note?.startsWith('T10') && c.category === 'AUTHENTICATION')
      expect(m.map((c) => [c.rate, c.current, c.future])).toEqual([[1.2, false, true], [0.9, true, false], [0.8, false, false]])
    })
    it('"today" is the India day: a price starting today in India is in use even while UTC is still yesterday', async () => {
      const { AnalyticsService } = await import('../../src/modules/whatsapp-crm/analytics.service.js')
      const lateEveningUtc = new Date('2026-10-01T19:00:00Z') // 00:30 on 2 Oct in India
      const s2 = new AnalyticsService({ repo: aRepo, now: () => lateEveningUtc })
      await s2.addRateCard({ category: 'AUTHENTICATION', rate: 0.5, effectiveFrom: '2026-10-02', note: 'T10 today' }, null)
      const card = (await s2.rateCards()).cards.find((c) => c.note === 'T10 today')
      expect(card).toMatchObject({ current: true, future: false })
    })
    it('refuses a second price for the same category and day', async () => {
      await svc.addRateCard({ category: 'UTILITY', rate: 0.1, effectiveFrom: '2026-02-01', note: 'T10 a' }, null)
      await expect(svc.addRateCard({ category: 'UTILITY', rate: 0.2, effectiveFrom: '2026-02-01', note: 'T10 b' }, null)).rejects.toMatchObject({ statusCode: 409, code: 'RATE_EXISTS' })
    })
    it('a price already in effect cannot be removed; one still to come can', async () => {
      const future = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)
      await svc.addRateCard({ category: 'UTILITY', rate: 0.1, effectiveFrom: '2026-02-01', note: 'T10 a' }, null)
      const r = await svc.addRateCard({ category: 'UTILITY', rate: 0.2, effectiveFrom: future, note: 'T10 b' }, null)
      const past = r.cards.find((c) => c.note === 'T10 a'), soon = r.cards.find((c) => c.note === 'T10 b')
      await expect(svc.removeRateCard(past.id)).rejects.toMatchObject({ statusCode: 409, code: 'RATE_IN_EFFECT' })
      await svc.removeRateCard(soon.id)
      expect((await svc.rateCards()).cards.some((c) => c.id === soon.id)).toBe(false)
      await expect(svc.removeRateCard('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ statusCode: 404 })
    })
    it('validates input', async () => {
      await expect(svc.addRateCard({ category: 'NOPE', rate: -1, effectiveFrom: 'x' }, null)).rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })
})
