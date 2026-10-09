import { describeHours, extractPincode, findMatchingRule, friendlyName, renderTemplate } from './bot.js'
import { describeLastOrderLocalized, detectLanguage, localizeHours, matchArea, matchProduct, pickText, pincodeResult } from './bot-language.js'
import { MetaApiError } from './meta-client.js'

const STALE_MS = 10 * 60 * 1000
/** Longer than this is a pitch, a pasted document or an essay, not a customer question: a person reads it, no auto-reply. */
const MAX_BOT_TEXT = 350

const AND = { en: ' & ', gu: ' અને ', gl: ' ane ' }
const OUR_AREAS = { en: 'our service areas', gu: 'અમારા સેવા વિસ્તારો', gl: 'amara seva vistar' }
const PRODUCT_TEXT = {
  have: { en: 'Yes, we have:', gu: 'હા, અમારી પાસે છે:', gl: 'Ha, amari pase chhe:' },
  priceNote: { en: "(today's price, it can change)", gu: '(આજનો ભાવ, બદલાઈ શકે છે)', gl: '(aajno bhav, badlai shake chhe)' },
  unsure: {
    en: 'I could not find that in our list right now. A team member will check and reply here shortly.',
    gu: 'હાલ અમારી યાદીમાં મને તે મળ્યું નથી. અમારી ટીમ તપાસીને અહીં જવાબ આપશે.',
    gl: 'Haal amari yadi ma mane te malyu nathi. Amari team check kari ne ahi jawab aapshe.',
  },
}
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

    if (msg.type === 'sticker' || msg.interactiveType === 'nfm_reply') return { outcome: 'IGNORED' } // a form answer is not a question for the bot
    const text = (msg.body ?? '').trim()
    if (!TEXT_TYPES.has(msg.type) || !text) {
      return this._handoff(conv, settings, msg, { reason: 'MEDIA', outcome: 'MEDIA', ack: true, lang: conv.bot_language })
    }
    if (text.length > MAX_BOT_TEXT) {
      // Vendor pitches and long messages: stay silent, a person reads it.
      return this._handoff(conv, settings, msg, { reason: 'LONG_TEXT', outcome: 'LONG_TEXT', ack: false })
    }

    if ((await this.botRepo.countBotMessagesSince(conversationId, 60)) >= settings.max_replies_per_hour) {
      return this._handoff(conv, settings, msg, { reason: 'RATE_LIMITED', outcome: 'RATE_LIMITED', ack: false })
    }

    const ctx = await this._context(text, {
      isOpen: await this.isStoreOpen(this.now()),
      previousLanguage: conv.bot_language,
      awaitingArea: await this.botRepo.awaitingArea(conversationId),
    })
    await this._remember(conv, ctx, text)
    const rules = await this.botRepo.listRules()
    const rule = findMatchingRule(rules, text, ctx)

    if (!rule) return this._handoff(conv, settings, msg, { reason: 'NO_MATCH', outcome: 'NO_MATCH', ack: true, lang: ctx.lang })

    // The customer answered "which area?" with a place we do not know: keep their words for the waiting list.
    if (rule.match_type === 'AREA_ASKED') {
      await this.botRepo.rememberCustomer(conv.contact_id, { areaText: cleanForEcho(text, 100) }).catch(() => {})
    }

    if (rule.action === 'IGNORE') {
      await this.botRepo.logEvent({ conversationId, inboundWamid: msg.wamid, ruleId: rule.id, outcome: 'IGNORED', detail: rule.name })
      return { outcome: 'IGNORED', ruleId: rule.id }
    }

    if (rule.cooldown_minutes > 0) {
      const last = await this.botRepo.lastRuleReplyAt(conversationId, rule.id)
      if (last && this.now().getTime() - new Date(last).getTime() < rule.cooldown_minutes * 60000) {
        await this.botRepo.logEvent({ conversationId, inboundWamid: msg.wamid, ruleId: rule.id, outcome: 'SKIPPED_COOLDOWN' })
        return { outcome: 'SKIPPED_COOLDOWN', ruleId: rule.id }
      }
    }

    const { reply, handoff } = await this._buildReply(rule, conv, ctx, settings, text)

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

  /**
   * Everything the rules need to know about one message, worked out once:
   * the customer's language, a delivery area it names, a product word it names, a PIN code.
   */
  async _context(text, { isOpen, previousLanguage = null, awaitingArea = false, forceLanguage = null }) {
    const detected = detectLanguage(text, previousLanguage)
    const areas = await this.botRepo.listAreas()
    const hit = matchArea(text, areas)
    const product = matchProduct(text, await this.botRepo.listProductAliases())
    return {
      isOpen,
      pincode: extractPincode(text),
      lang: forceLanguage ?? detected.lang,
      langConfident: !forceLanguage && detected.confident,
      area: hit?.area ?? null,
      areas,
      awaitingArea,
      product,
    }
  }

  /** Remember language + area on the contact (this is also the "waiting for us" list). Never blocks the reply. */
  async _remember(conv, ctx, text) {
    try {
      const language = ctx.langConfident && ctx.lang !== conv.bot_language ? ctx.lang : null
      const areaId = ctx.area?.id ?? null
      if (language || areaId) await this.botRepo.rememberCustomer(conv.contact_id, { language, areaId })
    } catch (err) {
      this.logger.warn({ err: err.message, contactId: conv.contact_id }, 'Bot could not save the customer language/area')
    }
  }

  /** Builds the reply text and whether the facts demand a person. Shared with the dry-run tester. */
  async _buildReply(rule, conv, ctx, settings, text, { sample = false } = {}) {
    const lang = ctx.lang
    const known = friendlyName(conv?.customer_name, conv?.profile_name)
    const vars = {
      // "Hi there" reads fine in English; in Gujarati an empty name is better than a stray English word.
      customer_name: known === 'there' && lang !== 'en' ? '' : known,
      play_store_link: settings?.play_store_url ?? '',
      app_store_link: settings?.app_store_url ?? '',
      website: settings?.website_url ?? '',
    }
    let handoff = false
    const template = pickText(rule.reply_text ?? '', rule.reply_text_gu, rule.reply_text_gl, lang)
    const uses = (name) => new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'i').test(template)

    if (uses('last_order')) {
      vars.last_order = sample
        ? `${describeLastOrderLocalized({ order_number: 'BK10482', status: 'OUT_FOR_DELIVERY' }, lang)} (sample)`
        : describeLastOrderLocalized(await this.botRepo.lastOrder(conv?.customer_id), lang)
    }
    if (uses('business_hours')) {
      vars.business_hours = localizeHours(describeHours(await this.botRepo.weeklyHours(), this.now()), lang)
    }
    if (uses('area_name') && ctx.area) vars.area_name = lang === 'gu' && ctx.area.name_gu ? ctx.area.name_gu : ctx.area.name
    if (uses('area_text')) vars.area_text = cleanForEcho(text, 60)
    if (uses('served_areas')) {
      const names = (ctx.areas ?? []).filter((a) => a.is_serviceable).map((a) => (lang === 'gu' && a.name_gu ? a.name_gu : a.name))
      vars.served_areas = names.length ? names.join(AND[lang] ?? AND.en) : OUR_AREAS[lang] ?? OUR_AREAS.en
    }
    if (rule.match_type === 'PINCODE' && ctx.pincode) {
      const listed = await this.botRepo.pincodeListed(ctx.pincode)
      vars.pincode_result = pincodeResult(listed, ctx.pincode, lang)
      handoff = !listed
    }
    if (uses('product_info')) {
      const found = ctx.product ? await this.botRepo.findProducts(ctx.product) : []
      if (found.length === 0) {
        // Never claim we have (or lack) something the catalog cannot confirm: say only that a person will check.
        return { reply: PRODUCT_TEXT.unsure[lang] ?? PRODUCT_TEXT.unsure.en, handoff: true }
      } else {
        vars.product_info = describeProducts(found, lang, Boolean(settings?.quote_prices))
      }
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

  async _handoff(conv, settings, msg, { reason, outcome, ack, ruleId = null, lang = null }) {
    await this._pause(conv.id, settings, reason)
    await this.botRepo.logEvent({ conversationId: conv.id, inboundWamid: msg.wamid, ruleId, outcome, detail: reason })
    const fallback = pickText(settings.fallback_text ?? '', settings.fallback_text_gu, settings.fallback_text_gl, lang ?? conv.bot_language ?? 'en')
    if (ack && settings.fallback_enabled && fallback?.trim()) {
      await this._send(conv, fallback.trim(), null, { fullyHandled: false })
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
   * @param {{ language?: 'en'|'gu'|'gl'|null, awaitingArea?: boolean }} [opts] force a language / pretend we just asked for the area
   */
  async test(text, when = 'NOW', { language = null, awaitingArea = false } = {}) {
    const isOpen = when === 'OPEN' ? true : when === 'CLOSED' ? false : await this.isStoreOpen(this.now())
    const settings = await this.botRepo.getSettings()
    const ctx = await this._context(text, { isOpen, awaitingArea, forceLanguage: language })
    const rule = findMatchingRule(await this.botRepo.listRules(), text, ctx)
    const info = { language: ctx.lang, area: ctx.area ? { name: ctx.area.name, serviceable: ctx.area.is_serviceable } : null, product: ctx.product }
    if (!rule) {
      const fallback = pickText(settings?.fallback_text ?? '', settings?.fallback_text_gu, settings?.fallback_text_gl, ctx.lang)
      return { matched: false, isOpen, outcome: 'NO_MATCH', handoff: true, reply: settings?.fallback_enabled ? fallback : null, rule: null, ...info }
    }
    if (rule.action === 'IGNORE') {
      return { matched: true, isOpen, outcome: 'IGNORED', handoff: false, reply: null, rule: { id: rule.id, name: rule.name, action: rule.action }, ...info }
    }
    const { reply, handoff } = await this._buildReply(rule, { customer_name: 'Rahul' }, ctx, settings, text, { sample: true })
    const handsOff = handoff || rule.action === 'REPLY_HANDOFF' || rule.action === 'HANDOFF'
    return { matched: true, isOpen, outcome: handsOff ? 'HANDOFF' : 'REPLIED', handoff: handsOff, reply: reply || null, rule: { id: rule.id, name: rule.name, action: rule.action }, ...info }
  }
}

/** Customer text echoed back in a reply: one line, no WhatsApp formatting characters, bounded. */
function cleanForEcho(text, max) {
  return String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[*_~`<>{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
}

const rupees = (n) => `₹${Number(n) % 1 === 0 ? Number(n) : Number(n).toFixed(2)}`

/** "Yes, we have:" + one bullet per item; prices only when a manager turned price quoting on. */
function describeProducts(items, lang, quotePrices) {
  const lines = items.map((p) => {
    if (!quotePrices) return `• ${p.name}`
    const lo = Number(p.min_price)
    const hi = Number(p.max_price)
    const price = lo === hi ? rupees(lo) : `${rupees(lo)}–${rupees(hi)}`
    return `• ${p.name} – ${price}${p.unit ? `/${p.unit}` : ''}`
  })
  const note = quotePrices ? `\n${PRODUCT_TEXT.priceNote[lang] ?? PRODUCT_TEXT.priceNote.en}` : ''
  return `${PRODUCT_TEXT.have[lang] ?? PRODUCT_TEXT.have.en}\n${lines.join('\n')}${note}`
}
