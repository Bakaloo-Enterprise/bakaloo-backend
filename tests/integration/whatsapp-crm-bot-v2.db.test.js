/**
 * WhatsApp bot v2 — replays REAL customer messages from the 4–9 Oct 2026 export through the bot. Real Postgres, opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/whatsapp-crm-bot-v2.db.test.js
 * No WhatsApp call is made: the Meta client is a recording fake.
 */
import crypto from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const WA = '919999002001'
const SHOP_SLUG = 't16-shop'
const SLUGS = ['t16-lemon', 't16-lemon-out', 't16-milk']

describe.skipIf(!enabled)('WhatsApp bot v2 — real chats', () => {
  let query, closePool, repo, botRepo, bot, botAdmin, inbound
  let sent
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  const fakeClient = { sendText: vi.fn(async (a) => { sent.push(a); return { wamid: `wamid.BOT.${sent.length}.${Math.random().toString(36).slice(2, 8)}` } }) }
  let n = 0

  async function say(text, { type = 'text', extra = {}, wa = WA, source = null } = {}) {
    const msg = { from: wa, id: `wamid.T16.${++n}.${Math.random().toString(36).slice(2, 8)}`, timestamp: String(Math.floor(Date.now() / 1000)), type, ...extra }
    if (type === 'text') msg.text = { body: text }
    const value = { metadata: { phone_number_id: 'PN1' }, contacts: [{ wa_id: wa, profile: { name: '' } }], messages: [msg] }
    if (source === 'ad') msg.referral = { source_url: 'https://fb.me/x', source_type: 'ad', headline: 'Bakaloo' }
    const payload = { object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value }] }] }
    const ev = await repo.recordWebhookEvent(crypto.createHash('sha256').update(JSON.stringify(payload) + Math.random()).digest('hex'), payload)
    await inbound.processEvent(ev.id)
    return sent.at(-1)?.body ?? null
  }
  const contact = async (wa = WA) => (await query(`SELECT ct.*, a.name AS area_name FROM wa_contacts ct LEFT JOIN wa_service_areas a ON a.id = ct.service_area_id WHERE ct.wa_id = $1`, [wa])).rows[0]
  const events = async (wa = WA) => (await query(`SELECT e.outcome FROM wa_bot_events e JOIN wa_conversations c ON c.id = e.conversation_id JOIN wa_contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1 ORDER BY e.created_at, e.id`, [wa])).rows.map((r) => r.outcome)

  async function clean() {
    await query(`DELETE FROM wa_contacts WHERE wa_id LIKE '91999900200%'`)
    await query(`DELETE FROM shop_products WHERE shop_id IN (SELECT id FROM shops WHERE slug = $1)`, [SHOP_SLUG])
    await query(`DELETE FROM products WHERE slug = ANY($1)`, [SLUGS])
    await query(`DELETE FROM shops WHERE slug = $1`, [SHOP_SLUG])
    await query(`DELETE FROM wa_webhook_events WHERE payload::text LIKE '%wamid.T16.%'`)
    await query(`DELETE FROM wa_service_areas WHERE name LIKE 'T16 %'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { WhatsappRepository } = await import('../../src/modules/whatsapp-crm/whatsapp.repository.js')
    const { BotRepository } = await import('../../src/modules/whatsapp-crm/bot.repository.js')
    const { BotService } = await import('../../src/modules/whatsapp-crm/bot.service.js')
    const { BotAdminService } = await import('../../src/modules/whatsapp-crm/bot-admin.service.js')
    const { InboundService } = await import('../../src/modules/whatsapp-crm/inbound.service.js')
    repo = new WhatsappRepository()
    botRepo = new BotRepository()
    bot = new BotService({ botRepo, repo, client: fakeClient, isStoreOpen: async () => true, emit: () => {}, logger })
    botAdmin = new BotAdminService({ botRepo })
    inbound = new InboundService({ repo, emit: () => {}, logger, phoneNumberId: 'PN1', bot })
    await clean()
    // A tiny catalog: lemon in stock at two prices, lemon-out (nobody has it), milk.
    const shop = (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ('T16 Shop', $1, 'T16', 'x', 'Surat', 'GJ', '395006', 21.2, 72.8, true) RETURNING id`, [SHOP_SLUG])).rows[0].id
    const mk = async (name, slug, price, unit, stock) => {
      const id = (await query(`INSERT INTO products (name, slug, price, unit, is_active) VALUES ($1,$2,$3,$4,true) RETURNING id`, [name, slug, price, unit])).rows[0].id
      await query(`INSERT INTO shop_products (shop_id, product_id, price, stock_quantity, is_available) VALUES ($1,$2,$3,$4,true)`, [shop, id, price, stock])
    }
    await mk('T16 Lemon', 't16-lemon', 80, 'kg', 25)
    await mk('T16 Lemon Pickle', 't16-lemon-out', 120, 'jar', 0) // out of stock: must never be offered
    await mk('T16 Milk', 't16-milk', 60, 'litre', 10)
    await query(`INSERT INTO wa_product_aliases (alias, search_term) VALUES ('t16lemon', 't16 lemon'), ('t16pickle', 't16 lemon pickle'), ('t16milk', 't16 milk') ON CONFLICT DO NOTHING`)
  })

  beforeEach(async () => {
    sent = []
    fakeClient.sendText.mockClear()
    await query(`DELETE FROM wa_contacts WHERE wa_id LIKE '91999900200%'`)
    await query(`UPDATE wa_bot_settings SET enabled = true, human_pause_minutes = 720, max_replies_per_hour = 20, fallback_enabled = true, quote_prices = false, fallback_text = 'Thank you for your message 🙏 We have passed it to our team and they will reply here as soon as possible.' WHERE id = 1`)
  })

  afterAll(async () => {
    await query(`UPDATE wa_bot_settings SET enabled = false, quote_prices = false WHERE id = 1`)
    await query(`DELETE FROM wa_product_aliases WHERE alias LIKE 't16%'`)
    await clean()
    await closePool()
  })

  describe('Meta-ad openers (the 3 pre-filled lines)', () => {
    it('"Where are you serviceable?" -> answers instantly and asks the area', async () => {
      const r = await say('Where are you serviceable?', { source: 'ad' })
      expect(r).toMatch(/Mota Varachha & Utran/)
      expect(r).toMatch(/Which area are you in\?/)
      expect((await contact()).bot_language).toBe('en')
    })
    it('"How can I order ?" -> steps with both app links and the website, then asks the area', async () => {
      const r = await say('How can I order ?')
      expect(r).toContain('https://play.google.com/store/apps/details?id=com.bakaloo.india')
      expect(r).toContain('https://apps.apple.com/in/app/bakaloo/id6756962834')
      expect(r).toMatch(/Which area are you in\?/)
    })
    it('"Hi" -> greeting + area question; no stray "Hi there ,"', async () => {
      const r = await say('Hi')
      expect(r).toMatch(/^Hi there, welcome to Bakaloo/)
      expect(r).toMatch(/Which area are you in\?/)
    })
    it('"Hi" then "Where are you serviceable?" then "How can I order ?" are all answered (no silent cooldown)', async () => {
      await say('Hi')
      await say('Where are you serviceable?')
      await say('How can I order ?')
      expect(sent).toHaveLength(3)
    })
  })

  describe('area answers', () => {
    it('serviceable area (English) -> how to order + remembers the area', async () => {
      await say('Where are you serviceable?')
      const r = await say('motavarachha')
      expect(r).toMatch(/we deliver to Mota Varachha/)
      expect(r).toMatch(/spin & win/)
      expect((await contact()).area_name).toBe('Mota Varachha')
    })
    it('out-of-area (Amroli) -> polite no, names where we deliver, offers START, records the area', async () => {
      const r = await say('Amroli')
      expect(r).toMatch(/don't deliver to Amroli yet/)
      expect(r).toMatch(/Mota Varachha & Utran/)
      expect(r).toMatch(/START/)
      expect((await contact()).area_name).toBe('Amroli')
      expect(await events()).toEqual(['REPLIED']) // no handoff: nothing for a person to do
    })
    it('Gujarati-script area button tap "મોટા વરાછા" gets a Gujarati reply', async () => {
      const r = await say(null, { type: 'button', extra: { button: { text: 'મોટા વરાછા', payload: 'x' } } })
      expect(r).toMatch(/વાહ, અમે મોટા વરાછા માં ડિલિવરી કરીએ છીએ/)
      expect((await contact()).bot_language).toBe('gu')
    })
    it('the "બીજું / other area" button asks for the area name instead of going silent', async () => {
      const r = await say(null, { type: 'button', extra: { button: { text: 'અથવા કોઈ બીજું', payload: 'x' } } })
      expect(r).toMatch(/તમારા વિસ્તારનું નામ લખો/)
    })
    it('unknown place right after we asked -> acknowledged, handed to a person, text saved for the waiting list', async () => {
      await say('Where are you serviceable?')
      const r = await say('Yogi chowk')
      expect(r).toMatch(/check if we deliver to Yogi chowk/)
      expect(await events()).toEqual(['REPLIED', 'HANDOFF'])
      const c = await contact()
      expect(c.area_text).toBe('Yogi chowk')
      const { rows } = await query(`SELECT area, people FROM (${'SELECT COALESCE(a.name, c.area_text) AS area, COUNT(*)::int AS people FROM wa_contacts c LEFT JOIN wa_service_areas a ON a.id = c.service_area_id WHERE c.wa_id = $1 GROUP BY 1'}) x`, [WA])
      expect(rows[0]).toEqual({ area: 'Yogi chowk', people: 1 })
    })
    it('"yes" or "hi" after the area question is NOT treated as a place name', async () => {
      await say('Where are you serviceable?')
      sent.length = 0
      await say('Yes')
      expect(sent.every((s) => !/check if we deliver/.test(s.body))).toBe(true)
      expect((await contact()).area_text).toBeNull()
    })
    it('an area edited by the manager is used immediately (new area, new spelling)', async () => {
      const a = await botAdmin.createArea({ name: 'T16 Zonetown', aliases: ['zonetown', 'zone town'], isServiceable: true })
      try {
        expect(await say('zone town')).toMatch(/we deliver to T16 Zonetown/)
      } finally {
        await botAdmin.deleteArea(a.id)
      }
    })
  })

  describe('Roman Gujarati and Gujarati questions', () => {
    it('"Tamaro Area kyo chhe" style conversation: reply language follows the customer', async () => {
      const r = await say('Libu no su bhav 6')
      expect(r).toBeTruthy()
      expect((await contact()).bot_language).toBe('gl')
    })
    it('"Vegetables ni price please" -> general price answer with app links (no invented price)', async () => {
      const r = await say('Vegetables ni price please')
      expect(r).toMatch(/Prices change with the market/)
      expect(r).not.toMatch(/₹/)
    })
    it('Gujarati script price question -> Gujarati answer', async () => {
      const r = await say('શું ભાવ છે 1 કિલો નો')
      expect(r).toMatch(/ભાવ બજાર પ્રમાણે/)
    })
  })

  describe('products (live catalog)', () => {
    it('product we sell, price quoting OFF -> says we have it, no price', async () => {
      const r = await say('t16lemon')
      expect(r).toMatch(/Yes, we have:\n• T16 Lemon/)
      expect(r).not.toMatch(/₹/)
      expect(r).toContain('play.google.com')
    })
    it('price quoting ON -> live shop price with unit and a "can change" note', async () => {
      await query(`UPDATE wa_bot_settings SET quote_prices = true WHERE id = 1`)
      const r = await say('t16lemon')
      expect(r).toMatch(/• T16 Lemon – ₹80\/kg/)
      expect(r).toMatch(/can change/)
    })
    it('a product that exists but has no stock anywhere is never offered; a person is asked to check', async () => {
      const r = await say('t16pickle')
      expect(r).not.toMatch(/Yes, we have/)
      expect(r).toMatch(/team member will check/)
      expect(await events()).toEqual(['HANDOFF'])
    })
    it('Gujarati wording around catalog names', async () => {
      await say('Libu no su bhav 6') // sets language to roman Gujarati
      sent.length = 0
      const r = await say('t16milk')
      expect(r).toMatch(/Ha, amari pase chhe:\n• T16 Milk/)
    })
  })

  describe('things the bot must NOT answer', () => {
    it('"Ok" after the app link -> silent, no handoff, no pause', async () => {
      await say('Utran')
      sent.length = 0
      expect(await say('Ok')).toBeNull()
      expect((await events()).at(-1)).toBe('IGNORED')
      expect((await query(`SELECT bot_state FROM wa_conversations c JOIN wa_contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1`, [WA])).rows[0].bot_state).toBe('BOT')
    })
    it('a long vendor pitch -> no reply, a person reads it', async () => {
      const pitch = 'Hello Team Bakaloo, came across your platform and liked the idea. '.repeat(8)
      expect(await say(pitch)).toBeNull()
      expect(await events()).toEqual(['LONG_TEXT'])
    })
    it('a payment screenshot (image) -> short acknowledgement in the right language, then a person', async () => {
      await say('Libu no su bhav 6')
      sent.length = 0
      const r = await say(null, { type: 'image', extra: { image: { id: 'IMG1', mime_type: 'image/jpeg', sha256: 'x' } } })
      expect(r).toMatch(/Tamara sandesh badal aabhar/)
      expect((await events()).at(-1)).toBe('MEDIA')
    })
    it('an unknown question when we did not ask for an area -> language-matched fallback + handoff', async () => {
      const r = await say('Can you deliver wedding catering for 500 people')
      expect(r).toMatch(/passed it to our team/)
      expect(await events()).toEqual(['NO_MATCH'])
    })
    it('a person who answers silences the bot (existing behaviour kept)', async () => {
      await say('Hi')
      await bot.onAgentReply((await query(`SELECT c.id FROM wa_conversations c JOIN wa_contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = $1`, [WA])).rows[0].id)
      sent.length = 0
      expect(await say('Amroli')).toBeNull()
    })
  })

  describe('tester + admin', () => {
    it('dry run reports language, area and product and sends nothing', async () => {
      const r = await bot.test('Amroli')
      expect(r).toMatchObject({ outcome: 'REPLIED', language: 'en', area: { name: 'Amroli', serviceable: false }, rule: { name: 'Area we do not deliver to (yet)' } })
      const g = await bot.test('Amroli', 'NOW', { language: 'gu' })
      expect(g.reply).toMatch(/જણાવવા બદલ આભાર/)
      const asked = await bot.test('Yogi chowk', 'NOW', { awaitingArea: true })
      expect(asked.rule.name).toMatch(/Area not recognised/)
      expect(sent).toHaveLength(0)
    })
    it('area validation: too-short spelling and duplicates are refused', async () => {
      await expect(botAdmin.createArea({ name: 'T16 Short', aliases: ['ab'] })).rejects.toMatchObject({ code: 'INVALID_AREA' })
      const a = await botAdmin.createArea({ name: 'T16 Dup' })
      try {
        await expect(botAdmin.createArea({ name: 't16 dup' })).rejects.toMatchObject({ code: 'AREA_EXISTS' })
      } finally {
        await botAdmin.deleteArea(a.id)
      }
    })
    it('rule with the new types/actions validates; settings reject non-https links', async () => {
      const r = await botAdmin.createRule({ name: 'T16 silent', matchType: 'EXACT', keywords: ['t16 ignoreme'], action: 'IGNORE' }, null)
      expect(r.action).toBe('IGNORE')
      await botAdmin.deleteRule(r.id)
      const p = await botAdmin.createRule({ name: 'T16 product', matchType: 'PRODUCT', replyText: '{{product_info}}', action: 'REPLY' }, null)
      expect(p.keywords).toEqual([])
      await botAdmin.deleteRule(p.id)
      await expect(botAdmin.updateSettings({ websiteUrl: 'javascript:alert(1)' }, null)).rejects.toMatchObject({ code: 'INVALID_SETTINGS' })
    })
  })
})
