import { MetaApiError } from './meta-client.js'
import { buildSendComponents, canSend, renderPreview } from './template.js'
import { classifySendError, consentDecision, resolveTemplateValues } from './campaign.js'

/**
 * Sends one APPROVED template to one contact on behalf of a campaign or workflow.
 *
 * It is the single gate for automated sends. In order:
 *   template approved → consent / suppression → every variable filled → Meta.
 * A message that fails a gate is never created, so nothing half-built reaches the customer.
 *
 * Automated messages are stored like any other outbound message (they show in the chat), tagged with
 * campaign_id / workflow_id. They do NOT pause the bot, do NOT count as a person replying, and do
 * not make a waiting chat look answered.
 */
export class AutomatedSender {
  /**
   * @param {{ repo: import('./whatsapp.repository.js').WhatsappRepository,
   *           tplRepo: import('./template.repository.js').TemplateRepository,
   *           client: { sendTemplate: Function },
   *           emit: (e: string, p: object) => void,
   *           logger: { warn: Function } }} deps
   */
  constructor({ repo, tplRepo, client, emit, logger }) {
    Object.assign(this, { repo, tplRepo, client, emit, logger })
  }

  /**
   * @param {{ contact: object, template: object, spec?: Record<string,string>, tokens?: Record<string,string|number>,
   *           headerMediaUrl?: string|null, campaignId?: string, workflowId?: string, attempts?: number,
   *           onQueued?: (messageId: string) => Promise<void> }} i
   * @returns {Promise<
   *   { outcome: 'SENT', message: object } |
   *   { outcome: 'SKIPPED', reason: string, setConsent?: string } |
   *   { outcome: 'RETRY' } |
   *   { outcome: 'FAILED', reason: string, code?: number|null, text?: string, pauseCampaign?: boolean, messageId?: string }>}
   */
  async send({ contact, template, spec = {}, tokens = {}, headerMediaUrl = null, campaignId, workflowId, attempts = 1, onQueued }) {
    const gate = canSend(template)
    if (!gate.ok) return { outcome: 'FAILED', reason: 'TEMPLATE_NOT_SENDABLE', text: gate.reason, pauseCampaign: true }

    const decision = consentDecision({
      category: template.meta_category,
      consent: contact.consent,
      suppressed: contact.suppressed,
      hasMessagedUs: contact.has_messaged_us,
      hasAddress: Boolean(contact.wa_id || contact.bsuid),
    })
    if (!decision.ok) return { outcome: 'SKIPPED', reason: decision.reason }

    const { values, missing } = resolveTemplateValues(template, spec, tokens)
    if (missing.length) return { outcome: 'SKIPPED', reason: 'MISSING_VALUES', text: `Could not fill: ${missing.join(', ')}` }

    const built = buildSendComponents(template, values, { headerMediaUrl })
    if (built.error) return { outcome: 'FAILED', reason: 'INVALID_TEMPLATE_VALUES', text: built.error }
    if (built.missing.length) return { outcome: 'SKIPPED', reason: 'MISSING_VALUES', text: `Could not fill: ${built.missing.join(', ')}` }

    const preview = renderPreview(template, values)
    const queued = await this.repo.withTransaction(async (client) => {
      const conv = await this.repo.ensureConversation(contact.id, client)
      const msg = await this.repo.insertOutboundQueued(
        { conversationId: conv.id, contactId: contact.id, type: 'template', body: preview, templateName: template.name, templateLanguage: template.language, templateId: template.id, campaignId, workflowId },
        client,
      )
      await this.repo.bumpConversationForOutbound(conv.id, preview.slice(0, 200), client, { keepAwaiting: true })
      return { conversationId: conv.id, message: msg }
    })
    if (onQueued) await onQueued(queued.message.id)

    try {
      const { wamid } = await this.client.sendTemplate({ to: contact.wa_id, bsuid: contact.bsuid, name: template.name, language: template.language, components: built.components })
      const sent = await this.repo.markOutboundSent(queued.message.id, wamid)
      this.emit('crm:message', { conversationId: queued.conversationId, contactId: contact.id, assignedTo: null })
      return { outcome: 'SENT', message: sent }
    } catch (err) {
      const meta = err instanceof MetaApiError ? err : new MetaApiError(err?.message ?? 'Send failed', { retryable: false })
      await this.repo.markOutboundFailed(queued.message.id, meta)
      this.emit('crm:message', { conversationId: queued.conversationId, contactId: contact.id, assignedTo: null })
      const verdict = classifySendError(meta, attempts)
      if (verdict.retry) return { outcome: 'RETRY' }
      this.logger.warn({ contactId: contact.id, templateId: template.id, code: meta.code, campaignId, workflowId }, 'Automated WhatsApp send failed')
      if (verdict.setConsent) await this.tplRepo.setConsent(contact.id, verdict.setConsent)
      if (verdict.status === 'SKIPPED') return { outcome: 'SKIPPED', reason: verdict.reason, setConsent: verdict.setConsent, messageId: queued.message.id }
      return { outcome: 'FAILED', reason: verdict.reason, code: meta.code ?? null, text: meta.details || meta.message, pauseCampaign: verdict.pauseCampaign, messageId: queued.message.id }
    }
  }
}
