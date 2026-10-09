/**
 * Abandoned-cart workflow: one reminder per customer, and a normal message when the template cannot be delivered.
 * Real Postgres, opt-in:  WA_CRM_DB_TEST=1 npx vitest run tests/integration/whatsapp-crm-cart-fallback.db.test.js --no-file-parallelism
 * Meta is a recording fake — no real WhatsApp call is made.
 */
import crypto from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MetaApiError } from '../../src/modules/whatsapp-crm/meta-client.js'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PHONES = ['9999016001', '9999016002', '9999016003', '9999016009']
const DAYTIME = new Date()
DAYTIME.setUTCHours(6, 0, 0, 0) // 11:30 IST: outside quiet hours
const NIGHT = new Date(DAYTIME.getTime() + 11 * 3600_000) // 22:30 IST
const TEXTS = {
  gu: 'નમસ્તે {{customer_name}} 👋 તમારી Cart માં {{cart_items}} (₹{{cart_value}}) રહી ગયું છે. Order પૂરો કરો: {{cart_link}}',
  en: 'Hi {{customer_name}} 👋 you left {{cart_items}} (₹{{cart_value}}) in your cart. Complete your order: {{cart_link}}',
}

describe.skipIf(!enabled)('abandoned-cart workflow — cooldown + normal-message fallback', () => {
  let query, closePool, repo, tplRepo, sender, workflows, wRepo, inbound, client, mgr
  let clock = DAYTIME
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  let n = 0

  const customer = async (phone, name, { consent = 'OPTED_IN', messaged = false, lang = null } = {}) => {
    const userId = (await query(`INSERT INTO users (phone, name) VALUES ($1,$2) RETURNING id`, [phone, name])).rows[0].id
    await query(
      `INSERT INTO wa_contacts (wa_id, phone, user_id, profile_name, source, marketing_consent, last_inbound_at, bot_language)
       VALUES ($1,$2,$3,$4,'APP',$5, CASE WHEN $6::boolean THEN NOW() ELSE NULL END, $7)`,
      ['91' + phone, phone, userId, name, consent, messaged, lang],
    )
    return userId
  }
  const template = async () => {
    const text = 'Hey {{customer_name}}, your cart is waiting at Bakaloo. Complete it here.'
    const components = [{ type: 'BODY', text, example: { body_text_named_params: [{ param_name: 'customer_name', example: 'x' }] } }]
    return (await query(
      `INSERT INTO wa_templates (name, language, meta_category, status, components, body_text, parameter_format, meta_template_id)
       VALUES ('t16_cart','en','MARKETING','APPROVED',$1::jsonb,$2,'NAMED',$3) RETURNING *`,
      [JSON.stringify(components), text, String(Math.floor(Math.random() * 1e12))],
    )).rows[0]
  }
  async function workflow(tpl, { fallback = TEXTS, config = {} } = {}) {
    const w = await workflows.create({
      name: 'T16 cart', triggerType: 'CART_ABANDONED', triggerConfig: { delayMinutes: 5, ...config },
      actions: [{ type: 'SEND_TEMPLATE', templateId: tpl.id, values: {}, ...(fallback ? { fallbackTexts: fallback } : {}) }],
    }, mgr)
    await workflows.setActive(w.id, true)
    await query(`UPDATE wa_workflows SET activated_at = NOW() - interval '1 hour' WHERE id = $1`, [w.id])
    return w
  }
  /** A real-looking abandoned cart: two items, so {{cart_items}} has a value like it does in production. */
  const cart = async (userId, { minsAgo = 6 } = {}) => {
    const id = (await query(`INSERT INTO abandoned_carts (user_id, status, abandoned_at, detected_at, cart_value, item_count) VALUES ($1,'OPEN', NOW() - ($2 || ' minutes')::interval, NOW(), 480, 2) RETURNING id`, [userId, String(minsAgo)])).rows[0].id
    await query(`INSERT INTO abandoned_cart_items (abandoned_cart_id, product_name, quantity, unit_price, list_price, line_total) VALUES ($1,'Tomato',1,40,40,40),($1,'Onion',1,30,30,30)`, [id])
    return id
  }
  const runs = async (wfId) => (await query(`SELECT r.status, r.reason, r.message_id FROM wa_workflow_runs r JOIN users u ON u.id = r.user_id WHERE r.workflow_id = $1 AND u.phone = ANY($2) ORDER BY r.created_at`, [wfId, PHONES])).rows
  const texts = () => client.sendText.mock.calls.map((c) => c[0].body)

  async function cleanup() {
    await query(`DELETE FROM wa_workflows WHERE name LIKE 'T16 %'`)
    await query(`DELETE FROM wa_contacts WHERE phone = ANY($1)`, [PHONES])
    await query(`DELETE FROM wa_templates WHERE name LIKE 't16\\_%'`)
    await query(`DELETE FROM abandoned_carts WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [PHONES])
    await query(`DELETE FROM users WHERE phone = ANY($1)`, [PHONES])
    await query(`DELETE FROM wa_webhook_events WHERE payload::text LIKE '%wamid.T16.%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { WhatsappRepository } = await import('../../src/modules/whatsapp-crm/whatsapp.repository.js')
    const { TemplateRepository } = await import('../../src/modules/whatsapp-crm/template.repository.js')
    const { AutomatedSender } = await import('../../src/modules/whatsapp-crm/automated-sender.js')
    const { WorkflowRepository } = await import('../../src/modules/whatsapp-crm/workflow.repository.js')
    const { WorkflowService } = await import('../../src/modules/whatsapp-crm/workflow.service.js')
    const { InboundService } = await import('../../src/modules/whatsapp-crm/inbound.service.js')
    repo = new WhatsappRepository()
    tplRepo = new TemplateRepository()
    wRepo = new WorkflowRepository()
    client = { sendTemplate: vi.fn(), sendText: vi.fn() }
    sender = new AutomatedSender({ repo, tplRepo, client, emit: () => {}, logger })
    workflows = new WorkflowService({ repo: wRepo, tplRepo, sender, emit: () => {}, logger, now: () => clock, appUrl: 'https://app.test' })
    inbound = new InboundService({ repo, emit: () => {}, logger, phoneNumberId: 'PN1', workflows })
    await cleanup()
  })

  beforeEach(async () => {
    clock = DAYTIME
    client.sendTemplate.mockReset().mockImplementation(async () => ({ wamid: `wamid.T16.${++n}.${Math.random().toString(36).slice(2, 8)}` }))
    client.sendText.mockReset().mockImplementation(async () => ({ wamid: `wamid.T16.TXT${++n}.${Math.random().toString(36).slice(2, 8)}` }))
    await cleanup()
    mgr = (await query(`INSERT INTO users (phone,name,email,role) VALUES ('9999016009','T16 Manager','9999016009@t.local','ADMIN') RETURNING id`)).rows[0].id
  })

  afterAll(async () => {
    await cleanup()
    await closePool()
  })

  describe('one reminder per customer', () => {
    it('a customer who re-abandons minutes later (the 09:39 / 09:46 case) is not reminded twice', async () => {
      const u = await customer('9999016001', 'Pratham')
      const wf = await workflow(await template())
      const first = await cart(u)
      await workflows.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(1)
      await query(`UPDATE abandoned_carts SET status = 'RECOVERED' WHERE id = $1`, [first]) // bought / cleared, then…
      await cart(u) // …adds again and leaves again
      await workflows.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(1)
      expect((await runs(wf.id)).map((r) => [r.status, r.reason])).toEqual([['SENT', null], ['SKIPPED', 'RECENTLY_REMINDED']])
    })

    it('applies to a workflow created before the setting existed (no cooldown_hours stored)', async () => {
      const u = await customer('9999016001', 'Pratham')
      const wf = await workflow(await template())
      await query(`UPDATE wa_workflows SET trigger_config = trigger_config - 'cooldown_hours' WHERE id = $1`, [wf.id])
      const first = await cart(u)
      await workflows.tick()
      await query(`UPDATE abandoned_carts SET status = 'RECOVERED' WHERE id = $1`, [first])
      await cart(u)
      await workflows.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(1)
    })

    it('0 hours turns the limit off; a reminder older than the limit does not block a new one', async () => {
      const u = await customer('9999016001', 'Pratham')
      const wf = await workflow(await template(), { config: { cooldownHours: 0 } })
      const first = await cart(u)
      await workflows.tick()
      await query(`UPDATE abandoned_carts SET status = 'RECOVERED' WHERE id = $1`, [first])
      await cart(u)
      await workflows.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(2)

      await query(`UPDATE wa_workflows SET trigger_config = jsonb_set(trigger_config, '{cooldown_hours}', '24') WHERE id = $1`, [wf.id])
      await query(`UPDATE wa_workflow_runs SET finished_at = NOW() - interval '25 hours' WHERE workflow_id = $1`, [wf.id])
      await query(`UPDATE abandoned_carts SET status = 'RECOVERED' WHERE user_id = $1`, [u])
      await cart(u)
      await workflows.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(3)
    })

    it('different customers are independent', async () => {
      const a = await customer('9999016001', 'Asha')
      const b = await customer('9999016002', 'Bina')
      await workflow(await template())
      await cart(a)
      await cart(b)
      await workflows.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(2)
    })
  })

  describe('normal message when the template cannot be sent', () => {
    it('template not approved any more + customer wrote recently -> normal message in their language, with name, value, items and cart link', async () => {
      const u = await customer('9999016001', 'Asha', { messaged: true, lang: 'en' })
      const tpl = await template()
      const wf = await workflow(tpl)
      await query(`UPDATE wa_templates SET status = 'PAUSED' WHERE id = $1`, [tpl.id])
      const c = await cart(u)
      await workflows.tick()
      expect(client.sendTemplate).not.toHaveBeenCalled()
      expect(client.sendText).toHaveBeenCalledTimes(1)
      const body = texts()[0]
      expect(body).toMatch(/^Hi Asha/)
      expect(body).toContain('Tomato, Onion')
      expect(body).toContain('₹480')
      expect(body).toContain(`https://app.test/cart?utm_source=whatsapp&utm_medium=cart_reminder&wcr=${c.replace(/-/g, '').slice(0, 10)}`)
      const [run] = await runs(wf.id)
      expect(run).toMatchObject({ status: 'SENT', reason: 'FALLBACK_TEXT' })
      const msg = (await query(`SELECT msg_type, workflow_id, status FROM wa_messages WHERE id = $1`, [run.message_id])).rows[0]
      expect(msg).toMatchObject({ msg_type: 'text', workflow_id: wf.id, status: 'SENT' })
      expect((await query(`SELECT reminder_count FROM abandoned_carts WHERE id = $1`, [c])).rows[0].reminder_count).toBe(1)
    })

    it('language: unknown language -> Gujarati text; Roman-Gujarati customer with no such text -> the next available', async () => {
      const u = await customer('9999016001', 'Asha', { messaged: true, lang: null })
      const tpl = await template()
      await workflow(tpl)
      await query(`UPDATE wa_templates SET status = 'PAUSED' WHERE id = $1`, [tpl.id])
      await cart(u)
      await workflows.tick()
      expect(texts()[0]).toMatch(/^નમસ્તે Asha/)
      client.sendText.mockClear()
      await query(`UPDATE abandoned_carts SET status = 'RECOVERED' WHERE user_id = $1`, [u])
      await query(`UPDATE wa_workflow_runs SET finished_at = NOW() - interval '30 hours'`)
      await query(`UPDATE wa_contacts SET bot_language = 'gl' WHERE user_id = $1`, [u])
      await cart(u)
      await workflows.tick()
      expect(texts()[0]).toMatch(/^નમસ્તે Asha/) // no Roman text written -> Gujarati
    })

    it('an ad lead who never opted in but chatted minutes ago still gets the reminder as a normal message', async () => {
      const u = await customer('9999016002', 'Bina', { consent: 'UNKNOWN', messaged: true, lang: 'en' })
      const wf = await workflow(await template())
      await cart(u)
      await workflows.tick()
      expect(client.sendTemplate).not.toHaveBeenCalled() // marketing template needs opt-in
      expect(client.sendText).toHaveBeenCalledTimes(1)
      expect((await runs(wf.id))[0]).toMatchObject({ status: 'SENT', reason: 'FALLBACK_TEXT' })
    })

    it('Meta refusing the template at send time with the marketing limit (131049) -> normal message', async () => {
      const u = await customer('9999016001', 'Asha', { messaged: true, lang: 'en' })
      client.sendTemplate.mockRejectedValueOnce(new MetaApiError('limit', { code: 131049 }))
      await workflow(await template())
      await cart(u)
      await workflows.tick()
      expect(client.sendText).toHaveBeenCalledTimes(1)
    })

    it('NOT sent when the 24-hour window is closed (Meta would refuse a normal message)', async () => {
      const u = await customer('9999016002', 'Bina', { consent: 'UNKNOWN', messaged: false })
      const wf = await workflow(await template())
      await cart(u)
      await workflows.tick()
      expect(client.sendText).not.toHaveBeenCalled()
      expect((await runs(wf.id))[0]).toMatchObject({ status: 'SKIPPED', reason: 'NO_CONSENT' })
    })

    it('NOT sent to someone who opted out, is on the do-not-contact list, or has blocked us', async () => {
      const out = await customer('9999016001', 'Asha', { consent: 'OPTED_OUT', messaged: true })
      const sup = await customer('9999016002', 'Bina', { consent: 'OPTED_IN', messaged: true })
      await query(`INSERT INTO wa_suppression (contact_id) SELECT id FROM wa_contacts WHERE user_id = $1`, [sup])
      const blk = await customer('9999016003', 'Chitra', { consent: 'OPTED_IN', messaged: true })
      client.sendTemplate.mockRejectedValueOnce(new MetaApiError('blocked', { code: 131026 })) // not on WhatsApp / blocked
      await workflow(await template())
      await cart(out)
      await cart(sup)
      await cart(blk)
      await workflows.tick()
      expect(client.sendText).not.toHaveBeenCalled()
    })

    it('a workflow without a normal-message text behaves exactly as before', async () => {
      const u = await customer('9999016002', 'Bina', { consent: 'UNKNOWN', messaged: true })
      const wf = await workflow(await template(), { fallback: null })
      await cart(u)
      await workflows.tick()
      expect(client.sendText).not.toHaveBeenCalled()
      expect((await runs(wf.id))[0]).toMatchObject({ status: 'SKIPPED', reason: 'NO_CONSENT' })
    })

    it('night time: neither the template nor the normal message is sent (marketing quiet hours 9pm-9am)', async () => {
      const u = await customer('9999016001', 'Asha', { messaged: true })
      const wf = await workflow(await template())
      clock = NIGHT
      await cart(u)
      await workflows.tick()
      expect(client.sendTemplate).not.toHaveBeenCalled()
      expect(client.sendText).not.toHaveBeenCalled()
      expect((await runs(wf.id))[0]).toMatchObject({ status: 'SKIPPED', reason: 'QUIET_HOURS' })
    })

    it('a Meta error on the normal message itself is recorded, not retried (no duplicate)', async () => {
      const u = await customer('9999016002', 'Bina', { consent: 'UNKNOWN', messaged: true })
      client.sendText.mockRejectedValue(new MetaApiError('nope', { code: 131047 }))
      const wf = await workflow(await template())
      await cart(u)
      await workflows.tick()
      await workflows.tick()
      expect(client.sendText).toHaveBeenCalledTimes(1)
      expect((await runs(wf.id))[0]).toMatchObject({ status: 'FAILED', reason: 'FALLBACK_SEND_FAILED' })
    })
  })

  describe('template accepted by Meta, refused later (the status update)', () => {
    const failedStatus = async (wamid, code) => {
      const payload = { object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, statuses: [{ id: wamid, status: 'failed', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '919999016001', errors: [{ code, title: 'x', message: 'x' }] }] } }] }] }
      const ev = await repo.recordWebhookEvent(crypto.createHash('sha256').update(JSON.stringify(payload) + Math.random()).digest('hex'), payload)
      await inbound.processEvent(ev.id)
    }
    const setup = async (over = {}) => {
      const u = await customer('9999016001', 'Asha', { messaged: true, lang: 'en', ...over })
      const wf = await workflow(await template())
      const c = await cart(u)
      await workflows.tick()
      const wamid = (await query(`SELECT m.wamid FROM wa_workflow_runs r JOIN wa_messages m ON m.id = r.message_id WHERE r.workflow_id = $1`, [wf.id])).rows[0].wamid
      return { u, wf, c, wamid }
    }

    it('131049 (marketing limit) arrives after the send -> the normal message goes out once', async () => {
      const { wf, wamid } = await setup()
      expect(client.sendText).not.toHaveBeenCalled()
      await failedStatus(wamid, 131049)
      expect(client.sendText).toHaveBeenCalledTimes(1)
      expect(texts()[0]).toMatch(/^Hi Asha/)
      expect((await runs(wf.id))[0].reason).toBe('FALLBACK_SENT')
      await failedStatus(wamid, 131049) // Meta repeats the webhook
      expect(client.sendText).toHaveBeenCalledTimes(1)
    })

    it('opted-out / not-on-WhatsApp failures never trigger a normal message', async () => {
      const a = await setup()
      await failedStatus(a.wamid, 131050)
      expect(client.sendText).not.toHaveBeenCalled()
      expect((await runs(a.wf.id))[0].reason).toBe('FALLBACK_NOT_ALLOWED')
    })

    it('not sent if the customer already bought in the meantime', async () => {
      const { c, wamid, wf } = await setup()
      await query(`UPDATE abandoned_carts SET status = 'CONVERTED' WHERE id = $1`, [c])
      await failedStatus(wamid, 131049)
      expect(client.sendText).not.toHaveBeenCalled()
      expect((await runs(wf.id))[0].reason).toBe('FALLBACK_SKIPPED_CART_RECOVERED')
    })

    it('not sent when the window has closed, or the workflow has no normal text', async () => {
      const a = await setup()
      await query(`UPDATE wa_contacts SET last_inbound_at = NOW() - interval '30 hours' WHERE user_id = $1`, [a.u])
      await failedStatus(a.wamid, 131049)
      expect(client.sendText).not.toHaveBeenCalled()
    })

    it('a failure of an ordinary message (not a cart reminder) is ignored', async () => {
      const u = await customer('9999016001', 'Asha', { messaged: true })
      const contactId = (await query(`SELECT id FROM wa_contacts WHERE user_id = $1`, [u])).rows[0].id
      const conversationId = (await repo.withTransaction((cl) => repo.ensureConversation(contactId, cl))).id
      const m = await repo.insertOutboundQueued({ conversationId, contactId, type: 'text', body: 'hello' })
      await repo.markOutboundSent(m.id, 'wamid.T16.PLAIN1')
      await failedStatus('wamid.T16.PLAIN1', 131049)
      expect(client.sendText).not.toHaveBeenCalled()
    })
  })

  describe('setup rules', () => {
    it('rejects unknown {{tokens}}, over-long texts, and a coupon token without a coupon', async () => {
      const tpl = await template()
      const mk = (fallbackTexts) => workflows.create({ name: 'T16 bad', triggerType: 'CART_ABANDONED', triggerConfig: {}, actions: [{ type: 'SEND_TEMPLATE', templateId: tpl.id, values: {}, fallbackTexts }] }, mgr)
      await expect(mk({ en: 'Hi {{nope}}' })).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(mk({ en: 'x'.repeat(1001) })).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(mk({ en: 'Use {{coupon_code}}' })).rejects.toMatchObject({ code: 'VALIDATION' })
      const ok = await mk({ en: 'Hi {{customer_name}}', gu: '  ' })
      expect(ok.actions[0].fallbackTexts).toEqual({ en: 'Hi {{customer_name}}' }) // blank languages are dropped
      expect(ok.trigger_config).toMatchObject({ delay_minutes: 5, cooldown_hours: 24 })
    })
    it('the cooldown must be 0 to 336 hours', async () => {
      const tpl = await template()
      await expect(workflows.create({ name: 'T16 bad2', triggerType: 'CART_ABANDONED', triggerConfig: { cooldownHours: 400 }, actions: [{ type: 'SEND_TEMPLATE', templateId: tpl.id, values: {} }] }, mgr)).rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })
})
