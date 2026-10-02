/**
 * WhatsApp CRM Phase 4 — pipeline automation, manual moves, board. Real Postgres, opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/whatsapp-crm-phase4.db.test.js
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const WA = ['919999000041', '919999000042', '919999000043', '919999000044']
const PHONES = ['9999000041', '9999000042', '9999000043', '9999000044', '9999000045', '9999000046']

describe.skipIf(!enabled)('WhatsApp CRM — pipeline', () => {
  let query, closePool, svc, repo, loadCrmAccess, CrmAdminRepository
  let mgr, agent, otherAgent
  const emitted = []
  const logger = { info: vi.fn(), warn: vi.fn() }

  const stageKey = async (waId) =>
    (await query(`SELECT s.key, ct.stage_source FROM wa_contacts ct LEFT JOIN crm_stages s ON s.id = ct.stage_id WHERE ct.wa_id = $1`, [waId])).rows[0]
  const contactId = async (waId) => (await query(`SELECT id FROM wa_contacts WHERE wa_id = $1`, [waId])).rows[0].id
  const stageId = async (key) => (await query(`SELECT id FROM crm_stages WHERE key = $1`, [key])).rows[0].id

  async function mkContact(waId, { profile = 'Cust', assignedTo = null, direction = 'INBOUND', lastMinsAgo = 5 } = {}) {
    const c = (await query(`INSERT INTO wa_contacts (wa_id, phone, profile_name) VALUES ($1,$2,$3) RETURNING id`, [waId, waId.slice(2), profile])).rows[0].id
    const v = (
      await query(
        `INSERT INTO wa_conversations (contact_id, assigned_to, last_inbound_at, last_message_at, last_message_direction, unread_count)
         VALUES ($1,$2, NOW(), NOW() - ($3 || ' minutes')::interval, $4, 1) RETURNING id`,
        [c, assignedTo, String(lastMinsAgo), direction],
      )
    ).rows[0].id
    return { contactId: c, conversationId: v }
  }
  async function mkCustomer(phone, name = 'Real Customer') {
    return (await query(`INSERT INTO users (phone, name) VALUES ($1,$2) RETURNING id`, [phone, name])).rows[0].id
  }
  let orderSeq = 0
  async function mkOrder(userId, status = 'CONFIRMED', total = 500) {
    return (
      await query(
        `INSERT INTO orders (order_number, user_id, status, items, subtotal, total_amount, delivery_address)
         VALUES ($1,$2,$3::order_status,'[]'::jsonb,$4,$4,'{}'::jsonb) RETURNING id`,
        [`T4-${Date.now() % 1e8}-${++orderSeq}`, userId, status, total],
      )
    ).rows[0].id
  }
  const setOrderStatus = (id, status) => query(`UPDATE orders SET status = $2::order_status WHERE id = $1`, [id, status])

  async function cleanup() {
    await query(`DELETE FROM wa_contacts WHERE wa_id = ANY($1)`, [WA])
    await query(`DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [PHONES])
    await query(`DELETE FROM abandoned_carts WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [PHONES])
    await query(`DELETE FROM business_accounts WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [PHONES])
    await query(`DELETE FROM users WHERE phone = ANY($1)`, [PHONES])
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { PipelineRepository } = await import('../../src/modules/whatsapp-crm/pipeline.repository.js')
    const { PipelineService } = await import('../../src/modules/whatsapp-crm/pipeline.service.js')
    ;({ loadCrmAccess } = await import('../../src/modules/whatsapp-crm/access.js'))
    ;({ CrmAdminRepository } = await import('../../src/modules/whatsapp-crm/crm-admin.repository.js'))
    repo = new PipelineRepository()
    svc = new PipelineService({ repo, emit: (e, p) => emitted.push({ e, p }), logger })
    await cleanup()
    const role = async (n) => (await query(`SELECT id FROM roles WHERE name = $1`, [n])).rows[0].id
    const mkStaff = async (phone, name, r) =>
      (await query(`INSERT INTO users (phone,name,email,role,role_id) VALUES ($1,$2,$3,'ADMIN',$4) RETURNING id`, [phone, name, `${phone}@t.local`, await role(r)])).rows[0].id
    mgr = await mkStaff('9999000045', 'Mgr', 'CRM Manager')
    agent = await mkStaff('9999000046', 'Agent', 'CRM Agent')
    otherAgent = agent // replaced below
    otherAgent = (await query(`INSERT INTO users (phone,name,email,role,role_id) VALUES ('9999000040','Other','9999000040@t.local','ADMIN',$1) RETURNING id`, [await role('CRM Agent')])).rows[0].id
  })

  beforeEach(async () => {
    emitted.length = 0
    await query(`DELETE FROM wa_contacts WHERE wa_id = ANY($1)`, [WA])
    await query(`DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [PHONES])
    await query(`DELETE FROM abandoned_carts WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [PHONES])
    await query(`DELETE FROM users WHERE phone = ANY($1) AND role = 'CUSTOMER'`, [PHONES])
  })

  afterAll(async () => {
    await cleanup()
    await query(`DELETE FROM users WHERE phone = '9999000040'`)
    await closePool()
  })

  describe('automation', () => {
    it('stages are seeded: 7 automatic + 4 human-only', async () => {
      const s = await repo.listStages()
      expect(s.filter((x) => x.is_auto).map((x) => x.key)).toEqual(['lead', 'conversation', 'customer', 'first_order', 'second_order', 'third_order', 'repeat'])
      expect(s.filter((x) => !x.is_auto).map((x) => x.key).sort()).toEqual(['b2b_opportunity', 'follow_up', 'negotiation', 'success'])
    })

    it('a new unregistered contact lands in WhatsApp Lead; reconciling again changes nothing for it', async () => {
      await mkContact(WA[0])
      await svc.reconcile()
      expect((await stageKey(WA[0])).key).toBe('lead')
      const hist = async () => Number((await query(`SELECT COUNT(*) FROM crm_stage_history WHERE contact_id = $1`, [await contactId(WA[0])])).rows[0].count)
      expect(await hist()).toBe(1)
      await svc.reconcile()
      expect(await hist()).toBe(1) // idempotent
      expect(emitted.some((x) => x.e === 'crm:pipeline')).toBe(true)
    })

    it('first agent reply: Lead -> Conversation', async () => {
      const { contactId: cid, conversationId } = await mkContact(WA[0])
      await svc.evaluateContact(cid)
      expect((await stageKey(WA[0])).key).toBe('lead')
      await query(`INSERT INTO wa_messages (conversation_id, contact_id, direction, msg_type, body, status) VALUES ($1,$2,'OUTBOUND','text','hi','SENT')`, [conversationId, cid])
      await svc.evaluateContact(cid)
      expect((await stageKey(WA[0])).key).toBe('conversation')
    })

    it('phone later registered in Bakaloo: contact is auto-linked and moves to Customer', async () => {
      await mkContact(WA[0])
      await svc.reconcile()
      expect((await stageKey(WA[0])).key).toBe('lead')
      const uid = await mkCustomer('9999000041')
      const r = await svc.reconcile()
      expect(r.linked).toBeGreaterThanOrEqual(1)
      expect((await query(`SELECT user_id FROM wa_contacts WHERE wa_id = $1`, [WA[0]])).rows[0].user_id).toBe(uid)
      expect((await stageKey(WA[0])).key).toBe('customer')
    })

    it('does not link a different customer who only shares the last 8 digits', async () => {
      await mkContact('918999000041') // phone 8999000041
      await mkCustomer('9999000041')
      await svc.reconcile()
      expect((await query(`SELECT user_id FROM wa_contacts WHERE wa_id = '918999000041'`)).rows[0].user_id).toBeNull()
      await query(`DELETE FROM wa_contacts WHERE wa_id = '918999000041'`)
    })

    it('counts only PLACED orders; PENDING / CANCELLED / REFUNDED do not move the card', async () => {
      const uid = await mkCustomer('9999000041')
      await mkContact(WA[0])
      await svc.reconcile()
      await mkOrder(uid, 'PENDING')
      await mkOrder(uid, 'CANCELLED')
      await mkOrder(uid, 'REFUNDED')
      await svc.reconcile()
      expect((await stageKey(WA[0])).key).toBe('customer')
    })

    it('walks the ladder 1 -> 2 -> 3 -> 4 orders: First, Second, Third, Repeat', async () => {
      const uid = await mkCustomer('9999000041')
      await mkContact(WA[0])
      const seen = []
      for (let i = 0; i < 4; i++) {
        await mkOrder(uid, i % 2 ? 'DELIVERED' : 'CONFIRMED')
        await svc.reconcile()
        seen.push((await stageKey(WA[0])).key)
      }
      expect(seen).toEqual(['first_order', 'second_order', 'third_order', 'repeat'])
      const hist = (await query(`SELECT source FROM crm_stage_history WHERE contact_id = $1`, [await contactId(WA[0])])).rows
      expect(hist.every((h) => h.source === 'AUTO')).toBe(true)
      expect(hist).toHaveLength(4) // placed straight into 1st Order (customer already existed), then 3 moves
    })

    it('a PENDING order that is later confirmed moves the card then', async () => {
      const uid = await mkCustomer('9999000041')
      await mkContact(WA[0])
      const o = await mkOrder(uid, 'PENDING')
      await svc.reconcile()
      expect((await stageKey(WA[0])).key).toBe('customer')
      await setOrderStatus(o, 'CONFIRMED')
      await svc.reconcile()
      expect((await stageKey(WA[0])).key).toBe('first_order')
    })

    it('ROLLBACK: cancelling an order moves an AUTO card back', async () => {
      const uid = await mkCustomer('9999000041')
      await mkContact(WA[0])
      await mkOrder(uid)
      const second = await mkOrder(uid)
      await svc.reconcile()
      expect((await stageKey(WA[0])).key).toBe('second_order')
      await setOrderStatus(second, 'CANCELLED')
      await svc.reconcile()
      expect((await stageKey(WA[0])).key).toBe('first_order')
      const last = (await query(`SELECT reason FROM crm_stage_history WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1`, [await contactId(WA[0])])).rows[0]
      expect(last.reason).toMatch(/cancelled/)
    })

    it('a card an agent put in a HUMAN-ONLY stage is never moved by automation', async () => {
      const uid = await mkCustomer('9999000041')
      const { contactId: cid } = await mkContact(WA[0])
      await svc.reconcile()
      await svc.moveCard(cid, await stageId('follow_up'), await loadCrmAccess(mgr))
      for (let i = 0; i < 3; i++) await mkOrder(uid)
      await svc.reconcile()
      const s = await stageKey(WA[0])
      expect(s).toMatchObject({ key: 'follow_up', stage_source: 'MANUAL' })
    })

    it('a card manually dragged within the ladder only moves FORWARD afterwards', async () => {
      const uid = await mkCustomer('9999000041')
      const { contactId: cid } = await mkContact(WA[0])
      await svc.reconcile()
      await svc.moveCard(cid, await stageId('third_order'), await loadCrmAccess(mgr)) // agent says: 3rd order stage
      await mkOrder(uid) // automation would say first_order (backwards) -> ignored
      await svc.reconcile()
      expect((await stageKey(WA[0])).key).toBe('third_order')
      for (let i = 0; i < 3; i++) await mkOrder(uid) // now 4 orders -> repeat is forward -> allowed
      await svc.reconcile()
      expect((await stageKey(WA[0])).key).toBe('repeat')
    })
  })

  describe('manual moves & access', () => {
    it('manager moves any card; history records who and MANUAL', async () => {
      const { contactId: cid } = await mkContact(WA[0], { assignedTo: otherAgent })
      await svc.reconcile()
      const r = await svc.moveCard(cid, await stageId('negotiation'), await loadCrmAccess(mgr))
      expect(r.changed).toBe(true)
      const h = (await svc.history(cid, await loadCrmAccess(mgr)))[0]
      expect(h).toMatchObject({ source: 'MANUAL', to_stage: 'Negotiation', changed_by: 'Mgr' })
    })
    it('moving onto the stage it is already in is a no-op (nothing logged)', async () => {
      const { contactId: cid } = await mkContact(WA[0])
      await svc.reconcile()
      const before = (await svc.history(cid, await loadCrmAccess(mgr))).length
      expect((await svc.moveCard(cid, await stageId('lead'), await loadCrmAccess(mgr))).changed).toBe(false)
      expect((await svc.history(cid, await loadCrmAccess(mgr))).length).toBe(before)
    })
    it('an agent cannot move (or see history of) another agent’s card — 404', async () => {
      const { contactId: cid } = await mkContact(WA[0], { assignedTo: otherAgent })
      await svc.reconcile()
      const a = await loadCrmAccess(agent)
      await expect(svc.moveCard(cid, await stageId('follow_up'), a)).rejects.toMatchObject({ statusCode: 404 })
      await expect(svc.history(cid, a)).rejects.toMatchObject({ statusCode: 404 })
    })
    it('unknown card / unknown stage are 404', async () => {
      const { contactId: cid } = await mkContact(WA[0])
      const m = await loadCrmAccess(mgr)
      await expect(svc.moveCard('00000000-0000-0000-0000-000000000000', await stageId('lead'), m)).rejects.toMatchObject({ code: 'CONTACT_NOT_FOUND' })
      await expect(svc.moveCard(cid, '00000000-0000-0000-0000-000000000000', m)).rejects.toMatchObject({ code: 'STAGE_NOT_FOUND' })
    })
  })

  describe('board', () => {
    it('groups cards by stage with order count, spend, open cart, priority and next action', async () => {
      const uid = await mkCustomer('9999000041', 'Mita Paul')
      await mkOrder(uid, 'CONFIRMED', 600)
      await mkOrder(uid, 'DELIVERED', 640)
      await query(`INSERT INTO abandoned_carts (user_id, status, abandoned_at, cart_value) VALUES ($1,'OPEN',NOW(),1240)`, [uid])
      await mkContact(WA[0], { direction: 'INBOUND', lastMinsAgo: 40 })
      await svc.reconcile()

      const b = await svc.board({}, true, mgr)
      const col = b.stages.find((s) => s.key === 'second_order')
      const card = col.cards.find((c) => c.contact_id)
      expect(col.cards.length).toBeGreaterThanOrEqual(1)
      const mine = col.cards.find((c) => c.customer_name === 'Mita Paul')
      expect(mine).toMatchObject({ order_count: 2, total_spend: 1240, open_cart_value: 1240, nextAction: 'REPLY_NOW' })
      expect(mine.waitingMinutes).toBeGreaterThanOrEqual(40)
      expect(['HIGH', 'MEDIUM']).toContain(mine.priority)
      expect(card).toBeTruthy()
    })

    it('sorts a column by priority: the long-waiting customer first', async () => {
      await mkContact(WA[0], { profile: 'Waiting long', direction: 'INBOUND', lastMinsAgo: 90 })
      await mkContact(WA[1], { profile: 'Answered', direction: 'OUTBOUND', lastMinsAgo: 5 })
      await svc.reconcile()
      const names = (await svc.board({}, true, mgr)).stages.flatMap((s) => s.cards).filter((c) => ['Waiting long', 'Answered'].includes(c.profile_name)).map((c) => c.profile_name)
      expect(names[0]).toBe('Waiting long')
    })

    it('an agent only sees own + unassigned cards; a manager sees all', async () => {
      await mkContact(WA[0], { profile: 'Mine', assignedTo: agent })
      await mkContact(WA[1], { profile: 'Unowned' })
      await mkContact(WA[2], { profile: 'Theirs', assignedTo: otherAgent })
      await svc.reconcile()
      const names = (b) => b.stages.flatMap((s) => s.cards).map((c) => c.profile_name).filter((n) => ['Mine', 'Unowned', 'Theirs'].includes(n)).sort()
      expect(names(await svc.board({}, false, agent))).toEqual(['Mine', 'Unowned'])
      expect(names(await svc.board({}, true, mgr))).toEqual(['Mine', 'Theirs', 'Unowned'])
    })

    it('filters: owner, label, B2B / B2C, search', async () => {
      const b2bUser = await mkCustomer('9999000042', 'Wholesale Co')
      await query(`INSERT INTO business_accounts (user_id, company_name, gst_number, status, b2b_enabled) VALUES ($1,'Wholesale Co','TESTGST0000000Z','APPROVED',true)`, [b2bUser])
      await mkContact(WA[0], { profile: 'Retail Rina', assignedTo: agent })
      await mkContact(WA[1], { profile: 'Biz', assignedTo: otherAgent })
      await query(`UPDATE wa_contacts SET phone = '9999000042', user_id = $1 WHERE wa_id = $2`, [b2bUser, WA[1]])
      const vip = (await query(`SELECT id FROM wa_labels WHERE name = 'VIP'`)).rows[0].id
      await query(`INSERT INTO wa_contact_labels (contact_id, label_id) VALUES ($1,$2)`, [await contactId(WA[0]), vip])
      await svc.reconcile()
      const pick = async (f) => (await svc.board(f, true, mgr)).stages.flatMap((s) => s.cards).map((c) => c.profile_name).filter((n) => ['Retail Rina', 'Biz'].includes(n)).sort()
      expect(await pick({ assignedTo: agent })).toEqual(['Retail Rina'])
      expect(await pick({ labelId: vip })).toEqual(['Retail Rina'])
      expect(await pick({ b2b: 'B2B' })).toEqual(['Biz'])
      expect(await pick({ b2b: 'B2C' })).toEqual(['Retail Rina'])
      expect(await pick({ search: 'Rina' })).toEqual(['Retail Rina'])
      expect(await pick({ assignedTo: 'unassigned' })).toEqual([])
    })

    it('VIP-labelled unowned B2B customer gets ASSIGN_TO_B2B only when nothing is waiting', async () => {
      const u = await mkCustomer('9999000042')
      await query(`INSERT INTO business_accounts (user_id, company_name, gst_number, status, b2b_enabled) VALUES ($1,'Co','TESTGST0000000Z','APPROVED',true)`, [u])
      await mkContact(WA[0], { profile: 'B2B quiet', direction: 'OUTBOUND' })
      await query(`UPDATE wa_contacts SET phone='9999000042', user_id=$1 WHERE wa_id=$2`, [u, WA[0]])
      await svc.reconcile()
      const card = (await svc.board({}, true, mgr)).stages.flatMap((s) => s.cards).find((c) => c.profile_name === 'B2B quiet')
      expect(card.nextAction).toBe('ASSIGN_TO_B2B')
    })
  })
})
