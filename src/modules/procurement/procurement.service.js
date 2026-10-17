import { BusinessError } from '../../utils/business-error.js'
import { istDate, money, parsePeriod } from '../../utils/business-period.js'
import { emitInTx } from '../../utils/audit-log.js'
import { invalidateCatalogCaches } from '../catalog-bulk/catalog-cache.js'
import { withTransaction } from './procurement.repository.js'
import { cleanVendorProfile, maskAccount } from './suppliers.rules.js'
import { ADJUSTMENT_KINDS, REJECT_OUTCOMES, canCancel, checkAdjustment, checkArrival, checkReceipt, checkSplit, entryFigures, isLossKind, normalizeEntry, valueOf } from './procurement.rules.js'

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
  /** UPI and bank details are only shown to people who may manage procurement; the account number is masked anyway. */
  vendorShape(v, canSeePay = false) {
    return {
      id: v.id, name: v.name, phone: v.phone, notes: v.notes, is_active: v.is_active, created_at: v.created_at, entries: v.entries,
      tradeName: v.trade_name, gstin: v.gstin, address: v.address, contactPerson: v.contact_person, paymentTerms: v.payment_terms, creditDays: v.credit_days,
      upiId: canSeePay ? v.upi_id : null, bankName: canSeePay ? v.bank_name : null, bankIfsc: canSeePay ? v.bank_ifsc : null, bankAccountMasked: canSeePay ? maskAccount(v.bank_account_no) : null,
      hasPayDetails: Boolean(v.upi_id || v.bank_account_no),
    }
  }
  async vendors(q = {}, canSeePay = false) { return (await this.repo.vendors({ includeInactive: Boolean(q.includeInactive) })).map((v) => this.vendorShape(v, canSeePay)) }
  async createVendor(input, actorId) {
    const name = String(input.name ?? '').trim()
    if (name.length < 2) throw new BusinessError('Vendor name needs at least 2 letters.', 400, 'VALIDATION', { name: 'Too short' })
    if (await this.repo.vendorByName(name)) throw new BusinessError('A vendor with that name already exists.', 409, 'VENDOR_EXISTS')
    const v = await this.repo.createVendor({ name, phone: input.phone, notes: input.notes, ...cleanVendorProfile(input) }, actorId)
    return this.vendorShape(v, true)
  }
  async updateVendor(id, input) {
    if (input.name !== undefined) {
      const clash = await this.repo.vendorByName(String(input.name).trim())
      if (clash && clash.id !== id) throw new BusinessError('A vendor with that name already exists.', 409, 'VENDOR_EXISTS')
    }
    const v = await this.repo.updateVendor(id, { name: input.name?.trim(), phone: input.phone, notes: input.notes, isActive: input.isActive, ...cleanVendorProfile(input) })
    if (!v) throw new BusinessError('Vendor not found.', 404, 'VENDOR_NOT_FOUND')
    return this.vendorShape(v, true)
  }

  // ─── entries ───
  async createEntry(input, actor) {
    // "On the way" purchases are priced on what was ordered; the counted figures come with the receiving check.
    const ordered = input.ordered === true
    const n = normalizeEntry(ordered ? { ...input, receivedQty: input.expectedQty, damagedQty: 0 } : input, { today: this.today() })
    await this.periods?.assertOpen(n.procuredOn, 'That purchase date')
    const product = await this.repo.product(input.productId)
    if (!product) throw new BusinessError('Product not found.', 404, 'PRODUCT_NOT_FOUND')
    if (input.destinationShopId) {
      const shop = await this.repo.shop(input.destinationShopId)
      if (!shop || !shop.is_active) throw new BusinessError('That store is not active.', 409, 'SHOP_INACTIVE')
    }
    if (input.businessAccountId && !(await this.repo.businessAccount(input.businessAccountId))) throw new BusinessError('Business account not found.', 404, 'ACCOUNT_NOT_FOUND')

    return this.detail(await this.#create(input, n, product, actor, ordered))
  }

  async #create(input, n, product, actor, ordered = false) {
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
        reservationNote: input.reservationNote, createdBy: actor.userId, status: ordered ? 'ORDERED' : 'ACTIVE',
      })
      await this.repo.logEvent(client, id, actor.userId, ordered ? 'ORDERED' : 'CREATED', { received: n.receivedQty, expected: n.expectedQty, damaged: n.damagedQty, unitPrice: n.unitPrice, total: n.purchaseTotal, purpose: n.purpose, vendor: vendor.name })
      await emitInTx(client, 'procurement.entry.create', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: id, after: { productId: input.productId, vendorId: vendor.id, ...n } })
      return id
    })
  }

  figures(e) { return this.#figures(e) }

  #figures(e) {
    const f = entryFigures({ expectedQty: e.expected_qty, receivedQty: e.received_qty, damagedQty: e.damaged_qty }, { allocated: e.allocated, centralAdjusted: e.central_adjusted, reserved: e.reserved, converted: e.converted })
    return { ...f, purchaseTotal: money(e.purchase_total), unitPrice: money(e.unit_price) }
  }

  #shape(e) {
    return {
      id: e.id, entryNo: Number(e.entry_no), product: { id: e.product_id, name: e.product_name, sku: e.product_sku }, vendor: { id: e.vendor_id, name: e.vendor_name },
      unit: e.unit, expectedQty: e.expected_qty, receivedQty: e.received_qty, damagedQty: e.damaged_qty, procuredOn: e.procured_on,
      invoiceRef: e.invoice_ref, receivingNote: e.receiving_note, status: e.status, purpose: e.purpose,
      destination: e.destination_shop_id ? { id: e.destination_shop_id, name: e.destination_name } : null,
      reservedFor: e.purpose === 'B2B_RESERVED' ? { businessAccountId: e.business_account_id, businessName: e.business_name, note: e.reservation_note } : null,
      createdAt: e.created_at, inTransit: e.in_transit, reserved: e.reserved, converted: e.converted, packSize: e.pack_size, packUnit: e.pack_unit, invoiceCount: e.invoice_count, owedQty: e.owed_qty, receivedAt: e.received_at, ...this.#figures(e),
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
    const [allocations, adjustments, events, documents, conversions] = await Promise.all([this.repo.allocations(id), this.repo.adjustments(id), this.repo.events(id), this.repo.documents(id), this.repo.conversions(id)])
    return {
      ...this.#shape(e),
      allocations: allocations.map((a) => ({ id: a.id, shopId: a.shop_id, shopName: a.shop_name, quantity: a.quantity, status: a.status, note: a.note, at: a.created_at, reversedAt: a.reversed_at })),
      adjustments: adjustments.map((a) => ({
        id: a.id, kind: a.kind, label: ADJUSTMENT_KINDS[a.kind].label, quantity: a.quantity, shopId: a.shop_id, shopName: a.shop_name, reason: a.reason, by: a.actor_name, at: a.created_at,
        value: valueOf(a.quantity, a.unit_cost), loss: isLossKind(a.kind),
      })),
      conversions: conversions.map((c) => ({ id: c.id, unitsUsed: c.units_used, gramsUsed: c.grams_used, gramsPacked: c.grams_packed, gramsLost: c.grams_lost, status: c.status, note: c.note, at: c.created_at, reversedAt: c.reversed_at, by: c.actor_name, lines: c.lines })),
      documents: documents.map((d) => ({ id: d.id, kind: d.kind, fileName: d.file_name, mime: d.mime_type, size: d.size_bytes, at: d.created_at })),
      history: events.map((v) => ({ kind: v.kind, detail: v.detail, by: v.actor_name, at: v.created_at })),
    }
  }

  // ─── receiving + quality check ───
  /**
   * Count and check goods that were ordered. Accepted goods become usable stock; rejected goods are thrown away
   * (a loss), sent back or replaced (recovered cost, not a loss). Nothing here touches store stock — that still
   * happens when the manager sends usable goods to stores.
   */
  async receive(entryId, input, actor) {
    await withTransaction(async (client) => {
      const e = await this.repo.lockEntry(client, entryId)
      if (!e) throw new BusinessError('Purchase not found.', 404, 'ENTRY_NOT_FOUND')
      const r = checkReceipt({ status: e.status, expectedQty: e.expected_qty }, input)
      const wasted = r.outcome === 'WASTAGE' ? r.rejectedQty : 0
      await this.repo.markReceived(client, entryId, { receivedQty: r.receivedQty, damagedQty: wasted, owedQty: r.owedQty, note: input.note?.trim() || null, userId: actor.userId })
      if (r.rejectedQty > 0 && r.outcome !== 'WASTAGE') {
        await this.repo.insertAdjustment(client, { entryId, kind: 'VENDOR_RETURN', quantity: r.rejectedQty, shopId: null, movementId: null, unitCost: r.outcome === 'REPLACEMENT' ? 0 : e.unit_price, reason: `Rejected on receiving — ${REJECT_OUTCOMES[r.outcome].label.toLowerCase()}`, actorId: actor.userId })
      }
      const detail = { ordered: e.expected_qty, received: r.receivedQty, accepted: r.accepted, rejected: r.rejectedQty, outcome: r.outcome, short: r.missing, owed: r.owedQty }
      await this.repo.logEvent(client, entryId, actor.userId, 'RECEIVED', detail)
      await emitInTx(client, 'procurement.receive', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: entryId, after: detail })
    })
    return this.detail(entryId)
  }

  /** The supplier brings what it owed (the short part or a replacement). */
  async arrive(entryId, quantity, actor) {
    await withTransaction(async (client) => {
      const e = await this.repo.lockEntry(client, entryId)
      if (!e) throw new BusinessError('Purchase not found.', 404, 'ENTRY_NOT_FOUND')
      const q = checkArrival({ status: e.status, owedQty: e.owed_qty }, quantity)
      await this.repo.addArrival(client, entryId, q)
      await this.repo.logEvent(client, entryId, actor.userId, 'ARRIVED_LATER', { quantity: q, stillOwed: e.owed_qty - q })
      await emitInTx(client, 'procurement.arrive', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: entryId, after: { quantity: q } })
    })
    return this.detail(entryId)
  }

  // ─── split across stores ───
  async allocate(entryId, { allocations, note, updateCostPrice = true, inTransit = false }, actor) {
    const touched = await withTransaction(async (client) => {
      const e = await this.repo.lockEntry(client, entryId)
      if (!e) throw new BusinessError('Purchase not found.', 404, 'ENTRY_NOT_FOUND')
      return this.applySplit(client, e, allocations, { note, updateCostPrice, inTransit }, actor)
    })
    if (!inTransit) await invalidateCatalogCaches({ shopIds: touched.shopIds, productIds: [touched.productId] })
    return this.detail(entryId)
  }

  /** Send stock to stores inside the caller's transaction. `e` is the locked entry with live figures. */
  async applySplit(client, e, allocations, { note, updateCostPrice = true, inTransit = false }, actor) {
    const entryId = e.id
    const fig = this.#figures(e)
    const rows = checkSplit({ available: fig.available, purpose: e.purpose, destinationShopId: e.destination_shop_id, status: e.status }, allocations)
    const out = []
    for (const r of rows) {
      const shop = await this.repo.shop(r.shopId, client)
      if (!shop || !shop.is_active) throw new BusinessError(`${shop?.name ?? 'That store'} is not active.`, 409, 'SHOP_INACTIVE')
      const sp = await this.repo.ensureShopProduct(client, r.shopId, e.product_id)
      if (!sp) throw new BusinessError(`${e.product_name} was removed from ${shop.name}. Add it back first.`, 409, 'PRODUCT_REMOVED_FROM_STORE')
      let movement = null
      if (!inTransit) {
        try {
          movement = await this.repo.applyStock(client, {
            shopProductId: sp.id, delta: r.quantity, type: 'PROCUREMENT_RECEIPT', reason: `Procurement #${e.entry_no} (${e.vendor_name})`,
            actor: { userId: actor.userId }, metadata: { procurementEntryId: e.id, entryNo: Number(e.entry_no) },
          })
        } catch (err) { throw this.#stockError(err) }
        if (updateCostPrice) await this.repo.setCostPrice(client, sp.id, e.unit_price)
      }
      const allocId = await this.repo.insertAllocation(client, { entryId, shopId: r.shopId, shopProductId: sp.id, quantity: r.quantity, movementId: movement?.id ?? null, note, actorId: actor.userId, inTransit })
      out.push({ allocationId: allocId, shopId: r.shopId, shopName: shop.name, quantity: r.quantity })
    }
    await this.repo.logEvent(client, entryId, actor.userId, inTransit ? 'DISPATCHED' : 'ALLOCATED', { split: out.map((o) => ({ shop: o.shopName, quantity: o.quantity })), updateCostPrice, inTransit })
    await emitInTx(client, 'procurement.allocate', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: entryId, after: { split: out } })
    return { shopIds: out.map((o) => o.shopId), productId: e.product_id }
  }

  // ─── transfers "on the way": received by the store ───
  async transfers() {
    const rows = await this.repo.transitList()
    return rows.map((r) => ({ id: r.id, quantity: r.quantity, sentAt: r.created_at, note: r.note, entryId: r.entry_id, entryNo: Number(r.entry_no), product: r.product_name, vendor: r.vendor_name, shop: r.shop_name, by: r.actor_name }))
  }

  /**
   * The store confirms what actually arrived. That is the moment the stock becomes saleable there. If less arrived than
   * was sent, the missing units are written off as lost on the way (valued at cost); more than was sent is refused.
   */
  async receiveTransfer(allocationId, { receivedQty, note }, actor) {
    const info = await withTransaction(async (client) => {
      const peek = await this.repo.allocationFull(client, allocationId)
      if (!peek) throw new BusinessError('Transfer not found.', 404, 'ALLOCATION_NOT_FOUND')
      const e = await this.repo.lockEntry(client, peek.entry_id)
      const a = await this.repo.allocationFull(client, allocationId)
      if (a.status !== 'IN_TRANSIT') throw new BusinessError(a.status === 'APPLIED' ? 'That transfer was already received.' : 'That transfer is not on the way.', 409, 'NOT_IN_TRANSIT')
      const got = Number(receivedQty)
      if (!Number.isInteger(got) || got < 1) throw new BusinessError('Say how many arrived (at least 1). If nothing arrived, cancel the transfer.', 400, 'VALIDATION', { receivedQty: 'Invalid' })
      if (got > a.quantity) throw new BusinessError(`Only ${a.quantity} was sent, so ${got} cannot arrive.`, 409, 'MORE_THAN_SENT', { sent: a.quantity })
      let movement
      try {
        movement = await this.repo.applyStock(client, {
          shopProductId: a.shop_product_id, delta: got, type: 'PROCUREMENT_RECEIPT', reason: `Procurement #${e.entry_no} (${e.vendor_name}) — received at the store`,
          actor: { userId: actor.userId }, metadata: { procurementEntryId: e.id, entryNo: Number(e.entry_no), allocationId },
        })
      } catch (err) { throw this.#stockError(err) }
      await this.repo.setCostPrice(client, a.shop_product_id, e.unit_price)
      await this.repo.markTransferReceived(client, allocationId, { quantity: got, movementId: movement.id, userId: actor.userId })
      const lost = a.quantity - got
      if (lost > 0) {
        await this.repo.insertAdjustment(client, { entryId: e.id, kind: 'WASTAGE', quantity: lost, shopId: null, movementId: null, unitCost: e.unit_price, reason: `Lost on the way to ${a.shop_name}${note ? ` — ${note}` : ''}`.slice(0, 300), actorId: actor.userId })
      }
      await this.repo.logEvent(client, e.id, actor.userId, 'TRANSFER_RECEIVED', { shop: a.shop_name, sent: a.quantity, received: got, lost })
      await emitInTx(client, 'procurement.transfer.receive', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: e.id, after: { allocationId, sent: a.quantity, received: got, lost } })
      return { entryId: e.id, shopId: a.shop_id, productId: e.product_id }
    })
    await invalidateCatalogCaches({ shopIds: [info.shopId], productIds: [info.productId] })
    return this.detail(info.entryId)
  }

  /** A transfer that never left: its units are free again. */
  async cancelTransfer(allocationId, actor) {
    const entryId = await withTransaction(async (client) => {
      const peek = await this.repo.allocationFull(client, allocationId)
      if (!peek) throw new BusinessError('Transfer not found.', 404, 'ALLOCATION_NOT_FOUND')
      const e = await this.repo.lockEntry(client, peek.entry_id)
      const a = await this.repo.allocationFull(client, allocationId)
      if (a.status !== 'IN_TRANSIT') throw new BusinessError('That transfer is not on the way.', 409, 'NOT_IN_TRANSIT')
      await this.repo.markCancelled(client, allocationId, actor.userId)
      await this.repo.logEvent(client, e.id, actor.userId, 'TRANSFER_CANCELLED', { shop: a.shop_name, quantity: a.quantity })
      await emitInTx(client, 'procurement.transfer.cancel', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: e.id, after: { allocationId, quantity: a.quantity } })
      return e.id
    })
    return this.detail(entryId)
  }

  async reverseAllocation(allocationId, actor) {
    const info = await withTransaction(async (client) => {
      const peek = await client.query(`SELECT entry_id FROM procurement_allocations WHERE id = $1`, [allocationId])
      if (!peek.rows[0]) throw new BusinessError('Allocation not found.', 404, 'ALLOCATION_NOT_FOUND')
      const e = await this.repo.lockEntry(client, peek.rows[0].entry_id)
      const a = await this.repo.allocation(client, allocationId)
      if (a.status === 'IN_TRANSIT') throw new BusinessError('That transfer is still on the way. Cancel it instead.', 409, 'STILL_IN_TRANSIT')
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
      await this.periods?.assertOpen(e.procured_on, 'This purchase')
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
