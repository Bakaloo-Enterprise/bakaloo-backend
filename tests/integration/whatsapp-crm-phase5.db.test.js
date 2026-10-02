/**
 * WhatsApp CRM Phase 5 — rule-based bot, handoff, admin rules. Real Postgres, opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/whatsapp-crm-phase5.db.test.js
 * No real WhatsApp call is ever made: the Meta client is a recording fake.
 */
import crypto from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const WA = { a: '919999001001', b: '919999001002', c: '919999001003' }
const PHONES = ['9999001001', '9999001002', '9999001003', '9999001009']
const SHOP_SLUG = 't5-shop'

describe.skipIf(!enabled)('WhatsApp CRM — bot', () => {
  let query, closePool, repo, botRepo, bot, botAdmin, inbound, SendService, InboundService, PipelineService, PipelineRepository
  let sent // messages the fake Meta client "sent"
  let storeOpen
  let clock
  let failSend
  const emitted = []
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  const fakeClient = {
    sendText: vi.fn(async (a) => {
      if (failSend) {
        const { MetaApiError } = await import('../../src/modules/whatsapp-crm/meta-client.js')
        throw new MetaApiError('nope', { code: 131026, details: 'not on WhatsApp' })
      }
      sent.push(a)
      return { wamid: `wamid.BOT${sent.length}.${Math.random().toString(36).slice(2, 8)}` }
    }),
  }

  const conv = async (wa) => (await query(`SELECT c.*, ct.marketing_consent FROM wa_conversations c JOIN wa_contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1`, [wa])).rows[0]
  const botMsgs = async (wa) => (await query(`SELECT m.body, m.is_bot, m.status, m.bot_rule_id FROM wa_messages m JOIN wa_contacts ct ON ct.id = m.contact_id WHERE ct.wa_id = $1 AND m.is_bot ORDER BY m.created_at`, [wa])).rows
  const events = async (wa) => (await query(`SELECT e.outcome FROM wa_bot_events e JOIN wa_conversations c ON c.id = e.conversation_id JOIN wa_contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1 ORDER BY e.created_at`, [wa])).rows.map((r) => r.outcome)

  let n = 0
  /** Deliver a customer message through the REAL inbound pipeline (webhook event -> store -> bot). */
  async function customerSays(wa, text, { type = 'text', ageMs = 0, name = 'Rahul Das', extra = {} } = {}) {
    const ts = Math.floor((clock().getTime() - ageMs) / 1000)
    const msg = { from: wa, id: `wamid.T5.${++n}.${Math.random().toString(36).slice(2, 8)}`, timestamp: String(ts), type, ...extra }
    if (type === 'text') msg.text = { body: text }
    const payload = { object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, contacts: [{ wa_id: wa, profile: { name } }], messages: [msg] } }] }] }
    const ev = await repo.recordWebhookEvent(crypto.createHash('sha256').update(JSON.stringify(payload) + Math.random()).digest('hex'), payload)
    await inbound.processEvent(ev.id)
    return ev.id
  }

  async function cleanup() {
    await query(`DELETE FROM wa_contacts WHERE wa_id LIKE '91999900100%'`)
    await query(`DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [PHONES])
    await query(`DELETE FROM users WHERE phone = ANY($1)`, [PHONES])
    await query(`DELETE FROM shops WHERE slug = $1`, [SHOP_SLUG])
    await query(`DELETE FROM wa_bot_rules WHERE name LIKE 'T5 %'`)
    await query(`DELETE FROM wa_webhook_events WHERE payload::text LIKE '%wamid.T5.%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { WhatsappRepository } = await import('../../src/modules/whatsapp-crm/whatsapp.repository.js')
    const { BotRepository } = await import('../../src/modules/whatsapp-crm/bot.repository.js')
    const { BotService } = await import('../../src/modules/whatsapp-crm/bot.service.js')
    const { BotAdminService } = await import('../../src/modules/whatsapp-crm/bot-admin.service.js')
    ;({ InboundService } = await import('../../src/modules/whatsapp-crm/inbound.service.js'))
    ;({ SendService } = await import('../../src/modules/whatsapp-crm/send.service.js'))
    ;({ PipelineService } = await import('../../src/modules/whatsapp-crm/pipeline.service.js'))
    ;({ PipelineRepository } = await import('../../src/modules/whatsapp-crm/pipeline.repository.js'))
    repo = new WhatsappRepository()
    botRepo = new BotRepository()
    clock = () => new Date()
    bot = new BotService({ botRepo, repo, client: fakeClient, isStoreOpen: async () => storeOpen, emit: (e, p) => emitted.push({ e, p }), logger, now: () => clock() })
    botAdmin = new BotAdminService({ botRepo })
    inbound = new InboundService({ repo, emit: () => {}, logger, phoneNumberId: 'PN1', bot })
    await cleanup()
  })

  beforeEach(async () => {
    sent = []
    emitted.length = 0
    storeOpen = true
    failSend = false
    clock = () => new Date()
    fakeClient.sendText.mockClear()
    await query(`DELETE FROM wa_contacts WHERE wa_id LIKE '91999900100%'`)
    await query(`DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [PHONES])
    await query(`DELETE FROM users WHERE phone = ANY($1)`, [PHONES])
    await query(`DELETE FROM shops WHERE slug = $1`, [SHOP_SLUG])
    await query(`UPDATE wa_bot_settings SET enabled = true, human_pause_minutes = 720, max_replies_per_hour = 6, fallback_enabled = true, fallback_text = 'A member of our team will reply shortly.' WHERE id = 1`)
  })

  afterAll(async () => {
    await query(`UPDATE wa_bot_settings SET enabled = false WHERE id = 1`) // restore the safe default
    await cleanup()
    await closePool()
  })

  describe('safety defaults', () => {
    it('the master switch is OFF by default: nothing is auto-sent', async () => {
      await query(`UPDATE wa_bot_settings SET enabled = false WHERE id = 1`)
      await customerSays(WA.a, 'hi')
      expect(sent).toHaveLength(0)
      expect(await botMsgs(WA.a)).toHaveLength(0)
    })
    it('the shipped default really is disabled (fresh settings row)', async () => {
      const { rows } = await query(`SELECT column_default FROM information_schema.columns WHERE table_name = 'wa_bot_settings' AND column_name = 'enabled'`)
      expect(rows[0].column_default).toBe('false')
    })
  })

  describe('answering', () => {
    it('greets by first name, stores the reply as a BOT message and marks the chat answered + read', async () => {
      await customerSays(WA.a, 'Hi!')
      expect(sent).toHaveLength(1)
      expect(sent[0].body).toMatch(/^Hi Rahul, welcome to Bakaloo/)
      expect(sent[0].body).toMatch(/1 – Delivery area/)
      const m = await botMsgs(WA.a)
      expect(m).toHaveLength(1)
      expect(m[0]).toMatchObject({ is_bot: true, status: 'SENT' })
      expect(m[0].bot_rule_id).toBeTruthy()
      const c = await conv(WA.a)
      expect(c).toMatchObject({ unread_count: 0, last_message_direction: 'OUTBOUND', bot_state: 'BOT' })
      expect(await events(WA.a)).toEqual(['REPLIED'])
    })

    it('after-hours greeting is used when the store is closed', async () => {
      storeOpen = false
      await customerSays(WA.a, 'hello')
      expect(sent[0].body).toMatch(/We are closed right now/)
    })

    it('a bot reply does NOT count as an agent reply for the pipeline (still a Lead)', async () => {
      const pipe = new PipelineService({ repo: new PipelineRepository(), emit: () => {}, logger })
      await customerSays(WA.a, 'hi')
      const cid = (await conv(WA.a)).contact_id
      await pipe.evaluateContact(cid)
      expect((await query(`SELECT s.key FROM wa_contacts ct JOIN crm_stages s ON s.id = ct.stage_id WHERE ct.id = $1`, [cid])).rows[0].key).toBe('lead')
    })

    it('cooldown: a repeated greeting inside the cooldown is not answered twice', async () => {
      await customerSays(WA.a, 'hi')
      await customerSays(WA.a, 'hi')
      expect(sent).toHaveLength(1)
      expect(await events(WA.a)).toEqual(['REPLIED', 'SKIPPED_COOLDOWN'])
    })

    it('"hi, where is my order" reaches the order rule (not the bare greeting) and quotes the real latest order', async () => {
      const uid = (await query(`INSERT INTO users (phone, name) VALUES ('9999001001','Real Rahul') RETURNING id`)).rows[0].id
      await query(`INSERT INTO orders (order_number,user_id,status,items,subtotal,total_amount,delivery_address) VALUES ('T5-OLD',$1,'DELIVERED','[]',1,1,'{}')`, [uid])
      await new Promise((r) => setTimeout(r, 5))
      await query(`INSERT INTO orders (order_number,user_id,status,items,subtotal,total_amount,delivery_address) VALUES ('T5-NEW',$1,'OUT_FOR_DELIVERY','[]',1,1,'{}')`, [uid])
      await customerSays(WA.a, 'hi, where is my order?')
      expect(sent[0].body).toMatch(/^Hi Real, Your latest order T5-NEW is out for delivery\./)
    })

    it('order question from someone with no orders gets an honest answer', async () => {
      await customerSays(WA.b, 'where is my order', { name: 'New Person' })
      expect(sent[0].body).toMatch(/could not find a recent order/)
    })

    it('menu digits only count as the WHOLE message: "2 kg onions" is not "Order status"', async () => {
      await customerSays(WA.a, '2')
      expect(sent[0].body).toMatch(/latest order|could not find/)
      sent.length = 0
      await customerSays(WA.b, '2 kg onions please')
      expect(sent.every((s) => !/latest order/.test(s.body))).toBe(true)
      expect(await events(WA.b)).toEqual(['NO_MATCH'])
    })

    it('business hours reply uses the real weekly schedule wording', async () => {
      await customerSays(WA.a, 'what are your timings?')
      expect(sent[0].body).toMatch(/^We are open (from \d{1,2}:\d{2} [AP]M to \d{1,2}:\d{2} [AP]M (today|tomorrow|on \w+)|during our regular working hours)\.$/)
    })
  })

  describe('delivery area (PIN code)', () => {
    it('confirms only when an active shop LISTS the pincode', async () => {
      await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, serviceable_pincodes, is_active) VALUES ('T5 Shop', $1, 'T5', 'x', 'Kolkata', 'WB', '700099', 22.5, 88.3, ARRAY['700091','700092'], true)`, [SHOP_SLUG])
      await customerSays(WA.a, 'do you deliver to 700091?')
      expect(sent[0].body).toBe('Good news! We deliver to 700091.')
      expect((await conv(WA.a)).bot_state).toBe('BOT')
    })
    it('an unlisted pincode is NOT answered "no" — it is handed to a person', async () => {
      await customerSays(WA.a, '800001')
      expect(sent[0].body).toMatch(/could not confirm delivery to 800001/)
      expect(sent[0].body).not.toMatch(/do not deliver|don't deliver/i)
      const c = await conv(WA.a)
      expect(c).toMatchObject({ bot_state: 'HUMAN', bot_handoff_reason: 'REQUESTED' })
      expect(c.last_message_direction).toBe('INBOUND') // still waiting for a person
      expect(c.unread_count).toBe(1)
    })
    it('a phone number in the message is not mistaken for a pincode', async () => {
      await customerSays(WA.a, 'call me on 9876543210')
      expect(sent.every((s) => !/deliver to/.test(s.body))).toBe(true)
    })
  })

  describe('handoff to a human', () => {
    it('unrecognised message: fallback acknowledgement, chat goes to HUMAN and keeps waiting for a person', async () => {
      await customerSays(WA.a, 'my cat is stuck in the lift')
      expect(sent.map((s) => s.body)).toEqual(['A member of our team will reply shortly.'])
      const c = await conv(WA.a)
      expect(c).toMatchObject({ bot_state: 'HUMAN', bot_handoff_reason: 'NO_MATCH', last_message_direction: 'INBOUND', unread_count: 1 })
      expect(c.bot_paused_until).toBeTruthy()
      expect(await events(WA.a)).toEqual(['NO_MATCH'])
    })
    it('fallback ack can be turned off: still hands off, sends nothing', async () => {
      await query(`UPDATE wa_bot_settings SET fallback_enabled = false WHERE id = 1`)
      await customerSays(WA.a, 'asdf qwer')
      expect(sent).toHaveLength(0)
      expect((await conv(WA.a)).bot_state).toBe('HUMAN')
    })
    it('"talk to an agent" replies AND hands off', async () => {
      await customerSays(WA.a, 'I want to talk to an agent')
      expect(sent[0].body).toMatch(/connecting you with our team/)
      expect((await conv(WA.a)).bot_state).toBe('HUMAN')
      expect(await events(WA.a)).toEqual(['HANDOFF'])
    })
    it('payment trouble replies and hands off', async () => {
      await customerSays(WA.a, 'money deducted but no order')
      expect((await conv(WA.a)).bot_handoff_reason).toBe('REQUESTED')
    })
    it('while a person has the chat, the bot stays silent', async () => {
      await customerSays(WA.a, 'weird text zzz')
      sent.length = 0
      await customerSays(WA.a, 'hi')
      await customerSays(WA.a, 'where is my order')
      expect(sent).toHaveLength(0)
    })
    it('the bot comes back after the quiet period', async () => {
      await customerSays(WA.a, 'weird text zzz')
      await query(`UPDATE wa_conversations SET bot_paused_until = NOW() - INTERVAL '1 minute' WHERE id = $1`, [(await conv(WA.a)).id])
      sent.length = 0
      await customerSays(WA.a, 'hello')
      expect(sent).toHaveLength(1)
      expect((await conv(WA.a)).bot_state).toBe('BOT')
    })
    it('a resolved chat that reopens gets the bot back', async () => {
      await customerSays(WA.a, 'weird text zzz')
      await query(`UPDATE wa_conversations SET status = 'RESOLVED' WHERE id = $1`, [(await conv(WA.a)).id])
      sent.length = 0
      await customerSays(WA.a, 'hello')
      expect((await conv(WA.a)).status).toBe('OPEN')
      expect(sent).toHaveLength(1)
    })
    it('an agent reply pauses the bot (via the real SendService)', async () => {
      await customerSays(WA.a, 'hi')
      const c = await conv(WA.a)
      await query(`UPDATE wa_conversations SET last_inbound_at = NOW() WHERE id = $1`, [c.id])
      const svc = new SendService({ repo, client: { sendText: async () => ({ wamid: 'wamid.AGENT1' }) }, emit: () => {}, logger, bot })
      await svc.sendText({ conversationId: c.id, body: 'Hello, this is Sayan' })
      expect(await conv(WA.a)).toMatchObject({ bot_state: 'HUMAN', bot_handoff_reason: 'AGENT_REPLIED' })
      sent.length = 0
      await customerSays(WA.a, 'where is my order')
      expect(sent).toHaveLength(0)
    })
    it('"resume bot" / "take over" controls work', async () => {
      await customerSays(WA.a, 'hi')
      const id = (await conv(WA.a)).id
      await bot.setState(id, 'HUMAN')
      expect((await conv(WA.a)).bot_state).toBe('HUMAN')
      await bot.setState(id, 'BOT')
      expect(await conv(WA.a)).toMatchObject({ bot_state: 'BOT', bot_paused_until: null })
    })
  })

  describe('guards', () => {
    it('photos / voice notes go to a person; stickers are ignored', async () => {
      await customerSays(WA.a, null, { type: 'image', extra: { image: { id: 'M1', mime_type: 'image/jpeg' } } })
      expect(await events(WA.a)).toEqual(['MEDIA'])
      expect((await conv(WA.a)).bot_state).toBe('HUMAN')
      await customerSays(WA.b, null, { type: 'sticker', extra: { sticker: { id: 'S1', mime_type: 'image/webp' } } })
      expect(await events(WA.b)).toEqual([])
      expect((await conv(WA.b)).bot_state).toBe('BOT')
    })
    it('quick-reply button taps are read as text', async () => {
      await customerSays(WA.a, null, { type: 'button', extra: { button: { text: 'Need help', payload: 'help' } } })
      expect(sent[0].body).toMatch(/Reply with a number/)
    })
    it('a message older than 10 minutes (backlog after an outage) is not answered late', async () => {
      await customerSays(WA.a, 'hi', { ageMs: 11 * 60 * 1000 })
      expect(sent).toHaveLength(0)
      expect(await events(WA.a)).toEqual(['SKIPPED_STALE'])
    })
    it('rate limit: after the hourly cap the chat is handed to a person instead of looping', async () => {
      await query(`UPDATE wa_bot_settings SET max_replies_per_hour = 2 WHERE id = 1`)
      await customerSays(WA.a, 'where is my order')
      await customerSays(WA.a, 'offers')
      await customerSays(WA.a, 'timings')
      expect(sent).toHaveLength(2)
      expect(await events(WA.a)).toEqual(['REPLIED', 'REPLIED', 'RATE_LIMITED'])
      expect((await conv(WA.a)).bot_handoff_reason).toBe('RATE_LIMITED')
    })
    it('if Meta rejects the reply, it is recorded as FAILED and the chat goes to a person', async () => {
      failSend = true
      await customerSays(WA.a, 'hi')
      const m = await botMsgs(WA.a)
      expect(m[0].status).toBe('FAILED')
      expect(await events(WA.a)).toEqual(['SEND_FAILED'])
      expect((await conv(WA.a)).bot_handoff_reason).toBe('SEND_FAILED')
    })
    it('a crash inside the bot never breaks message ingestion', async () => {
      const boom = new (await import('../../src/modules/whatsapp-crm/bot.service.js')).BotService({
        botRepo: { getSettings: async () => { throw new Error('db down') }, logEvent: async () => {}, setBotState: async () => {} },
        repo, client: fakeClient, isStoreOpen: async () => true, emit: () => {}, logger,
      })
      const ib = new InboundService({ repo, emit: () => {}, logger, phoneNumberId: 'PN1', bot: boom })
      const payload = { object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, contacts: [{ wa_id: WA.c, profile: { name: 'X' } }], messages: [{ from: WA.c, id: `wamid.T5.boom.${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' } }] } }] }] }
      const ev = await repo.recordWebhookEvent(crypto.createHash('sha256').update(Math.random() + '').digest('hex'), payload)
      await expect(ib.processEvent(ev.id)).resolves.toBeTruthy()
      expect((await conv(WA.c)).unread_count).toBe(1) // message stored and visible to agents
    })
  })

  describe('opt-out / opt-in', () => {
    it('STOP records the opt-out and confirms; START opts back in', async () => {
      await customerSays(WA.a, 'STOP')
      expect(sent[0].body).toMatch(/unsubscribed/)
      expect((await conv(WA.a)).marketing_consent).toBe('OPTED_OUT')
      await customerSays(WA.a, 'start')
      expect((await conv(WA.a)).marketing_consent).toBe('OPTED_IN')
    })
    it('the word "stop" inside a sentence does NOT unsubscribe anyone', async () => {
      await customerSays(WA.a, 'please do not stop my order')
      expect((await conv(WA.a)).marketing_consent).toBe('UNKNOWN')
    })
  })

  describe('dry-run tester', () => {
    it('shows the rule and reply without sending anything or changing state', async () => {
      const r = await bot.test('hi where is my order', 'OPEN')
      expect(r).toMatchObject({ matched: true, outcome: 'REPLIED', rule: { name: 'Order status' } })
      expect(r.reply).toMatch(/\(sample\)/)
      const g = await bot.test('hello', 'CLOSED')
      expect(g.rule.name).toBe('Greeting (after hours)')
      const none = await bot.test('zzz qqq', 'NOW')
      expect(none).toMatchObject({ matched: false, outcome: 'NO_MATCH', handoff: true })
      expect(sent).toHaveLength(0)
    })
  })

  describe('admin rules', () => {
    it('create, edit (merged validation), reorder, delete', async () => {
      const r = await botAdmin.createRule({ name: 'T5 Wholesale', matchType: 'CONTAINS', keywords: ['wholesale', 'bulk order'], replyText: 'Our wholesale team will contact you.', action: 'REPLY_HANDOFF' }, null)
      expect(r.position).toBeGreaterThan(120)
      const edited = await botAdmin.updateRule(r.id, { keywords: ['wholesale', 'bulk', 'Bulk'], cooldownMinutes: 30 })
      expect(edited.keywords).toEqual(['wholesale', 'bulk']) // de-duplicated case-insensitively
      expect(edited.cooldown_minutes).toBe(30)

      const all = await botAdmin.listRules()
      const ids = all.map((x) => x.id)
      const moved = await botAdmin.reorder([r.id, ...ids.filter((i) => i !== r.id)])
      expect(moved[0].id).toBe(r.id)
      expect(moved.map((x) => x.position)).toEqual(moved.map((_, i) => (i + 1) * 10))

      await botAdmin.deleteRule(r.id)
      await expect(botAdmin.deleteRule(r.id)).rejects.toMatchObject({ code: 'RULE_NOT_FOUND' })
    })
    it('a new rule actually changes what the bot says', async () => {
      const r = await botAdmin.createRule({ name: 'T5 Bulk', matchType: 'CONTAINS', keywords: ['wholesale'], replyText: 'Hi {{customer_name}}, wholesale team here.' }, null)
      await botRepo.reorder([r.id])
      await customerSays(WA.a, 'do you do wholesale?')
      expect(sent[0].body).toBe('Hi Rahul, wholesale team here.')
    })
    it('rejects keywords that would fire inside normal sentences', async () => {
      const base = { name: 'T5 Bad', replyText: 'x', matchType: 'CONTAINS' }
      await expect(botAdmin.createRule({ ...base, keywords: ['5'] }, null)).rejects.toMatchObject({ code: 'INVALID_RULE', message: expect.stringContaining('Exact keywords') })
      await expect(botAdmin.createRule({ ...base, keywords: ['a'] }, null)).rejects.toMatchObject({ code: 'INVALID_RULE' })
      // the same keyword is fine as an exact keyword
      const ok = await botAdmin.createRule({ ...base, keywords: ['rice'], exactKeywords: ['5'] }, null)
      expect(ok.exact_keywords).toEqual(['5'])
    })
    it('requires a name, a keyword, and a reply (except for pure handoff / PIN rules)', async () => {
      await expect(botAdmin.createRule({ name: ' ', matchType: 'EXACT', keywords: ['x1'], replyText: 'r' }, null)).rejects.toMatchObject({ code: 'INVALID_RULE' })
      await expect(botAdmin.createRule({ name: 'T5 NoKw', matchType: 'EXACT', keywords: [], replyText: 'r' }, null)).rejects.toMatchObject({ code: 'INVALID_RULE' })
      await expect(botAdmin.createRule({ name: 'T5 NoReply', matchType: 'EXACT', keywords: ['hey'], action: 'REPLY' }, null)).rejects.toMatchObject({ code: 'INVALID_RULE' })
      const handoff = await botAdmin.createRule({ name: 'T5 Silent', matchType: 'EXACT', keywords: ['callback'], action: 'HANDOFF' }, null)
      expect(handoff.reply_text).toBeNull()
      await expect(botAdmin.updateRule('00000000-0000-0000-0000-000000000000', { name: 'x' })).rejects.toMatchObject({ code: 'RULE_NOT_FOUND' })
    })
    it('a silent HANDOFF rule hands off without sending anything', async () => {
      const r = await botAdmin.createRule({ name: 'T5 Silent2', matchType: 'EXACT', keywords: ['callback please'], action: 'HANDOFF' }, null)
      await botRepo.reorder([r.id])
      await customerSays(WA.a, 'callback please')
      expect(sent).toHaveLength(0)
      expect((await conv(WA.a)).bot_state).toBe('HUMAN')
    })
    it('settings: validation and persistence', async () => {
      await expect(botAdmin.updateSettings({ fallbackText: '   ' }, null)).rejects.toMatchObject({ code: 'INVALID_SETTINGS' })
      const s = await botAdmin.updateSettings({ humanPauseMinutes: 60, maxRepliesPerHour: 3 }, null)
      expect(s).toMatchObject({ human_pause_minutes: 60, max_replies_per_hour: 3 })
    })
  })
})
