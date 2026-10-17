import { BusinessError } from '../../utils/business-error.js'
import { emitInTx } from '../../utils/audit-log.js'
import { invalidateCatalogCaches } from '../catalog-bulk/catalog-cache.js'
import { withTransaction } from './procurement.repository.js'
import { planTotals, suggestDistribution } from './distribution.rules.js'

const whole = (v) => Number.isInteger(v) && v > 0

/**
 * Smart distribution: suggest where a received purchase should go, then apply the manager's confirmed plan in ONE
 * transaction — B2B holds (quantity reservations) and store stock together, so they cannot disagree.
 */
export class DistributionService {
  constructor({ repo, procurement, procRepo }) {
    Object.assign(this, { repo, procurement, procRepo })
  }

  async preview(entryId) {
    const e = await this.procRepo.entry(entryId)
    if (!e) throw new BusinessError('Purchase not found.', 404, 'ENTRY_NOT_FOUND')
    const fig = this.procurement.figures(e)
    const blocked = this.#blocked(e)
    const [reqs, app, shops] = await Promise.all([this.repo.openRequests(e.product_id), this.repo.appDemand(e.product_id), this.repo.shopsCarrying(e.product_id)])
    const requirements = reqs.map((r) => ({ id: r.id, reqNo: Number(r.req_no), customer: r.customer_name, due: r.due, open: Math.max(0, r.asked - r.reserved) }))
    const s = blocked ? { reservations: [], stores: [], keepCentral: fig.available, shortages: { b2b: 0, appOrders: 0, shelves: 0 } } : suggestDistribution(fig.available, {
      requirements, appDemand: app.map((a) => ({ shopId: a.shop_id, qty: a.qty })),
      shops: shops.map((x) => ({ shopId: x.shop_id, name: x.name, stock: x.stock, low: x.low })), onlyShopId: e.destination_shop_id,
    })
    return {
      entry: { id: e.id, entryNo: Number(e.entry_no), product: { id: e.product_id, name: e.product_name }, vendor: e.vendor_name, unit: e.unit, dedicatedTo: e.destination_shop_id ? e.destination_name : null },
      available: fig.available, blocked, requests: requirements, suggestion: { ...s, reservations: s.reservations.map((r) => ({ ...r, reqNo: requirements.find((q) => q.id === r.requirementId)?.reqNo })) },
      note: 'Order of care: customer requests first (held in the warehouse), then app B2B orders to the store that will deliver them, then shelves up to each store’s low-stock line. Whatever is left stays in the warehouse.',
    }
  }

  #blocked(e) {
    if (e.status === 'ORDERED') return 'These goods have not arrived yet.'
    if (e.status === 'CANCELLED') return 'This purchase was cancelled.'
    if (e.purpose === 'B2B_RESERVED') return 'This whole purchase is held for B2B. Release it first.'
    return null
  }

  /** Apply a confirmed plan: reserve for customers, then send to stores. Nothing is applied if any part is wrong. */
  async distribute(entryId, { reservations = [], allocations = [], note }, actor) {
    const reqIds = [...new Set(reservations.map((r) => r.requirementId))]
    if (reservations.length === 0 && allocations.length === 0) throw new BusinessError('Choose where the stock should go.', 400, 'VALIDATION', { plan: 'Empty' })
    if (reservations.some((r) => !whole(r.quantity))) throw new BusinessError('Quantities must be whole numbers of at least 1.', 400, 'VALIDATION', { reservations: 'Invalid' })
    if (reqIds.length !== reservations.length) throw new BusinessError('A request appears twice. Combine its quantities.', 400, 'DUPLICATE_REQUEST')

    const touched = await withTransaction(async (client) => {
      const e = await this.procRepo.lockEntry(client, entryId)
      if (!e) throw new BusinessError('Purchase not found.', 404, 'ENTRY_NOT_FOUND')
      const blocked = this.#blocked(e)
      if (blocked) throw new BusinessError(blocked, 409, 'NOT_DISTRIBUTABLE')
      const fig = this.procurement.figures(e)
      const totals = planTotals({ reservations, allocations: allocations.map((a) => ({ quantity: a.quantity })) })
      if (totals.total > fig.available) throw new BusinessError(`You are sending ${totals.total} but only ${Math.max(0, fig.available)} is free.`, 409, 'OVER_ALLOCATION', { requested: totals.total, available: fig.available })

      if (reservations.length > 0) {
        const locked = await this.repo.lockRequests(client, reqIds)
        const open = new Map((await this.repo.openRequests(e.product_id, client)).map((r) => [r.id, Math.max(0, r.asked - r.reserved)]))
        for (const r of reservations) {
          const row = locked.find((x) => x.id === r.requirementId)
          if (!row) throw new BusinessError('A customer request no longer exists.', 404, 'REQUIREMENT_NOT_FOUND')
          if (row.status !== 'CONFIRMED') throw new BusinessError(`Request #${row.req_no} is not “Sure” any more.`, 409, 'REQUIREMENT_NOT_CONFIRMED')
          const need = open.get(r.requirementId) ?? 0
          if (r.quantity > need) throw new BusinessError(`${row.customer_name} only still needs ${need} of this product.`, 409, 'OVER_RESERVATION', { open: need })
        }
        for (const r of reservations) {
          const id = await this.repo.insertReservation(client, { requirementId: r.requirementId, productId: e.product_id, entryId, quantity: r.quantity, actorId: actor.userId })
          await this.repo.logEntryEvent(client, entryId, actor.userId, 'RESERVED_FOR_REQUEST', { requirementId: r.requirementId, quantity: r.quantity, reservationId: id })
        }
        await emitInTx(client, 'procurement.reserve.qty', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: entryId, after: { reservations } })
      }
      if (allocations.length === 0) return { shopIds: [], productId: e.product_id }
      // Re-read so the stores' share is checked against what is free AFTER the new holds.
      const fresh = await this.procRepo.entry(entryId, client)
      return this.procurement.applySplit(client, fresh, allocations, { note, updateCostPrice: true }, actor)
    })
    if (touched.shopIds.length) await invalidateCatalogCaches({ shopIds: touched.shopIds, productIds: [touched.productId] })
    return this.procurement.detail(entryId)
  }

  async releaseReservation(reservationId, actor) {
    const entryId = await withTransaction(async (client) => {
      const r = await this.repo.reservationById(client, reservationId)
      if (!r) throw new BusinessError('Reservation not found.', 404, 'RESERVATION_NOT_FOUND')
      if (r.status !== 'RESERVED') throw new BusinessError('That hold is already closed.', 409, 'ALREADY_CLOSED')
      await this.repo.closeReservation(client, reservationId, 'RELEASED')
      await this.repo.logEntryEvent(client, r.entry_id, actor.userId, 'RESERVATION_RELEASED', { reservationId, quantity: r.quantity })
      await emitInTx(client, 'procurement.reserve.release', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: r.entry_id, after: { reservationId, quantity: r.quantity } })
      return r.entry_id
    })
    return this.procurement.detail(entryId)
  }

  /** Called inside the request's status transaction. Delivered = the held stock leaves; cancelled/back to Maybe = it is freed. */
  async settleForRequest(client, requirementId, outcome, actor, label) {
    const held = await this.repo.openReservations(client, requirementId)
    for (const h of held) {
      if (outcome === 'DELIVERED') {
        await this.repo.insertSupplyAdjustment(client, { entryId: h.entry_id, quantity: h.quantity, unitCost: h.unit_price, reason: `Delivered to ${label}`, actorId: actor.userId })
        await this.repo.closeReservation(client, h.id, 'FULFILLED')
        await this.repo.logEntryEvent(client, h.entry_id, actor.userId, 'SUPPLIED_TO_B2B', { requirementId, quantity: h.quantity })
      } else {
        await this.repo.closeReservation(client, h.id, 'RELEASED')
        await this.repo.logEntryEvent(client, h.entry_id, actor.userId, 'RESERVATION_RELEASED', { requirementId, quantity: h.quantity, because: outcome })
      }
    }
    return held.reduce((n, h) => n + h.quantity, 0)
  }
}
