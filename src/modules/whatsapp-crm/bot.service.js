import { describeHours, describeLastOrder, extractPincode, findMatchingRule, friendlyName, renderTemplate } from './bot.js'
import { MetaApiError } from './meta-client.js'

const STALE_MS = 10 * 60 * 1000
/** Message types the bot can read as text. Everything else is a human's job (except stickers, ignored). */
const TEXT_TYPES = new Set(['text', 'button', 'interactive'])

/**
 * The auto-reply bot. Rule-based, no AI. Decides, sends, and ALWAYS fails safe:
 * any doubt or error hands the conversation to a human instead of staying silent
 * or guessing. Never throws into the webhook pipeline.
 */
export class BotService {
  /**
   * @param {{ botRepo: import('./bot.repository.js').BotRepository,
   *           repo: import('./whatsapp.repository.js').WhatsappRepository,
   *           client: { sendText: Function },
   *           isStoreOpen: (at?: Date) => Promise<boolean>,
   *           emit: (e: string, p: object) => void,
   *           logger: { info: Function, warn: Function },
   *           now?: () => Date }} deps
   */
  constructor({ botRepo, repo, client, isStoreOpen, emit, logger, now = () => new Date() }) {
    this.botRepo = botRepo
    this.repo = repo
    this.client = client
    this.isStoreOpen = isStoreOpen
    this.emit = emit
    this.logger = logger
    this.now = now
  }

  /**
   * Called once per NEWLY STORED inbound message (Meta retries never reach here twice).
   * @param {{ conversationId: string, message: { wamid: string, type: string, body: string|null, timestamp: Date } }} input
   */
  async handleInbound({ conversationId, message }) {
    try {
      return await this._handle(conversationId, message)
    } catch (err) {
      this.logger.warn({ err: err.message, conversationId }, 'Bot failed; leaving the chat for a person')
      await this._safeHandoff(conversationId, 'ERROR')
      return { outcome: 'ERROR' }
    }
  }

  async _handle(conversationId, msg) {
    const settings = await this.botRepo.getSettings()
    if (!settings?.enabled) return { outcome: 'DISABLED' }

    let conv = await this.repo.getConversation(conversationId)
    if (!conv) return { outcome: 'GONE' }

    if (conv.bot_state === 'HUMAN') {
      const until = conv.bot_paused_until ? new Date(conv.bot_paused_until) : null
      if (!until || until > this.now()) return { outcome: 'HUMAN' }
      await this.botRepo.setBotState(conversationId, 'BOT') // quiet period over: bot is back
    }

    if (this.now().getTime() - new Date(msg.timestamp).getTime() > STALE_MS) {
      await this.botRepo.logEvent({ conversationId, inboundWamid: msg.wamid, outcome: 'SKIPPED_STALE', detail: 'message older than 10 minutes' })
      return { outcome: 'SKIPPED_STALE' }
    }

    if (msg.type === 'sticker') return { outcome: 'IGNORED' }
    const text = (msg.body ?? '').trim()
    if (!TEXT_TYPES.has(msg.type) || !text) {
      return this._handoff(conv, settings, msg, { reason: 'MEDIA', outcome: 'MEDIA', ack: true })
    }

    if ((await this.botRepo.countBotMessagesSince(conversationId, 60)) >= settings.max_replies_per_hour) {
      return this._handoff(conv, settings, msg, { reason: 'RATE_LIMITED', outcome: 'RATE_LIMITED', ack: false })
    }

    const isOpen = await this.isStoreOpen(this.now())
    const pincode = extractPincode(text)
    const rules = await this.botRepo.listRules()
    const rule = findMatchingRule(rules, text, { isOpen, pincode })

    if (!rule) return this._handoff(conv, settings, msg, { reason: 'NO_MATCH', outcome: 'NO_MATCH', ack: true })

    if (rule.cooldown_minutes > 0) {
      const last = await this.botRepo.lastRuleReplyAt(conversationId, rule.id)
      if (last && this.now().getTime() - new Date(last).getTime() < rule.cooldown_minutes * 60000) {
        await this.botRepo.logEvent({ conversationId, inboundWamid: msg.wamid, ruleId: rule.id, outcome: 'SKIPPED_COOLDOWN' })
        return { outcome: 'SKIPPED_COOLDOWN', ruleId: rule.id }
      }
    }

    const { reply, handoff } = await this._buildReply(rule, conv, pincode)

    if (rule.action === 'OPT_OUT') await this.botRepo.setMarketingConsent(conv.contact_id, 'OPTED_OUT')
    if (rule.action === 'OPT_IN') await this.botRepo.setMarketingConsent(conv.contact_id, 'OPTED_IN')

    const wantsHandoff = handoff || rule.action === 'REPLY_HANDOFF' || rule.action === 'HANDOFF'

    if (reply) {
      const sent = await this._send(conv, reply, rule.id, { fullyHandled: !wantsHandoff })
      if (!sent) return this._handoff(conv, settings, msg, { reason: 'SEND_FAILED', outcome: 'SEND_FAILED', ack: false, ruleId: rule.id })
    }

    if (wantsHandoff) {
      await this._pause(conv.id, settings, 'REQUESTED')
      await this.botRepo.logEvent({ conversationId, inboundWamid: msg.wamid, ruleId: rule.id, outcome: 'HANDOFF', detail: rule.name })
      this.emit('crm:conversation', { conversationIds: [conv.id] })
      return { outcome: 'HANDOFF', ruleId: rule.id, replied: Boolean(reply) }
    }

    await this.botRepo.logEvent({ conversationId, inboundWamid: msg.wamid, ruleId: rule.id, outcome: 'REPLIED', detail: rule.name })
    return { outcome: 'REPLIED', ruleId: rule.id }
  }

  /** Builds the reply text and whether the facts demand a person. Shared with the dry-run tester. */
  async _buildReply(rule, conv, pincode, { sample = false } = {}) {
    const vars = { customer_name: friendlyName(conv?.customer_name, conv?.profile_name) }
    let handoff = false
    const template = rule.reply_text ?? ''

    if (/\{\{\s*last_order\s*\}\}/i.test(template)) {
      vars.last_order = sample ? 'Your latest order BK10482 is out for delivery. (sample)' : describeLastOrder(await this.botRepo.lastOrder(conv?.customer_id))
    }
    if (/\{\{\s*business_hours\s*\}\}/i.test(template)) {
      vars.business_hours = describeHours(await this.botRepo.weeklyHours(), this.now())
    }
    if (rule.match_type === 'PINCODE' && pincode) {
      const listed = await this.botRepo.pincodeListed(pincode)
      vars.pincode_result = listed
        ? `Good news! We deliver to ${pincode}.`
        : `I could not confirm delivery to ${pincode} automatically. A team member will check and reply here shortly.`
      handoff = !listed
    }
    const reply = rule.action === 'HANDOFF' && !template.trim() ? '' : renderTemplate(template, vars)
    return { reply, handoff }
  }

  async _send(conv, text, ruleId, { fullyHandled }) {
    const queued = await this.repo.insertOutboundQueued({ conversationId: conv.id, contactId: conv.contact_id, type: 'text', body: text, isBot: true, botRuleId: ruleId })
    try {
      const { wamid } = await this.client.sendText({ to: conv.wa_id, bsuid: conv.bsuid, body: text })
      await this.repo.markOutboundSent(queued.id, wamid)
    } catch (err) {
      const meta = err instanceof MetaApiError ? err : new MetaApiError(err?.message ?? 'Send failed')
      await this.repo.markOutboundFailed(queued.id, meta)
      this.logger.warn({ conversationId: conv.id, code: meta.code }, 'Bot reply failed to send')
      this.emit('crm:message', { conversationId: conv.id, contactId: conv.contact_id, assignedTo: conv.assigned_to ?? null })
      return false
    }
    // A chat the bot fully handled looks answered and read; a handed-off one keeps waiting for a person.
    await this.repo.bumpConversationForOutbound(conv.id, text.slice(0, 200), null, { keepAwaiting: !fullyHandled })
    if (fullyHandled) await this.botRepo.markConversationReadAndAnswered(conv.id)
    this.emit('crm:message', { conversationId: conv.id, contactId: conv.contact_id, assignedTo: conv.assigned_to ?? null })
    return true
  }

  async _pause(conversationId, settings, reason) {
    const until = new Date(this.now().getTime() + settings.human_pause_minutes * 60000)
    await this.botRepo.setBotState(conversationId, 'HUMAN', { pausedUntil: until, reason })
  }

  async _handoff(conv, settings, msg, { reason, outcome, ack, ruleId = null }) {
    await this._pause(conv.id, settings, reason)
    await this.botRepo.logEvent({ conversationId: conv.id, inboundWamid: msg.wamid, ruleId, outcome, detail: reason })
    if (ack && settings.fallback_enabled && settings.fallback_text?.trim()) {
      await this._send(conv, settings.fallback_text.trim(), null, { fullyHandled: false })
    }
    this.emit('crm:conversation', { conversationIds: [conv.id] })
    return { outcome, handedOff: true }
  }

  async _safeHandoff(conversationId, reason) {
    try {
      const settings = await this.botRepo.getSettings()
      if (settings) await this._pause(conversationId, settings, reason)
    } catch {
      // nothing more we can do; the chat is unread and visible to agents either way
    }
  }

  // ─── Called by other parts of the CRM ─────────────────────────────

  /** An agent replied: the bot steps back for the quiet period. Never throws. */
  async onAgentReply(conversationId) {
    try {
      const settings = await this.botRepo.getSettings()
      if (settings) await this._pause(conversationId, settings, 'AGENT_REPLIED')
    } catch (err) {
      this.logger.warn({ err: err.message, conversationId }, 'Could not pause the bot after an agent reply')
    }
  }

  async setState(conversationId, state) {
    if (state === 'BOT') await this.botRepo.setBotState(conversationId, 'BOT')
    else await this._pause(conversationId, await this.botRepo.getSettings(), 'MANUAL')
    this.emit('crm:conversation', { conversationIds: [conversationId] })
  }

  /**
   * Dry run for the "try a message" box: which rule would answer, and with what.
   * Sends nothing, changes nothing. Order/customer facts are clearly-marked samples.
   * @param {string} text
   * @param {'NOW'|'OPEN'|'CLOSED'} when
   */
  async test(text, when = 'NOW') {
    const isOpen = when === 'OPEN' ? true : when === 'CLOSED' ? false : await this.isStoreOpen(this.now())
    const pincode = extractPincode(text)
    const rule = findMatchingRule(await this.botRepo.listRules(), text, { isOpen, pincode })
    if (!rule) {
      const s = await this.botRepo.getSettings()
      return { matched: false, isOpen, outcome: 'NO_MATCH', handoff: true, reply: s?.fallback_enabled ? s.fallback_text : null, rule: null }
    }
    const { reply, handoff } = await this._buildReply(rule, { customer_name: 'Rahul' }, pincode, { sample: true })
    const handsOff = handoff || rule.action === 'REPLY_HANDOFF' || rule.action === 'HANDOFF'
    return { matched: true, isOpen, outcome: handsOff ? 'HANDOFF' : 'REPLIED', handoff: handsOff, reply: reply || null, rule: { id: rule.id, name: rule.name, action: rule.action } }
  }
}
