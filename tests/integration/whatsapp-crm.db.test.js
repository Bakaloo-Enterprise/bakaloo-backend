/**
 * WhatsApp CRM — real-database test (Phase 1).
 *
 * Unlike the other "integration" tests in this repo (which mock pg), this one
 * runs the repository + services against a REAL Postgres so the SQL itself is
 * verified. It writes and then deletes its own rows, so it is OPT-IN:
 *
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/whatsapp-crm.db.test.js
 *
 * Point DB_* in .env at a throwaway database, never at production.
 */
import crypto from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'

// All fixture numbers live in these ranges so cleanup can never touch real data.
const TEST_WA_IDS = ['919999000001', '919999000002', '919999000003', '919999000004', '918999000011', '919999000005']
const TEST_PHONES = ['9999000001', '9999000011', '9999000005']
const TEST_BSUIDS = ['IN.TEST000000000001']

describe.skipIf(!enabled)('WhatsApp CRM — inbound + outbound against real Postgres', () => {
  let repo, InboundService, SendService, RetryLaterError, CrmError, query, closePool
  let emitted
  let inbound
  const createdEventIds = []

  const emit = (event, payload) => emitted.push({ event, payload })
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { WhatsappRepository } = await import('../../src/modules/whatsapp-crm/whatsapp.repository.js')
    ;({ InboundService } = await import('../../src/modules/whatsapp-crm/inbound.service.js'))
    ;({ SendService } = await import('../../src/modules/whatsapp-crm/send.service.js'))
    ;({ RetryLaterError, CrmError } = await import('../../src/modules/whatsapp-crm/errors.js'))
    repo = new WhatsappRepository()
    await cleanup()
  })

  beforeEach(() => {
    emitted = []
    inbound = new InboundService({ repo, emit, logger, phoneNumberId: 'PN1' })
  })

  afterAll(async () => {
    await cleanup()
    await closePool()
  })

  async function cleanup() {
    await query(`DELETE FROM wa_contacts WHERE wa_id = ANY($1) OR bsuid = ANY($2)`, [TEST_WA_IDS, TEST_BSUIDS])
    if (createdEventIds.length) await query(`DELETE FROM wa_webhook_events WHERE id = ANY($1)`, [createdEventIds])
    await query(`DELETE FROM users WHERE phone = ANY($1)`, [TEST_PHONES])
  }

  // ── helpers ─────────────────────────────────────────────────────
  const meta = { phone_number_id: 'PN1', display_phone_number: '15550000000' }
  const body = (value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value }] }] })
  const textMsg = (from, id, text, extra = {}) => ({ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...extra })

  async function deliver(payload, { receivedAgoMs = 0 } = {}) {
    const hash = crypto.createHash('sha256').update(JSON.stringify(payload) + Math.random()).digest('hex')
    const ev = await repo.recordWebhookEvent(hash, payload)
    createdEventIds.push(ev.id)
    if (receivedAgoMs) await query(`UPDATE wa_webhook_events SET received_at = NOW() - ($2 || ' milliseconds')::interval WHERE id = $1`, [ev.id, String(receivedAgoMs)])
    return ev.id
  }
  const inboundFrom = (waId, id, text, profile = 'Rahul', extra = {}) =>
    body({ metadata: meta, contacts: [{ wa_id: waId, profile: { name: profile } }], messages: [textMsg(waId, id, text, extra)] })

  const convFor = async (waId) =>
    (await query(`SELECT c.*, ct.* , c.id AS conv_id FROM wa_contacts ct JOIN wa_conversations c ON c.contact_id = ct.id WHERE ct.wa_id = $1`, [waId])).rows[0]
  const msgCount = async (waId) =>
    Number((await query(`SELECT COUNT(*) FROM wa_messages m JOIN wa_contacts ct ON ct.id = m.contact_id WHERE ct.wa_id = $1`, [waId])).rows[0].count)

  // ── inbound ─────────────────────────────────────────────────────
  it('stores a first message from an unknown number: contact, conversation, unread, open window', async () => {
    const id = await deliver(inboundFrom('919999000001', 'wamid.T1', 'Is milk available?'))
    await inbound.processEvent(id)

    const row = await convFor('919999000001')
    expect(row.phone).toBe('9999000001')
    expect(row.user_id).toBeNull()
    expect(row.source).toBe('ORGANIC')
    expect(row.profile_name).toBe('Rahul')
    expect(row.unread_count).toBe(1)
    expect(row.last_message_preview).toBe('Is milk available?')
    expect(row.status).toBe('OPEN')
    const conv = await repo.getConversation(row.conv_id)
    expect(conv.window_open).toBe(true)
    expect(emitted.map((e) => e.event)).toEqual(['crm:message'])
  })

  it('is idempotent: the same wamid delivered twice (Meta retry) stores ONE message', async () => {
    const payload = inboundFrom('919999000001', 'wamid.T2', 'hello again')
    await inbound.processEvent(await deliver(payload))
    const before = await msgCount('919999000001')
    await inbound.processEvent(await deliver(payload)) // different event row, same wamid
    expect(await msgCount('919999000001')).toBe(before)
    expect(emitted.filter((e) => e.event === 'crm:message')).toHaveLength(1) // second delivery emits nothing
  })

  it('does not reprocess an event that is already processed', async () => {
    const id = await deliver(inboundFrom('919999000001', 'wamid.T3', 'x'))
    await inbound.processEvent(id)
    expect(await inbound.processEvent(id)).toEqual({ skipped: 'already_processed' })
  })

  it('a duplicate webhook BODY (same hash) is not stored twice', async () => {
    const payload = inboundFrom('919999000001', 'wamid.T4', 'x')
    const hash = crypto.createHash('sha256').update('same-body-' + Date.now()).digest('hex')
    const a = await repo.recordWebhookEvent(hash, payload)
    const b = await repo.recordWebhookEvent(hash, payload)
    createdEventIds.push(a.id)
    expect(a.inserted).toBe(true)
    expect(b.inserted).toBe(false)
    expect(b.id).toBe(a.id)
  })

  it('links the conversation to the existing Bakaloo customer by exact phone', async () => {
    const { rows } = await query(`INSERT INTO users (phone, name) VALUES ('9999000001', 'Existing Customer') RETURNING id`)
    const userId = rows[0].id
    // contact already exists unlinked from the first test; a new message links it
    await inbound.processEvent(await deliver(inboundFrom('919999000001', 'wamid.T5', 'order status?')))
    expect((await convFor('919999000001')).user_id).toBe(userId)
    const list = await repo.listConversations({ search: 'Existing' })
    expect(list.find((c) => c.wa_id === '919999000001')?.customer_name).toBe('Existing Customer')
  })

  it('does NOT link a different customer whose number only shares the last 8 digits', async () => {
    await query(`INSERT INTO users (phone, name) VALUES ('9999000011', 'Other Customer')`)
    // 8999000011 vs 9999000011: same last 8 digits, different people
    await inbound.processEvent(await deliver(inboundFrom('918999000011', 'wamid.T6', 'hi', 'Someone Else')))
    const row = await convFor('918999000011')
    expect(row.phone).toBe('8999000011')
    expect(row.user_id).toBeNull()
  })

  it('records Click-to-WhatsApp ad attribution once and keeps it', async () => {
    const referral = { source_type: 'ad', source_id: '123456789', headline: 'Weekend Grocery Offer' }
    await inbound.processEvent(await deliver(inboundFrom('919999000002', 'wamid.T7', 'offer?', 'Ad Lead', { referral })))
    let row = await convFor('919999000002')
    expect(row.source).toBe('META_AD')
    expect(row.referral).toEqual(referral)

    await inbound.processEvent(await deliver(inboundFrom('919999000002', 'wamid.T8', 'later message')))
    row = await convFor('919999000002')
    expect(row.referral).toEqual(referral)
    expect(row.source).toBe('META_AD')
  })

  it('keeps a username-only sender (no phone) and merges onto the SAME contact once the phone is known', async () => {
    const bsuid = TEST_BSUIDS[0]
    const first = body({
      metadata: meta,
      contacts: [{ user_id: bsuid, profile: { name: 'Priya', username: '@priya_s' } }],
      messages: [{ from_user_id: bsuid, id: 'wamid.T9', timestamp: '1790000000', type: 'text', text: { body: 'hello' } }],
    })
    await inbound.processEvent(await deliver(first))
    let { rows } = await query(`SELECT * FROM wa_contacts WHERE bsuid = $1`, [bsuid])
    expect(rows).toHaveLength(1)
    expect(rows[0].wa_id).toBeNull()
    expect(rows[0].phone).toBeNull()
    expect(rows[0].wa_username).toBe('priya_s')

    // later Meta includes the phone (e.g. customer shared it / 30-day rule)
    const second = body({
      metadata: meta,
      contacts: [{ wa_id: '919999000003', user_id: bsuid, profile: { name: 'Priya' } }],
      messages: [{ from: '919999000003', from_user_id: bsuid, id: 'wamid.T10', timestamp: '1790000100', type: 'text', text: { body: 'my number is now visible' } }],
    })
    await inbound.processEvent(await deliver(second))
    ;({ rows } = await query(`SELECT * FROM wa_contacts WHERE bsuid = $1 OR wa_id = '919999000003'`, [bsuid]))
    expect(rows).toHaveLength(1)
    expect(rows[0].wa_id).toBe('919999000003')
    expect(rows[0].phone).toBe('9999000003')
    expect(Number((await query(`SELECT COUNT(*) FROM wa_messages WHERE contact_id = $1`, [rows[0].id])).rows[0].count)).toBe(2)
  })

  it('a resolved conversation reopens when the customer writes again', async () => {
    await inbound.processEvent(await deliver(inboundFrom('919999000004', 'wamid.T11', 'first')))
    const row = await convFor('919999000004')
    await query(`UPDATE wa_conversations SET status = 'RESOLVED', unread_count = 0 WHERE id = $1`, [row.conv_id])
    await inbound.processEvent(await deliver(inboundFrom('919999000004', 'wamid.T12', 'one more thing')))
    const after = await convFor('919999000004')
    expect(after.status).toBe('OPEN')
    expect(after.unread_count).toBe(1)
  })

  // ── outbound + statuses ─────────────────────────────────────────
  describe('agent replies and delivery statuses', () => {
    let convId
    let sent
    const fakeClient = (impl) => ({ sendText: vi.fn(impl ?? (async () => ({ wamid: `wamid.OUT${Math.random().toString(36).slice(2)}` }))) })
    const statusPayload = (wamid, status, extra = {}) =>
      body({ metadata: meta, statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '919999000005', ...extra }] })

    beforeEach(async () => {
      await cleanup()
      await inbound.processEvent(await deliver(inboundFrom('919999000005', `wamid.IN${Math.random().toString(36).slice(2)}`, 'need help', 'Out Test')))
      convId = (await convFor('919999000005')).conv_id
    })

    it('sends text, stores wamid and marks SENT', async () => {
      const client = fakeClient()
      const svc = new SendService({ repo, client, emit, logger })
      sent = await svc.sendText({ conversationId: convId, body: ' Hello! ' })
      expect(sent.status).toBe('SENT')
      expect(sent.body).toBe('Hello!')
      expect(sent.wamid).toMatch(/^wamid\.OUT/)
      expect(client.sendText).toHaveBeenCalledWith(expect.objectContaining({ to: '919999000005', body: 'Hello!' }))
    })

    it('applies delivery statuses forward-only even when they arrive out of order', async () => {
      const svc = new SendService({ repo, client: fakeClient(), emit, logger })
      const msg = await svc.sendText({ conversationId: convId, body: 'ladder' })

      await inbound.processEvent(await deliver(statusPayload(msg.wamid, 'read')))
      await inbound.processEvent(await deliver(statusPayload(msg.wamid, 'delivered'))) // late, must be ignored
      await inbound.processEvent(await deliver(statusPayload(msg.wamid, 'failed', { errors: [{ code: 131000, title: 'x' }] }))) // too late to fail

      const row = (await query(`SELECT status, delivered_at, read_at, error_code FROM wa_messages WHERE id = $1`, [msg.id])).rows[0]
      expect(row.status).toBe('READ')
      expect(row.read_at).not.toBeNull()
      expect(row.delivered_at).toBeNull()
      expect(row.error_code).toBeNull()
    })

    it('records a failed send with Meta’s reason, and an opt-out error marks the contact OPTED_OUT', async () => {
      const svc = new SendService({ repo, client: fakeClient(), emit, logger })
      const msg = await svc.sendText({ conversationId: convId, body: 'promo' })
      await inbound.processEvent(
        await deliver(statusPayload(msg.wamid, 'failed', { errors: [{ code: 131050, title: 'User opted out', error_data: { details: 'stop marketing' } }] })),
      )
      const row = (await query(`SELECT status, error_code, error_details FROM wa_messages WHERE id = $1`, [msg.id])).rows[0]
      expect(row).toMatchObject({ status: 'FAILED', error_code: 131050, error_details: 'stop marketing' })
      const contact = (await query(`SELECT marketing_consent FROM wa_contacts WHERE wa_id = '919999000005'`)).rows[0]
      expect(contact.marketing_consent).toBe('OPTED_OUT')
    })

    it('retries a status for a message not stored yet, then gives up after the grace period', async () => {
      const fresh = await deliver(statusPayload('wamid.UNKNOWN1', 'delivered'))
      await expect(inbound.processEvent(fresh)).rejects.toBeInstanceOf(RetryLaterError)
      expect((await repo.getWebhookEvent(fresh)).processed_at).toBeNull() // still pending

      const old = await deliver(statusPayload('wamid.UNKNOWN2', 'delivered'), { receivedAgoMs: 10 * 60 * 1000 })
      await expect(inbound.processEvent(old)).resolves.toMatchObject({ unmatched: 1 })
      expect((await repo.getWebhookEvent(old)).processed_at).not.toBeNull()
    })

    it('BLOCKS free-form text outside the 24-hour window without calling Meta', async () => {
      await query(`UPDATE wa_conversations SET last_inbound_at = NOW() - INTERVAL '25 hours' WHERE id = $1`, [convId])
      const client = fakeClient()
      const svc = new SendService({ repo, client, emit, logger })
      await expect(svc.sendText({ conversationId: convId, body: 'too late' })).rejects.toMatchObject({ code: 'OUTSIDE_24H_WINDOW', statusCode: 409 })
      expect(client.sendText).not.toHaveBeenCalled()
    })

    it('when Meta rejects the send, the message is kept as FAILED (not lost, not retried blindly)', async () => {
      const { MetaApiError } = await import('../../src/modules/whatsapp-crm/meta-client.js')
      const client = fakeClient(async () => {
        throw new MetaApiError('bad', { code: 131026, details: 'not on WhatsApp', httpStatus: 400 })
      })
      const svc = new SendService({ repo, client, emit, logger })
      await expect(svc.sendText({ conversationId: convId, body: 'will fail' })).rejects.toMatchObject({ statusCode: 502 })
      const row = (await query(`SELECT status, error_code, wamid FROM wa_messages WHERE conversation_id = $1 AND body = 'will fail'`, [convId])).rows[0]
      expect(row).toMatchObject({ status: 'FAILED', error_code: 131026, wamid: null })
      expect(client.sendText).toHaveBeenCalledTimes(1)
    })

    it('rejects empty and over-long messages and unknown conversations', async () => {
      const svc = new SendService({ repo, client: fakeClient(), emit, logger })
      await expect(svc.sendText({ conversationId: convId, body: '   ' })).rejects.toMatchObject({ code: 'EMPTY_MESSAGE' })
      await expect(svc.sendText({ conversationId: convId, body: 'x'.repeat(4097) })).rejects.toMatchObject({ code: 'MESSAGE_TOO_LONG' })
      await expect(svc.sendText({ conversationId: '00000000-0000-0000-0000-000000000000', body: 'x' })).rejects.toMatchObject({ statusCode: 404 })
    })
  })
})
