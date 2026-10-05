import { CrmError } from './errors.js'
import { friendlyName } from './bot.js'
import { canSend } from './template.js'
import { consentDecision, isQuietHoursIST, unfillableKeys, validateCampaignInput } from './campaign.js'
import { waIdToIndianPhone, toWaId } from './phone.js'

export const CAMPAIGN_TICK_SECONDS = 10
const PARALLEL_SENDS = 5
const MAX_SCHEDULE_DAYS = 30
const CAMPAIGN_TOKENS = ['customer_name']

/**
 * WhatsApp campaigns: build → preview → launch (now or scheduled) → paced sending → results.
 *
 * Safety rules enforced here (and again per message in AutomatedSender):
 *  - only an APPROVED template; if Meta pauses/disables it mid-campaign the campaign pauses itself
 *  - only contacts with recorded opt-in, never opted-out or suppressed ones
 *  - the audience is snapshotted at launch; each contact appears once
 *  - marketing templates are not sent 9 pm – 9 am IST
 */
export class CampaignService {
  /**
   * @param {{ repo: import('./campaign.repository.js').CampaignRepository,
   *           tplRepo: import('./template.repository.js').TemplateRepository,
   *           sender: import('./automated-sender.js').AutomatedSender,
   *           emit: (e: string, p: object) => void,
   *           logger: { info: Function, warn: Function },
   *           now?: () => Date }} deps
   */
  constructor({ repo, tplRepo, sender, emit, logger, now = () => new Date() }) {
    Object.assign(this, { repo, tplRepo, sender, emit, logger, now })
  }

  // ─── Builder ───────────────────────────────────────────────────────
  async list(q) {
    const rows = await this.repo.list(q)
    return Promise.all(rows.map(async (c) => ({ ...c, stats: await this.repo.stats(c.id) })))
  }

  async get(id) {
    const c = await this.repo.get(id)
    if (!c) throw new CrmError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND')
    return { ...c, stats: await this.repo.stats(id) }
  }

  options() {
    return this.repo.audienceOptions()
  }

  async create(input, userId) {
    const { errors, value } = validateCampaignInput(input)
    if (!value) throw new CrmError('Please fix the highlighted fields', 400, 'VALIDATION', errors)
    await this.assertTemplate(value.templateId, value.templateValues ?? {}, { forDraft: true })
    return this.get((await this.repo.insert(value, userId)).id)
  }

  async update(id, input) {
    const current = await this.repo.get(id)
    if (!current) throw new CrmError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND')
    if (current.status !== 'DRAFT') throw new CrmError('Only a draft campaign can be edited.', 409, 'NOT_DRAFT')
    const { errors, value } = validateCampaignInput(input, { partial: true })
    if (!value) throw new CrmError('Please fix the highlighted fields', 400, 'VALIDATION', errors)
    await this.assertTemplate(value.templateId ?? current.template_id, value.templateValues ?? current.template_values, { forDraft: true })
    const updated = await this.repo.updateDraft(id, value)
    if (!updated) throw new CrmError('Only a draft campaign can be edited.', 409, 'NOT_DRAFT')
    return this.get(id)
  }

  async remove(id) {
    if (!(await this.repo.deleteDraft(id))) throw new CrmError('Only a draft campaign can be deleted. Cancel it instead.', 409, 'NOT_DRAFT')
  }

  /** The template must exist and every variable must be fillable (typed value or {{customer_name}}). */
  async assertTemplate(templateId, spec, { forDraft = false } = {}) {
    const tpl = await this.tplRepo.get(templateId)
    if (!tpl || tpl.status === 'DELETED') throw new CrmError('Template not found', 404, 'TEMPLATE_NOT_FOUND')
    if (!forDraft) {
      const gate = canSend(tpl)
      if (!gate.ok) throw new CrmError(gate.reason, 409, 'TEMPLATE_NOT_SENDABLE')
    }
    const missing = unfillableKeys(tpl, spec, CAMPAIGN_TOKENS)
    if (missing.length) {
      throw new CrmError(`Fill in a value for: ${missing.join(', ')}`, 400, 'MISSING_VALUES', { templateValues: `Fill in a value for: ${missing.join(', ')}` })
    }
    return tpl
  }

  // ─── Audience preview / snapshot ───────────────────────────────────
  async decide(campaign, template) {
    const rows = await this.repo.resolveAudience(campaign.audience)
    const entries = rows.map((r) => {
      const d = consentDecision({
        category: template.meta_category,
        consent: r.consent,
        suppressed: r.suppressed,
        // campaigns are bulk sends: an unknown-consent contact is never enough, even for UTILITY
        hasMessagedUs: false,
        hasAddress: Boolean(r.wa_id || r.bsuid),
      })
      return { contactId: r.id, status: d.ok ? 'PENDING' : 'SKIPPED', reason: d.reason }
    })
    const skipped = {}
    for (const e of entries) if (e.reason) skipped[e.reason] = (skipped[e.reason] ?? 0) + 1
    return { entries, summary: { audience: entries.length, willSend: entries.filter((e) => e.status === 'PENDING').length, skipped } }
  }

  async preview(id) {
    const c = await this.repo.get(id)
    if (!c) throw new CrmError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND')
    const tpl = await this.assertTemplate(c.template_id, c.template_values)
    return (await this.decide(c, tpl)).summary
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────
  /** @param {{ scheduledAt?: string|Date|null }} [opts] omit to start immediately */
  async launch(id, { scheduledAt = null } = {}) {
    const c = await this.repo.get(id)
    if (!c) throw new CrmError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND')
    if (c.status !== 'DRAFT') throw new CrmError('This campaign has already been launched.', 409, 'NOT_DRAFT')
    const tpl = await this.assertTemplate(c.template_id, c.template_values)
    if (tpl.header_format === 'IMAGE' && !c.header_media_url && !c.header_image_source) throw new CrmError('This template has a picture. Choose which picture to send before launching.', 400, 'PICTURE_REQUIRED', { headerImageSource: 'Choose which picture to send' })

    let when = null
    if (scheduledAt) {
      when = new Date(scheduledAt)
      const ms = when.getTime() - this.now().getTime()
      if (Number.isNaN(when.getTime()) || ms < 60_000) throw new CrmError('Pick a time at least a minute from now.', 400, 'BAD_SCHEDULE')
      if (ms > MAX_SCHEDULE_DAYS * 86_400_000) throw new CrmError(`Schedule at most ${MAX_SCHEDULE_DAYS} days ahead.`, 400, 'BAD_SCHEDULE')
    }

    const { entries, summary } = await this.decide(c, tpl)
    if (summary.willSend === 0) {
      throw new CrmError('Nobody in this audience can receive this message — no recorded opt-in, or all are opted out / suppressed.', 409, 'NO_RECIPIENTS', summary)
    }
    // Snapshot first, then flip status; a second launch call loses the DRAFT → * race below.
    await this.repo.replaceRecipients(id, entries)
    const moved = await this.repo.transition(id, 'DRAFT', when ? 'SCHEDULED' : 'SENDING', { scheduledAt: when, total: summary.willSend })
    if (!moved) throw new CrmError('This campaign has already been launched.', 409, 'NOT_DRAFT')
    this.emit('crm:campaign', { campaignId: id })
    return this.get(id)
  }

  async pause(id) {
    const c = await this.repo.transition(id, ['SENDING', 'SCHEDULED'], 'PAUSED', { pauseReason: 'Paused by a team member' })
    if (!c) throw new CrmError('Only a running or scheduled campaign can be paused.', 409, 'BAD_STATE')
    this.emit('crm:campaign', { campaignId: id })
    return this.get(id)
  }

  async resume(id) {
    const current = await this.repo.get(id)
    if (!current) throw new CrmError('Campaign not found', 404, 'CAMPAIGN_NOT_FOUND')
    if (current.status !== 'PAUSED') throw new CrmError('Only a paused campaign can be resumed.', 409, 'BAD_STATE')
    await this.assertTemplate(current.template_id, current.template_values) // fails clearly if Meta still blocks it
    const future = current.scheduled_at && new Date(current.scheduled_at) > this.now()
    const c = await this.repo.transition(id, 'PAUSED', future ? 'SCHEDULED' : 'SENDING', {})
    if (!c) throw new CrmError('Only a paused campaign can be resumed.', 409, 'BAD_STATE')
    this.emit('crm:campaign', { campaignId: id })
    return this.get(id)
  }

  async cancel(id) {
    const c = await this.repo.transition(id, ['SCHEDULED', 'SENDING', 'PAUSED'], 'CANCELLED', {})
    if (!c) throw new CrmError('Only a scheduled, running or paused campaign can be cancelled.', 409, 'BAD_STATE')
    await this.repo.skipPending(id, 'CANCELLED')
    this.emit('crm:campaign', { campaignId: id })
    return this.get(id)
  }

  recipients(id, q) {
    return this.repo.listRecipients(id, q)
  }

  // ─── Sending (called every CAMPAIGN_TICK_SECONDS by the worker) ────
  async tick() {
    const started = await this.repo.startDueScheduled()
    if (started.length) this.logger.info({ started }, 'Scheduled WhatsApp campaigns started')
    await this.repo.recoverStuckRecipients()

    let sent = 0
    for (const id of await this.repo.listSending()) sent += await this.runBatch(id)
    return { sent }
  }

  async runBatch(campaignId) {
    const c = await this.repo.get(campaignId)
    if (!c || c.status !== 'SENDING') return 0

    const tpl = await this.tplRepo.get(c.template_id)
    if (!tpl) return this.pauseWith(c, 'The template no longer exists.')
    const gate = canSend(tpl)
    if (!gate.ok) return this.pauseWith(c, gate.reason)
    if (tpl.meta_category === 'MARKETING' && isQuietHoursIST(this.now())) return 0 // resumes by itself at 9 am IST

    const perTick = Math.max(1, Math.ceil((c.rate_per_minute * CAMPAIGN_TICK_SECONDS) / 60))
    const claimed = await this.repo.claimRecipients(campaignId, perTick)
    let sent = 0
    let stop = null

    for (let i = 0; i < claimed.length; i += PARALLEL_SENDS) {
      if (stop) {
        await Promise.all(claimed.slice(i).map((r) => this.repo.requeueRecipient(r.id)))
        break
      }
      const results = await Promise.all(claimed.slice(i, i + PARALLEL_SENDS).map((r) => this.sendOne(c, tpl, r)))
      for (const res of results) {
        if (res.sent) sent++
        if (res.pause) stop = res.pause
      }
    }

    if (stop) return this.pauseWith(c, stop, sent)
    if ((await this.repo.pendingCount(campaignId)) === 0) {
      await this.repo.transition(campaignId, 'SENDING', 'COMPLETED', {})
      this.logger.info({ campaignId }, 'WhatsApp campaign completed')
      this.emit('crm:campaign', { campaignId })
    }
    return sent
  }

  async pauseWith(campaign, reason, sent = 0) {
    await this.repo.transition(campaign.id, 'SENDING', 'PAUSED', { pauseReason: String(reason).slice(0, 200) })
    this.logger.warn({ campaignId: campaign.id, reason }, 'WhatsApp campaign paused automatically')
    this.emit('crm:campaign', { campaignId: campaign.id })
    return sent
  }

  /** @returns {Promise<{ sent?: boolean, pause?: string }>} */
  async sendOne(campaign, tpl, recipient) {
    try {
      const contact = await this.repo.getContactForSend(recipient.contact_id)
      if (!contact) {
        await this.repo.setRecipient(recipient.id, { status: 'SKIPPED', reason: 'NO_ADDRESS' })
        return {}
      }
      const out = await this.sender.send({
        contact,
        template: tpl,
        spec: campaign.template_values,
        tokens: { customer_name: friendlyName(contact.customer_name, contact.profile_name) },
        headerMediaUrl: campaign.header_media_url,
        imageSource: campaign.header_image_source ?? null,
        campaignId: campaign.id,
        attempts: recipient.attempts,
        onQueued: (messageId) => this.repo.setRecipient(recipient.id, { status: 'SENDING', messageId }),
      })
      switch (out.outcome) {
        case 'SENT':
          await this.repo.setRecipient(recipient.id, { status: 'SENT', messageId: out.message.id })
          return { sent: true }
        case 'RETRY':
          await this.repo.requeueRecipient(recipient.id)
          return {}
        case 'SKIPPED':
          await this.repo.setRecipient(recipient.id, { status: 'SKIPPED', reason: out.reason, errorText: out.text, messageId: out.messageId })
          return {}
        default:
          if (out.pauseCampaign) {
            await this.repo.requeueRecipient(recipient.id)
            return { pause: out.text ?? 'The template cannot be sent right now.' }
          }
          await this.repo.setRecipient(recipient.id, { status: 'FAILED', reason: out.reason, errorCode: out.code, errorText: out.text, messageId: out.messageId })
          return {}
      }
    } catch (err) {
      // Unexpected (database, bug): leave a clear mark, never retry blindly.
      this.logger.warn({ err: err.message, recipientId: recipient.id }, 'Campaign recipient failed unexpectedly')
      await this.repo.setRecipient(recipient.id, { status: 'FAILED', reason: 'INTERNAL_ERROR', errorText: err.message }).catch(() => {})
      return {}
    }
  }

  // ─── Consent & suppression ─────────────────────────────────────────
  /**
   * Staff record that these customers agreed to WhatsApp messages (the source says where, e.g. "checkout checkbox").
   * Needs an explicit confirmation — consent is a legal matter, never implied.
   */
  async recordConsent({ phones, source, confirm }) {
    if (confirm !== true) throw new CrmError('Please confirm that these customers agreed to receive WhatsApp messages from Bakaloo.', 400, 'CONFIRM_REQUIRED')
    const src = String(source ?? '').trim()
    if (src.length < 3 || src.length > 40) throw new CrmError('Say where the consent was collected (3–40 characters), e.g. “checkout checkbox”.', 400, 'VALIDATION', { source: 'Required' })
    const list = Array.isArray(phones) ? phones : []
    if (!list.length || list.length > 5000) throw new CrmError('Send between 1 and 5000 phone numbers.', 400, 'VALIDATION', { phones: 'Between 1 and 5000' })
    const valid = []
    const invalid = []
    for (const p of list) {
      const wa = toWaId(p)
      const ten = waIdToIndianPhone(wa)
      if (ten) valid.push(ten)
      else invalid.push(String(p).slice(0, 20))
    }
    const updated = valid.length ? await this.repo.recordConsentForPhones([...new Set(valid)], src.toUpperCase().replace(/\s+/g, '_')) : 0
    return { recorded: updated, invalid: invalid.slice(0, 50), invalidCount: invalid.length }
  }

  listSuppressed(q) {
    return this.repo.listSuppressed(q)
  }

  async suppress(contactId, reason, userId) {
    if (!(await this.repo.suppress(contactId, reason, userId))) throw new CrmError('Contact not found', 404, 'CONTACT_NOT_FOUND')
  }

  async unsuppress(contactId) {
    if (!(await this.repo.unsuppress(contactId))) throw new CrmError('That contact is not on the list.', 404, 'NOT_SUPPRESSED')
  }
}
