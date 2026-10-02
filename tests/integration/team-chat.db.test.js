/**
 * WhatsApp CRM Phase 9 — internal team chat. Real Postgres, opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/team-chat.db.test.js
 * Realtime is a recording fake. Run with the other CRM DB suites using --no-file-parallelism.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PH = (n) => `9999005${String(n).padStart(3, '0')}`

describe.skipIf(!enabled)('team chat', () => {
  let query, closePool, svc, repo
  let hq, hq2, shopA, shopB, shopA2, inactive, cust, shopAId, shopBId
  let emitted = []
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }

  const mkUser = async (n, name, { platformRole = null, active = true, role = 'ADMIN' } = {}) =>
    (await query(`INSERT INTO users (phone,name,email,role,platform_role,is_active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [PH(n), name, `${PH(n)}@t.local`, role, platformRole, active])).rows[0].id
  const mkShop = async (code) => (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ($1,$2,$3,'x','Kolkata','WB','700099',22.5,88.3,true) RETURNING id`, [`T9 Shop ${code}`, `t9-shop-${code}`, code])).rows[0].id
  const staffOf = (userId, shopId) => query(`INSERT INTO shop_staff (user_id, shop_id, role) VALUES ($1,$2,'SHOP_STAFF')`, [userId, shopId])
  const mkOrder = async (shopId, number) => (await query(`INSERT INTO orders (order_number, user_id, shop_id, status, items, subtotal, total_amount, delivery_address, payment_method) VALUES ($1,$2,$3,'CONFIRMED','[]'::jsonb,100,100,'{}'::jsonb,'COD') RETURNING id`, [number, cust, shopId])).rows[0].id
  const group = (as, name, memberIds) => svc.create(as, { kind: 'GROUP', name, memberIds })
  const unreadOf = async (u, channelId) => (await svc.list(u)).find((c) => c.id === channelId)?.unread

  async function cleanup() {
    await query(`DELETE FROM chat_channels WHERE created_by IN (SELECT id FROM users WHERE phone LIKE '9999005%') OR name LIKE 'T9 %'`)
    await query(`DELETE FROM orders WHERE order_number LIKE 'T9-%'`)
    await query(`DELETE FROM products WHERE slug LIKE 't9-%'`)
    await query(`DELETE FROM shop_staff WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '9999005%')`)
    await query(`DELETE FROM shops WHERE slug LIKE 't9-shop-%'`)
    await query(`DELETE FROM users WHERE phone LIKE '9999005%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { ChatRepository } = await import('../../src/modules/team-chat/chat.repository.js')
    const { ChatService } = await import('../../src/modules/team-chat/chat.service.js')
    repo = new ChatRepository()
    svc = new ChatService({ repo, emit: (ids, event, payload) => emitted.push({ ids: [...new Set(ids)], event, payload }), logger })
  })

  beforeEach(async () => {
    emitted = []
    await cleanup()
    hq = await mkUser(1, 'T9 Hema HQ', { platformRole: 'ADMIN' })
    hq2 = await mkUser(2, 'T9 Hari Support', { platformRole: 'HQ_SUPPORT' })
    shopA = await mkUser(3, 'T9 Asha ShopA')
    shopA2 = await mkUser(4, 'T9 Amit ShopA')
    shopB = await mkUser(5, 'T9 Bala ShopB')
    inactive = await mkUser(6, 'T9 Gone', { active: false })
    cust = await mkUser(7, 'T9 Customer Cathy', { role: 'CUSTOMER' })
    shopAId = await mkShop('A9')
    shopBId = await mkShop('B9')
    await staffOf(shopA, shopAId); await staffOf(shopA2, shopAId); await staffOf(shopB, shopBId)
  })

  afterAll(async () => {
    await cleanup()
    await closePool()
  })

  describe('who can use chat', () => {
    it('active dashboard users only — not customers or deactivated staff', async () => {
      await expect(svc.me(cust)).rejects.toMatchObject({ statusCode: 403 })
      await expect(svc.me(inactive)).rejects.toMatchObject({ statusCode: 403 })
      expect(await svc.me(shopA)).toMatchObject({ canManage: false, isHq: false })
      expect(await svc.me(hq)).toMatchObject({ canManage: true, isHq: true })
      expect(await svc.me(hq2)).toMatchObject({ canManage: false, isHq: true })
    })

    it('the people list is staff only, excludes you, and exposes no phone or email', async () => {
      const people = await svc.people(shopA, { search: 'T9' })
      const ids = people.map((p) => p.id)
      expect(ids).toContain(shopB)
      expect(ids).not.toContain(shopA)
      expect(ids).not.toContain(cust)
      expect(ids).not.toContain(inactive)
      expect(Object.keys(people[0]).sort()).toEqual(['id', 'name', 'platform_role', 'shops'])
      expect(people.find((p) => p.id === shopB).shops).toEqual(['T9 Shop B9'])
    })

    it('a role that lists chat.manage can manage channels', async () => {
      const role = (await query(`INSERT INTO roles (name, permissions) VALUES ('T9 Chat Mgr', '["chat.manage"]'::jsonb) RETURNING id`)).rows[0].id
      await query(`UPDATE users SET role_id = $2 WHERE id = $1`, [shopA, role])
      expect((await svc.me(shopA)).canManage).toBe(true)
      await query(`UPDATE users SET role_id = NULL WHERE id = $1`, [shopA])
      await query(`DELETE FROM roles WHERE name = 'T9 Chat Mgr'`)
    })
  })

  describe('direct messages', () => {
    it('one DM per pair, whoever starts it, shown to each side with the other person\'s name', async () => {
      const a = await svc.create(shopA, { kind: 'DM', userId: shopB })
      const b = await svc.create(shopB, { kind: 'DM', userId: shopA })
      expect(b.id).toBe(a.id)
      expect(a).toMatchObject({ kind: 'DM', name: 'T9 Bala ShopB', member_count: 2 })
      expect((await svc.get(shopB, a.id)).name).toBe('T9 Asha ShopA')
      expect((await query(`SELECT COUNT(*)::int n FROM chat_channels WHERE kind='DM' AND dm_key = $1`, [[shopA, shopB].sort().join(':')])).rows[0].n).toBe(1)
    })
    it('not with yourself, a customer, or deactivated staff', async () => {
      await expect(svc.create(shopA, { kind: 'DM', userId: shopA })).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(svc.create(shopA, { kind: 'DM', userId: cust })).rejects.toMatchObject({ code: 'PERSON_NOT_FOUND' })
      await expect(svc.create(shopA, { kind: 'DM', userId: inactive })).rejects.toMatchObject({ code: 'PERSON_NOT_FOUND' })
    })
    it('two people starting the same DM at once still get one channel', async () => {
      const [x, y] = await Promise.all([svc.create(shopA, { kind: 'DM', userId: shopB }), svc.create(shopB, { kind: 'DM', userId: shopA })])
      expect(x.id).toBe(y.id)
    })
    it('a DM cannot be renamed, extended, left or archived', async () => {
      const d = await svc.create(shopA, { kind: 'DM', userId: shopB })
      await expect(svc.update(shopA, d.id, { name: 'x y' })).rejects.toMatchObject({ statusCode: 403 })
      await expect(svc.addMembers(shopA, d.id, [hq])).rejects.toMatchObject({ statusCode: 403 })
      await expect(svc.removeMember(shopA, d.id, shopA)).rejects.toMatchObject({ statusCode: 403 })
      await expect(svc.setArchived(shopA, d.id, true)).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('groups and channels', () => {
    it('anyone can start a group and becomes its owner; members are told', async () => {
      const g = await group(shopA, 'T9 Store A pickers', [shopA2, shopB])
      expect(g).toMatchObject({ kind: 'GROUP', member_count: 3, my_role: 'OWNER' })
      expect(g.members.find((m) => m.user_id === shopA).role).toBe('OWNER')
      const ev = emitted.find((e) => e.event === 'chat:channel')
      expect(ev.ids.sort()).toEqual([shopA, shopA2, shopB].sort())
    })
    it('refuses people who are not active staff, and an empty group', async () => {
      await expect(group(shopA, 'T9 g', [cust])).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(group(shopA, 'T9 g', [inactive])).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(group(shopA, 'T9 g', [])).rejects.toMatchObject({ code: 'VALIDATION' })
    })
    it('only HQ managers create channels; an audience adds all HQ staff and the staff of chosen stores (store ↔ store)', async () => {
      await expect(svc.create(shopA, { kind: 'CHANNEL', name: 'T9 x', memberIds: [shopB] })).rejects.toMatchObject({ statusCode: 403 })
      const c = await svc.create(hq, { kind: 'CHANNEL', name: 'T9 Stores A+B', audience: { shopIds: [shopAId, shopBId] } })
      expect(c.members.map((m) => m.user_id).sort()).toEqual([hq, shopA, shopA2, shopB].sort())
      const all = await svc.create(hq, { kind: 'CHANNEL', name: 'T9 HQ team', audience: { hq: true } })
      const ids = all.members.map((m) => m.user_id) // the dev DB may hold other real HQ staff; check only this test's people
      expect(ids).toEqual(expect.arrayContaining([hq, hq2]))
      expect(ids).not.toEqual(expect.arrayContaining([shopA]))
      expect(ids).not.toContain(shopB)
    })
    it('refreshing a channel adds new store staff and never removes anyone', async () => {
      const c = await svc.create(hq, { kind: 'CHANNEL', name: 'T9 Store A', audience: { shopIds: [shopAId] } })
      const newbie = await mkUser(8, 'T9 Newbie')
      await staffOf(newbie, shopAId)
      await svc.removeMember(hq, c.id, shopA) // manager removed Asha on purpose…
      expect(await svc.refreshAudience(hq, c.id)).toEqual({ added: 2 }) // …refresh re-adds her (audience says so) and adds Newbie
      expect((await svc.get(hq, c.id)).members.map((m) => m.user_id)).toEqual(expect.arrayContaining([newbie, shopA, shopA2, hq]))
      await expect(svc.refreshAudience(shopA, c.id)).rejects.toMatchObject({ statusCode: 403 })
    })
    it('owner adds and removes people; a plain member cannot; an inactive person cannot be added', async () => {
      const g = await group(shopA, 'T9 g', [shopA2])
      await svc.addMembers(shopA, g.id, [shopB])
      await expect(svc.addMembers(shopA2, g.id, [hq])).rejects.toMatchObject({ statusCode: 403 })
      await expect(svc.addMembers(shopA, g.id, [inactive])).rejects.toMatchObject({ code: 'VALIDATION' })
      await svc.removeMember(shopA, g.id, shopB)
      expect((await svc.get(shopA, g.id)).member_count).toBe(2)
      await expect(svc.removeMember(shopA2, g.id, shopA)).rejects.toMatchObject({ statusCode: 403 })
    })
    it('a member can leave a group; ownership passes on; the last one out archives it', async () => {
      const g = await group(shopA, 'T9 g', [shopA2])
      await svc.removeMember(shopA, g.id, shopA)
      expect((await svc.get(shopA2, g.id)).my_role).toBe('OWNER')
      await svc.removeMember(shopA2, g.id, shopA2)
      expect((await query(`SELECT archived_at FROM chat_channels WHERE id = $1`, [g.id])).rows[0].archived_at).not.toBeNull()
    })
    it('members of a managed channel cannot walk out of it', async () => {
      const c = await svc.create(hq, { kind: 'CHANNEL', name: 'T9 ch', memberIds: [shopA] })
      await expect(svc.removeMember(shopA, c.id, shopA)).rejects.toMatchObject({ statusCode: 403 })
    })
    it('a group is capped at 100 people', async () => {
      const ids = []
      for (let i = 0; i < 100; i++) ids.push(await mkUser(100 + i, `T9 bulk ${i}`))
      await expect(group(shopA, 'T9 big', ids)).rejects.toMatchObject({ code: 'TOO_MANY_MEMBERS' })
    })
  })

  describe('privacy: a chat you are not in does not exist', () => {
    it('every operation answers 404 to an outsider, and the list never shows it', async () => {
      const g = await group(shopA, 'T9 private', [shopA2])
      for (const call of [
        () => svc.get(shopB, g.id), () => svc.messages(shopB, g.id), () => svc.send(shopB, g.id, { body: 'hi' }),
        () => svc.markRead(shopB, g.id), () => svc.update(shopB, g.id, { name: 'hack' }), () => svc.addMembers(shopB, g.id, [shopB]),
        () => svc.setArchived(shopB, g.id, true), () => svc.removeMember(shopB, g.id, shopA),
      ]) await expect(call()).rejects.toMatchObject({ statusCode: 404, code: 'CHANNEL_NOT_FOUND' })
      expect((await svc.list(shopB)).some((c) => c.id === g.id)).toBe(false)
    })
    it('even an HQ manager is not let into other people\'s chats', async () => {
      const d = await svc.create(shopA, { kind: 'DM', userId: shopB })
      await expect(svc.messages(hq, d.id)).rejects.toMatchObject({ statusCode: 404 })
    })
    it('removing someone ends their access immediately; deactivating staff does too', async () => {
      const g = await group(shopA, 'T9 g', [shopA2, shopB])
      await svc.send(shopA, g.id, { body: 'secret plan' })
      await svc.removeMember(shopA, g.id, shopB)
      await expect(svc.messages(shopB, g.id)).rejects.toMatchObject({ statusCode: 404 })
      await query(`UPDATE users SET is_active = false WHERE id = $1`, [shopA2])
      await expect(svc.messages(shopA2, g.id)).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('messages, unread and mentions', () => {
    it('delivers to members only (their personal rooms), including the sender\'s other tabs', async () => {
      const g = await group(shopA, 'T9 g', [shopA2])
      emitted = []
      const m = await svc.send(shopA, g.id, { body: ' hello team ' })
      expect(m).toMatchObject({ body: 'hello team', sender_id: shopA, sender_name: 'T9 Asha ShopA', deleted: false, ref: null })
      const ev = emitted.find((e) => e.event === 'chat:message')
      expect(ev.ids.sort()).toEqual([shopA, shopA2].sort())
      expect(ev.payload.channelId).toBe(g.id)
    })
    it('counts unread per person, clears on read, and your own messages are never unread for you', async () => {
      const g = await group(shopA, 'T9 g', [shopA2])
      await svc.send(shopA, g.id, { body: 'one' }); await svc.send(shopA, g.id, { body: 'two' })
      expect(await unreadOf(shopA2, g.id)).toBe(2)
      expect(await unreadOf(shopA, g.id)).toBe(0)
      expect(await svc.unread(shopA2)).toEqual({ unread: 2, mentions: 0 })
      await svc.markRead(shopA2, g.id)
      expect(await unreadOf(shopA2, g.id)).toBe(0)
      await svc.send(shopA2, g.id, { body: 'reply' })
      expect(await unreadOf(shopA, g.id)).toBe(1)
    })
    it('someone added later does not see old messages as unread', async () => {
      const g = await group(shopA, 'T9 g', [shopA2])
      await svc.send(shopA, g.id, { body: 'before' })
      await svc.addMembers(shopA, g.id, [shopB])
      expect(await unreadOf(shopB, g.id)).toBe(0)
    })
    it('@mentions: only members are kept, never yourself, and they raise the mention count', async () => {
      const g = await group(shopA, 'T9 g', [shopA2])
      const m = await svc.send(shopA, g.id, { body: '@Amit look', mentions: [shopA2, shopA, shopB, 'junk'] })
      expect(m.mentions).toEqual([shopA2])
      await svc.send(shopA, g.id, { body: 'no mention' })
      expect(await svc.unread(shopA2)).toEqual({ unread: 2, mentions: 1 })
      expect((await svc.list(shopA2))[0]).toMatchObject({ unread: 2, unread_mentions: 1 })
    })
    it('lists newest-last with paging by seq', async () => {
      const g = await group(shopA, 'T9 g', [shopA2])
      for (let i = 1; i <= 5; i++) await svc.send(shopA, g.id, { body: `m${i}` })
      const page1 = await svc.messages(shopA, g.id, { limit: 3 })
      expect(page1.map((m) => m.body)).toEqual(['m3', 'm4', 'm5'])
      const page2 = await svc.messages(shopA, g.id, { limit: 3, before: page1[0].seq })
      expect(page2.map((m) => m.body)).toEqual(['m1', 'm2'])
    })
    it('rejects empty and over-long text, and writing in an archived chat', async () => {
      const g = await group(shopA, 'T9 g', [shopA2])
      await expect(svc.send(shopA, g.id, { body: '   ' })).rejects.toMatchObject({ code: 'EMPTY_MESSAGE' })
      await expect(svc.send(shopA, g.id, { body: 'x'.repeat(4001) })).rejects.toMatchObject({ code: 'BODY_TOO_LONG' })
      await svc.setArchived(shopA, g.id, true)
      await expect(svc.send(shopA, g.id, { body: 'hi' })).rejects.toMatchObject({ code: 'ARCHIVED' })
      expect((await svc.list(shopA)).some((c) => c.id === g.id)).toBe(false)
      expect((await svc.list(shopA, { archived: true })).some((c) => c.id === g.id)).toBe(true)
      await svc.setArchived(shopA, g.id, false)
      await expect(svc.send(shopA, g.id, { body: 'back' })).resolves.toMatchObject({ body: 'back' })
    })
    it('limits how fast one person can send', async () => {
      const g = await group(shopA, 'T9 g', [shopA2])
      for (let i = 0; i < 30; i++) await svc.send(shopA, g.id, { body: `m${i}` })
      await expect(svc.send(shopA, g.id, { body: 'one too many' })).rejects.toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' })
      await expect(svc.send(shopA2, g.id, { body: 'someone else is fine' })).resolves.toBeTruthy()
    })
    it('concurrent sends keep a strict order and nothing is lost', async () => {
      const g = await group(shopA, 'T9 g', [shopA2])
      await Promise.all(Array.from({ length: 10 }, (_, i) => svc.send(i % 2 ? shopA : shopA2, g.id, { body: `c${i}` })))
      const all = await svc.messages(shopA, g.id, { limit: 50 })
      expect(all).toHaveLength(10)
      expect(all.map((m) => m.seq)).toEqual([...all.map((m) => m.seq)].sort((a, b) => a - b))
    })
    it('delete: own message (or an HQ manager\'s), content is removed for good, the marker stays', async () => {
      const g = await group(shopA, 'T9 g', [shopA2, hq])
      const m = await svc.send(shopA, g.id, { body: 'oops wrong chat', mentions: [shopA2] })
      await expect(svc.deleteMessage(shopA2, g.id, m.id)).rejects.toMatchObject({ statusCode: 403 })
      await svc.deleteMessage(shopA, g.id, m.id)
      const [after] = await svc.messages(shopA2, g.id)
      expect(after).toMatchObject({ deleted: true, body: '', mentions: [], ref: null })
      expect((await query(`SELECT body, mentions FROM chat_messages WHERE id = $1`, [m.id])).rows[0]).toEqual({ body: '', mentions: [] })
      expect(await unreadOf(shopA2, g.id)).toBe(0) // a deleted message is not "unread"
      const m2 = await svc.send(shopA2, g.id, { body: 'rude' })
      await svc.deleteMessage(hq, g.id, m2.id) // HQ manager moderates
      expect((await svc.messages(hq, g.id)).at(-1).deleted).toBe(true)
    })
  })

  describe('sharing an order, product or customer', () => {
    it('store staff can share their own store\'s order, not another store\'s', async () => {
      const oA = await mkOrder(shopAId, 'T9-A1')
      const oB = await mkOrder(shopBId, 'T9-B1')
      const g = await group(shopA, 'T9 g', [shopB])
      const m = await svc.send(shopA, g.id, { body: 'please check', ref: { type: 'ORDER', id: oA } })
      expect(m.ref).toEqual({ type: 'ORDER', id: oA, label: 'Order T9-A1' })
      await expect(svc.send(shopA, g.id, { body: 'x', ref: { type: 'ORDER', id: oB } })).rejects.toMatchObject({ code: 'REF_FORBIDDEN' })
    })
    it('HQ can share any order; a message may be only a shared item', async () => {
      const oB = await mkOrder(shopBId, 'T9-B2')
      const g = await group(hq, 'T9 g', [shopB])
      const m = await svc.send(hq, g.id, { body: '', ref: { type: 'ORDER', id: oB } })
      expect(m).toMatchObject({ body: '', ref: { label: 'Order T9-B2' } })
      expect((await svc.list(shopB))[0].preview).toBe('Shared Order T9-B2')
    })
    it('searching orders is scoped the same way', async () => {
      await mkOrder(shopAId, 'T9-S1'); await mkOrder(shopBId, 'T9-S2')
      expect((await svc.searchRefs(shopA, { type: 'ORDER', q: 'T9-S' })).map((r) => r.label)).toEqual(['Order T9-S1'])
      expect((await svc.searchRefs(hq, { type: 'ORDER', q: 'T9-S' })).map((r) => r.label).sort()).toEqual(['Order T9-S1', 'Order T9-S2'])
      expect(await svc.searchRefs(hq, { type: 'ORDER', q: 'T' })).toEqual([]) // too short
    })
    it('products can be shared by anyone', async () => {
      const p = (await query(`INSERT INTO products (name, slug, price) VALUES ('T9 Basmati Rice 5kg','t9-basmati',450) RETURNING id`)).rows[0].id
      const g = await group(shopA, 'T9 g', [shopB])
      expect((await svc.send(shopA, g.id, { body: 'stock?', ref: { type: 'PRODUCT', id: p } })).ref.label).toBe('T9 Basmati Rice 5kg')
      expect((await svc.searchRefs(shopA, { type: 'PRODUCT', q: 'basmati' })).some((r) => r.id === p)).toBe(true)
    })
    it('customers: HQ only, by name only (no phone), and store staff cannot even search them', async () => {
      const g = await group(hq, 'T9 g', [shopA])
      const m = await svc.send(hq, g.id, { body: 'VIP', ref: { type: 'CUSTOMER', id: cust } })
      expect(JSON.stringify(m)).not.toContain(PH(7))
      expect(m.ref.label).toBe('T9 Customer Cathy')
      const g2 = await group(shopA, 'T9 g2', [shopB])
      await expect(svc.send(shopA, g2.id, { body: 'x', ref: { type: 'CUSTOMER', id: cust } })).rejects.toMatchObject({ code: 'REF_FORBIDDEN' })
      expect(await svc.searchRefs(shopA, { type: 'CUSTOMER', q: 'Cathy' })).toEqual([])
      expect((await svc.searchRefs(hq, { type: 'CUSTOMER', q: 'Cathy' })).map((r) => r.id)).toEqual([cust])
    })
    it('an unknown item is refused', async () => {
      const g = await group(shopA, 'T9 g', [shopB])
      await expect(svc.send(shopA, g.id, { body: 'x', ref: { type: 'PRODUCT', id: '99999999-9999-4999-8999-999999999999' } })).rejects.toMatchObject({ code: 'REF_NOT_FOUND' })
    })
  })

  describe('separate from customer messages', () => {
    it('never touches the WhatsApp tables', async () => {
      const before = (await query(`SELECT (SELECT COUNT(*) FROM wa_messages) AS m, (SELECT COUNT(*) FROM wa_conversations) AS c`)).rows[0]
      const g = await group(shopA, 'T9 g', [shopB])
      await svc.send(shopA, g.id, { body: 'internal only' })
      expect((await query(`SELECT (SELECT COUNT(*) FROM wa_messages) AS m, (SELECT COUNT(*) FROM wa_conversations) AS c`)).rows[0]).toEqual(before)
    })
  })
})
