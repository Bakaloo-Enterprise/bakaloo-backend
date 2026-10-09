import { parseWebhook } from './webhook-parser.js'
import { waIdToIndianPhone } from './phone.js'
import { canTransition, mapMetaStatus } from './status-ladder.js'
import { RetryLaterError } from './errors.js'
import { META_CODE } from './meta-client.js'
import { normalizePricing } from './analytics.js'

/** Statuses for a message we have no record of are retried for this long, then ignored. */
const UNMATCHED_STATUS_GRACE_MS = 5 * 60 * 1000

/**
 * Applies a stored webhook event: inbound customer messages and delivery
 * statuses. Safe to run more than once for the same event (idempotent).
 */
export class InboundService {
  /**
   * @param {{ repo: import('./whatsapp.repository.js').WhatsappRepository,
   *           emit: (event: string, payload: object) => void,
   *           logger: { info: Function, warn: Function, debug: Function },
   *           phoneNumberId?: string, now?: () => Date }} deps
   */
  constructor({ repo, emit, logger, phoneNumberId, pipeline = null, bot = null, templates = null, workflows = null, now = () => new Date() }) {
    this.repo = repo
    this.templates = templates
    this.workflows = workflows
    this.pipeline = pipeline
    this.bot = bot
    this.emit = emit
    this.logger = logger
    this.phoneNumberId = phoneNumberId
    this.now = now
  }

  async processEvent(eventId) {
    const event = await this.repo.getWebhookEvent(eventId)
    if (!event) return { skipped: 'missing' }
    if (event.processed_at) return { skipped: 'already_processed' }

    const phoneNumberId = typeof this.phoneNumberId === 'function' ? await this.phoneNumberId() : this.phoneNumberId
    const parsed = parseWebhook(event.payload, { phoneNumberId })

    if (parsed.messages.length === 0 && parsed.skipped > 0 && parsed.statuses.length === 0) {
      // Usually: the webhook is for a different WhatsApp number than the one saved in settings.
      this.logger.warn({ eventId, skipped: parsed.skipped, configuredPhoneNumberId: phoneNumberId }, 'WhatsApp webhook event ignored (other number or unsupported)')
    }
    for (const msg of parsed.messages) await this.handleMessage(msg)

    let unmatched = 0
    for (const st of parsed.statuses) {
      if (!(await this.handleStatus(st))) unmatched++
    }

    // Template approval changes (approved / rejected / paused / quality / category). Idempotent;
    // a DB failure throws so BullMQ retries the whole event.
    for (const ev of parsed.templateEvents) {
      if (this.templates) await this.templates.applyWebhook(ev)
    }

    // A status can beat our own "message accepted by Meta" write. Retry shortly; give up
    // after the grace period (it is then a message sent from outside this system).
    const ageMs = this.now().getTime() - new Date(event.received_at).getTime()
    if (unmatched > 0 && ageMs < UNMATCHED_STATUS_GRACE_MS) {
      throw new RetryLaterError(`${unmatched} status update(s) for messages not stored yet`)
    }

    await this.repo.markEventProcessed(eventId)
    return { messages: parsed.messages.length, statuses: parsed.statuses.length, unmatched }
  }

  async handleMessage(msg) {
    if (msg.isReaction) return // emoji reactions are not chat messages; shown in a later phase

    const phone = waIdToIndianPhone(msg.waId)
    const userId = await this.repo.findCustomerIdByPhone(phone)
    const preview = (msg.body ?? `[${msg.type}]`).slice(0, 200)

    const result = await this.repo.withTransaction(async (client) => {
      const { contact, created } = await this.repo.upsertContact(
        {
          waId: msg.waId,
          bsuid: msg.bsuid,
          parentBsuid: msg.parentBsuid,
          username: msg.username,
          profileName: msg.profileName,
          phone,
          userId,
          referral: msg.referral,
          at: msg.timestamp,
        },
        client,
      )
      if (contact._ambiguous) {
        this.logger.warn({ contactId: contact.id, waId: msg.waId, bsuid: msg.bsuid }, 'WhatsApp contact matched two rows (phone and BSUID) — not merged')
      }

      const conversation = await this.repo.ensureConversation(contact.id, client)
      const stored = await this.repo.insertInboundMessage(
        {
          conversationId: conversation.id,
          contactId: contact.id,
          wamid: msg.wamid,
          type: msg.type,
          body: msg.body,
          media: msg.media,
          interactive: msg.interactive,
          replyToWamid: msg.replyToWamid,
          timestamp: msg.timestamp,
        },
        client,
      )
      if (!stored) return null // duplicate delivery of the same wamid

      const updated = await this.repo.bumpConversationForInbound(conversation.id, preview, msg.timestamp, client)
      return { contact, created, conversation: updated, message: stored }
    })

    if (!result) return
    // Tell the dashboards first: a hiccup in the pipeline step below must never hide a new chat.
    // Content-free on purpose: agents may only see their own chats, so the socket tells
    // clients "something changed here" and each one refetches via the permission-checked API.
    this.emit('crm:message', {
      conversationId: result.conversation.id,
      contactId: result.contact.id,
      assignedTo: result.conversation.assigned_to ?? null,
      newContact: result.created,
    })
    // Place a brand-new contact on the board immediately (reconcile would do it within a minute).
    if (result.created || !result.contact.stage_id) {
      try {
        await this.pipeline?.evaluateContact(result.contact.id)
      } catch (err) {
        this.logger.warn({ err: err?.message, contactId: result.contact.id }, 'Could not place the new WhatsApp contact on the pipeline board yet')
      }
    }
    // The bot answers last, after the message is safely stored and agents have been notified.
    // It never throws; on any doubt it hands the chat to a person.
    await this.bot?.handleInbound({
      conversationId: result.conversation.id,
      message: { wamid: msg.wamid, type: msg.type, body: msg.body, timestamp: msg.timestamp, interactiveType: msg.interactive?.type ?? null },
    })
  }

  /** @returns {Promise<boolean>} false when the message is not stored (yet) */
  async handleStatus(st) {
    const mapped = mapMetaStatus(st.status)
    if (!mapped) return true // e.g. "deleted" — nothing to do

    // Billing facts ride on delivery statuses; keep them even when the status itself is a repeat or goes backwards.
    await this.repo.recordPricing(st.wamid, normalizePricing(st.pricing))

    const applied = await this.repo.withTransaction(async (client) => {
      const row = await this.repo.getOutboundByWamidForUpdate(st.wamid, client)
      if (!row) return { found: false }
      if (!canTransition(row.status, mapped)) return { found: true, changed: false }

      const message = await this.repo.applyStatus(row.id, mapped, st.timestamp, st.error, client)
      return { found: true, changed: true, row, message }
    })

    if (!applied.found) return false
    if (!applied.changed) return true

    if (mapped === 'FAILED' && st.error?.code === META_CODE.USER_OPTED_OUT_MARKETING) {
      await this.repo.setMarketingConsent(applied.row.contact_id, 'OPTED_OUT')
    }

    // A cart-reminder template that Meta later refused to deliver may be replaced by a normal message.
    if (mapped === 'FAILED' && this.workflows) {
      await this.workflows.onTemplateFailed(applied.row.id, { code: st.error?.code ?? null }).catch(() => {})
    }

    this.emit('crm:status', {
      conversationId: applied.row.conversation_id,
      messageId: applied.row.id,
      status: mapped,
    })
    return true
  }
}
