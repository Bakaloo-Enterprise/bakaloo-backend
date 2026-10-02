import { BusinessError } from '../../utils/business-error.js'
import { istDate, money, parsePeriod } from '../../utils/business-period.js'
import { emitInTx } from '../../utils/audit-log.js'
import { invalidateCatalogCaches } from '../catalog-bulk/catalog-cache.js'
import { withTransaction } from './procurement.repository.js'
import { ADJUSTMENT_KINDS, canCancel, checkAdjustment, checkSplit, entryFigures, isLossKind, normalizeEntry, valueOf } from './procurement.rules.js'

/**
 * Procurement (Phase 12): what was bought, from whom, at what cost → split across stores → why quantities differ.
 * Store stock only ever changes through ShopProductsRepository.applyStockChange, inside the same transaction as the
 * procurement row, so the stock ledger, the allocation and the audit record cannot disagree.
 */
export class ProcurementService {
  constructor({ repo, now = () => new Date() }) {
    Object.assign(this, { repo, now })
  }

  today() { return istDate(this.now()) }

  // ─── vendors ───
  vendors(q = {}) { return this.repo.vendors({ includeInactive: Boolean(q.includeInactive) }) }
  async createVendor(input, actorId) {
    const name = String(input.name ?? '').trim()
    if (name.length < 2) throw new BusinessError('Vendor name needs at least 2 letters.', 400, 'VALIDATION', { name: 'Too short' })
    if (await this.repo.vendorByName(name)) throw new BusinessError('A vendor with that name already exists.', 409, 'VENDOR_EXISTS')
    return this.repo.createVendor({ ...input, name }, actorId)
  }
  async updateVendor(id, input) {
    if (input.name !== undefined) {
      const clash = await this.repo.vendorByName(String(input.name).trim())
      if (clash && clash.id !== id) throw new BusinessError('A vendor with that name already exists.', 409, 'VENDOR_EXISTS')
    }
    const v = await this.repo.updateVendor(id, { ...input, name: input.name?.trim() })
    if (!v) throw new BusinessError('Vendor not found.', 404, 'VENDOR_NOT_FOUND')
    return v
  }

  // ─── entries ───
  async createEntry(input, actor) {
    const n = normalizeEntry(input, { today: this.today() })
    const product = await this.repo.product(input.productId)
    if (!product) throw new BusinessError('Product not found.', 404, 'PRODUCT_NOT_FOUND')
    if (input.destinationShopId) {
      const shop = await this.repo.shop(input.destinationShopId)
      if (!shop || !shop.is_active) throw new BusinessError('That store is not active.', 409, 'SHOP_INACTIVE')
    }
    if (input.businessAccountId && !(await this.repo.businessAccount(input.businessAccountId))) throw new BusinessError('Business account not found.', 404, 'ACCOUNT_NOT_FOUND')

    return this.detail(await this.#create(input, n, product, actor))
  }

  async #create(input, n, product, actor) {
    return withTransaction(async (client) => {
      let vendor = input.vendorId ? await this.repo.vendorById(input.vendorId, client) : null
      if (input.vendorId && !vendor) throw new BusinessError('Vendor not found.', 404, 'VENDOR_NOT_FOUND')
      if (!vendor && input.vendorName?.trim()) {
        vendor = (await this.repo.vendorByName(input.vendorName.trim(), client)) ?? (await this.repo.createVendor({ name: input.vendorName.trim() }, actor.userId, client))
      }
      if (!vendor) throw new BusinessError('Choose or name a vendor.', 400, 'VALIDATION', { vendorId: 'Required' })
      if (vendor.is_active === false) throw new BusinessError('That vendor is switched off.', 409, 'VENDOR_INACTIVE')
      const id = await this.repo.insertEntry(client, {
        ...n, productId: input.productId, vendorId: vendor.id, unit: input.unit ?? product.net_quantity ?? null, invoiceRef: input.invoiceRef,
        receivingNote: input.receivingNote, destinationShopId: input.destinationShopId, businessAccountId: input.businessAccountId,
        reservationNote: input.reservationNote, createdBy: actor.userId,
      })
      await this.repo.logEvent(client, id, actor.userId, 'CREATED', { received: n.receivedQty, expected: n.expectedQty, damaged: n.damagedQty, unitPrice: n.unitPrice, total: n.purchaseTotal, purpose: n.purpose, vendor: vendor.name })
      await emitInTx(client, 'procurement.entry.create', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: id, after: { productId: input.productId, vendorId: vendor.id, ...n } })
      return id
    })
  }

  #figures(e) {
    const f = entryFigures({ expectedQty: e.expected_qty, receivedQty: e.received_qty, damagedQty: e.damaged_qty }, { allocated: e.allocated, centralAdjusted: e.central_adjusted })
    return { ...f, purchaseTotal: money(e.purchase_total), unitPrice: money(e.unit_price) }
  }

  #shape(e) {
    return {
      id: e.id, entryNo: Number(e.entry_no), product: { id: e.product_id, name: e.product_name, sku: e.product_sku }, vendor: { id: e.vendor_id, name: e.vendor_name },
      unit: e.unit, expectedQty: e.expected_qty, receivedQty: e.received_qty, damagedQty: e.damaged_qty, procuredOn: e.procured_on,
      invoiceRef: e.invoice_ref, receivingNote: e.receiving_note, status: e.status, purpose: e.purpose,
      destination: e.destination_shop_id ? { id: e.destination_shop_id, name: e.destination_name } : null,
      reservedFor: e.purpose === 'B2B_RESERVED' ? { businessAccountId: e.business_account_id, businessName: e.business_name, note: e.reservation_note } : null,
      createdAt: e.created_at, ...this.#figures(e),
    }
  }

  async list(q) {
    const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 100)
    const offset = Math.max(Number(q.offset) || 0, 0)
    const { rows, total } = await this.repo.list({ ...q, limit, offset })
    return { items: rows.map((r) => this.#shape(r)), total, limit, offset }
  }

  async detail(id) {
    const e = await this.repo.entry(id)
    if (!e) throw new BusinessError('Purchase not found.', 404, 'ENTRY_NOT_FOUND')
    const [allocations, adjustments, events] = await Promise.all([this.repo.allocations(id), this.repo.adjustments(id), this.repo.events(id)])
    return {
      ...this.#shape(e),
      allocations: allocations.map((a) => ({ id: a.id, shopId: a.shop_id, shopName: a.shop_name, quantity: a.quantity, status: a.status, note: a.note, at: a.created_at, reversedAt: a.reversed_at })),
      adjustments: adjustments.map((a) => ({
        id: a.id, kind: a.kind, label: ADJUSTMENT_KINDS[a.kind].label, quantity: a.quantity, shopId: a.shop_id, shopName: a.shop_name, reason: a.reason, by: a.actor_name, at: a.created_at,
        value: valueOf(a.quantity, a.unit_cost), loss: isLossKind(a.kind),
      })),
      history: events.map((v) => ({ kind: v.kind, detail: v.detail, by: v.actor_name, at: v.created_at })),
    }
  }

  // ─── split across stores ───
  async allocate(entryId, { allocations, note, updateCostPrice = true }, actor) {
    const touched = await withTransaction(async (client) => {
      const e = await this.repo.lockEntry(client, entryId)
      if (!e) throw new BusinessError('Purchase not found.', 404, 'ENTRY_NOT_FOUND')
      const fig = this.#figures(e)
      const rows = checkSplit({ available: fig.available, purpose: e.purpose, destinationShopId: e.destination_shop_id, status: e.status }, allocations)
      const out = []
      for (const r of rows) {
        const shop = await this.repo.shop(r.shopId, client)
        if (!shop || !shop.is_active) throw new BusinessError(`${shop?.name ?? 'That store'} is not active.`, 409, 'SHOP_INACTIVE')
        const sp = await this.repo.ensureShopProduct(client, r.shopId, e.product_id)
        if (!sp) throw new BusinessError(`${e.product_name} was removed from ${shop.name}. Add it back first.`, 409, 'PRODUCT_REMOVED_FROM_STORE')
        let movement
        try {
          movement = await this.repo.applyStock(client, {
            shopProductId: sp.id, delta: r.quantity, type: 'PROCUREMENT_RECEIPT', reason: `Procurement #${e.entry_no} (${e.vendor_name})`,
            actor: { userId: actor.userId }, metadata: { procurementEntryId: e.id, entryNo: Number(e.entry_no) },
          })
        } catch (err) { throw this.#stockError(err) }
        if (updateCostPrice) await this.repo.setCostPrice(client, sp.id, e.unit_price)
        const allocId = await this.repo.insertAllocation(client, { entryId, shopId: r.shopId, shopProductId: sp.id, quantity: r.quantity, movementId: movement.id, note, actorId: actor.userId })
        out.push({ allocationId: allocId, shopId: r.shopId, shopName: shop.name, quantity: r.quantity })
      }
      await this.repo.logEvent(client, entryId, actor.userId, 'ALLOCATED', { split: out.map((o) => ({ shop: o.shopName, quantity: o.quantity })), updateCostPrice })
      await emitInTx(client, 'procurement.allocate', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: entryId, after: { split: out } })
      return { shopIds: out.map((o) => o.shopId), productId: e.product_id }
    })
    await invalidateCatalogCaches({ shopIds: touched.shopIds, productIds: [touched.productId] })
    return this.detail(entryId)
  }

  async reverseAllocation(allocationId, actor) {
    const info = await withTransaction(async (client) => {
      const peek = await client.query(`SELECT entry_id FROM procurement_allocations WHERE id = $1`, [allocationId])
      if (!peek.rows[0]) throw new BusinessError('Allocation not found.', 404, 'ALLOCATION_NOT_FOUND')
      const e = await this.repo.lockEntry(client, peek.rows[0].entry_id)
      const a = await this.repo.allocation(client, allocationId)
      if (a.status !== 'APPLIED') throw new BusinessError('That allocation was already reversed.', 409, 'ALREADY_REVERSED')
      const taken = await this.repo.shopHeld(client, e.id, a.shop_id)
      if (taken < a.quantity) throw new BusinessError('Part of this stock was already written off at the store. Record an adjustment instead.', 409, 'PARTLY_ADJUSTED')
      let movement
      try {
        movement = await this.repo.applyStock(client, {
          shopProductId: a.shop_product_id, delta: -a.quantity, type: 'PROCUREMENT_REVERSAL', reason: `Reversed procurement #${e.entry_no}`,
          actor: { userId: actor.userId }, metadata: { procurementEntryId: e.id, allocationId },
        })
      } catch (err) { throw this.#stockError(err, 'The store has already sold part of this stock, so it cannot be taken back.') }
      await this.repo.markReversed(client, allocationId, { movementId: movement.id, actorId: actor.userId })
      await this.repo.logEvent(client, e.id, actor.userId, 'ALLOCATION_REVERSED', { shopId: a.shop_id, quantity: a.quantity })
      await emitInTx(client, 'procurement.allocation.reverse', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: e.id, after: { allocationId, quantity: a.quantity } })
      return { entryId: e.id, shopId: a.shop_id, productId: e.product_id }
    })
    await invalidateCatalogCaches({ shopIds: [info.shopId], productIds: [info.productId] })
    return this.detail(info.entryId)
  }

  // ─── returns, damage, adjustments ───
  async adjust(entryId, input, actor) {
    const info = await withTransaction(async (client) => {
      const e = await this.repo.lockEntry(client, entryId)
      if (!e) throw new BusinessError('Purchase not found.', 404, 'ENTRY_NOT_FOUND')
      const shopHeld = input.shopId ? await this.repo.shopHeld(client, entryId, input.shopId) : 0
      const adj = checkAdjustment({ status: e.status }, input, { available: this.#figures(e).available, shopHeld })
      let movementId = null
      if (adj.shopId) {
        const spId = await this.repo.shopProductFor(client, adj.shopId, e.product_id)
        if (!spId) throw new BusinessError('That store no longer carries this product.', 409, 'PRODUCT_REMOVED_FROM_STORE')
        try {
          const m = await this.repo.applyStock(client, {
            shopProductId: spId, delta: -adj.quantity, type: ADJUSTMENT_KINDS[adj.kind].stockType, reason: `${ADJUSTMENT_KINDS[adj.kind].label}: ${adj.reason}`.slice(0, 500),
            actor: { userId: actor.userId }, metadata: { procurementEntryId: e.id, kind: adj.kind, fromProcurement: true },
          })
          movementId = m.id
        } catch (err) { throw this.#stockError(err, 'The store no longer holds that much — part of it has been sold.') }
      }
      const id = await this.repo.insertAdjustment(client, { entryId, kind: adj.kind, quantity: adj.quantity, shopId: adj.shopId, movementId, unitCost: e.unit_price, reason: adj.reason, actorId: actor.userId })
      await this.repo.logEvent(client, entryId, actor.userId, 'ADJUSTED', { kind: adj.kind, quantity: adj.quantity, shopId: adj.shopId, reason: adj.reason })
      await emitInTx(client, 'procurement.adjust', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: entryId, after: { adjustmentId: id, ...adj } })
      return { shopId: adj.shopId, productId: e.product_id }
    })
    if (info.shopId) await invalidateCatalogCaches({ shopIds: [info.shopId], productIds: [info.productId] })
    return this.detail(entryId)
  }

  // ─── reservation, cancel ───
  async reserve(entryId, { businessAccountId, note }, actor) {
    if (!businessAccountId && !String(note ?? '').trim()) throw new BusinessError('Say which business account (or note) this stock is reserved for.', 400, 'VALIDATION', { businessAccountId: 'Required' })
    if (businessAccountId && !(await this.repo.businessAccount(businessAccountId))) throw new BusinessError('Business account not found.', 404, 'ACCOUNT_NOT_FOUND')
    await withTransaction(async (client) => {
      const e = await this.repo.lockEntry(client, entryId)
      if (!e) throw new BusinessError('Purchase not found.', 404, 'ENTRY_NOT_FOUND')
      if (e.status !== 'ACTIVE') throw new BusinessError('This purchase was cancelled.', 409, 'ENTRY_CANCELLED')
      if (e.destination_shop_id) throw new BusinessError('A purchase dedicated to one store cannot be reserved for B2B.', 409, 'DEDICATED_STORE')
      await this.repo.setPurpose(client, entryId, { purpose: 'B2B_RESERVED', businessAccountId, reservationNote: note?.trim() || null })
      await this.repo.logEvent(client, entryId, actor.userId, 'RESERVED', { businessAccountId, note })
      await emitInTx(client, 'procurement.reserve', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: entryId, after: { businessAccountId, note } })
    })
    return this.detail(entryId)
  }

  async release(entryId, actor) {
    await withTransaction(async (client) => {
      const e = await this.repo.lockEntry(client, entryId)
      if (!e) throw new BusinessError('Purchase not found.', 404, 'ENTRY_NOT_FOUND')
      if (e.purpose !== 'B2B_RESERVED') throw new BusinessError('This stock is not reserved.', 409, 'NOT_RESERVED')
      await this.repo.setPurpose(client, entryId, { purpose: 'RETAIL' })
      await this.repo.logEvent(client, entryId, actor.userId, 'RELEASED', {})
      await emitInTx(client, 'procurement.release', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: entryId, after: {} })
    })
    return this.detail(entryId)
  }

  async cancel(entryId, actor) {
    await withTransaction(async (client) => {
      const e = await this.repo.lockEntry(client, entryId)
      if (!e) throw new BusinessError('Purchase not found.', 404, 'ENTRY_NOT_FOUND')
      if (e.status === 'CANCELLED') throw new BusinessError('Already cancelled.', 409, 'ENTRY_CANCELLED')
      if (!canCancel(await this.repo.counts(client, entryId))) throw new BusinessError('Stock from this purchase was already used. Record a vendor return or adjustment instead.', 409, 'ENTRY_IN_USE')
      await this.repo.setStatus(client, entryId, 'CANCELLED')
      await this.repo.logEvent(client, entryId, actor.userId, 'CANCELLED', {})
      await emitInTx(client, 'procurement.cancel', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: entryId, after: {} })
    })
    return this.detail(entryId)
  }

  // ─── reports ───
  async vendorReport(q) {
    const p = parsePeriod(q, this.now())
    const rows = await this.repo.vendorSummary({ start: p.from, end: p.to })
    const vendors = rows.map((r) => ({
      vendorId: r.vendor_id, name: r.vendor_name, entries: r.entries, products: r.products, receivedQty: r.received_qty, shortageQty: r.shortage_qty, damagedQty: r.damaged_qty,
      purchaseValue: money(r.purchase_value), avgPrice: r.received_qty > 0 ? money(Number(r.purchase_value) / r.received_qty) : null,
    }))
    const totalValue = vendors.reduce((n, v) => n + v.purchaseValue, 0)
    const out = { range: { period: p.period, from: p.from, to: p.to }, totalValue: money(totalValue), vendors: vendors.map((v) => ({ ...v, sharePct: totalValue > 0 ? Math.round((v.purchaseValue / totalValue) * 1000) / 10 : null })) }
    if (q.vendorId) {
      const prods = await this.repo.vendorProducts({ start: p.from, end: p.to, vendorId: q.vendorId })
      out.products = prods.map((r) => ({ productId: r.product_id, name: r.product_name, receivedQty: r.received_qty, damagedQty: r.damaged_qty, purchaseValue: money(r.purchase_value), avgPrice: r.received_qty > 0 ? money(Number(r.purchase_value) / r.received_qty) : null, lastUnitPrice: money(r.last_unit_price) }))
    }
    return out
  }

  /** Procured → allocated → sold → remaining → returned / damaged / adjusted, with purchase cost beside sales value. */
  async reconciliation(q) {
    const p = parsePeriod(q, this.now())
    const entries = await this.repo.reconciliationEntries({ start: p.from, end: p.to, productId: q.productId, vendorId: q.vendorId })
    const productIds = [...new Set(entries.map((e) => e.product_id))]
    const sold = new Map((await this.repo.salesAndStock({ productIds, from: p.start, to: p.end })).map((r) => [r.product_id, r]))
    const rows = entries.map((e) => {
      const f = this.#figures(e)
      const loss = (kinds) => Object.entries(kinds).filter(([k]) => isLossKind(k)).reduce((n, [, qty]) => n + valueOf(qty, e.unit_price), 0)
      return {
        ...this.#shape(e), perShop: e.per_shop, centralByKind: e.central_by_kind, storeByKind: e.store_by_kind,
        lossValue: money(loss(e.central_by_kind) + loss(e.store_by_kind)),
        damagedAtDoorValue: valueOf(e.damaged_qty, e.unit_price), figures: f,
      }
    })
    const byProduct = new Map()
    for (const r of rows) {
      const cur = byProduct.get(r.product.id) ?? { productId: r.product.id, name: r.product.name, received: 0, damagedAtDoor: 0, shortage: 0, allocated: 0, centralAdjusted: 0, storeAdjusted: 0, availableCentral: 0, purchaseCost: 0, lossValue: 0 }
      cur.received += r.receivedQty; cur.damagedAtDoor += r.damagedQty; cur.shortage += r.shortage; cur.allocated += r.allocated; cur.centralAdjusted += r.centralAdjusted
      cur.storeAdjusted += Object.values(r.storeByKind).reduce((n, v) => n + v, 0); cur.availableCentral += r.available
      cur.purchaseCost += r.purchaseTotal; cur.lossValue += r.lossValue + r.damagedAtDoorValue
      byProduct.set(r.product.id, cur)
    }
    const products = [...byProduct.values()].map((c) => {
      const s = sold.get(c.productId)
      return { ...c, purchaseCost: money(c.purchaseCost), lossValue: money(c.lossValue), soldQty: s?.sold_qty ?? 0, salesValue: money(s?.sales_value ?? 0), storeStockNow: s?.store_stock_now ?? 0 }
    })
    return {
      range: { period: p.period, from: p.from, to: p.to },
      note: 'Sold and "in stores now" are counted per product across all stores (stock is not tracked per purchase batch), so read them beside the totals rather than as a per-batch figure.',
      entries: rows, products,
    }
  }

  #stockError(err, friendly) {
    if (err?.code === 'STOCK_NEGATIVE_FORBIDDEN') return new BusinessError(friendly ?? 'The store would end up with negative stock.', 409, 'STORE_STOCK_TOO_LOW')
    return err
  }
}
