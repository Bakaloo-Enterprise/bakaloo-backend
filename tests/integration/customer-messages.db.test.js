/**
 * Messaging a customer from their profile: saved personal notifications + their history, and the WhatsApp
 * conversation that is found / created for them (without ever opening the 24-hour window).
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/customer-messages.db.test.js
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PH = (n) => `9999020${String(n).padStart(3, '0')}`

describe.skipIf(!enabled)('Customer profile messaging', () => {
  let restoreFeatures, app, query, closePool, svc, crm, repo, tok, admin, agent, cust, cust2, noPhone
  const call = (method, url, { token, payload } = {}) => app.inject({ method, url: `/api/v1/admin${url}`, payload, headers: token ? { authorization: `Bearer ${token}` } : {} })
  const emitted = []
  const fastify = { emitNotification: (id, n) => emitted.push([id, n]) }

  async function cleanup() {
    await query(`DELETE FROM wa_messages WHERE contact_id IN (SELECT id FROM wa_contacts WHERE phone LIKE '9999020%' OR wa_id LIKE '919999020%')`)
    await query(`DELETE FROM wa_conversations WHERE contact_id IN (SELECT id FROM wa_contacts WHERE phone LIKE '9999020%' OR wa_id LIKE '919999020%')`)
    await query(`DELETE FROM wa_contacts WHERE phone LIKE '9999020%' OR wa_id LIKE '919999020%'`)
    await query(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE '9999020%@t.local')`)
    await query(`DELETE FROM users WHERE email LIKE '9999020%@t.local'`)
  }
  const mkUser = async (n, name, { role = 'CUSTOMER', roleName = null, phone = PH(n) } = {}) => {
    const rid = roleName ? (await query(`SELECT id FROM roles WHERE name=$1`, [roleName])).rows[0].id : null
    return (await query(`INSERT INTO users (phone,name,email,role,role_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [phone, name, `${PH(n)}@t.local`, role, rid])).rows[0].id
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { AdminCustomersService } = await import('../../src/modules/admin/customers/customers.service.js')
    const { getWhatsappServices } = await import('../../src/modules/whatsapp-crm/whatsapp.factory.js')
    const { signAccessToken } = await import('../../src/utils/jwt.js')
    const { buildApp } = await import('../../src/app.js')
    svc = new AdminCustomersService()
    ;({ crm, repo } = getWhatsappServices())
    app = await buildApp(); await app.ready()
    restoreFeatures = await (await import('../helpers/features.js')).releaseFeatures(query)
    await cleanup()
    admin = await mkUser(1, 'T16 Admin', { role: 'ADMIN' })
    agent = await mkUser(2, 'T16 Agent', { role: 'ADMIN', roleName: 'CRM Agent' })
    cust = await mkUser(3, 'T16 Asha'); cust2 = await mkUser(4, 'T16 Bikram')
    noPhone = await mkUser(5, 'T16 NoPhone', { phone: '12345' })
    await query(`UPDATE users SET platform_role='SUPER_ADMIN' WHERE id=$1`, [admin])
    const t = (id, n, role = 'ADMIN', platform = null) => signAccessToken({ id, phone: PH(n), role, platform_role: platform })
    tok = { admin: t(admin, 1, 'ADMIN', 'SUPER_ADMIN'), agent: t(agent, 2), cust: t(cust, 3, 'CUSTOMER') }
  }, 60_000)
  afterAll(async () => { await restoreFeatures?.(); await cleanup(); await app?.close(); await closePool() })

  const access = (id, view_all = false) => ({ userId: id, isSuper: false, has: (p) => (view_all ? true : ['crm.inbox.view', 'crm.inbox.reply'].includes(p)) })

  describe('personal notifications', () => {
    it('are saved with who sent them, shown live, and listed in the customer’s history', async () => {
      const n = await svc.sendPersonalNotification(cust, 'Your refund', 'Rs 40 is on its way', fastify, { id: admin })
      expect(n).toMatchObject({ title: 'Your refund', type: 'ADMIN_MESSAGE' })
      expect(emitted.at(-1)[0]).toBe(cust)
      const row = (await query(`SELECT type, data, is_read FROM notifications WHERE id=$1`, [n.id])).rows[0]
      expect(row).toMatchObject({ type: 'ADMIN_MESSAGE', is_read: false })
      expect(row.data).toMatchObject({ sentBy: admin, sentByName: 'T16 Admin' })
      const h = await svc.notificationHistory(cust)
      expect(h).toHaveLength(1)
      expect(h[0]).toMatchObject({ title: 'Your refund', personal: true, isRead: false, sentByName: 'T16 Admin' })
    })
    it('personal-only hides automatic notifications; "all" shows both; other customers see nothing of it', async () => {
      await query(`INSERT INTO notifications (user_id,title,body,type) VALUES ($1,'Order delivered','x','ORDER_STATUS')`, [cust])
      expect((await svc.notificationHistory(cust, { personal: true })).map((x) => x.title)).toEqual(['Your refund'])
      const all = await svc.notificationHistory(cust, { personal: false })
      expect(all.map((x) => x.title).sort()).toEqual(['Order delivered', 'Your refund'])
      expect(all.find((x) => x.title === 'Order delivered').personal).toBe(false)
      expect(await svc.notificationHistory(cust2, { personal: false })).toEqual([])
    })
    it('refuses an unknown customer without saving anything', async () => {
      await expect(svc.sendPersonalNotification('00000000-0000-4000-8000-000000000000', 'x', 'y', fastify, { id: admin })).rejects.toMatchObject({ statusCode: 404 })
    })
    it('a phone-push failure never loses the saved message', async () => {
      const n = await svc.sendPersonalNotification(cust2, 'Hello', 'Hi Bikram', null, { id: admin })
      expect(n.id).toBeTruthy()
      expect((await svc.notificationHistory(cust2)).map((x) => x.title)).toEqual(['Hello'])
    })
  })

  describe('opening the WhatsApp conversation', () => {
    it('creates the contact + conversation; the 24-hour window stays CLOSED', async () => {
      const conv = await crm.openCustomerConversation(cust, access(agent))
      expect(conv).toMatchObject({ wa_id: `91${PH(3)}`, phone: PH(3), customer_id: cust, window_open: false, marketing_consent: 'UNKNOWN' })
      const contact = (await query(`SELECT source, last_inbound_at, user_id FROM wa_contacts WHERE id=$1`, [conv.contact_id])).rows[0]
      expect(contact).toMatchObject({ source: 'APP', last_inbound_at: null, user_id: cust })
    })
    it('is idempotent — the same conversation, one contact', async () => {
      const a = await crm.openCustomerConversation(cust, access(agent))
      const b = await crm.openCustomerConversation(cust, access(agent))
      expect(a.id).toBe(b.id)
      expect((await query(`SELECT COUNT(*)::int AS n FROM wa_contacts WHERE phone=$1`, [PH(3)])).rows[0].n).toBe(1)
    })
    it('links an existing number-only contact to the customer instead of duplicating it', async () => {
      await query(`INSERT INTO wa_contacts (wa_id, phone, source) VALUES ($1,$2,'ORGANIC')`, [`91${PH(4)}`, PH(4)])
      const conv = await crm.openCustomerConversation(cust2, access(agent))
      expect(conv.customer_id).toBe(cust2)
      expect((await query(`SELECT COUNT(*)::int AS n FROM wa_contacts WHERE phone=$1`, [PH(4)])).rows[0].n).toBe(1)
      expect((await query(`SELECT user_id FROM wa_contacts WHERE phone=$1`, [PH(4)])).rows[0].user_id).toBe(cust2)
    })
    it('refuses someone whose number is not a valid mobile number, a non-customer, or an unknown id', async () => {
      for (const id of [noPhone, admin, '00000000-0000-4000-8000-000000000000']) await expect(crm.openCustomerConversation(id, access(agent))).rejects.toMatchObject({ code: 'NO_WHATSAPP_NUMBER', statusCode: 409 })
    })
    it('an agent cannot open a conversation that belongs to another agent', async () => {
      const conv = await crm.openCustomerConversation(cust, access(agent))
      await query(`UPDATE wa_conversations SET assigned_to=$2 WHERE id=$1`, [conv.id, admin])
      await expect(crm.openCustomerConversation(cust, access(agent))).rejects.toMatchObject({ statusCode: 404 })
      expect((await crm.openCustomerConversation(cust, access(admin, true))).id).toBe(conv.id)
      await query(`UPDATE wa_conversations SET assigned_to=NULL WHERE id=$1`, [conv.id])
    })
  })

  describe('the WhatsApp history on the profile', () => {
    it('is empty — and creates nothing — for a customer who was never messaged', async () => {
      const lone = await mkUser(6, 'T16 Lone')
      expect(await crm.customerThread(lone, access(agent))).toEqual({ conversation: null, messages: [], restricted: false })
      expect((await query(`SELECT COUNT(*)::int AS n FROM wa_contacts WHERE phone=$1`, [PH(6)])).rows[0].n).toBe(0)
    })
    it('lists the messages oldest → newest, and flags another agent’s conversation as restricted', async () => {
      const conv = await crm.openCustomerConversation(cust, access(agent))
      await query(`INSERT INTO wa_messages (conversation_id, contact_id, direction, msg_type, body, status, created_at) VALUES ($1,$2,'OUTBOUND','text','Your order is ready','SENT', NOW() - interval '2 minutes')`, [conv.id, conv.contact_id])
      await query(`INSERT INTO wa_messages (conversation_id, contact_id, direction, msg_type, body, status, created_at) VALUES ($1,$2,'INBOUND','text','Thanks!','RECEIVED', NOW() - interval '1 minute')`, [conv.id, conv.contact_id])
      const t = await crm.customerThread(cust, access(agent))
      expect(t.messages.map((m) => m.body)).toEqual(['Your order is ready', 'Thanks!'])
      expect(t.conversation.id).toBe(conv.id)
      await query(`UPDATE wa_conversations SET assigned_to=$2 WHERE id=$1`, [conv.id, admin])
      expect(await crm.customerThread(cust, access(agent))).toEqual({ conversation: null, messages: [], restricted: true })
    })
  })

  describe('over HTTP', () => {
    it('401 without a token, 403 for a customer', async () => {
      for (const [m, u] of [['GET', `/customers/${cust}/notifications`], ['GET', `/crm/customers/${cust}/thread`], ['POST', `/crm/customers/${cust}/conversation`]]) {
        expect((await call(m, u)).statusCode, u).toBe(401)
        expect((await call(m, u, { token: tok.cust })).statusCode, `${u} as customer`).toBe(403)
      }
    })
    it('history endpoint validates and returns the list', async () => {
      expect((await call('GET', `/customers/not-a-uuid/notifications`, { token: tok.admin })).statusCode).toBe(400)
      expect((await call('GET', `/customers/${cust}/notifications?limit=500`, { token: tok.admin })).statusCode).toBe(400)
      const r = await call('GET', `/customers/${cust}/notifications?personal=true`, { token: tok.admin })
      expect(r.statusCode).toBe(200)
      expect(r.json().data[0]).toMatchObject({ title: 'Your refund', personal: true })
    })
    it('"Send notification" over HTTP saves it with the sender', async () => {
      const r = await call('POST', `/customers/${cust2}/notify`, { token: tok.admin, payload: { title: 'Via HTTP', body: 'Hello there' } })
      expect(r.statusCode).toBe(200)
      const h = (await call('GET', `/customers/${cust2}/notifications`, { token: tok.admin })).json().data
      expect(h.find((x) => x.title === 'Via HTTP')).toMatchObject({ sentByName: 'T16 Admin' })
    })
    it('the conversation route works for a CRM agent and returns what the profile needs', async () => {
      await query(`UPDATE wa_conversations SET assigned_to=NULL WHERE contact_id IN (SELECT id FROM wa_contacts WHERE phone=$1)`, [PH(3)])
      const r = await call('POST', `/crm/customers/${cust}/conversation`, { token: tok.agent })
      expect(r.statusCode).toBe(200)
      expect(r.json().data).toMatchObject({ customer_id: cust, window_open: false, wa_id: `91${PH(3)}` })
      const th = await call('GET', `/crm/customers/${cust}/thread`, { token: tok.agent })
      expect(th.json().data.messages).toHaveLength(2)
    })
    it('an agent gets a clear 409 for a customer without a number, and 400 for a bad id', async () => {
      const r = await call('POST', `/crm/customers/${noPhone}/conversation`, { token: tok.agent })
      expect(r.statusCode).toBe(409)
      expect(r.json().code).toBe('NO_WHATSAPP_NUMBER')
      expect((await call('POST', `/crm/customers/xyz/conversation`, { token: tok.agent })).statusCode).toBe(400)
    })
  })
})
