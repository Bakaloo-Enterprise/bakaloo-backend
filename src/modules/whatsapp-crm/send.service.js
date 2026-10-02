import { CrmError } from './errors.js'
import { MetaApiError, META_CODE } from './meta-client.js'

/**
 * Agent-initiated sends from the shared inbox.
 *
 * Rule enforced here, not just in the UI: free-form text may only be sent
 * while the customer's 24-hour window is open (they wrote within 24 h).
 * Outside it WhatsApp only accepts an approved template — added in Phase 6.
 */
export class SendService {
  /**
   * @param {{ repo: import('./whatsapp.repository.js').WhatsappRepository,
   *           client: ReturnType<typeof import('./meta-client.js').createMetaClient>,
   *           emit: (event: string, payload: object) => void,
   *           logger: { warn: Function } }} deps
   */
  constructor({ repo, client, emit, logger, pipeline = null, bot = null }) {
    this.repo = repo
    this.bot = bot
    this.pipeline = pipeline
    this.client = client
    this.emit = emit
    this.logger = logger
  }

  async sendText({ conversationId, body, sentBy, replyToWamid }) {
    const text = String(body ?? '').trim()
    if (!text) throw new CrmError('Message cannot be empty', 400, 'EMPTY_MESSAGE')
    if (text.length > 4096) throw new CrmError('Message is too long (max 4096 characters)', 400, 'MESSAGE_TOO_LONG')

    const conv = await this.repo.getConversation(conversationId)
    if (!conv) throw new CrmError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND')

    if (!conv.window_open) {
      throw new CrmError(
        'The 24-hour reply window is closed. WhatsApp only allows an approved template message to this customer now.',
        409,
        'OUTSIDE_24H_WINDOW',
      )
    }

    // Record first (QUEUED) so the agent sees the message instantly and a crash
    // between "Meta accepted" and "we saved the id" can never lose it.
    const queued = await this.repo.insertOutboundQueued({
      conversationId: conv.id,
      contactId: conv.contact_id,
      type: 'text',
      body: text,
      replyToWamid: replyToWamid ?? null,
      sentBy: sentBy ?? null,
    })
    await this.repo.bumpConversationForOutbound(conv.id, text.slice(0, 200))

    try {
      const { wamid } = await this.client.sendText({
        to: conv.wa_id,
        bsuid: conv.bsuid,
        body: text,
        replyToWamid,
      })
      const sent = await this.repo.markOutboundSent(queued.id, wamid)
      this.emit('crm:message', { conversationId: conv.id, contactId: conv.contact_id, assignedTo: conv.assigned_to ?? null })
      await this.bot?.onAgentReply(conv.id) // a person is handling this chat: the bot steps back
      await this.pipeline?.evaluateContact(conv.contact_id) // first agent reply: Lead -> Conversation
      return sent
    } catch (err) {
      const meta = err instanceof MetaApiError ? err : new MetaApiError(err?.message ?? 'Send failed')
      await this.repo.markOutboundFailed(queued.id, meta)
      this.logger.warn({ conversationId: conv.id, code: meta.code, fbtraceId: meta.fbtraceId }, 'WhatsApp send failed')
      this.emit('crm:message', { conversationId: conv.id, contactId: conv.contact_id, assignedTo: conv.assigned_to ?? null })

      if (meta.code === META_CODE.OUTSIDE_24H_WINDOW) {
        throw new CrmError('WhatsApp rejected the message: the 24-hour reply window is closed.', 409, 'OUTSIDE_24H_WINDOW')
      }
      // Not retried automatically: a blind retry of a customer-facing message risks a duplicate.
      throw new CrmError(`WhatsApp could not send the message${meta.details ? `: ${meta.details}` : ''}`, 502, 'WHATSAPP_SEND_FAILED')
    }
  }
}
