/**
 * WhatsApp CRM Phase 8 — prospect outreach (upload → preview → confirm → campaign). Real Postgres, opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/whatsapp-crm-phase8.db.test.js
 * Meta is a recording fake — no real WhatsApp call is made. Run with the other CRM DB suites using --no-file-parallelism.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const DAYTIME = new Date('2026-10-02T06:00:00Z') // 11:30 IST
// 98765 4xxxx — numbers private to this suite
const P = (n) => `9999004${String(n).padStart(3, '0')}`
const ALL = Array.from({ length: 12 }, (_, i) => P(i + 1))
const csv = (rows) => Buffer.from(['Name,Business Name,Mobile', ...rows].join('\n'), 'utf8')

describe.skipIf(!enabled)('WhatsApp CRM — prospect outreach', () => {
  let query, closePool, prospects, campaigns, cRepo, sender, client, mgr
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }

  const preview = (rows, name = 'T8 list') => prospects.preview({ buffer: csv(rows), filename: 'p.csv', name, userId: mgr })
  const rowsOf = async (id) => (await query(`SELECT row_number, status, selected, contact_id FROM wa_prospect_rows WHERE import_id = $1 ORDER BY row_number`, [id])).rows
  const contact = async (phone) => (await query(`SELECT * FROM wa_contacts WHERE wa_id = $1`, ['91' + phone])).rows[0]
  const confirm = (id, o = {}) => prospects.confirm(id, { confirm: true, source: 'trade show', ...o }, mgr)

  async function cleanup() {
    await query(`DELETE FROM wa_campaigns WHERE name LIKE 'T8 %'`)
    await query(`DELETE FROM wa_prospect_imports WHERE name LIKE 'T8 %'`)
    await query(`DELETE FROM wa_contacts WHERE wa_id LIKE '91999900400%' OR wa_id LIKE '91999900401%'`)
    await query(`DELETE FROM wa_templates WHERE name LIKE 't8\\_%'`)
    await query(`DELETE FROM users WHERE phone = ANY($1) OR email = 't8mgr@t.local'`, [ALL])
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { ProspectRepository } = await import('../../src/modules/whatsapp-crm/prospect.repository.js')
    const { ProspectService } = await import('../../src/modules/whatsapp-crm/prospect.service.js')
    const { WhatsappRepository } = await import('../../src/modules/whatsapp-crm/whatsapp.repository.js')
    const { TemplateRepository } = await import('../../src/modules/whatsapp-crm/template.repository.js')
    const { AutomatedSender } = await import('../../src/modules/whatsapp-crm/automated-sender.js')
    const { CampaignRepository } = await import('../../src/modules/whatsapp-crm/campaign.repository.js')
    const { CampaignService } = await import('../../src/modules/whatsapp-crm/campaign.service.js')
    prospects = new ProspectService({ repo: new ProspectRepository(), logger })
    cRepo = new CampaignRepository()
    client = { sendTemplate: vi.fn() }
    sender = new AutomatedSender({ repo: new WhatsappRepository(), tplRepo: new TemplateRepository(), client, emit: () => {}, logger })
    campaigns = new CampaignService({ repo: cRepo, tplRepo: new TemplateRepository(), sender, emit: () => {}, logger, now: () => DAYTIME })
  })

  beforeEach(async () => {
    await cleanup()
    mgr = (await query(`INSERT INTO users (phone,name,email,role) VALUES ($1,'T8 Manager','t8mgr@t.local','ADMIN') RETURNING id`, [P(12)])).rows[0].id
    client.sendTemplate.mockReset()
    let n = 0
    client.sendTemplate.mockImplementation(async () => ({ wamid: `wamid.T8.${Date.now()}.${++n}` }))
  })

  afterAll(async () => {
    await cleanup()
    await closePool()
  })

  describe('preview (creates nothing but the preview rows)', () => {
    it('classifies every row and creates no contacts', async () => {
      await query(`INSERT INTO users (phone,name) VALUES ($1,'Cust')`, [P(2)])
      await query(`INSERT INTO wa_contacts (wa_id, phone, source, marketing_consent) VALUES ($1,$2,'ORGANIC','OPTED_IN')`, ['91' + P(3), P(3)])
      await query(`INSERT INTO wa_contacts (wa_id, phone, source, marketing_consent) VALUES ($1,$2,'ORGANIC','OPTED_OUT')`, ['91' + P(4), P(4)])
      const sup = (await query(`INSERT INTO wa_contacts (wa_id, phone, source, marketing_consent) VALUES ($1,$2,'ORGANIC','OPTED_IN') RETURNING id`, ['91' + P(5), P(5)])).rows[0].id
      await query(`INSERT INTO wa_suppression (contact_id, reason) VALUES ($1,'t8')`, [sup])

      const imp = await preview([`Ravi,Ravi Stores,${P(1)}`, `Cust,,${P(2)}`, `Known,,${P(3)}`, `Out,,${P(4)}`, `Sup,,${P(5)}`, `Bad,,12345`, `Again,,${P(1)}`])
      expect(imp).toMatchObject({ status: 'PREVIEW', total_rows: 7, columns: { phone: 'Mobile', name: 'Name', business: 'Business Name' } })
      expect(imp.counts).toEqual({ NEW: 1, EXISTING_CUSTOMER: 1, EXISTING_CONTACT: 1, OPTED_OUT: 1, SUPPRESSED: 1, INVALID: 1, DUPLICATE: 1 })
      expect((await rowsOf(imp.id)).every((r) => !r.selected && !r.contact_id)).toBe(true)
      expect(await contact(P(1))).toBeUndefined()
    })

    it('rejects files with no phone column, no rows, or the wrong type — and stores nothing', async () => {
      await expect(prospects.preview({ buffer: Buffer.from('Name,City\nA,B\n'), filename: 'p.csv', name: 'T8 x', userId: mgr })).rejects.toMatchObject({ code: 'NO_PHONE_COLUMN', statusCode: 400 })
      await expect(prospects.preview({ buffer: Buffer.from('Name,Mobile\n'), filename: 'p.csv', name: 'T8 x', userId: mgr })).rejects.toMatchObject({ code: 'EMPTY_FILE' })
      await expect(prospects.preview({ buffer: Buffer.from('x'), filename: 'p.pdf', name: 'T8 x', userId: mgr })).rejects.toMatchObject({ code: 'BAD_FILE' })
      expect((await query(`SELECT 1 FROM wa_prospect_imports WHERE name = 'T8 x'`)).rowCount).toBe(0)
    })

    it('a preview can be discarded with its rows; a confirmed list cannot', async () => {
      const a = await preview([`A,,${P(1)}`])
      await prospects.discard(a.id)
      expect((await query(`SELECT 1 FROM wa_prospect_rows WHERE import_id = $1`, [a.id])).rowCount).toBe(0)
      const b = await preview([`B,,${P(1)}`])
      await confirm(b.id)
      await expect(prospects.discard(b.id)).rejects.toMatchObject({ code: 'NOT_DISCARDABLE', statusCode: 409 })
    })
  })

  describe('confirm (records consent; sends nothing)', () => {
    it('needs the explicit statement and a source, and cannot be done twice', async () => {
      const imp = await preview([`A,,${P(1)}`])
      await expect(prospects.confirm(imp.id, { confirm: false, source: 'x form' }, mgr)).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })
      await expect(prospects.confirm(imp.id, { confirm: true, source: 'x' }, mgr)).rejects.toMatchObject({ code: 'VALIDATION' })
      await confirm(imp.id)
      await expect(confirm(imp.id)).rejects.toMatchObject({ code: 'ALREADY_CONFIRMED', statusCode: 409 })
      expect(client.sendTemplate).not.toHaveBeenCalled()
    })

    it('opts in new and known contacts, leaves existing customers out unless asked, and records the source', async () => {
      const u = (await query(`INSERT INTO users (phone,name) VALUES ($1,'Cust') RETURNING id`, [P(2)])).rows[0].id
      await query(`INSERT INTO wa_contacts (wa_id, phone, source, marketing_consent) VALUES ($1,$2,'ORGANIC','UNKNOWN')`, ['91' + P(3), P(3)])
      const imp = await preview([`Ravi,Ravi Stores,${P(1)}`, `Cust,,${P(2)}`, `Known,,${P(3)}`])

      const done = await confirm(imp.id, { source: 'Trade Show!' })
      expect(done).toMatchObject({ status: 'CONFIRMED', reachable: 2, consent_source: 'PROSPECT_TRADE_SHOW_' })
      expect(await contact(P(1))).toMatchObject({ marketing_consent: 'OPTED_IN', source: 'IMPORT', profile_name: 'Ravi', consent_source: 'PROSPECT_TRADE_SHOW_' })
      expect((await contact(P(3))).marketing_consent).toBe('OPTED_IN')
      expect(await contact(P(2))).toBeUndefined() // customer excluded → no contact created
      expect((await rowsOf(imp.id)).map((r) => r.selected)).toEqual([true, false, true])
      expect(u).toBeTruthy()
    })

    it('includes existing customers when asked, linking the customer to the contact', async () => {
      const u = (await query(`INSERT INTO users (phone,name) VALUES ($1,'Cust') RETURNING id`, [P(2)])).rows[0].id
      const imp = await preview([`Cust,,${P(2)}`])
      expect((await confirm(imp.id, { includeExisting: true })).reachable).toBe(1)
      expect((await contact(P(2))).user_id).toBe(u)
    })

    it('never overrides an opt-out that arrives between preview and confirm', async () => {
      const imp = await preview([`A,,${P(1)}`, `B,,${P(2)}`])
      await query(`INSERT INTO wa_contacts (wa_id, phone, source, marketing_consent, consent_source) VALUES ($1,$2,'ORGANIC','OPTED_OUT','STOP')`, ['91' + P(1), P(1)])
      const done = await confirm(imp.id)
      expect(done.reachable).toBe(1)
      expect(await contact(P(1))).toMatchObject({ marketing_consent: 'OPTED_OUT', consent_source: 'STOP' })
      expect((await rowsOf(imp.id)).map((r) => r.selected)).toEqual([false, true])
    })

    it('refuses to confirm when nobody is usable', async () => {
      await query(`INSERT INTO wa_contacts (wa_id, phone, source, marketing_consent) VALUES ($1,$2,'ORGANIC','OPTED_OUT')`, ['91' + P(1), P(1)])
      const imp = await preview([`A,,${P(1)}`, `B,,999`])
      await expect(confirm(imp.id)).rejects.toMatchObject({ code: 'NOTHING_TO_ADD', statusCode: 409 })
    })

    it('two simultaneous confirms add the list once', async () => {
      const imp = await preview([`A,,${P(1)}`])
      const res = await Promise.allSettled([confirm(imp.id), confirm(imp.id)])
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect((await query(`SELECT COUNT(*)::int n FROM wa_contacts WHERE wa_id = $1`, ['91' + P(1)])).rows[0].n).toBe(1)
    })
  })

  describe('reaching prospects through a campaign', () => {
    const tpl = async () => (await query(
      `INSERT INTO wa_templates (name, language, meta_category, status, components, body_text, parameter_format, meta_template_id)
       VALUES ('t8_wholesale','en','MARKETING','APPROVED',$1::jsonb,'Hi {{customer_name}}, wholesale rates at Bakaloo.','NAMED','88123')
       RETURNING *`,
      [JSON.stringify([{ type: 'BODY', text: 'Hi {{customer_name}}, wholesale rates at Bakaloo.', example: { body_text_named_params: [{ param_name: 'customer_name', example: 'x' }] } }])],
    )).rows[0]

    it('only a confirmed list is offered as an audience, with its reachable count', async () => {
      const a = await preview([`A,,${P(1)}`, `B,,${P(2)}`], 'T8 pending')
      const b = await preview([`A,,${P(3)}`, `B,,${P(4)}`, `C,,bad`], 'T8 added')
      await confirm(b.id)
      const opts = (await cRepo.audienceOptions()).imports.filter((i) => i.name.startsWith('T8 '))
      expect(opts).toEqual([{ id: b.id, name: 'T8 added', members: 2 }])
      expect(a.id).toBeTruthy()
    })

    it('an unconfirmed list has no audience even if its id is used', async () => {
      const a = await preview([`A,,${P(1)}`])
      const t = await tpl()
      const camp = await campaigns.create({ name: 'T8 camp', templateId: t.id, audience: { type: 'IMPORT', ids: [a.id] } }, mgr)
      await expect(campaigns.launch(camp.id)).rejects.toMatchObject({ code: 'NO_RECIPIENTS' })
    })

    it('sends to the confirmed prospects once, and skips one who opted out after confirming', async () => {
      const imp = await preview([`Ravi,,${P(1)}`, `Sita,,${P(2)}`, `Opt,,${P(3)}`])
      await confirm(imp.id)
      await query(`UPDATE wa_contacts SET marketing_consent = 'OPTED_OUT' WHERE wa_id = $1`, ['91' + P(3)])
      const t = await tpl()
      const camp = await campaigns.create({ name: 'T8 camp', templateId: t.id, audience: { type: 'IMPORT', ids: [imp.id] } }, mgr)
      expect(await campaigns.preview(camp.id)).toEqual({ audience: 3, willSend: 2, skipped: { OPTED_OUT: 1 } })
      await campaigns.launch(camp.id)
      await campaigns.tick()
      await campaigns.tick()
      expect(client.sendTemplate).toHaveBeenCalledTimes(2)
      const r = (await query(`SELECT c.phone, r.status, r.skip_reason FROM wa_campaign_recipients r JOIN wa_contacts c ON c.id = r.contact_id WHERE r.campaign_id = $1 ORDER BY c.phone`, [camp.id])).rows
      expect(r.map((x) => [x.phone, x.status, x.skip_reason])).toEqual([[P(1), 'SENT', null], [P(2), 'SENT', null], [P(3), 'SKIPPED', 'OPTED_OUT']])
    })
  })
})
