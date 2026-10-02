/**
 * WhatsApp CRM Phase 6 — templates: lifecycle, sync, webhooks, sending. Real Postgres, opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/whatsapp-crm-phase6.db.test.js
 * Meta is a recording fake — no real WhatsApp call is made.
 */
import crypto from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MetaApiError } from '../../src/modules/whatsapp-crm/meta-client.js' // no DB/env dependency, so it is safe at collection time

const enabled = process.env.WA_CRM_DB_TEST === '1'
const WA = { a: '919999002001', b: '919999002002' }
const PHONES = ['9999002001', '9999002002', '9999002009', '9999002010']

describe.skipIf(!enabled)('WhatsApp CRM — templates', () => {
  let query, closePool, tplRepo, svc, send, repo, inbound, loadCrmAccess, CrmAdminService, TemplateService
  let client, mgr, agent, access
  const emitted = []
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }

  const input = (o = {}) => ({
    name: 't6_cart', language: 'en', metaCategory: 'MARKETING', purpose: 'abandoned_cart',
    bodyText: 'Hi {{customer_name}}, your cart worth Rs {{cart_value}} is still waiting for you at Bakaloo.',
    examples: { customer_name: 'Rahul', cart_value: '1240' }, ...o,
  })
  const row = async (name, lang = 'en') => (await query(`SELECT * FROM wa_templates WHERE name = $1 AND language = $2 ORDER BY created_at DESC LIMIT 1`, [name, lang])).rows[0]
  const events = async (id) => (await query(`SELECT event, source FROM wa_template_events WHERE template_id = $1 ORDER BY created_at`, [id])).rows.map((e) => `${e.source}:${e.event}`)
  const remote = (o = {}) => ({
    id: String(Math.floor(Math.random() * 1e12)), name: 't6_remote', language: 'en_US', category: 'UTILITY', status: 'APPROVED', parameter_format: 'NAMED',
    components: [{ type: 'BODY', text: 'Hello {{first_name}}, your order is on the way now', example: { body_text_named_params: [{ param_name: 'first_name', example: 'Pablo' }] } }], ...o,
  })
  /** Create a draft and push it to a given Meta state, like a real submit + approval would. */
  async function approved(over = {}, { category = 'UTILITY', status = 'APPROVED' } = {}) {
    const { template } = await svc.createDraft(input({ metaCategory: category, ...over }), mgr)
    await tplRepo.patch(template.id, { status, meta_template_id: String(Math.floor(Math.random() * 1e12)), submitted_at: new Date() })
    return tplRepo.get(template.id)
  }

  let n = 0
  async function webhook(field, value, { time = Math.floor(Date.now() / 1000) } = {}) {
    const payload = { object: 'whatsapp_business_account', entry: [{ id: 'WABA', time, changes: [{ field, value }] }] }
    const ev = await repo.recordWebhookEvent(crypto.createHash('sha256').update(JSON.stringify(payload) + ++n + Math.random()).digest('hex'), payload)
    await inbound.processEvent(ev.id)
    return ev.id
  }

  async function cleanup() {
    await query(`DELETE FROM wa_contacts WHERE wa_id LIKE '91999900200%'`)
    await query(`DELETE FROM wa_templates WHERE name LIKE 't6\\_%'`)
    await query(`DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [PHONES])
    await query(`DELETE FROM abandoned_carts WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [PHONES])
    await query(`DELETE FROM users WHERE phone = ANY($1)`, [PHONES])
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { TemplateRepository } = await import('../../src/modules/whatsapp-crm/template.repository.js')
    ;({ TemplateService } = await import('../../src/modules/whatsapp-crm/template.service.js'))
    const { TemplateSendService } = await import('../../src/modules/whatsapp-crm/template-send.service.js')
    const { WhatsappRepository } = await import('../../src/modules/whatsapp-crm/whatsapp.repository.js')
    const { InboundService } = await import('../../src/modules/whatsapp-crm/inbound.service.js')
    const { CrmAdminRepository } = await import('../../src/modules/whatsapp-crm/crm-admin.repository.js')
    ;({ CrmAdminService } = await import('../../src/modules/whatsapp-crm/crm-admin.service.js'))
    ;({ loadCrmAccess } = await import('../../src/modules/whatsapp-crm/access.js'))

    tplRepo = new TemplateRepository()
    repo = new WhatsappRepository()
    const crm = new CrmAdminService({ repo, admin: new CrmAdminRepository(), emit: () => {} })

    client = {
      createTemplate: vi.fn(), editTemplate: vi.fn(), deleteTemplate: vi.fn(), listAllTemplates: vi.fn(), getTemplate: vi.fn(), sendTemplate: vi.fn(),
    }
    svc = new TemplateService({ repo: tplRepo, client, emit: (e, p) => emitted.push({ e, p }), logger })
    const botCalls = (globalThis.__t6BotCalls = [])
    send = new TemplateSendService({
      repo, tplRepo, client, getConversation: (id, acc) => crm.getAccessibleConversation(id, acc), emit: () => {}, logger,
      bot: { onAgentReply: async (id) => botCalls.push(id) }, pipeline: null,
    })
    inbound = new InboundService({ repo, emit: () => {}, logger, phoneNumberId: 'PN1', templates: svc })

    await cleanup()
    const role = async (r) => (await query(`SELECT id FROM roles WHERE name = $1`, [r])).rows[0].id
    const mk = async (phone, name, r) => (await query(`INSERT INTO users (phone,name,email,role,role_id) VALUES ($1,$2,$3,'ADMIN',$4) RETURNING id`, [phone, name, `${phone}@t.local`, await role(r)])).rows[0].id
    mgr = await mk('9999002009', 'T6 Manager', 'CRM Manager')
    agent = await mk('9999002010', 'T6 Agent', 'CRM Agent')
    access = await loadCrmAccess(mgr)
  })

  beforeEach(async () => {
    emitted.length = 0
    globalThis.__t6BotCalls.length = 0
    for (const f of Object.values(client)) f.mockReset()
    await query(`DELETE FROM wa_templates WHERE name LIKE 't6\\_%'`)
    await query(`DELETE FROM wa_contacts WHERE wa_id LIKE '91999900200%'`)
    await query(`DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [PHONES])
    await query(`DELETE FROM abandoned_carts WHERE user_id IN (SELECT id FROM users WHERE phone = ANY($1))`, [PHONES])
    await query(`DELETE FROM users WHERE phone = ANY($1) AND role = 'CUSTOMER'`, [PHONES])
  })

  afterAll(async () => {
    await cleanup()
    await query(`DELETE FROM users WHERE phone IN ('9999002009','9999002010')`)
    await closePool()
  })

  // ── creating & editing drafts ──────────────────────────────────
  describe('drafts', () => {
    it('saves a valid draft with the exact Meta components, and records the event', async () => {
      const { template, warnings } = await svc.createDraft(input({ headerText: 'Your cart' }), mgr)
      expect(template).toMatchObject({ name: 't6_cart', language: 'en', meta_category: 'MARKETING', status: 'DRAFT', parameter_format: 'NAMED', meta_template_id: null, header_format: 'TEXT' })
      expect(template.components.map((c) => c.type)).toEqual(['HEADER', 'BODY'])
      expect(template.variables.map((v) => v.name)).toEqual(['customer_name', 'cart_value'])
      expect(warnings).toEqual([])
      expect(await events(template.id)).toEqual(['MANUAL:CREATED'])
    })
    it('returns every form problem together, and stores nothing', async () => {
      await expect(svc.createDraft({ name: 'Bad Name', language: 'x', metaCategory: '', bodyText: '' }, mgr)).rejects.toMatchObject({
        code: 'INVALID_TEMPLATE', statusCode: 400, details: expect.arrayContaining([expect.objectContaining({ field: 'name' }), expect.objectContaining({ field: 'bodyText' })]),
      })
      expect((await query(`SELECT COUNT(*) FROM wa_templates WHERE name = 'Bad Name'`)).rows[0].count).toBe('0')
    })
    it('same name+language twice is refused; the same name in another language is fine', async () => {
      await svc.createDraft(input(), mgr)
      await expect(svc.createDraft(input(), mgr)).rejects.toMatchObject({ code: 'TEMPLATE_EXISTS' })
      await expect(svc.createDraft(input({ language: 'hi' }), mgr)).resolves.toBeTruthy()
    })
    it('a draft can be freely edited, including its name', async () => {
      const { template } = await svc.createDraft(input(), mgr)
      const { template: t2 } = await svc.update(template.id, input({ name: 't6_cart_v2', bodyText: 'Hello {{customer_name}}, your cart worth Rs {{cart_value}} awaits you at the store.' }), mgr)
      expect(t2).toMatchObject({ name: 't6_cart_v2', status: 'DRAFT' })
      expect(t2.body_text).toMatch(/awaits you/)
      expect(client.editTemplate).not.toHaveBeenCalled() // nothing at Meta yet
    })
  })

  // ── submit ─────────────────────────────────────────────────────
  describe('submit', () => {
    it('sends exactly what Meta expects and tracks the review', async () => {
      const { template } = await svc.createDraft(input({ footerText: 'Reply STOP to opt out' }), mgr)
      client.createTemplate.mockResolvedValue({ id: '9001', status: 'PENDING', category: 'MARKETING' })
      const out = await svc.submit(template.id)
      expect(client.createTemplate).toHaveBeenCalledWith({
        name: 't6_cart', language: 'en', category: 'MARKETING', parameterFormat: 'NAMED', allowCategoryChange: true,
        components: expect.arrayContaining([expect.objectContaining({ type: 'BODY' }), expect.objectContaining({ type: 'FOOTER' })]),
      })
      expect(out).toMatchObject({ status: 'PENDING', meta_template_id: '9001' })
      expect(out.submitted_at).toBeTruthy()
      expect(await events(template.id)).toEqual(['MANUAL:CREATED', 'SUBMIT:SUBMITTED'])
    })
    it('records when Meta changes the category (price impact)', async () => {
      const { template } = await svc.createDraft(input({ metaCategory: 'UTILITY' }), mgr)
      client.createTemplate.mockResolvedValue({ id: '9002', status: 'PENDING', category: 'MARKETING' })
      const out = await svc.submit(template.id)
      expect(out.meta_category).toBe('MARKETING')
      expect(await events(template.id)).toContain('SUBMIT:CATEGORY_ADJUSTED')
    })
    it('a double-click submits ONCE (atomic claim)', async () => {
      const { template } = await svc.createDraft(input(), mgr)
      client.createTemplate.mockImplementation(() => new Promise((r) => setTimeout(() => r({ id: '9003', status: 'PENDING', category: 'MARKETING' }), 80)))
      const results = await Promise.allSettled([svc.submit(template.id), svc.submit(template.id)])
      expect(client.createTemplate).toHaveBeenCalledTimes(1)
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ code: 'NOT_A_DRAFT' })
    })
    it('a Meta failure puts the template back to DRAFT so it can be fixed and retried', async () => {
      const { template } = await svc.createDraft(input(), mgr)
      client.createTemplate.mockRejectedValue(new MetaApiError('x', { code: 100, subcode: 2388024, details: 'Content in This Language Already Exists', httpStatus: 400 }))
      await expect(svc.submit(template.id)).rejects.toMatchObject({ code: 'TEMPLATE_EXISTS', statusCode: 409 })
      expect(await tplRepo.get(template.id)).toMatchObject({ status: 'DRAFT', meta_template_id: null, submitted_at: null })
      client.createTemplate.mockResolvedValue({ id: '9004', status: 'PENDING', category: 'MARKETING' })
      await expect(svc.submit(template.id)).resolves.toMatchObject({ status: 'PENDING' })
    })
    it.each([
      [new MetaApiError('WhatsApp templates are not configured (missing access token or WhatsApp Business Account id)'), 'NOT_CONFIGURED', 409],
      [new MetaApiError('x', { code: 190, httpStatus: 401 }), 'WHATSAPP_AUTH', 502],
      [new MetaApiError('x', { code: 100, subcode: 2388019, httpStatus: 400 }), 'TEMPLATE_LIMIT', 409],
      [new MetaApiError('x', { code: 100, details: 'Invalid parameter', httpStatus: 400 }), 'META_REJECTED', 422],
      [new MetaApiError('timeout', { retryable: true }), 'WHATSAPP_UNAVAILABLE', 502],
    ])('maps Meta error %# to a clear message (%s)', async (metaErr, code, status) => {
      const { template } = await svc.createDraft(input({ name: `t6_err_${Math.random().toString(36).slice(2, 8)}` }), mgr)
      client.createTemplate.mockRejectedValue(metaErr)
      await expect(svc.submit(template.id)).rejects.toMatchObject({ code, statusCode: status })
    })
    it('only drafts can be submitted; unknown id is 404', async () => {
      const t = await approved({ name: 't6_live' })
      await expect(svc.submit(t.id)).rejects.toMatchObject({ code: 'NOT_A_DRAFT' })
      await expect(svc.submit('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' })
    })
  })

  // ── editing submitted templates ────────────────────────────────
  describe('editing a submitted template', () => {
    it.each(['PENDING', 'IN_APPEAL', 'DISABLED', 'PENDING_DELETION', 'ARCHIVED'])('%s cannot be edited (Meta allows approved / rejected / paused only)', async (status) => {
      const t = await approved({ name: `t6_ed_${status.toLowerCase()}` }, { status })
      await expect(svc.update(t.id, input({ name: t.name }), mgr)).rejects.toMatchObject({ code: 'NOT_EDITABLE', statusCode: 409 })
      expect(client.editTemplate).not.toHaveBeenCalled()
    })
    it('approved: name, language and category stay fixed; Meta gets ALL components and re-reviews', async () => {
      const t = await approved({ name: 't6_ed_ok' }, { category: 'UTILITY' })
      client.editTemplate.mockResolvedValue(undefined)
      const { template } = await svc.update(t.id, input({ name: 't6_hacked', language: 'hi', metaCategory: 'MARKETING', bodyText: 'Hello {{customer_name}}, your cart worth Rs {{cart_value}} was updated at Bakaloo today.' }), mgr)
      expect(client.editTemplate).toHaveBeenCalledWith(t.meta_template_id, { components: expect.any(Array), category: undefined })
      expect(client.editTemplate.mock.calls[0][1].components.find((c) => c.type === 'BODY').text).toMatch(/was updated/)
      expect(template).toMatchObject({ name: 't6_ed_ok', language: 'en', meta_category: 'UTILITY', status: 'PENDING', rejection_reason: null })
      expect(await events(t.id)).toContain('MANUAL:EDITED')
    })
    it('a REJECTED template may change category when resubmitted', async () => {
      const t = await approved({ name: 't6_ed_rej' }, { category: 'UTILITY', status: 'REJECTED' })
      client.editTemplate.mockResolvedValue(undefined)
      await svc.update(t.id, input({ name: 't6_ed_rej', metaCategory: 'MARKETING' }), mgr)
      expect(client.editTemplate).toHaveBeenCalledWith(t.meta_template_id, expect.objectContaining({ category: 'MARKETING' }))
    })
    it('a Meta refusal leaves the stored template untouched', async () => {
      const t = await approved({ name: 't6_ed_fail' })
      client.editTemplate.mockRejectedValue(new MetaApiError('x', { code: 100, details: 'You can only edit once per day', httpStatus: 400 }))
      await expect(svc.update(t.id, input({ name: 't6_ed_fail', bodyText: 'Hello {{customer_name}}, your cart worth Rs {{cart_value}} is different now at Bakaloo.' }), mgr)).rejects.toMatchObject({ code: 'META_REJECTED' })
      expect((await tplRepo.get(t.id)).status).toBe('APPROVED')
      expect((await tplRepo.get(t.id)).body_text).toMatch(/still waiting/)
    })
    it('templates with numbered variables are view/send only', async () => {
      const { template } = await svc.createDraft(input({ name: 't6_ed_pos' }), mgr)
      await tplRepo.patch(template.id, { parameter_format: 'POSITIONAL', status: 'APPROVED', meta_template_id: '777' })
      await expect(svc.update(template.id, input({ name: 't6_ed_pos' }), mgr)).rejects.toMatchObject({ code: 'NOT_EDITABLE' })
    })
  })

  // ── delete ─────────────────────────────────────────────────────
  describe('delete', () => {
    it('a draft is removed locally without touching Meta', async () => {
      const { template } = await svc.createDraft(input({ name: 't6_del_draft' }), mgr)
      expect(await svc.remove(template.id)).toEqual({ deleted: true, remote: false })
      expect(await tplRepo.get(template.id)).toBeNull()
      expect(client.deleteTemplate).not.toHaveBeenCalled()
    })
    it('an approved template is deleted at Meta by NAME + ID (not every language) and its name stays reserved', async () => {
      const t = await approved({ name: 't6_del_live' })
      client.deleteTemplate.mockResolvedValue(undefined)
      const out = await svc.remove(t.id)
      expect(client.deleteTemplate).toHaveBeenCalledWith({ name: 't6_del_live', hsmId: t.meta_template_id })
      expect(out).toMatchObject({ remote: true, nameReservedDays: 30 })
      expect((await tplRepo.get(t.id)).status).toBe('DELETED')
      await expect(svc.get(t.id)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' }) // hidden from the library
    })
    it('a Meta refusal (e.g. disabled template) keeps the row', async () => {
      const t = await approved({ name: 't6_del_dis' }, { status: 'DISABLED' })
      client.deleteTemplate.mockRejectedValue(new MetaApiError('x', { code: 100, details: 'cannot delete', httpStatus: 400 }))
      await expect(svc.remove(t.id)).rejects.toMatchObject({ code: 'META_REJECTED' })
      expect((await tplRepo.get(t.id)).status).toBe('DISABLED')
    })
  })

  // ── sync ───────────────────────────────────────────────────────
  describe('sync with Meta', () => {
    it('imports templates made in WhatsApp Manager (numbered ones as view/send-only), updates known ones, and reports counts', async () => {
      const known = await approved({ name: 't6_known' }, { status: 'PENDING' })
      client.listAllTemplates.mockResolvedValue([
        remote({ id: known.meta_template_id, name: 't6_known', language: 'en', category: 'MARKETING', status: 'REJECTED', rejected_reason: 'INCORRECT_CATEGORY', quality_score: { score: 'RED' }, components: known.components, parameter_format: 'NAMED' }),
        remote({ id: '5001', name: 't6_imported' }),
        remote({ id: '5002', name: 't6_numbered', parameter_format: undefined, components: [{ type: 'BODY', text: 'Hi {{1}}, code {{2}} expires in 3 days', example: { body_text: [['Pablo', 'SAVE20']] } }] }),
      ])
      const r = await svc.sync()
      expect(r).toMatchObject({ total: 3, created: 2, updated: 1, conflicts: 0, markedMissing: 0 })
      expect(await row('t6_known')).toMatchObject({ status: 'REJECTED', rejection_reason: 'INCORRECT_CATEGORY', quality_score: 'RED', meta_category: 'MARKETING' })
      expect(await row('t6_imported', 'en_US')).toMatchObject({ status: 'APPROVED', meta_template_id: '5001', purpose: 'custom', parameter_format: 'NAMED' })
      const numbered = await row('t6_numbered', 'en_US')
      expect(numbered.parameter_format).toBe('POSITIONAL')
      expect(numbered.variables.map((v) => v.key)).toEqual(['body.1', 'body.2'])
      expect(await events(known.id)).toContain('SYNC:STATUS_REJECTED')
      expect((await tplRepo.lastSyncedAt())).toBeTruthy()
    })
    it('a template that disappeared at Meta is marked DELETED; drafts are never touched', async () => {
      const gone = await approved({ name: 't6_gone' })
      const { template: draft } = await svc.createDraft(input({ name: 't6_my_draft' }), mgr)
      client.listAllTemplates.mockResolvedValue([remote({ id: '5100', name: 't6_other' })])
      const r = await svc.sync()
      expect(r.markedMissing).toBeGreaterThanOrEqual(1)
      expect((await tplRepo.get(gone.id)).status).toBe('DELETED')
      expect((await tplRepo.get(draft.id)).status).toBe('DRAFT')
    })
    it('SAFEGUARD: an empty answer from Meta never wipes the library', async () => {
      const t = await approved({ name: 't6_safe' })
      client.listAllTemplates.mockResolvedValue([])
      const r = await svc.sync()
      expect(r.warnings.join(' ')).toMatch(/nothing was marked as missing/)
      expect((await tplRepo.get(t.id)).status).toBe('APPROVED')
    })
    it('a local draft with the same name+language as a Meta template is left alone and counted as a conflict', async () => {
      const { template } = await svc.createDraft(input({ name: 't6_clash', language: 'en_US' }), mgr)
      client.listAllTemplates.mockResolvedValue([remote({ id: '5200', name: 't6_clash', language: 'en_US' })])
      const r = await svc.sync()
      expect(r.conflicts).toBe(1)
      expect(await tplRepo.get(template.id)).toMatchObject({ status: 'DRAFT', meta_template_id: null })
    })
    it('two syncs at once: the second is refused', async () => {
      client.listAllTemplates.mockImplementation(() => new Promise((r) => setTimeout(() => r([remote({ id: '5300', name: 't6_slow' })]), 120)))
      const [a, b] = await Promise.allSettled([svc.sync(), svc.sync()])
      expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
      expect((a.status === 'rejected' ? a : b).reason).toMatchObject({ code: 'SYNC_RUNNING' })
    })
    it('a Meta outage during sync surfaces a clear error and changes nothing', async () => {
      const t = await approved({ name: 't6_outage' })
      client.listAllTemplates.mockRejectedValue(new MetaApiError('socket hang up', { retryable: true }))
      await expect(svc.sync()).rejects.toMatchObject({ code: 'WHATSAPP_UNAVAILABLE' })
      expect((await tplRepo.get(t.id)).status).toBe('APPROVED')
    })
  })

  // ── webhooks (through the REAL inbound pipeline) ───────────────
  describe('approval webhooks', () => {
    const statusEv = (t, event, extra = {}) => ({ event, message_template_id: Number(t.meta_template_id), message_template_name: t.name, message_template_language: t.language.replace('_', '-'), ...extra })

    it('PENDING → APPROVED; the en-US webhook matches our en_US template', async () => {
      const t = await approved({ name: 't6_wh_ok', language: 'en_US' }, { status: 'PENDING' })
      const id = await webhook('message_template_status_update', statusEv(t, 'APPROVED', { reason: 'NONE', message_template_category: 'UTILITY' }))
      expect(await tplRepo.get(t.id)).toMatchObject({ status: 'APPROVED', rejection_reason: null })
      expect((await repo.getWebhookEvent(id)).processed_at).not.toBeNull()
      expect(await events(t.id)).toContain('WEBHOOK:APPROVED')
      expect(emitted.some((x) => x.e === 'crm:template')).toBe(true)
    })
    it('REJECTED keeps Meta’s reason and the plain-English explanation', async () => {
      const t = await approved({ name: 't6_wh_rej' }, { status: 'PENDING' })
      await webhook('message_template_status_update', statusEv(t, 'REJECTED', { reason: 'INVALID_FORMAT', rejection_info: { reason: 'Parameters are next to each other.', recommendation: 'Separate them with words.' } }))
      expect(await tplRepo.get(t.id)).toMatchObject({ status: 'REJECTED', rejection_reason: 'INVALID_FORMAT', rejection_detail: 'Parameters are next to each other. Separate them with words.' })
    })
    it('PAUSED → blocked from sending; REINSTATED → back to APPROVED', async () => {
      const t = await approved({ name: 't6_wh_pause' })
      await webhook('message_template_status_update', statusEv(t, 'PAUSED'), { time: 2_000_000_000 })
      expect((await tplRepo.get(t.id)).status).toBe('PAUSED')
      await webhook('message_template_status_update', statusEv(t, 'REINSTATED'), { time: 2_000_000_100 })
      expect((await tplRepo.get(t.id)).status).toBe('APPROVED')
    })
    it('FLAGGED marks the template at risk but still sendable; APPROVED clears it', async () => {
      const t = await approved({ name: 't6_wh_flag' })
      await webhook('message_template_status_update', statusEv(t, 'FLAGGED'), { time: 2_000_000_000 })
      expect(await tplRepo.get(t.id)).toMatchObject({ status: 'APPROVED', flagged: true })
    })
    it('an OLDER event never overwrites newer state (out-of-order delivery)', async () => {
      const t = await approved({ name: 't6_wh_order' }, { status: 'PENDING' })
      await webhook('message_template_status_update', statusEv(t, 'APPROVED'), { time: 2_000_000_500 })
      await webhook('message_template_status_update', statusEv(t, 'PENDING'), { time: 2_000_000_100 }) // delayed, older
      expect((await tplRepo.get(t.id)).status).toBe('APPROVED')
    })
    it('the same webhook delivered twice is harmless', async () => {
      const t = await approved({ name: 't6_wh_dup' }, { status: 'PENDING' })
      const ev = statusEv(t, 'APPROVED')
      await webhook('message_template_status_update', ev, { time: 2_000_000_000 })
      await webhook('message_template_status_update', ev, { time: 2_000_000_000 })
      expect((await tplRepo.get(t.id)).status).toBe('APPROVED')
    })
    it('quality score updates', async () => {
      const t = await approved({ name: 't6_wh_q' })
      await webhook('message_template_quality_update', { message_template_id: Number(t.meta_template_id), message_template_name: t.name, message_template_language: 'en', previous_quality_score: 'GREEN', new_quality_score: 'YELLOW' })
      expect((await tplRepo.get(t.id)).quality_score).toBe('YELLOW')
    })
    it('category: an impending re-categorisation shows a warning; the completed change switches the category', async () => {
      const t = await approved({ name: 't6_wh_cat' }, { category: 'UTILITY' })
      await webhook('template_category_update', { message_template_id: Number(t.meta_template_id), message_template_name: t.name, message_template_language: 'en', new_category: 'UTILITY', correct_category: 'MARKETING', category_update_timestamp: 1746169200 })
      expect(await tplRepo.get(t.id)).toMatchObject({ meta_category: 'UTILITY', pending_category: 'MARKETING' })
      await webhook('template_category_update', { message_template_id: Number(t.meta_template_id), message_template_name: t.name, message_template_language: 'en', previous_category: 'UTILITY', new_category: 'MARKETING' })
      expect(await tplRepo.get(t.id)).toMatchObject({ meta_category: 'MARKETING', pending_category: null })
    })
    it('a webhook for a template we have never seen is fetched from Meta and added', async () => {
      client.getTemplate.mockResolvedValue(remote({ id: '6001', name: 't6_wm_made', language: 'en_US', status: 'APPROVED' }))
      await webhook('message_template_status_update', { event: 'APPROVED', message_template_id: 6001, message_template_name: 't6_wm_made', message_template_language: 'en-US' })
      expect(client.getTemplate).toHaveBeenCalledWith('6001')
      expect(await row('t6_wm_made', 'en_US')).toMatchObject({ status: 'APPROVED', meta_template_id: '6001' })
    })
    it('UNARCHIVED / components updates re-read the template instead of guessing', async () => {
      const t = await approved({ name: 't6_wh_unarch' }, { status: 'ARCHIVED' })
      client.getTemplate.mockResolvedValue(remote({ id: t.meta_template_id, name: t.name, language: 'en', status: 'APPROVED', components: t.components, parameter_format: 'NAMED', category: 'UTILITY' }))
      await webhook('message_template_status_update', statusEv(t, 'UNARCHIVED'))
      expect((await tplRepo.get(t.id)).status).toBe('APPROVED')
    })
    it('a webhook can beat our own submit: it adopts the Meta id for a template we just submitted', async () => {
      const { template } = await svc.createDraft(input({ name: 't6_wh_race' }), mgr)
      await tplRepo.patch(template.id, { status: 'PENDING' }) // submit claimed, Meta id not stored yet
      await webhook('message_template_status_update', { event: 'APPROVED', message_template_id: 6100, message_template_name: 't6_wh_race', message_template_language: 'en' })
      expect(await tplRepo.get(template.id)).toMatchObject({ status: 'APPROVED', meta_template_id: '6100' })
    })
    it('a Meta outage while fetching an unknown template does not fail the webhook (sync will repair it)', async () => {
      client.getTemplate.mockRejectedValue(new MetaApiError('down', { retryable: true }))
      const id = await webhook('message_template_status_update', { event: 'APPROVED', message_template_id: 6200, message_template_name: 't6_unknown', message_template_language: 'en' })
      expect((await repo.getWebhookEvent(id)).processed_at).not.toBeNull()
    })
    it('LIMIT_EXCEEDED and unknown events are processed without error', async () => {
      await expect(webhook('message_template_status_update', { event: 'LIMIT_EXCEEDED' })).resolves.toBeTruthy()
      await expect(webhook('message_template_status_update', { event: 'BRAND_NEW_EVENT', message_template_id: 1 })).resolves.toBeTruthy()
    })
  })

  // ── sending ────────────────────────────────────────────────────
  describe('sending an approved template', () => {
    async function chat(wa, { name = 'Rahul Das', consent = 'UNKNOWN', assignedTo = null, userPhone = null } = {}) {
      let userId = null
      if (userPhone) userId = (await query(`INSERT INTO users (phone, name) VALUES ($1,$2) RETURNING id`, [userPhone, name])).rows[0].id
      const c = (await query(`INSERT INTO wa_contacts (wa_id, phone, profile_name, marketing_consent, user_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [wa, wa.slice(2), name, consent, userId])).rows[0].id
      const v = (await query(`INSERT INTO wa_conversations (contact_id, assigned_to, last_inbound_at, last_message_at, last_message_direction) VALUES ($1,$2, NOW() - INTERVAL '30 hours', NOW() - INTERVAL '30 hours','INBOUND') RETURNING id`, [c, assignedTo])).rows[0].id
      return { contactId: c, conversationId: v, userId }
    }
    const go = (cid, tid, values = {}, extra = {}) => send.send({ conversationId: cid, templateId: tid, values, sentBy: mgr, access, ...extra })

    it('sends outside the 24-hour window, auto-filling the customer name, and stores a readable copy', async () => {
      const t = await approved({ name: 't6_send_ok', metaCategory: 'UTILITY', bodyText: 'Hi {{customer_name}}, your order is confirmed and will arrive soon at your door.' }, { category: 'UTILITY' })
      const { conversationId } = await chat(WA.a)
      client.sendTemplate.mockResolvedValue({ wamid: 'wamid.TPL1' })
      const m = await go(conversationId, t.id)
      expect(client.sendTemplate).toHaveBeenCalledWith({
        to: WA.a, bsuid: null, name: 't6_send_ok', language: 'en',
        components: [{ type: 'body', parameters: [{ type: 'text', parameter_name: 'customer_name', text: 'Rahul' }] }],
      })
      expect(m).toMatchObject({ status: 'SENT', wamid: 'wamid.TPL1', msg_type: 'template', template_name: 't6_send_ok' })
      const stored = (await query(`SELECT body, template_id, sent_by, direction FROM wa_messages WHERE id = $1`, [m.id])).rows[0]
      expect(stored).toMatchObject({ body: 'Hi Rahul, your order is confirmed and will arrive soon at your door.', template_id: t.id, sent_by: mgr, direction: 'OUTBOUND' })
      expect(globalThis.__t6BotCalls).toHaveLength(1) // a person acted: the bot steps back
    })
    it('fills order and cart values from real data; typed values win over automatic ones', async () => {
      const t = await approved({ name: 't6_send_data', bodyText: 'Hi {{customer_name}}, order {{order_number}} with cart Rs {{cart_value}} needs your attention today.', examples: { customer_name: 'a', order_number: 'b', cart_value: 'c' } }, { category: 'UTILITY' })
      const { conversationId, userId } = await chat(WA.a, { userPhone: '9999002001', name: 'Priya Sharma' })
      await query(`INSERT INTO orders (order_number,user_id,status,items,subtotal,total_amount,delivery_address) VALUES ('T6-ORD-1',$1,'CONFIRMED','[]',1,1,'{}')`, [userId])
      await query(`INSERT INTO abandoned_carts (user_id,status,abandoned_at,cart_value) VALUES ($1,'OPEN',NOW(),1240.4)`, [userId])
      client.sendTemplate.mockResolvedValue({ wamid: 'wamid.TPL2' })
      await go(conversationId, t.id, { cart_value: '999' })
      expect(client.sendTemplate.mock.calls[0][0].components[0].parameters.map((p) => [p.parameter_name, p.text])).toEqual([['customer_name', 'Priya'], ['order_number', 'T6-ORD-1'], ['cart_value', '999']])
    })
    it('refuses to send a half-filled message and says what is missing', async () => {
      const t = await approved({ name: 't6_send_miss', bodyText: 'Hi {{customer_name}}, use code {{coupon_code}} at checkout to save more today.', examples: { customer_name: 'a', coupon_code: 'b' } }, { category: 'UTILITY' })
      const { conversationId } = await chat(WA.a)
      await expect(go(conversationId, t.id)).rejects.toMatchObject({ code: 'MISSING_VALUES', statusCode: 400, details: ['coupon_code'] })
      expect(client.sendTemplate).not.toHaveBeenCalled()
      expect((await query(`SELECT COUNT(*) FROM wa_messages WHERE msg_type = 'template' AND conversation_id = $1`, [conversationId])).rows[0].count).toBe('0')
    })
    it.each(['DRAFT', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'ARCHIVED'])('a %s template NEVER reaches Meta', async (status) => {
      const t = await approved({ name: `t6_send_${status.toLowerCase()}`, metaCategory: 'UTILITY' }, { category: 'UTILITY', status })
      const { conversationId } = await chat(WA.a)
      await expect(go(conversationId, t.id)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_SENDABLE', statusCode: 409 })
      expect(client.sendTemplate).not.toHaveBeenCalled()
    })
    it('a deleted / unknown template is a 404', async () => {
      const { conversationId } = await chat(WA.a)
      await expect(go(conversationId, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' })
    })
    it('CONSENT: marketing templates are blocked for customers who opted out; utility ones are allowed', async () => {
      const mkt = await approved({ name: 't6_send_mkt' }, { category: 'MARKETING' })
      const util = await approved({ name: 't6_send_util', bodyText: 'Hi {{customer_name}}, your delivery is on its way and will reach you soon.' }, { category: 'UTILITY' })
      const { conversationId } = await chat(WA.a, { consent: 'OPTED_OUT' })
      await expect(go(conversationId, mkt.id, { cart_value: '10' })).rejects.toMatchObject({ code: 'OPTED_OUT' })
      client.sendTemplate.mockResolvedValue({ wamid: 'wamid.UT' })
      await expect(go(conversationId, util.id)).resolves.toMatchObject({ status: 'SENT' })
    })
    it('agents cannot send into a chat they cannot see (404)', async () => {
      const t = await approved({ name: 't6_send_priv', metaCategory: 'UTILITY', bodyText: 'Hi {{customer_name}}, your delivery is on its way and will reach you soon.' }, { category: 'UTILITY' })
      const { conversationId } = await chat(WA.a, { assignedTo: mgr })
      const agentAccess = await loadCrmAccess(agent)
      await expect(send.send({ conversationId, templateId: t.id, values: {}, sentBy: agent, access: agentAccess })).rejects.toMatchObject({ statusCode: 404 })
    })

    describe('what Meta says when the send fails', () => {
      let t, conversationId
      beforeEach(async () => {
        t = await approved({ name: 't6_send_fail', bodyText: 'Hi {{customer_name}}, your delivery is on its way and will reach you soon.' }, { category: 'MARKETING' })
        ;({ conversationId } = await chat(WA.a))
      })
      const fail = (code, details = 'x') => client.sendTemplate.mockRejectedValue(new MetaApiError('x', { code, details, httpStatus: 400 }))
      const lastMsg = async () => (await query(`SELECT status, error_code FROM wa_messages WHERE msg_type = 'template' AND conversation_id = $1 ORDER BY created_at DESC LIMIT 1`, [conversationId])).rows[0]

      it('132001 (not approved / missing at Meta) → asks to sync; the failed attempt is recorded', async () => {
        fail(132001)
        await expect(go(conversationId, t.id)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_SENDABLE', message: expect.stringMatching(/Sync with Meta/) })
        expect(await lastMsg()).toMatchObject({ status: 'FAILED', error_code: 132001 })
      })
      it('132015 (paused) → our copy flips to PAUSED so nobody retries it', async () => {
        fail(132015)
        await expect(go(conversationId, t.id)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_SENDABLE' })
        expect((await tplRepo.get(t.id)).status).toBe('PAUSED')
      })
      it('132016 (disabled) → DISABLED', async () => {
        fail(132016)
        await expect(go(conversationId, t.id)).rejects.toBeTruthy()
        expect((await tplRepo.get(t.id)).status).toBe('DISABLED')
      })
      it('131050 (customer stopped marketing) → consent is recorded as OPTED_OUT', async () => {
        fail(131050)
        await expect(go(conversationId, t.id)).rejects.toMatchObject({ code: 'OPTED_OUT' })
        expect((await query(`SELECT marketing_consent FROM wa_contacts WHERE wa_id = $1`, [WA.a])).rows[0].marketing_consent).toBe('OPTED_OUT')
      })
      it('131049 (per-user marketing cap), 131026 (not on WhatsApp), 132000 (values mismatch) and unknown errors', async () => {
        fail(131049)
        await expect(go(conversationId, t.id)).rejects.toMatchObject({ code: 'MARKETING_LIMIT' })
        fail(131026)
        await expect(go(conversationId, t.id)).rejects.toMatchObject({ code: 'NOT_ON_WHATSAPP' })
        fail(132000)
        await expect(go(conversationId, t.id)).rejects.toMatchObject({ code: 'TEMPLATE_OUT_OF_DATE' })
        fail(135000, 'weird')
        await expect(go(conversationId, t.id)).rejects.toMatchObject({ code: 'WHATSAPP_SEND_FAILED', statusCode: 502 })
      })
    })
  })

  describe('known values for pre-filling the send dialog', () => {
    it('returns customer name, latest order and open cart — and only what exists', async () => {
      const c = await query(`INSERT INTO wa_contacts (wa_id, phone, profile_name) VALUES ($1,$2,'Lead Only') RETURNING id`, [WA.b, WA.b.slice(2)])
      const v = (await query(`INSERT INTO wa_conversations (contact_id, last_inbound_at) VALUES ($1, NOW()) RETURNING id`, [c.rows[0].id])).rows[0].id
      expect(await send.valuesFor(v, access)).toEqual({ customer_name: 'Lead' }) // no customer => no order / cart values invented
    })
  })
})
