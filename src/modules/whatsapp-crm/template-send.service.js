import { CrmError } from './errors.js'
import { META_CODE, MetaApiError } from './meta-client.js'
import { describeLastOrder, friendlyName } from './bot.js'
import { buildSendComponents, canSend, renderPreview, summarizeComponents } from './template.js'

/**
 * Sends an APPROVED template to a customer from the inbox.
 *
 * Gates, in order: conversation access → template exists and is APPROVED (canSend) →
 * marketing consent → every variable has a value → Meta. Nothing unapproved can reach Meta
 * from here, and a half-filled message can never be sent.
 */
export class TemplateSendService {
  /**
   * @param {{ repo: import('./whatsapp.repository.js').WhatsappRepository,
   *           tplRepo: import('./template.repository.js').TemplateRepository,
   *           client: { sendTemplate: Function },
   *           getConversation: (id: string, access: object) => Promise<object>,
   *           emit: (e: string, p: object) => void,
   *           logger: { warn: Function },
   *           pipeline?: { evaluateContact: Function }|null,
   *           bot?: { onAgentReply: Function }|null }} deps
   */
  constructor({ repo, tplRepo, client, getConversation, emit, logger, pipeline = null, bot = null }) {
    Object.assign(this, { repo, tplRepo, client, getConversation, emit, logger, pipeline, bot })
  }

  /** Values we can fill automatically for this customer; the dialog pre-fills them and staff can edit. */
  async knownValues(conv) {
    const [order, cart] = await Promise.all([this.tplRepo.lastOrder(conv.customer_id), this.tplRepo.openCartValue(conv.customer_id)])
    const out = { customer_name: friendlyName(conv.customer_name, conv.profile_name) }
    if (order) {
      out.order_number = order.order_number
      out.order_status = describeLastOrder(order).replace(/^Your latest order \S+ is /, '').replace(/\.$/, '')
    }
    if (cart != null) out.cart_value = String(Math.round(cart))
    return out
  }

  async valuesFor(conversationId, access) {
    return this.knownValues(await this.getConversation(conversationId, access))
  }

  /**
   * @param {{ conversationId: string, templateId: string, values?: Record<string,string>, headerMediaUrl?: string,
   *           sentBy: string, access: object }} input
   */
  async send({ conversationId, templateId, values = {}, headerMediaUrl, sentBy, access }) {
    const conv = await this.getConversation(conversationId, access) // 404 for chats the agent may not see

    const tpl = await this.tplRepo.get(templateId)
    if (!tpl || tpl.status === 'DELETED') throw new CrmError('Template not found', 404, 'TEMPLATE_NOT_FOUND')
    const gate = canSend(tpl)
    if (!gate.ok) throw new CrmError(gate.reason, 409, 'TEMPLATE_NOT_SENDABLE')

    if (tpl.meta_category === 'MARKETING' && conv.marketing_consent === 'OPTED_OUT') {
      throw new CrmError('This customer has opted out of marketing messages, so a marketing template cannot be sent. Use a utility template, or reply in the chat if the 24-hour window is open.', 409, 'OPTED_OUT')
    }

    // Auto-filled values first, then what the agent typed (theirs wins). Only keys this template uses.
    const known = await this.knownValues(conv)
    const keys = new Set(summarizeComponents(tpl.components, tpl.parameter_format).variables.map((v) => v.key))
    const merged = {}
    for (const k of keys) {
      const typed = values?.[k]
      merged[k] = typed != null && String(typed).trim() !== '' ? typed : known[k] ?? ''
    }

    const mediaUrl = String(headerMediaUrl ?? '').trim() || tpl.default_header_url || undefined
    const built = buildSendComponents(tpl, merged, { headerMediaUrl: mediaUrl })
    if (built.error) throw new CrmError(built.error, 400, 'INVALID_TEMPLATE_VALUES')
    if (built.missing.length) {
      throw new CrmError(`Fill in: ${built.missing.join(', ')}`, 400, 'MISSING_VALUES', built.missing)
    }

    const preview = renderPreview(tpl, merged)
    const queued = await this.repo.insertOutboundQueued({
      conversationId: conv.id, contactId: conv.contact_id, type: 'template', body: preview,
      templateName: tpl.name, templateLanguage: tpl.language, templateId: tpl.id, sentBy,
    })
    await this.repo.bumpConversationForOutbound(conv.id, preview.slice(0, 200))

    try {
      const { wamid } = await this.client.sendTemplate({ to: conv.wa_id, bsuid: conv.bsuid, name: tpl.name, language: tpl.language, components: built.components })
      const sent = await this.repo.markOutboundSent(queued.id, wamid)
      if (headerMediaUrl && headerMediaUrl !== tpl.default_header_url && !tpl.default_header_url) {
        await this.tplRepo.patch(tpl.id, { default_header_url: headerMediaUrl }).catch(() => {}) // remember the first picture used
      }
      this.emit('crm:message', { conversationId: conv.id, contactId: conv.contact_id, assignedTo: conv.assigned_to ?? null })
      await this.bot?.onAgentReply(conv.id) // a person is handling this chat
      await this.pipeline?.evaluateContact(conv.contact_id)
      return sent
    } catch (err) {
      const meta = err instanceof MetaApiError ? err : new MetaApiError(err?.message ?? 'Send failed')
      await this.repo.markOutboundFailed(queued.id, meta)
      this.emit('crm:message', { conversationId: conv.id, contactId: conv.contact_id, assignedTo: conv.assigned_to ?? null })
      this.logger.warn({ conversationId: conv.id, templateId: tpl.id, code: meta.code }, 'Template send failed')
      throw await this.explain(meta, tpl, conv)
    }
  }

  /** Turn a Meta send failure into advice, and keep our own records honest. */
  async explain(meta, tpl, conv) {
    switch (meta.code) {
      case META_CODE.TEMPLATE_NOT_FOUND_OR_UNAPPROVED:
        return new CrmError('Meta says this template is not approved or does not exist in this language. Run “Sync with Meta” to refresh the list.', 409, 'TEMPLATE_NOT_SENDABLE')
      case META_CODE.TEMPLATE_PAUSED:
        await this.tplRepo.patch(tpl.id, { status: 'PAUSED' })
        return new CrmError('Meta has paused this template because of customer feedback. It cannot be sent for now.', 409, 'TEMPLATE_NOT_SENDABLE')
      case META_CODE.TEMPLATE_DISABLED:
        await this.tplRepo.patch(tpl.id, { status: 'DISABLED' })
        return new CrmError('Meta has disabled this template.', 409, 'TEMPLATE_NOT_SENDABLE')
      case META_CODE.TEMPLATE_PARAM_MISMATCH:
        return new CrmError('The values do not match what this template expects. Run “Sync with Meta” — it may have been edited.', 409, 'TEMPLATE_OUT_OF_DATE')
      case META_CODE.USER_OPTED_OUT_MARKETING:
        await this.tplRepo.setConsent(conv.contact_id, 'OPTED_OUT')
        return new CrmError('This customer has opted out of marketing messages.', 409, 'OPTED_OUT')
      case META_CODE.PER_USER_MARKETING_LIMIT:
        return new CrmError('Meta limits how many marketing messages one person can receive. Try again after 24 hours.', 409, 'MARKETING_LIMIT')
      case META_CODE.NOT_A_WHATSAPP_USER:
        return new CrmError('This number is not reachable on WhatsApp.', 409, 'NOT_ON_WHATSAPP')
      default:
        return new CrmError(`WhatsApp could not send the template${meta.details ? `: ${meta.details}` : ''}`, 502, 'WHATSAPP_SEND_FAILED')
    }
  }
}
