import { CrmError } from './errors.js'
import { friendlyName } from './bot.js'
import { canSend } from './template.js'
import { TRIGGERS, cartRef, evaluateConditions, isQuietHoursIST, unfillableKeys, validateWorkflowInput } from './campaign.js'

const SCAN_BATCH = 100

const ORDER_STATUS_WORDS = {
  CONFIRMED: 'confirmed',
  PACKED: 'packed and ready',
  OUT_FOR_DELIVERY: 'out for delivery',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
}

/**
 * WHEN (trigger) / IF (conditions) / DO (actions) automations.
 *
 *   CART_ABANDONED  a cart has been idle for N minutes (default 5) and is still not bought
 *   ORDER_STATUS    an order just became PACKED / OUT_FOR_DELIVERY / DELIVERED / …
 *
 * Nothing here hooks into the orders or cart code: a scan every 30 s claims new events by inserting
 * a wa_workflow_runs row (unique per workflow + event). Whoever inserts the row owns the event, so it
 * fires at most once however many workers run; a crash mid-run is marked INTERRUPTED, never re-sent.
 */
export class WorkflowService {
  /**
   * @param {{ repo: import('./workflow.repository.js').WorkflowRepository,
   *           tplRepo: import('./template.repository.js').TemplateRepository,
   *           sender: import('./automated-sender.js').AutomatedSender,
   *           emit: Function, logger: { info: Function, warn: Function },
   *           appUrl?: string|null, now?: () => Date }} deps
   */
  constructor({ repo, tplRepo, sender, emit, logger, appUrl = null, now = () => new Date() }) {
    Object.assign(this, { repo, tplRepo, sender, emit, logger, now })
    this.appUrl = appUrl ? String(appUrl).replace(/\/+$/, '') : null
  }

  // ─── Builder ───────────────────────────────────────────────────────
  list() {
    return this.repo.list()
  }

  catalog() {
    return {
      triggers: Object.fromEntries(Object.entries(TRIGGERS).map(([k, v]) => [k, { label: v.label, fields: v.fields, tokens: v.tokens }])),
      cartLinkConfigured: Boolean(this.appUrl),
    }
  }

  async get(id) {
    const w = await this.repo.get(id)
    if (!w) throw new CrmError('Workflow not found', 404, 'WORKFLOW_NOT_FOUND')
    return { ...w, runs: await this.repo.recentRuns(id) }
  }

  async create(input, userId) {
    const { errors, value } = validateWorkflowInput(input)
    if (!value) throw new CrmError('Please fix the highlighted fields', 400, 'VALIDATION', errors)
    await this.checkActions(value.triggerType, value.actions, { forActivation: false })
    return this.repo.insert(value, userId)
  }

  async update(id, input) {
    const current = await this.repo.get(id)
    if (!current) throw new CrmError('Workflow not found', 404, 'WORKFLOW_NOT_FOUND')
    // The trigger type cannot change (its conditions and variables would no longer make sense).
    const { errors, value } = validateWorkflowInput({ ...input, triggerType: current.trigger_type }, { partial: true })
    if (!value) throw new CrmError('Please fix the highlighted fields', 400, 'VALIDATION', errors)
    delete value.triggerType
    await this.checkActions(current.trigger_type, value.actions ?? current.actions, { forActivation: current.is_active })
    return this.repo.update(id, value)
  }

  async setActive(id, active) {
    const w = await this.repo.get(id)
    if (!w) throw new CrmError('Workflow not found', 404, 'WORKFLOW_NOT_FOUND')
    if (active) await this.checkActions(w.trigger_type, w.actions, { forActivation: true })
    return this.repo.setActive(id, Boolean(active))
  }

  async remove(id) {
    if (!(await this.repo.remove(id))) throw new CrmError('Workflow not found', 404, 'WORKFLOW_NOT_FOUND')
  }

  /**
   * Every action must be usable: templates exist (and, to switch on, are APPROVED with every variable
   * fillable), labels exist, a coupon is one anybody can redeem.
   */
  async checkActions(triggerType, actions, { forActivation }) {
    const tokenNames = TRIGGERS[triggerType].tokens
    for (const a of actions) {
      if (a.type === 'ADD_LABEL') {
        if (!(await this.repo.labelExists(a.labelId))) throw new CrmError('That label no longer exists.', 400, 'VALIDATION', { actions: 'Label not found' })
        continue
      }
      const tpl = await this.tplRepo.get(a.templateId)
      if (!tpl || tpl.status === 'DELETED') throw new CrmError('That template does not exist.', 400, 'VALIDATION', { actions: 'Template not found' })
      if (forActivation) {
        const gate = canSend(tpl)
        if (!gate.ok) throw new CrmError(`Cannot switch on: ${gate.reason}`, 409, 'TEMPLATE_NOT_SENDABLE')
      }
      const missing = unfillableKeys(tpl, a.values, a.couponId ? tokenNames : tokenNames.filter((t) => t !== 'coupon_code'))
      if (missing.length) throw new CrmError(`Fill in a value for: ${missing.join(', ')}`, 400, 'MISSING_VALUES', { actions: `Fill in a value for: ${missing.join(', ')}` })
      const usesLink = JSON.stringify(a.values ?? {}).includes('cart_link') || this.usesToken(tpl, a, 'cart_link') || this.usesToken(tpl, a, 'cart_ref')
      if (usesLink && !this.appUrl && forActivation) throw new CrmError('The cart link needs CUSTOMER_APP_URL to be set on the server.', 409, 'CART_LINK_NOT_CONFIGURED')
      if (a.couponId && forActivation && !(await this.repo.publicCoupon(a.couponId))) {
        throw new CrmError('That coupon is not active, has expired, or is limited to certain customers. Only coupons anyone can use may be sent automatically.', 409, 'COUPON_UNAVAILABLE')
      }
    }
  }

  usesToken(tpl, action, name) {
    return unfillableKeys(tpl, action.values, []).includes(name) || Object.values(action.values ?? {}).some((v) => String(v).includes(`{{${name}}}`))
  }

  // ─── Scanning (every 30 s) ─────────────────────────────────────────
  async tick() {
    const interrupted = await this.repo.interruptStuckRuns()
    if (interrupted) this.logger.warn({ interrupted }, 'WhatsApp workflow runs interrupted by a stopped worker')

    let handled = 0
    for (const wf of await this.repo.activeByTrigger('CART_ABANDONED')) {
      for (const run of await this.repo.claimDueCarts(wf, SCAN_BATCH)) handled += await this.runSafely(wf, run, 'cart')
    }
    for (const wf of await this.repo.activeByTrigger('ORDER_STATUS')) {
      for (const run of await this.repo.claimDueOrderEvents(wf, SCAN_BATCH)) handled += await this.runSafely(wf, run, 'order')
    }
    return { handled }
  }

  async runSafely(wf, run, kind) {
    try {
      await this.process(wf, run, kind)
      return 1
    } catch (err) {
      this.logger.warn({ err: err.message, workflowId: wf.id, runId: run.id }, 'WhatsApp workflow run failed')
      await this.repo.finishRun(run.id, { status: 'FAILED', reason: 'INTERNAL_ERROR' }).catch(() => {})
      return 1
    }
  }

  async process(wf, run, kind) {
    const ctx = kind === 'cart' ? await this.repo.cartContext(run.subject_id) : await this.repo.orderContext(run.subject_id)
    if (!ctx) return this.repo.finishRun(run.id, { status: 'SKIPPED', reason: 'EVENT_GONE' })
    if (kind === 'cart' && !(await this.repo.cartStillOpen(ctx.id))) return this.repo.finishRun(run.id, { status: 'SKIPPED', reason: 'CART_RECOVERED' })

    const facts = kind === 'cart'
      ? { cart_value: ctx.cart_value, item_count: ctx.item_count, order_count: ctx.order_count }
      : { order_total: ctx.order_total, order_count: ctx.order_count, payment_method: ctx.payment_method }
    if (!evaluateConditions(wf.conditions, facts)) return this.repo.finishRun(run.id, { status: 'SKIPPED', reason: 'CONDITIONS_NOT_MET' })

    const contact = await this.repo.contactForUser(run.user_id)
    if (!contact) return this.repo.finishRun(run.id, { status: 'SKIPPED', reason: 'NO_ADDRESS' })

    const tokens = this.tokensFor(kind, ctx, contact)
    let result = { status: 'SKIPPED', reason: 'NO_MESSAGE_ACTION' }

    for (const action of wf.actions) {
      if (action.type === 'ADD_LABEL') {
        await this.repo.addLabel(contact.id, action.labelId)
        if (result.reason === 'NO_MESSAGE_ACTION') result = { status: 'SENT', reason: 'LABEL_ONLY' }
        continue
      }
      const sent = await this.sendAction(wf, run, kind, ctx, contact, tokens, action)
      if (sent.release) return this.repo.releaseRun(run.id)
      result = sent
      if (sent.status !== 'SENT') break // a message that could not go out ends the run
    }
    await this.repo.finishRun(run.id, { status: result.status, reason: result.reason ?? null, contactId: contact.id, messageId: result.messageId ?? null })
  }

  tokensFor(kind, ctx, contact) {
    const name = friendlyName(ctx.customer_name, contact.profile_name)
    if (kind === 'order') {
      return {
        customer_name: name,
        order_number: ctx.order_number,
        order_total: Math.round(ctx.order_total),
        order_status: ORDER_STATUS_WORDS[ctx.to_status] ?? String(ctx.to_status).toLowerCase().replace(/_/g, ' '),
      }
    }
    const ref = cartRef(ctx.id)
    return {
      customer_name: name,
      cart_value: Math.round(ctx.cart_value),
      item_count: ctx.item_count,
      cart_items: ctx.top_items ?? '',
      ...(this.appUrl ? { cart_link: `${this.appUrl}/cart?utm_source=whatsapp&utm_medium=cart_reminder&wcr=${ref}`, cart_ref: ref } : {}),
    }
  }

  async sendAction(wf, run, kind, ctx, contact, tokens, action) {
    const tpl = await this.tplRepo.get(action.templateId)
    if (!tpl) return { status: 'FAILED', reason: 'TEMPLATE_GONE' }
    if (tpl.meta_category === 'MARKETING' && isQuietHoursIST(this.now())) return { status: 'SKIPPED', reason: 'QUIET_HOURS' }

    const withCoupon = { ...tokens }
    let couponId = null
    if (kind === 'cart' && action.couponId) {
      const coupon = await this.repo.publicCoupon(action.couponId)
      if (!coupon) return { status: 'SKIPPED', reason: 'COUPON_UNAVAILABLE' } // never promise a code that no longer works
      withCoupon.coupon_code = coupon.code
      couponId = coupon.id
    }

    const out = await this.sender.send({ contact, template: tpl, spec: action.values, tokens: withCoupon, workflowId: wf.id })
    switch (out.outcome) {
      case 'SENT':
        if (kind === 'cart') await this.repo.linkCartMessage({ cartId: ctx.id, messageId: out.message.id, runId: run.id, couponId })
        return { status: 'SENT', messageId: out.message.id }
      case 'RETRY':
        return { release: true }
      case 'SKIPPED':
        return { status: 'SKIPPED', reason: out.reason, messageId: out.messageId }
      default:
        return { status: 'FAILED', reason: out.reason, messageId: out.messageId }
    }
  }
}
