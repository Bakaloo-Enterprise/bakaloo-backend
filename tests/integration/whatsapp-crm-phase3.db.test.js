/**
 * WhatsApp CRM Phase 3 — labels, ownership, visibility, workload, access guard.
 * Real Postgres, opt-in:  WA_CRM_DB_TEST=1 npx vitest run tests/integration/whatsapp-crm-phase3.db.test.js
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const WA = ['919999000071', '919999000072', '919999000073']
const PHONES = ['9999000061', '9999000062', '9999000063', '9999000064', '9999000065']

describe.skipIf(!enabled)('WhatsApp CRM — labels, assignment, visibility, workload', () => {
  let query, closePool, repo, admin, crm, loadCrmAccess, CRM_PERM
  let mgr, agentA, agentB, nobody, plainRole // user ids
  let convs // [c1,c2,c3] conversation ids
  const emitted = []
  const emit = (e, p) => emitted.push({ e, p })

  const mkUser = async (phone, name, roleName, platformRole = null) => {
    const r = roleName ? (await query(`SELECT id FROM roles WHERE name = $1`, [roleName])).rows[0].id : null
    return (await query(`INSERT INTO users (phone,name,email,role,platform_role,role_id) VALUES ($1,$2,$3,'ADMIN',$4,$5) RETURNING id`, [phone, name, `${phone}@t.local`, platformRole, r])).rows[0].id
  }
  const access = (userId) => loadCrmAccess(userId)

  async function cleanup() {
    await query(`DELETE FROM wa_contacts WHERE wa_id = ANY($1)`, [WA])
    await query(`DELETE FROM users WHERE phone = ANY($1)`, [PHONES])
    await query(`DELETE FROM wa_labels WHERE name LIKE 'T3-%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { WhatsappRepository } = await import('../../src/modules/whatsapp-crm/whatsapp.repository.js')
    const { CrmAdminRepository } = await import('../../src/modules/whatsapp-crm/crm-admin.repository.js')
    const { CrmAdminService } = await import('../../src/modules/whatsapp-crm/crm-admin.service.js')
    ;({ loadCrmAccess, CRM_PERM } = await import('../../src/modules/whatsapp-crm/access.js'))
    repo = new WhatsappRepository()
    admin = new CrmAdminRepository()
    crm = new CrmAdminService({ repo, admin, emit })
    await cleanup()
    mgr = await mkUser('9999000061', 'Mgr Maya', 'CRM Manager')
    agentA = await mkUser('9999000062', 'Agent Asha', 'CRM Agent')
    agentB = await mkUser('9999000063', 'Agent Bimal', 'CRM Agent')
    nobody = await mkUser('9999000064', 'No Crm Nikhil', 'Support Agent') // existing legacy role, no crm.*
    plainRole = await mkUser('9999000065', 'Hq Hari', null, 'SUPER_ADMIN') // HQ bypass, no role_id
  })

  beforeEach(async () => {
    emitted.length = 0
    await query(`DELETE FROM wa_contacts WHERE wa_id = ANY($1)`, [WA])
    convs = []
    for (const wa of WA) {
      const c = (await query(`INSERT INTO wa_contacts (wa_id, phone, profile_name) VALUES ($1,$2,$3) RETURNING id`, [wa, wa.slice(2), `Cust ${wa.slice(-2)}`])).rows[0].id
      const v = (await query(`INSERT INTO wa_conversations (contact_id, last_inbound_at, last_message_at, last_message_direction, unread_count) VALUES ($1, NOW(), NOW() - INTERVAL '30 minutes', 'INBOUND', 2) RETURNING id`, [c])).rows[0].id
      convs.push(v)
    }
  })

  afterAll(async () => {
    await cleanup()
    await closePool()
  })

  // ── access guard ────────────────────────────────────────────────
  describe('permissions', () => {
    it('CRM Agent: view/reply/apply labels only', async () => {
      const a = await access(agentA)
      expect(a.has(CRM_PERM.INBOX_VIEW)).toBe(true)
      expect(a.has(CRM_PERM.INBOX_REPLY)).toBe(true)
      expect(a.has(CRM_PERM.LABELS_APPLY)).toBe(true)
      expect(a.has(CRM_PERM.INBOX_VIEW_ALL)).toBe(false)
      expect(a.has(CRM_PERM.ASSIGN)).toBe(false)
      expect(a.has(CRM_PERM.LABELS_MANAGE)).toBe(false)
      expect(a.has(CRM_PERM.WORKLOAD_VIEW)).toBe(false)
    })
    it('CRM Manager has everything', async () => {
      const a = await access(mgr)
      for (const p of Object.values(CRM_PERM)) expect(a.has(p)).toBe(true)
    })
    it('a team member with another role (no crm.*) has nothing', async () => {
      const a = await access(nobody)
      for (const p of Object.values(CRM_PERM)) expect(a.has(p)).toBe(false)
    })
    it('HQ SUPER_ADMIN passes without any role_id', async () => {
      const a = await access(plainRole)
      expect(a.isSuper).toBe(true)
      expect(a.has(CRM_PERM.ASSIGN)).toBe(true)
    })
    it('unknown or deactivated user has nothing', async () => {
      expect((await access('00000000-0000-0000-0000-000000000000')).has(CRM_PERM.INBOX_VIEW)).toBe(false)
      await query(`UPDATE users SET is_active = false WHERE id = $1`, [agentB])
      expect((await access(agentB)).has(CRM_PERM.INBOX_VIEW)).toBe(false)
      await query(`UPDATE users SET is_active = true WHERE id = $1`, [agentB])
    })
  })

  // ── assignment ──────────────────────────────────────────────────
  describe('assignment', () => {
    it('manager assigns, then transfers; each step is audited with who/from/to', async () => {
      const m = await access(mgr)
      let c = await crm.assign(convs[0], agentA, m)
      expect(c.assigned_to).toBe(agentA)
      expect(c.assigned_name).toBe('Agent Asha')
      c = await crm.assign(convs[0], agentB, m)
      expect(c.assigned_to).toBe(agentB)
      c = await crm.assign(convs[0], null, m)
      expect(c.assigned_to).toBeNull()
      const log = (await query(`SELECT action, from_user_id, to_user_id, changed_by FROM wa_assignment_log WHERE conversation_id = $1 ORDER BY created_at`, [convs[0]])).rows
      expect(log.map((l) => l.action)).toEqual(['ASSIGN', 'TRANSFER', 'UNASSIGN'])
      expect(log[1]).toMatchObject({ from_user_id: agentA, to_user_id: agentB, changed_by: mgr })
      expect(emitted.every((x) => x.e === 'crm:conversation')).toBe(true)
    })

    it('assigning to the same owner changes and logs nothing', async () => {
      const m = await access(mgr)
      await crm.assign(convs[0], agentA, m)
      emitted.length = 0
      await crm.assign(convs[0], agentA, m)
      expect(Number((await query(`SELECT COUNT(*) FROM wa_assignment_log WHERE conversation_id = $1`, [convs[0]])).rows[0].count)).toBe(1)
      expect(emitted).toHaveLength(0)
    })

    it('an agent can CLAIM an unassigned chat for themselves', async () => {
      const c = await crm.assign(convs[1], agentA, await access(agentA))
      expect(c.assigned_to).toBe(agentA)
      expect((await query(`SELECT action FROM wa_assignment_log WHERE conversation_id = $1`, [convs[1]])).rows[0].action).toBe('CLAIM')
    })

    it('an agent cannot assign to someone else, steal an owned chat, or unassign', async () => {
      const a = await access(agentA)
      await expect(crm.assign(convs[1], agentB, a)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      await crm.assign(convs[1], agentB, await access(mgr))
      // B's chat is invisible to A -> 404, not even a hint that it exists
      await expect(crm.assign(convs[1], agentA, a)).rejects.toMatchObject({ statusCode: 404 })
      // A's own chat: A still cannot hand it to B (manager action)
      await crm.assign(convs[2], agentA, a)
      await expect(crm.assign(convs[2], agentB, a)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      await expect(crm.assign(convs[2], null, a)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    })

    it('cannot assign to someone who cannot work the inbox', async () => {
      const m = await access(mgr)
      await expect(crm.assign(convs[0], nobody, m)).rejects.toMatchObject({ code: 'NOT_AN_AGENT' })
      await expect(crm.assign(convs[0], '00000000-0000-0000-0000-000000000000', m)).rejects.toMatchObject({ code: 'NOT_AN_AGENT' })
    })

    it('bulk reassign moves only the conversations that change, logs them as BULK, enforces limits', async () => {
      const m = await access(mgr)
      await crm.assign(convs[0], agentA, m)
      const r = await crm.bulkAssign(convs, agentA, m) // convs[0] already A
      expect(r).toEqual({ requested: 3, changed: 2 })
      const owners = (await query(`SELECT assigned_to FROM wa_conversations WHERE id = ANY($1)`, [convs])).rows
      expect(owners.every((o) => o.assigned_to === agentA)).toBe(true)
      expect(Number((await query(`SELECT COUNT(*) FROM wa_assignment_log WHERE action = 'BULK' AND conversation_id = ANY($1)`, [convs])).rows[0].count)).toBe(2)
      await expect(crm.bulkAssign([], agentA, m)).rejects.toMatchObject({ code: 'NOTHING_SELECTED' })
      await expect(crm.bulkAssign(Array.from({ length: 201 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`), agentA, m)).rejects.toMatchObject({ code: 'TOO_MANY' })
      await expect(crm.bulkAssign(convs, agentB, await access(agentA))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    })
  })

  // ── visibility ──────────────────────────────────────────────────
  describe('visibility', () => {
    beforeEach(async () => {
      const m = await access(mgr)
      await crm.assign(convs[0], agentA, m)
      await crm.assign(convs[1], agentB, m)
      // convs[2] stays unassigned
    })
    const ids = (rows) => rows.map((r) => r.id).filter((id) => convs.includes(id))

    it('an agent lists only own + unassigned chats', async () => {
      expect(ids(await repo.listConversations({ visibleTo: agentA, limit: 100 })).sort()).toEqual([convs[0], convs[2]].sort())
    })
    it('a manager lists everything', async () => {
      expect(ids(await repo.listConversations({ limit: 100 })).sort()).toEqual([...convs].sort())
    })
    it('assignedTo filter: unassigned and by user', async () => {
      expect(ids(await repo.listConversations({ assignedTo: 'unassigned', limit: 100 }))).toEqual([convs[2]])
      expect(ids(await repo.listConversations({ assignedTo: agentB, limit: 100 }))).toEqual([convs[1]])
    })
    it('direct reads of another agent’s chat are a 404 (same as missing)', async () => {
      const a = await access(agentA)
      await expect(crm.getAccessibleConversation(convs[1], a)).rejects.toMatchObject({ statusCode: 404 })
      await expect(crm.getAccessibleConversation('00000000-0000-0000-0000-000000000000', a)).rejects.toMatchObject({ statusCode: 404 })
      expect((await crm.getAccessibleConversation(convs[0], a)).id).toBe(convs[0])
      expect((await crm.getAccessibleConversation(convs[1], await access(mgr))).id).toBe(convs[1])
    })
  })

  // ── labels ──────────────────────────────────────────────────────
  describe('labels', () => {
    it('create (case-insensitive unique), update, delete', async () => {
      const m = await access(mgr)
      const l = await crm.createLabel({ name: 'T3-Gold', color: '#112233' }, m)
      expect(l.color).toBe('#112233')
      await expect(crm.createLabel({ name: 't3-GOLD' }, m)).rejects.toMatchObject({ code: 'LABEL_EXISTS' })
      expect((await crm.updateLabel(l.id, { color: '#445566' })).color).toBe('#445566')
      await expect(crm.updateLabel('00000000-0000-0000-0000-000000000000', { name: 'x' })).rejects.toMatchObject({ code: 'LABEL_NOT_FOUND' })
      await crm.deleteLabel(l.id)
      await expect(crm.deleteLabel(l.id)).rejects.toMatchObject({ code: 'LABEL_NOT_FOUND' })
    })

    it('apply / remove labels on a conversation, filter by label, and delete cascades', async () => {
      const m = await access(mgr)
      const a = await access(agentA)
      const l = await crm.createLabel({ name: 'T3-VIP' }, m)
      await crm.assign(convs[0], agentA, m)

      const c = await crm.addConversationLabel(convs[0], l.id, a)
      expect(c.labels.map((x) => x.name)).toEqual(['T3-VIP'])
      await crm.addConversationLabel(convs[0], l.id, a) // idempotent
      expect((await repo.getConversation(convs[0])).labels).toHaveLength(1)
      expect((await repo.listConversations({ labelId: l.id, limit: 100 })).map((r) => r.id)).toEqual([convs[0]])

      const counts = (await admin.listLabels()).find((x) => x.id === l.id)
      expect(counts.customer_count).toBe(1)

      expect((await crm.removeConversationLabel(convs[0], l.id, a)).labels).toEqual([])
      await crm.addConversationLabel(convs[0], l.id, a)
      await crm.deleteLabel(l.id)
      expect((await repo.getConversation(convs[0])).labels).toEqual([])
    })

    it('an agent cannot label a chat they cannot see; unknown label is a 404', async () => {
      const m = await access(mgr)
      const l = await crm.createLabel({ name: 'T3-Secret' }, m)
      await crm.assign(convs[1], agentB, m)
      await expect(crm.addConversationLabel(convs[1], l.id, await access(agentA))).rejects.toMatchObject({ statusCode: 404 })
      await expect(crm.addConversationLabel(convs[0], '00000000-0000-0000-0000-000000000000', m)).rejects.toMatchObject({ code: 'LABEL_NOT_FOUND' })
    })

    it('the starter labels from the agreement exist', async () => {
      const names = (await admin.listLabels()).map((l) => l.name)
      for (const n of ['VIP', 'New Customer', 'B2B', 'Abandoned Cart', 'Needs Follow-up', 'Complaint']) expect(names).toContain(n)
    })
  })

  // ── agents & workload ───────────────────────────────────────────
  describe('agents & workload', () => {
    it('agent list = CRM roles + HQ admins only', async () => {
      const ids = (await admin.listAgents()).map((a) => a.id)
      expect(ids).toEqual(expect.arrayContaining([mgr, agentA, agentB, plainRole]))
      expect(ids).not.toContain(nobody)
    })

    it('workload counts active chats, unread, awaiting reply and waiting > 15 min per agent', async () => {
      const m = await access(mgr)
      await crm.assign(convs[0], agentA, m)
      await crm.assign(convs[1], agentA, m)
      await query(`UPDATE wa_conversations SET status = 'RESOLVED' WHERE id = $1`, [convs[1]]) // resolved is not workload
      const w = await admin.workload()
      const a = w.agents.find((x) => x.id === agentA)
      expect(a).toMatchObject({ active: 1, unread: 2, awaiting_reply: 1, waiting_over_15m: 1 })
      expect(w.agents.find((x) => x.id === agentB)).toMatchObject({ active: 0, unread: 0 })
      expect(w.unassigned.active).toBeGreaterThanOrEqual(1)
    })
  })
})
