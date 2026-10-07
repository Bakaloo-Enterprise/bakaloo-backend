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

  /**
   * An image / video / audio / document from an agent. Same 24-hour rule as text.
   * @param {{ conversationId: string, buffer: Buffer, mimeType: string, filename?: string, caption?: string, sentBy?: string }} a
   */
  async sendMedia({ conversationId, buffer, mimeType, filename, caption, sentBy }) {
    const kind = classifyMedia(mimeType)
    if (!kind) throw new CrmError('That file type cannot be sent on WhatsApp. Send a photo, video, voice note or a document such as PDF, Word or Excel.', 400, 'UNSUPPORTED_FILE_TYPE')
    if (!buffer?.length) throw new CrmError('That file is empty', 400, 'EMPTY_FILE')
    if (buffer.length > kind.maxBytes) {
      throw new CrmError(`That ${kind.label} is too large. WhatsApp allows up to ${Math.round(kind.maxBytes / 1024 / 1024)} MB.`, 400, 'FILE_TOO_LARGE')
    }
    const text = String(caption ?? '').trim().slice(0, 1024)
    const conv = await this.repo.getConversation(conversationId)
    if (!conv) throw new CrmError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND')
    if (!conv.window_open) {
      throw new CrmError('The 24-hour reply window is closed. WhatsApp only allows an approved template message to this customer now.', 409, 'OUTSIDE_24H_WINDOW')
    }

    const safeName = String(filename ?? '').replace(/[\r\n"\\/]/g, '_').slice(0, 200) || kind.label
    const queued = await this.repo.insertOutboundQueued({
      conversationId: conv.id,
      contactId: conv.contact_id,
      type: kind.type,
      body: text || null,
      media: { mime_type: mimeType, filename: safeName, caption: text || null, size: buffer.length },
      sentBy: sentBy ?? null,
    })
    await this.repo.bumpConversationForOutbound(conv.id, `[${kind.label}]${text ? ` ${text}` : ''}`.slice(0, 200))

    try {
      const { mediaId } = await this.client.uploadMedia({ buffer, mimeType, filename: safeName })
      await this.repo.setMessageMedia(queued.id, { mime_type: mimeType, filename: safeName, caption: text || null, size: buffer.length, id: mediaId })
      const { wamid } = await this.client.sendMedia({ to: conv.wa_id, bsuid: conv.bsuid, mediaType: kind.type, mediaId, caption: text, filename: safeName })
      const sent = await this.repo.markOutboundSent(queued.id, wamid)
      this.emit('crm:message', { conversationId: conv.id, contactId: conv.contact_id, assignedTo: conv.assigned_to ?? null })
      await this.bot?.onAgentReply(conv.id)
      await this.pipeline?.evaluateContact(conv.contact_id)
      return sent
    } catch (err) {
      const meta = err instanceof MetaApiError ? err : new MetaApiError(err?.message ?? 'Send failed')
      await this.repo.markOutboundFailed(queued.id, meta)
      this.logger.warn({ conversationId: conv.id, code: meta.code, fbtraceId: meta.fbtraceId }, 'WhatsApp media send failed')
      this.emit('crm:message', { conversationId: conv.id, contactId: conv.contact_id, assignedTo: conv.assigned_to ?? null })
      if (meta.code === META_CODE.OUTSIDE_24H_WINDOW) {
        throw new CrmError('WhatsApp rejected the message: the 24-hour reply window is closed.', 409, 'OUTSIDE_24H_WINDOW')
      }
      throw new CrmError(`WhatsApp could not send the file${meta.details ? `: ${meta.details}` : meta.message ? `: ${meta.message}` : ''}`, 502, 'WHATSAPP_SEND_FAILED')
    }
  }
}

const MB = 1024 * 1024
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
])

/** WhatsApp's accepted attachment types and size limits (documents capped lower than Meta's 100 MB to protect the server). */
export function classifyMedia(mimeType) {
  const m = String(mimeType ?? '').toLowerCase().split(';')[0].trim()
  if (m === 'image/jpeg' || m === 'image/png') return { type: 'image', label: 'photo', maxBytes: 5 * MB }
  if (m === 'video/mp4' || m === 'video/3gpp') return { type: 'video', label: 'video', maxBytes: 16 * MB }
  if (['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'].includes(m)) return { type: 'audio', label: 'voice note', maxBytes: 16 * MB }
  if (DOCUMENT_TYPES.has(m)) return { type: 'document', label: 'document', maxBytes: 25 * MB }
  return null
}
