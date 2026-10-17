import { BusinessError } from '../../utils/business-error.js'
import { istDate } from '../../utils/business-period.js'
import { emitInTx } from '../../utils/audit-log.js'
import { withTransaction } from './procurement.repository.js'
import { SOURCES, checkTransition, normalizeRequirement, planFor } from './requirements.rules.js'

/**
 * B2B requirements: requests that arrive outside the app (WhatsApp, calls, walk-ins) become records the purchase
 * plan can read. Nothing here moves stock; delivery still goes through the existing order / procurement paths.
 */
export class RequirementsService {
  constructor({ repo, distribution = null, now = () => new Date() }) {
    Object.assign(this, { repo, distribution, now })
  }

  #shape(r, items = [], held = []) {
    return {
      id: r.id, reqNo: Number(r.req_no), customerName: r.customer_name, customerPhone: r.customer_phone,
      business: r.business_account_id ? { id: r.business_account_id, name: r.business_name } : null,
      conversationId: r.wa_conversation_id, source: r.source, sourceLabel: SOURCES[r.source]?.label ?? r.source, status: r.status,
      order: r.order_id ? { id: r.order_id, number: r.order_number } : null,
      deliveryDate: r.delivery_date, paymentTerms: r.payment_terms, note: r.note, createdAt: r.created_at, createdBy: r.created_by_name,
      items: items.map((i) => ({ productId: i.product_id, name: i.product_name, unit: i.unit, imageUrl: i.image_url, quantity: i.quantity, unitPrice: i.unit_price === null ? null : Number(i.unit_price), held: held.find((h) => h.product_id === i.product_id)?.qty ?? 0 })),
    }
  }

  async list(q) {
    const limit = Math.min(Math.max(Number(q.limit) || 30, 1), 100)
    const offset = Math.max(Number(q.offset) || 0, 0)
    const { rows, total } = await this.repo.list({ ...q, limit, offset })
    const ids = rows.map((r) => r.id)
    const [items, held] = await Promise.all([this.repo.itemsFor(ids), this.distribution ? this.distribution.repo.reservationsForRequests(ids) : []])
    return { items: rows.map((r) => this.#shape(r, items.filter((i) => i.requirement_id === r.id), held.filter((h) => h.requirement_id === r.id))), total, limit, offset }
  }

  async detail(id) {
    const r = await this.repo.byId(id)
    if (!r) throw new BusinessError('Requirement not found.', 404, 'REQUIREMENT_NOT_FOUND')
    const [items, events, held] = await Promise.all([this.repo.itemsFor([id]), this.repo.events(id), this.distribution ? this.distribution.repo.reservationsForRequests([id]) : []])
    return { ...this.#shape(r, items, held), history: events.map((e) => ({ kind: e.kind, detail: e.detail, by: e.actor_name, at: e.created_at })) }
  }

  async create(input, actorId) {
    const n = normalizeRequirement(input, { today: istDate(this.now()) })
    const found = await this.repo.productsExist(n.items.map((i) => i.productId))
    if (n.items.some((i) => !found.has(i.productId))) throw new BusinessError('One of the products no longer exists.', 404, 'PRODUCT_NOT_FOUND')
    let businessAccountId = null
    if (input.businessAccountId) {
      const acc = await this.repo.businessAccount(input.businessAccountId)
      if (!acc) throw new BusinessError('Business account not found.', 404, 'ACCOUNT_NOT_FOUND')
      businessAccountId = acc.id
    }
    let waConversationId = null
    if (input.waConversationId) {
      if (!(await this.repo.conversation(input.waConversationId))) throw new BusinessError('That chat no longer exists.', 404, 'CONVERSATION_NOT_FOUND')
      waConversationId = input.waConversationId
    }
    const id = await withTransaction(async (client) => {
      const newId = await this.repo.insert(client, { ...n, businessAccountId, waConversationId }, actorId)
      await this.repo.logEvent(client, newId, actorId, 'CREATED', { source: n.source, status: n.status, lines: n.items.length })
      await emitInTx(client, 'b2b.requirement.create', { actor_user_id: actorId, actor_role: 'ADMIN', target_type: 'b2b_requirement', target_id: newId, after: { source: n.source, customer: n.customerName, items: n.items } })
      return newId
    })
    return this.detail(id)
  }

  async setStatus(id, to, actorId) {
    await withTransaction(async (client) => {
      const r = await this.repo.lock(client, id)
      if (!r) throw new BusinessError('Requirement not found.', 404, 'REQUIREMENT_NOT_FOUND')
      checkTransition(r.status, to)
      await this.repo.setStatus(client, id, to)
      // Held stock follows the request: delivered → it leaves once; cancelled / back to Maybe → it is freed.
      if (this.distribution && (to === 'DELIVERED' || to === 'CANCELLED' || to === 'INQUIRY')) {
        const info = await this.repo.byId(id, client)
        await this.distribution.settleForRequest(client, id, to, { userId: actorId }, `${info?.customer_name ?? 'customer'} (request #${info?.req_no})`)
      }
      await this.repo.logEvent(client, id, actorId, to, { from: r.status })
      await emitInTx(client, 'b2b.requirement.status', { actor_user_id: actorId, actor_role: 'ADMIN', target_type: 'b2b_requirement', target_id: id, before: { status: r.status }, after: { status: to } })
    })
    return this.detail(id)
  }

  customers(search = '') { return this.repo.customers(String(search).trim().slice(0, 60)) }

  async prefill(conversationId) {
    const c = await this.repo.conversation(conversationId)
    if (!c) throw new BusinessError('That chat no longer exists.', 404, 'CONVERSATION_NOT_FOUND')
    return {
      conversationId: c.id, customerName: c.company_name || c.profile_name || '', customerPhone: c.phone || c.wa_id || '',
      businessAccountId: c.business_account_id ?? null, source: 'WHATSAPP_META',
    }
  }

  /** The purchase plan: one row per product somebody needs, with how much is still missing. */
  async plan() {
    const rows = (await this.repo.planRows()).map((r) => ({
      productId: r.product_id, name: r.name, unit: r.unit, imageUrl: r.image_url, firstDue: r.first_due,
      appOrders: r.app_orders, confirmed: r.confirmed, storeStock: r.store_stock, centralStock: r.central_stock,
      lastPrice: r.last_price === null ? null : Number(r.last_price), lastVendor: r.last_vendor,
      ...planFor({ confirmed: r.confirmed, appOrders: r.app_orders, inquiry: r.inquiry, shopLow: r.shop_low, storeStock: r.store_stock, centralStock: r.central_stock, incoming: r.incoming }),
    }))
    const order = { BUY: 0, WATCH: 1, OK: 2 }
    rows.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name))
    return {
      items: rows,
      totals: { toBuyProducts: rows.filter((r) => r.status === 'BUY').length, committedProducts: rows.filter((r) => r.committed > 0).length, inquiryProducts: rows.filter((r) => r.projected > 0).length },
      note: 'Customer promises = confirmed requests + app orders waiting for approval (app orders only take stock once approved, so nothing is counted twice). "Have" = stock in stores + bought stock not yet sent to a store. "On the way" = ordered but not arrived, or still owed by a supplier.',
    }
  }
}
