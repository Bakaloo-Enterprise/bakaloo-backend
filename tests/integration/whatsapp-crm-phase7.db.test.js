/**
 * WhatsApp CRM Phase 7 — campaigns, consent, workflows (cart reminder + order status). Real Postgres, opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/whatsapp-crm-phase7.db.test.js
 * Meta is a recording fake — no real WhatsApp call is made.
 * Run it with the other CRM DB suites using --no-file-parallelism: they share one database, and the
 * Phase 6 template-sync test marks templates it does not know as missing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MetaApiError } from '../../src/modules/whatsapp-crm/meta-client.js'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PHONES = ['9999003001', '9999003002', '9999003003', '9999003004', '9999003005', '9999003009']
const DAYTIME = new Date('2026-10-02T06:00:00Z') // 11:30 IST — outside quiet hours
const NIGHT = new Date('2026-10-02T17:00:00Z') // 22:30 IST

describe.skipIf(!enabled)('WhatsApp CRM — campaigns & workflows', () => {
  let query, closePool, repo, tplRepo, sender, campaigns, workflows, cRepo, wRepo
  let client, mgr
  let clock = DAYTIME
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  const emitted = []

  // ── fixtures ──────────────────────────────────────────────────
  const user = async (phone, name) => (await query(`INSERT INTO users (phone, name) VALUES ($1,$2) RETURNING id`, [phone, name])).rows[0].id
  const contactOf = async (phone) => (await query(`SELECT * FROM wa_contacts WHERE phone = $1`, [phone])).rows[0]
  /** A contact for a customer, with a chosen consent and (optionally) a past inbound message. */
  async function customer(phone, name, { consent = 'UNKNOWN', messaged = false } = {}) {
    const userId = await user(phone, name)
    const c = (await query(
      `INSERT INTO wa_contacts (wa_id, phone, user_id, profile_name, source, marketing_consent, last_inbound_at)
       VALUES ($1,$2,$3,$4,'APP',$5, CASE WHEN $6::boolean THEN NOW() ELSE NULL END) RETURNING id`,
      ['91' + phone, phone, userId, name, consent, messaged],
    )).rows[0]
    return { userId, contactId: c.id }
  }
  async function template(name, { category = 'MARKETING', status = 'APPROVED', body } = {}) {
    const text = body ?? 'Hi {{customer_name}}, we have an offer for you at Bakaloo this week.'
    const vars = [...new Set([...text.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]))]
    const components = [{ type: 'BODY', text, example: { body_text_named_params: vars.map((v) => ({ param_name: v, example: 'x' })) } }]
    return (await query(
      `INSERT INTO wa_templates (name, language, meta_category, status, components, body_text, parameter_format, meta_template_id)
       VALUES ($1,'en','${category}',$2,$3::jsonb,$4,'NAMED',$5) RETURNING *`,
      [name, status, JSON.stringify(components), text, String(Math.floor(Math.random() * 1e12))],
    )).rows[0]
  }
  async function segmentWith(userIds) {
    const id = (await query(`INSERT INTO customer_segments (name) VALUES ('t7 segment') RETURNING id`)).rows[0].id
    for (const u of userIds) await query(`INSERT INTO customer_segment_members (segment_id, user_id) VALUES ($1,$2)`, [id, u])
    return id
  }
  const campaign = async (tpl, segmentId, over = {}) => campaigns.create({ name: 'T7 campaign', templateId: tpl.id, audience: { type: 'SEGMENT', ids: [segmentId] }, ...over }, mgr)
  const recipients = async (id) => (await query(`SELECT r.status, r.skip_reason, r.attempts, c.phone, r.message_id FROM wa_campaign_recipients r JOIN wa_contacts c ON c.id = r.contact_id WHERE r.campaign_id = $1 ORDER BY c.phone`, [id])).rows
  const statusOf = async (id) => (await query(`SELECT status, pause_reason FROM wa_campaigns WHERE id = $1`, [id])).rows[0]

  // scoped to this test's own customers: the dev DB may hold other people's carts and orders
  const runs = async (wfId) => (await query(`SELECT r.status, r.reason, r.message_id FROM wa_workflow_runs r JOIN users u ON u.id = r.user_id WHERE r.workflow_id = $1 AND u.phone = ANY($2) ORDER BY r.created_at`, [wfId, PHONES])).rows

  async function cleanup() {
    await query(`DELETE FROM wa_campaigns WHERE name LIKE 'T7 %'`)
    await query(`DELETE FROM wa_workflows WHERE name LIKE 'T7 %'`)
    await query(`DELETE FROM wa_contacts WHERE phone = ANY($1) OR wa_id LIKE '91999900300%'`, [PHONES])
    await query(`DELETE FROM wa_templates WHERE name LIKE 't7\\_%'`)
    await query(`DELETE FROM customer_segments WHERE name = 't7 segment'`)
    await query(`DELETE FROM coupons WHERE code LIKE 'T7%'`)
    await query(`DELETE FROM wa_labels WHERE name LIKE 'T7 %'`)
    await query(`DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [PHONES])
    await query(`DELETE FROM abandoned_carts WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [PHONES])
    await query(`DELETE FROM users WHERE phone = ANY($1)`, [PHONES])
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { WhatsappRepository } = await import('../../src/modules/whatsapp-crm/whatsapp.repository.js')
    const { TemplateRepository } = await import('../../src/modules/whatsapp-crm/template.repository.js')
    const { AutomatedSender } = await import('../../src/modules/whatsapp-crm/automated-sender.js')
    const { CampaignRepository } = await import('../../src/modules/whatsapp-crm/campaign.repository.js')
    const { CampaignService } = await import('../../src/modules/whatsapp-crm/campaign.service.js')
    const { WorkflowRepository } = await import('../../src/modules/whatsapp-crm/workflow.repository.js')
    const { WorkflowService } = await import('../../src/modules/whatsapp-crm/workflow.service.js')
    repo = new WhatsappRepository()
    tplRepo = new TemplateRepository()
    cRepo = new CampaignRepository()
    wRepo = new WorkflowRepository()
    client = { sendTemplate: vi.fn() }
    sender = new AutomatedSender({ repo, tplRepo, client, emit: (e, p) => emitted.push({ e, p }), logger })
    const now = () => clock
    campaigns = new CampaignService({ repo: cRepo, tplRepo, sender, emit: () => {}, logger, now })
    workflows = new WorkflowService({ repo: wRepo, tplRepo, sender, emit: () => {}, logger, now, appUrl: 'https://app.test' })
    await cleanup()
    mgr = (await query(`INSERT INTO users (phone,name,email,role) VALUES ('9999003009','T7 Manager','9999003009@t.local','ADMIN') RETURNING id`)).rows[0].id
  })

  beforeEach(async () => {
    clock = DAYTIME
    emitted.length = 0
    client.sendTemplate.mockReset()
    let n = 0
    client.sendTemplate.mockImplementation(async () => ({ wamid: `wamid.T7.${Date.now()}.${++n}` }))
    await cleanup()
    mgr = (await query(`INSERT INTO users (phone,name,email,role) VALUES ('9999003009','T7 Manager','9999003009@t.local','ADMIN') RETURNING id`)).rows[0].id
  })

  afterAll(async () => {
    await cleanup()
    await closePool()
  })

  // ═══ Campaigns ═══════════════════════════════════════════════
  describe('campaign audience and consent', () => {
    it('snapshots the audience: only opted-in, not suppressed contacts will be sent to', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const b = await customer('9999003002', 'Bala', { consent: 'UNKNOWN', messaged: true })
      const c = await customer('9999003003', 'Chitra', { consent: 'OPTED_OUT' })
      const d = await customer('9999003004', 'Dev', { consent: 'OPTED_IN' })
      await cRepo.suppress(d.contactId, 'complaint', mgr)
      const tpl = await template('t7_offer')
      const camp = await campaign(tpl, await segmentWith([a.userId, b.userId, c.userId, d.userId]))

      expect(await campaigns.preview(camp.id)).toEqual({ audience: 4, willSend: 1, skipped: { NO_CONSENT: 1, OPTED_OUT: 1, SUPPRESSED: 1 } })
      const launched = await campaigns.launch(camp.id)
      expect(launched).toMatchObject({ status: 'SENDING', total_recipients: 1 })
      const rows = await recipients(camp.id)
      expect(rows.map((r) => [r.phone, r.status, r.skip_reason])).toEqual([
        ['9999003001', 'PENDING', null], ['9999003002', 'SKIPPED', 'NO_CONSENT'], ['9999003003', 'SKIPPED', 'OPTED_OUT'], ['9999003004', 'SKIPPED', 'SUPPRESSED'],
      ])
    })

    it('a segment customer who never messaged us is created as a contact but never messaged (no opt-in)', async () => {
      const userId = await user('9999003005', 'Esha')
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const tpl = await template('t7_offer')
      const camp = await campaign(tpl, await segmentWith([userId, a.userId]))
      await campaigns.launch(camp.id)
      expect((await contactOf('9999003005'))).toMatchObject({ marketing_consent: 'UNKNOWN', source: 'APP' })
      await campaigns.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(1)
      expect(client.sendTemplate.mock.calls[0][0].to).toBe('919999003001')
    })

    it('refuses to launch when nobody can receive it', async () => {
      const b = await customer('9999003002', 'Bala')
      const camp = await campaign(await template('t7_offer'), await segmentWith([b.userId]))
      await expect(campaigns.launch(camp.id)).rejects.toMatchObject({ code: 'NO_RECIPIENTS', statusCode: 409 })
    })

    it('blocks an unapproved template at launch and a variable nobody can fill at save', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const seg = await segmentWith([a.userId])
      const pending = await template('t7_pending', { status: 'PENDING' })
      const camp = await campaign(pending, seg)
      await expect(campaigns.launch(camp.id)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_SENDABLE' })
      const needsCode = await template('t7_code', { body: 'Hi {{customer_name}} use {{coupon_code}} today at Bakaloo for savings' })
      await expect(campaign(needsCode, seg)).rejects.toMatchObject({ code: 'MISSING_VALUES' })
      expect((await campaign(needsCode, seg, { templateValues: { coupon_code: 'DIWALI10' } })).id).toBeTruthy()
    })
  })

  describe('campaign sending', () => {
    it('sends to each recipient once, tags the message, and completes', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const d = await customer('9999003004', 'Dev', { consent: 'OPTED_IN' })
      const tpl = await template('t7_offer')
      const camp = await campaign(tpl, await segmentWith([a.userId, d.userId]))
      await campaigns.launch(camp.id)

      await campaigns.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(2)
      expect(client.sendTemplate.mock.calls.map((c) => c[0].components[0].parameters[0].text).sort()).toEqual(['Asha', 'Dev'])
      const msgs = (await query(`SELECT campaign_id, status, template_id, sent_by FROM wa_messages WHERE campaign_id = $1`, [camp.id])).rows
      expect(msgs).toHaveLength(2)
      expect(msgs.every((m) => m.status === 'SENT' && m.template_id === tpl.id && m.sent_by === null)).toBe(true)
      expect((await statusOf(camp.id)).status).toBe('COMPLETED')

      await campaigns.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(2) // never twice
    })

    it('automated messages do not make a chat look answered or count as a person replying', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN', messaged: true })
      await query(`INSERT INTO wa_conversations (contact_id, last_message_direction, unread_count) VALUES ($1,'INBOUND',2)`, [a.contactId])
      const camp = await campaign(await template('t7_offer'), await segmentWith([a.userId]))
      await campaigns.launch(camp.id)
      await campaigns.tick()
      const conv = (await query(`SELECT last_message_direction, unread_count FROM wa_conversations WHERE contact_id = $1`, [a.contactId])).rows[0]
      expect(conv).toEqual({ last_message_direction: 'INBOUND', unread_count: 2 })
      const agentReply = (await query(
        `SELECT EXISTS (SELECT 1 FROM wa_messages m WHERE m.contact_id = $1 AND m.direction = 'OUTBOUND' AND NOT m.is_bot AND m.campaign_id IS NULL AND m.workflow_id IS NULL) AS x`, [a.contactId])).rows[0].x
      expect(agentReply).toBe(false)
    })

    it('paces by rate: 6 per minute sends one per 10-second tick', async () => {
      const users = []
      for (const p of ['9999003001', '9999003002', '9999003003']) users.push((await customer(p, 'P' + p, { consent: 'OPTED_IN' })).userId)
      const camp = await campaign(await template('t7_offer'), await segmentWith(users), { ratePerMinute: 6 })
      await campaigns.launch(camp.id)
      await campaigns.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(1)
      expect((await statusOf(camp.id)).status).toBe('SENDING')
      await campaigns.tick()
      await campaigns.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(3)
      expect((await statusOf(camp.id)).status).toBe('COMPLETED')
    })

    it('does not send marketing templates at night (IST) and resumes in the morning', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const camp = await campaign(await template('t7_offer'), await segmentWith([a.userId]))
      await campaigns.launch(camp.id)
      clock = NIGHT
      await campaigns.tick()
      expect(client.sendTemplate).not.toHaveBeenCalled()
      expect((await statusOf(camp.id)).status).toBe('SENDING')
      clock = DAYTIME
      await campaigns.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(1)
    })

    it('records an opt-out reported by Meta (131050) as a skip and remembers it', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const camp = await campaign(await template('t7_offer'), await segmentWith([a.userId]))
      await campaigns.launch(camp.id)
      client.sendTemplate.mockRejectedValueOnce(new MetaApiError('opted out', { code: 131050 }))
      await campaigns.tick()
      expect((await recipients(camp.id))[0]).toMatchObject({ status: 'SKIPPED', skip_reason: 'OPTED_OUT' })
      expect((await contactOf('9999003001')).marketing_consent).toBe('OPTED_OUT')
    })

    it('retries a temporary Meta error, then succeeds', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const camp = await campaign(await template('t7_offer'), await segmentWith([a.userId]))
      await campaigns.launch(camp.id)
      client.sendTemplate.mockRejectedValueOnce(new MetaApiError('busy', { code: 131056, retryable: true }))
      await campaigns.tick()
      expect((await recipients(camp.id))[0]).toMatchObject({ status: 'PENDING', attempts: 1 })
      await campaigns.tick()
      expect((await recipients(camp.id))[0]).toMatchObject({ status: 'SENT', attempts: 2 })
    })

    it('gives up after three temporary errors and marks the recipient failed', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const camp = await campaign(await template('t7_offer'), await segmentWith([a.userId]))
      await campaigns.launch(camp.id)
      client.sendTemplate.mockRejectedValue(new MetaApiError('busy', { code: 131056, retryable: true }))
      for (let i = 0; i < 4; i++) await campaigns.tick()
      expect((await recipients(camp.id))[0]).toMatchObject({ status: 'FAILED', attempts: 3 })
      expect((await statusOf(camp.id)).status).toBe('COMPLETED')
    })

    it('pauses itself (without losing the recipient) when Meta pauses the template', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const tpl = await template('t7_offer')
      const camp = await campaign(tpl, await segmentWith([a.userId]))
      await campaigns.launch(camp.id)
      client.sendTemplate.mockRejectedValueOnce(new MetaApiError('paused', { code: 132015 }))
      await campaigns.tick()
      expect(await statusOf(camp.id)).toMatchObject({ status: 'PAUSED' })
      expect((await recipients(camp.id))[0].status).toBe('PENDING') // not failed — resumable
      await tplRepo.patch(tpl.id, { status: 'PAUSED' })
      await expect(campaigns.resume(camp.id)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_SENDABLE' })
      await tplRepo.patch(tpl.id, { status: 'APPROVED' })
      await campaigns.resume(camp.id)
      await campaigns.tick()
      expect((await recipients(camp.id))[0].status).toBe('SENT')
    })

    it('pauses when the template is no longer approved before any send', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const tpl = await template('t7_offer')
      const camp = await campaign(tpl, await segmentWith([a.userId]))
      await campaigns.launch(camp.id)
      await tplRepo.patch(tpl.id, { status: 'DISABLED' })
      await campaigns.tick()
      expect(client.sendTemplate).not.toHaveBeenCalled()
      expect(await statusOf(camp.id)).toMatchObject({ status: 'PAUSED', pause_reason: expect.stringContaining('disabled') })
    })

    it('rechecks consent at send time: someone who opts out after launch is not messaged', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const camp = await campaign(await template('t7_offer'), await segmentWith([a.userId]))
      await campaigns.launch(camp.id)
      await query(`UPDATE wa_contacts SET marketing_consent = 'OPTED_OUT' WHERE id = $1`, [a.contactId])
      await campaigns.tick()
      expect(client.sendTemplate).not.toHaveBeenCalled()
      expect((await recipients(camp.id))[0]).toMatchObject({ status: 'SKIPPED', skip_reason: 'OPTED_OUT' })
    })

    it('pause stops sending, cancel skips what is left', async () => {
      const users = []
      for (const p of ['9999003001', '9999003002']) users.push((await customer(p, 'P' + p, { consent: 'OPTED_IN' })).userId)
      const camp = await campaign(await template('t7_offer'), await segmentWith(users), { ratePerMinute: 6 })
      await campaigns.launch(camp.id)
      await campaigns.tick()
      await campaigns.pause(camp.id)
      await campaigns.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(1)
      await campaigns.cancel(camp.id)
      expect((await statusOf(camp.id)).status).toBe('CANCELLED')
      expect((await recipients(camp.id)).map((r) => [r.status, r.skip_reason]).sort()).toEqual([['SENT', null], ['SKIPPED', 'CANCELLED']])
      await expect(campaigns.resume(camp.id)).rejects.toMatchObject({ code: 'BAD_STATE' })
    })

    it('scheduled campaigns wait for their time and cannot be launched twice', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const camp = await campaign(await template('t7_offer'), await segmentWith([a.userId]))
      await expect(campaigns.launch(camp.id, { scheduledAt: new Date(clock.getTime() + 10_000) })).rejects.toMatchObject({ code: 'BAD_SCHEDULE' })
      const at = new Date(Date.now() + 3_600_000).toISOString() // DB compares real NOW()
      expect(await campaigns.launch(camp.id, { scheduledAt: at })).toMatchObject({ status: 'SCHEDULED' })
      await campaigns.tick()
      expect(client.sendTemplate).not.toHaveBeenCalled()
      await expect(campaigns.launch(camp.id)).rejects.toMatchObject({ code: 'NOT_DRAFT' })
      await query(`UPDATE wa_campaigns SET scheduled_at = NOW() - interval '1 second' WHERE id = $1`, [camp.id])
      await campaigns.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(1)
    })

    it('two ticks at the same moment never double-send', async () => {
      const users = []
      for (const p of ['9999003001', '9999003002', '9999003003']) users.push((await customer(p, 'P' + p, { consent: 'OPTED_IN' })).userId)
      const camp = await campaign(await template('t7_offer'), await segmentWith(users))
      await campaigns.launch(camp.id)
      await Promise.all([campaigns.tick(), campaigns.tick(), campaigns.tick()])
      expect(client.sendTemplate).toHaveBeenCalledTimes(3)
      expect((await query(`SELECT COUNT(*)::int AS n FROM wa_messages WHERE campaign_id = $1`, [camp.id])).rows[0].n).toBe(3)
    })

    it('after a crash: a claimed recipient with no message is retried, one with a message is not re-sent', async () => {
      const users = []
      for (const p of ['9999003001', '9999003002']) users.push((await customer(p, 'P' + p, { consent: 'OPTED_IN' })).userId)
      const camp = await campaign(await template('t7_offer'), await segmentWith(users))
      await campaigns.launch(camp.id)
      const [r1, r2] = (await query(`SELECT r.id FROM wa_campaign_recipients r JOIN wa_contacts c ON c.id = r.contact_id WHERE r.campaign_id = $1 ORDER BY c.phone`, [camp.id])).rows
      const c2 = await contactOf('9999003002')
      const conv = (await query(`INSERT INTO wa_conversations (contact_id) VALUES ($1) ON CONFLICT (contact_id) DO UPDATE SET contact_id = EXCLUDED.contact_id RETURNING id`, [c2.id])).rows[0].id
      await query(`INSERT INTO wa_messages (contact_id, conversation_id, direction, msg_type, status) VALUES ($1,$2,'OUTBOUND','template','QUEUED')`, [c2.id, conv])
      await query(`UPDATE wa_campaign_recipients SET status='SENDING', claimed_at = NOW() - interval '10 minutes' WHERE id = ANY($1)`, [[r1.id, r2.id]])
      await query(`UPDATE wa_campaign_recipients SET message_id = (SELECT id FROM wa_messages WHERE contact_id = (SELECT contact_id FROM wa_campaign_recipients WHERE id = $1) LIMIT 1) WHERE id = $1`, [r2.id])
      await cRepo.recoverStuckRecipients()
      const rows = await recipients(camp.id)
      expect(rows[0].status).toBe('PENDING')
      expect(rows[1]).toMatchObject({ status: 'FAILED', skip_reason: 'UNKNOWN_OUTCOME' })
    })

    it('reports delivery from the real message status', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const d = await customer('9999003004', 'Dev', { consent: 'OPTED_IN' })
      const e = await customer('9999003005', 'Esha', { consent: 'OPTED_IN' })
      const camp = await campaign(await template('t7_offer'), await segmentWith([a.userId, d.userId, e.userId]))
      await campaigns.launch(camp.id)
      await campaigns.tick()
      const ids = (await recipients(camp.id)).map((r) => r.message_id)
      await query(`UPDATE wa_messages SET status = 'DELIVERED' WHERE id = $1`, [ids[0]])
      await query(`UPDATE wa_messages SET status = 'READ' WHERE id = $1`, [ids[1]])
      await query(`UPDATE wa_messages SET status = 'FAILED' WHERE id = $1`, [ids[2]])
      expect(await cRepo.stats(camp.id)).toMatchObject({ total: 3, sent: 2, delivered: 2, read: 1, failed: 1, skipped: 0, waiting: 0 })
    })

    it('only a draft can be edited or deleted', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const camp = await campaign(await template('t7_offer'), await segmentWith([a.userId]))
      expect((await campaigns.update(camp.id, { name: 'T7 renamed' })).name).toBe('T7 renamed')
      await campaigns.launch(camp.id)
      await expect(campaigns.update(camp.id, { name: 'T7 again' })).rejects.toMatchObject({ code: 'NOT_DRAFT' })
      await expect(campaigns.remove(camp.id)).rejects.toMatchObject({ code: 'NOT_DRAFT' })
    })
  })

  describe('consent recording and suppression', () => {
    it('records opt-in for valid phones, creates contacts, never overrides an opt-out, and reports bad numbers', async () => {
      await customer('9999003003', 'Chitra', { consent: 'OPTED_OUT' })
      const res = await campaigns.recordConsent({ phones: ['9999003001', '+91 99990 03002', '9999003003', '12345', '4155551212'], source: 'checkout checkbox', confirm: true })
      expect(res).toMatchObject({ recorded: 2, invalidCount: 2 })
      expect(await contactOf('9999003001')).toMatchObject({ marketing_consent: 'OPTED_IN', consent_source: 'CHECKOUT_CHECKBOX', wa_id: '919999003001' })
      expect((await contactOf('9999003002')).marketing_consent).toBe('OPTED_IN')
      expect((await contactOf('9999003003')).marketing_consent).toBe('OPTED_OUT')
    })

    it('needs an explicit confirmation and a source', async () => {
      await expect(campaigns.recordConsent({ phones: ['9999003001'], source: 'x checkbox', confirm: false })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })
      await expect(campaigns.recordConsent({ phones: ['9999003001'], source: '', confirm: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    })

    it('suppression is listed and removable', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      await campaigns.suppress(a.contactId, 'asked us to stop calling', mgr)
      expect((await campaigns.listSuppressed({})).some((s) => s.contact_id === a.contactId)).toBe(true)
      await campaigns.unsuppress(a.contactId)
      await expect(campaigns.unsuppress(a.contactId)).rejects.toMatchObject({ code: 'NOT_SUPPRESSED' })
    })
  })

  // ═══ Workflows ═══════════════════════════════════════════════
  describe('abandoned-cart reminder', () => {
    const cartTemplate = () => template('t7_cart', { body: 'Hi {{customer_name}}, your cart of Rs {{cart_value}} is waiting. Use {{coupon_code}} at Bakaloo: {{cart_link}}' })
    const coupon = async (over = {}) => (await query(
      `INSERT INTO coupons (code, discount_type, discount_value, is_active, target_type) VALUES ($1,'PERCENTAGE',10,$2,$3) RETURNING id, code`,
      [over.code ?? 'T7SAVE10', over.active ?? true, over.target ?? 'ALL'])).rows[0]
    async function workflow(tpl, over = {}) {
      const w = await workflows.create({
        name: 'T7 cart', triggerType: 'CART_ABANDONED', triggerConfig: { delayMinutes: 5 },
        actions: [{ type: 'SEND_TEMPLATE', templateId: tpl.id, values: {}, ...(over.couponId ? { couponId: over.couponId } : {}) }], ...over.input,
      }, mgr)
      return workflows.setActive(w.id, true)
    }
    const cart = async (userId, { minsAgo = 6, value = 800, items = 2 } = {}) =>
      (await query(`INSERT INTO abandoned_carts (user_id, status, abandoned_at, detected_at, cart_value, item_count) VALUES ($1,'OPEN', NOW() - ($2 || ' minutes')::interval, NOW(), $3, $4) RETURNING id`, [userId, String(minsAgo), value, items])).rows[0].id

    it('sends the reminder with name, value, coupon and cart link once the wait has passed', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const cp = await coupon()
      const wf = await workflow(await cartTemplate(), { couponId: cp.id })
      await query(`UPDATE wa_workflows SET activated_at = NOW() - interval '1 hour' WHERE id = $1`, [wf.id])
      const cartId = await cart(a.userId)

      await workflows.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(1)
      const params = client.sendTemplate.mock.calls[0][0].components[0].parameters
      expect(Object.fromEntries(params.map((p) => [p.parameter_name, p.text]))).toEqual({
        customer_name: 'Asha', cart_value: '800', coupon_code: 'T7SAVE10',
        cart_link: `https://app.test/cart?utm_source=whatsapp&utm_medium=cart_reminder&wcr=${cartId.replace(/-/g, '').slice(0, 10)}`,
      })
      const [run] = await runs(wf.id)
      expect(run).toMatchObject({ status: 'SENT' })
      expect((await query(`SELECT message_id, coupon_id FROM abandoned_cart_wa_messages WHERE abandoned_cart_id = $1`, [cartId])).rows[0]).toMatchObject({ message_id: run.message_id, coupon_id: cp.id })
      expect((await query(`SELECT reminder_count FROM abandoned_carts WHERE id = $1`, [cartId])).rows[0].reminder_count).toBe(1)
      expect((await query(`SELECT 1 FROM abandoned_cart_coupons WHERE abandoned_cart_id = $1 AND coupon_id = $2`, [cartId, cp.id])).rows).toHaveLength(1)
      expect((await query(`SELECT workflow_id FROM wa_messages WHERE id = $1`, [run.message_id])).rows[0].workflow_id).toBe(wf.id)

      await workflows.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(1) // an episode fires once
    })

    it('waits: a cart idle for only 2 minutes is not reminded; one idle for 3 hours is too old', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const b = await customer('9999003002', 'Bala', { consent: 'OPTED_IN' })
      const wf = await workflow(await cartTemplate(), { couponId: (await coupon()).id })
      await query(`UPDATE wa_workflows SET activated_at = NOW() - interval '1 day' WHERE id = $1`, [wf.id])
      await cart(a.userId, { minsAgo: 2 })
      await cart(b.userId, { minsAgo: 180 })
      await workflows.tick()
      expect(client.sendTemplate).not.toHaveBeenCalled()
      expect(await runs(wf.id)).toHaveLength(0)
    })

    it('does not back-fill carts that were abandoned before the workflow was switched on', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      await cart(a.userId)
      const wf = await workflow(await cartTemplate(), { couponId: (await coupon()).id }) // activated now, after detection
      await workflows.tick()
      expect(client.sendTemplate).not.toHaveBeenCalled()
      expect(await runs(wf.id)).toHaveLength(0)
    })

    it('skips (and says why) when conditions fail, there is no opt-in, or the coupon stopped working', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const b = await customer('9999003002', 'Bala', { consent: 'UNKNOWN', messaged: true })
      const cp = await coupon()
      const wf = await workflow(await cartTemplate(), { couponId: cp.id, input: { conditions: [{ field: 'cart_value', op: 'gt', value: 500 }] } })
      await query(`UPDATE wa_workflows SET activated_at = NOW() - interval '1 hour' WHERE id = $1`, [wf.id])
      const small = await customer('9999003003', 'Chitra', { consent: 'OPTED_IN' })
      await cart(small.userId, { value: 300 })
      await cart(b.userId)
      await workflows.tick()
      expect((await runs(wf.id)).map((r) => r.reason).sort()).toEqual(['CONDITIONS_NOT_MET', 'NO_CONSENT'])

      await query(`UPDATE coupons SET is_active = false WHERE id = $1`, [cp.id])
      await cart(a.userId)
      await workflows.tick()
      expect((await runs(wf.id)).map((r) => r.reason)).toContain('COUPON_UNAVAILABLE')
      expect(client.sendTemplate).not.toHaveBeenCalled()
    })

    it('does not send marketing reminders at night', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const wf = await workflow(await cartTemplate(), { couponId: (await coupon()).id })
      await query(`UPDATE wa_workflows SET activated_at = NOW() - interval '1 hour' WHERE id = $1`, [wf.id])
      await cart(a.userId)
      clock = NIGHT
      await workflows.tick()
      expect(client.sendTemplate).not.toHaveBeenCalled()
      expect((await runs(wf.id))[0]).toMatchObject({ status: 'SKIPPED', reason: 'QUIET_HOURS' })
    })

    it('fires once even when several workers scan at the same time', async () => {
      const users = []
      for (const p of ['9999003001', '9999003002', '9999003003']) users.push((await customer(p, 'P' + p, { consent: 'OPTED_IN' })).userId)
      const wf = await workflow(await cartTemplate(), { couponId: (await coupon()).id })
      await query(`UPDATE wa_workflows SET activated_at = NOW() - interval '1 hour' WHERE id = $1`, [wf.id])
      for (const u of users) await cart(u)
      await Promise.all([workflows.tick(), workflows.tick(), workflows.tick()])
      expect(client.sendTemplate).toHaveBeenCalledTimes(3)
      expect(await runs(wf.id)).toHaveLength(3)
    })

    it('a temporary Meta error gives the event back; the next scan sends it', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const wf = await workflow(await cartTemplate(), { couponId: (await coupon()).id })
      await query(`UPDATE wa_workflows SET activated_at = NOW() - interval '1 hour' WHERE id = $1`, [wf.id])
      await cart(a.userId)
      client.sendTemplate.mockRejectedValueOnce(new MetaApiError('busy', { code: 131056, retryable: true }))
      await workflows.tick()
      expect(await runs(wf.id)).toHaveLength(0)
      await workflows.tick()
      expect((await runs(wf.id))[0].status).toBe('SENT')
    })

    it('a run left RUNNING by a stopped worker is marked interrupted and never re-sent', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const wf = await workflow(await cartTemplate(), { couponId: (await coupon()).id })
      const cartId = await cart(a.userId)
      await query(`INSERT INTO wa_workflow_runs (workflow_id, subject_type, subject_id, user_id, status, created_at) VALUES ($1,'ABANDONED_CART',$2,$3,'RUNNING', NOW() - interval '20 minutes')`, [wf.id, cartId, a.userId])
      await workflows.tick()
      expect((await runs(wf.id))[0]).toMatchObject({ status: 'INTERRUPTED', reason: 'WORKER_STOPPED' })
      expect(client.sendTemplate).not.toHaveBeenCalled()
    })

    it('adds a label as a second action', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const label = (await query(`INSERT INTO wa_labels (name) VALUES ('T7 Cart rescue') RETURNING id`)).rows[0].id
      const tpl = await cartTemplate()
      const w = await workflows.create({
        name: 'T7 cart', triggerType: 'CART_ABANDONED', triggerConfig: { delayMinutes: 5 },
        actions: [{ type: 'SEND_TEMPLATE', templateId: tpl.id, values: { coupon_code: 'WELCOME' } }, { type: 'ADD_LABEL', labelId: label }],
      }, mgr)
      await workflows.setActive(w.id, true)
      await query(`UPDATE wa_workflows SET activated_at = NOW() - interval '1 hour' WHERE id = $1`, [w.id])
      await cart(a.userId)
      await workflows.tick()
      expect((await query(`SELECT source FROM wa_contact_labels WHERE contact_id = $1 AND label_id = $2`, [a.contactId, label])).rows[0]).toEqual({ source: 'AUTO' })
    })
  })

  describe('workflow setup rules', () => {
    it('cannot be switched on with an unapproved template, a private coupon, or no cart-link URL configured', async () => {
      const draft = await template('t7_cart', { status: 'PENDING', body: 'Hi {{customer_name}} your cart at Bakaloo is waiting for you today' })
      const w = await workflows.create({ name: 'T7 wf', triggerType: 'CART_ABANDONED', triggerConfig: {}, actions: [{ type: 'SEND_TEMPLATE', templateId: draft.id, values: {} }] }, mgr)
      await expect(workflows.setActive(w.id, true)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_SENDABLE' })

      const ok = await template('t7_cart2', { body: 'Hi {{customer_name}} your cart at Bakaloo is waiting for you today' })
      const priv = (await query(`INSERT INTO coupons (code, discount_type, discount_value, target_type) VALUES ('T7PRIV','PERCENTAGE',10,'INDIVIDUAL') RETURNING id`)).rows[0].id
      const w2 = await workflows.create({ name: 'T7 wf2', triggerType: 'CART_ABANDONED', triggerConfig: {}, actions: [{ type: 'SEND_TEMPLATE', templateId: ok.id, values: {}, couponId: priv }] }, mgr)
      await expect(workflows.setActive(w2.id, true)).rejects.toMatchObject({ code: 'COUPON_UNAVAILABLE' })

      workflows.appUrl = null
      const linky = await template('t7_link', { body: 'Hi {{customer_name}} come back to your cart: {{cart_link}} thanks from Bakaloo' })
      const w3 = await workflows.create({ name: 'T7 wf3', triggerType: 'CART_ABANDONED', triggerConfig: {}, actions: [{ type: 'SEND_TEMPLATE', templateId: linky.id, values: {} }] }, mgr)
      await expect(workflows.setActive(w3.id, true)).rejects.toMatchObject({ code: 'CART_LINK_NOT_CONFIGURED' })
      workflows.appUrl = 'https://app.test'
    })

    it('rejects a variable nobody can fill (e.g. cart_value in an order workflow)', async () => {
      const t = await template('t7_bad', { body: 'Hi {{customer_name}} your cart of {{cart_value}} at Bakaloo is waiting' })
      await expect(workflows.create({ name: 'T7 wf', triggerType: 'ORDER_STATUS', triggerConfig: { status: 'PACKED' }, actions: [{ type: 'SEND_TEMPLATE', templateId: t.id, values: {} }] }, mgr))
        .rejects.toMatchObject({ code: 'MISSING_VALUES' })
    })

    it('a coupon cannot be used in an order-status workflow, and the trigger type cannot be changed', async () => {
      const t = await template('t7_ok', { body: 'Hi {{customer_name}} your order {{order_number}} is {{order_status}} from Bakaloo' })
      await expect(workflows.create({ name: 'T7 wf', triggerType: 'ORDER_STATUS', triggerConfig: { status: 'PACKED' }, actions: [{ type: 'SEND_TEMPLATE', templateId: t.id, values: {}, couponId: '00000000-0000-4000-8000-000000000009' }] }, mgr))
        .rejects.toMatchObject({ code: 'VALIDATION' })
      const w = await workflows.create({ name: 'T7 wf', triggerType: 'ORDER_STATUS', triggerConfig: { status: 'PACKED' }, actions: [{ type: 'SEND_TEMPLATE', templateId: t.id, values: {} }] }, mgr)
      expect((await workflows.update(w.id, { triggerType: 'CART_ABANDONED', name: 'T7 renamed' })).trigger_type).toBe('ORDER_STATUS')
    })
  })

  describe('order status messages', () => {
    const orderTemplate = () => template('t7_order', { category: 'UTILITY', body: 'Hi {{customer_name}}, your Bakaloo order {{order_number}} is {{order_status}}.' })
    async function order(userId, status = 'PACKED', { minsAgo = 1, total = 640 } = {}) {
      const id = (await query(
        `INSERT INTO orders (order_number, user_id, status, items, subtotal, total_amount, delivery_address, payment_method)
         VALUES ($1,$2,$3::order_status,'[]'::jsonb,$4,$4,'{}'::jsonb,'COD') RETURNING id`,
        [`T7-${Math.floor(Math.random() * 1e8)}`, userId, status, total])).rows[0].id
      await query(`INSERT INTO order_status_history (order_id, to_status, changed_at) VALUES ($1,$2, NOW() - ($3 || ' minutes')::interval)`, [id, status, String(minsAgo)])
      return id
    }
    async function wf(tpl, status = 'PACKED') {
      const w = await workflows.setActive((await workflows.create({ name: 'T7 order', triggerType: 'ORDER_STATUS', triggerConfig: { status }, actions: [{ type: 'SEND_TEMPLATE', templateId: tpl.id, values: {} }] }, mgr)).id, true)
      await query(`UPDATE wa_workflows SET activated_at = NOW() - interval '1 hour' WHERE id = $1`, [w.id])
      return w
    }

    it('messages a customer who has chatted with us when their order is packed (utility needs no marketing opt-in)', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'UNKNOWN', messaged: true })
      const w = await wf(await orderTemplate())
      await order(a.userId, 'PACKED')
      await workflows.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(1)
      const params = client.sendTemplate.mock.calls[0][0].components[0].parameters
      expect(params.map((p) => [p.parameter_name, p.text])).toEqual([['customer_name', 'Asha'], ['order_number', expect.stringMatching(/^T7-/)], ['order_status', 'packed and ready']])
      await workflows.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(1)
      expect((await runs(w.id)).map((r) => r.status)).toEqual(['SENT'])
    })

    it('skips a customer with no consent who never messaged us, and an opted-out one', async () => {
      const a = await customer('9999003001', 'Asha')
      const c = await customer('9999003003', 'Chitra', { consent: 'OPTED_OUT', messaged: true })
      const w = await wf(await orderTemplate())
      await order(a.userId)
      await order(c.userId)
      await workflows.tick()
      expect(client.sendTemplate).not.toHaveBeenCalled()
      expect((await runs(w.id)).map((r) => r.reason).sort()).toEqual(['NO_CONSENT', 'OPTED_OUT'])
    })

    it('ignores other statuses and events older than 30 minutes (no late "packed" messages)', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const w = await wf(await orderTemplate(), 'PACKED')
      await order(a.userId, 'OUT_FOR_DELIVERY')
      await order(a.userId, 'PACKED', { minsAgo: 45 })
      await workflows.tick()
      expect(client.sendTemplate).not.toHaveBeenCalled()
      expect(await runs(w.id)).toHaveLength(0)
    })

    it('honours conditions on the order (COD only, minimum total)', async () => {
      const a = await customer('9999003001', 'Asha', { consent: 'OPTED_IN' })
      const t = await orderTemplate()
      const w = await workflows.setActive((await workflows.create({
        name: 'T7 order', triggerType: 'ORDER_STATUS', triggerConfig: { status: 'DELIVERED' },
        conditions: [{ field: 'order_total', op: 'gte', value: 500 }, { field: 'payment_method', op: 'eq', value: 'cod' }],
        actions: [{ type: 'SEND_TEMPLATE', templateId: t.id, values: {} }],
      }, mgr)).id, true)
      await query(`UPDATE wa_workflows SET activated_at = NOW() - interval '1 hour' WHERE id = $1`, [w.id])
      await order(a.userId, 'DELIVERED', { total: 300 })
      await order(a.userId, 'DELIVERED', { total: 900 })
      await workflows.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(1)
    })
  })
})
