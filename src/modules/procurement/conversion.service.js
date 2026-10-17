import { BusinessError } from '../../utils/business-error.js'
import { emitInTx } from '../../utils/audit-log.js'
import { invalidateCatalogCaches } from '../catalog-bulk/catalog-cache.js'
import { withTransaction } from './procurement.repository.js'
import { checkPackSize, formatAmount, planRepack } from './repack.rules.js'

/**
 * Repacking: a bulk purchase (say 50 kg of potatoes) becomes the pack sizes we sell (500 g, 1 kg…), sent straight to stores.
 * Grams in = grams out + a recorded loss. Stock stays whole units; stock only moves through applyStockChange, in one transaction.
 */
export class ConversionService {
  constructor({ procRepo, procurement }) {
    Object.assign(this, { procRepo, procurement })
  }

  async setPackSize(productId, input) {
    const v = checkPackSize({ size: Number(input.size), unit: input.unit })
    const p = await this.procRepo.setPackSize(productId, v)
    if (!p) throw new BusinessError('Product not found.', 404, 'PRODUCT_NOT_FOUND')
    return { id: p.id, name: p.name, packSize: p.pack_size, packUnit: p.pack_unit, label: formatAmount(p.pack_size, p.pack_unit) }
  }

  /** What can be made from this purchase: its free units and the other pack sizes in the same product family. */
  async preview(entryId) {
    const e = await this.procRepo.entry(entryId)
    if (!e) throw new BusinessError('Purchase not found.', 404, 'ENTRY_NOT_FOUND')
    const fig = this.procurement.figures(e)
    const blocked = this.#blocked(e)
    const [packs, history] = await Promise.all([e.product_family_id ? this.procRepo.familyPacks(e.product_id, e.product_family_id) : [], this.procRepo.conversions(entryId)])
    const perGram = e.pack_size ? Number(e.unit_price) / e.pack_size : null
    return {
      entry: { id: e.id, entryNo: Number(e.entry_no), product: { id: e.product_id, name: e.product_name }, vendor: e.vendor_name, price: Number(e.unit_price), dedicatedShopId: e.destination_shop_id },
      available: fig.available, unitSize: e.pack_size, unit: e.pack_unit, unitLabel: e.pack_size ? formatAmount(e.pack_size, e.pack_unit) : null, familyId: e.product_family_id, blocked,
      costPerGram: perGram === null ? null : Math.round(perGram * 100000) / 100000,
      history: history.map((c) => ({ id: c.id, unitsUsed: c.units_used, gramsUsed: c.grams_used, gramsPacked: c.grams_packed, gramsLost: c.grams_lost, status: c.status, at: c.created_at, by: c.actor_name, lines: c.lines })),
      targets: packs.map((p) => ({ productId: p.id, name: p.name, optionLabel: p.option_label, imageUrl: p.thumbnail_url, packSize: p.pack_size, packUnit: p.pack_unit, label: p.pack_size ? formatAmount(p.pack_size, p.pack_unit) : null, cost: perGram !== null && p.pack_size && p.pack_unit === e.pack_unit ? Math.round(perGram * p.pack_size * 100) / 100 : null })),
    }
  }

  #blocked(e) {
    if (e.status === 'ORDERED') return 'These goods have not arrived yet.'
    if (e.status === 'CANCELLED') return 'This purchase was cancelled.'
    if (e.purpose === 'B2B_RESERVED') return 'This whole purchase is held for B2B. Release it first.'
    if (!e.product_family_id) return 'This product has no other pack sizes. Group it with its 500 g / 1 kg versions in a product family first.'
    return null
  }

  async convert(entryId, { unitsUsed, lines, note }, actor) {
    const touched = await withTransaction(async (client) => {
      const e = await this.procRepo.lockEntry(client, entryId)
      if (!e) throw new BusinessError('Purchase not found.', 404, 'ENTRY_NOT_FOUND')
      const blocked = this.#blocked(e)
      if (blocked) throw new BusinessError(blocked, 409, 'NOT_CONVERTIBLE')
      if (!e.pack_size) throw new BusinessError('Say how big one unit of this purchase is first (for example 1 kg).', 409, 'NO_PACK_SIZE')
      const fig = this.procurement.figures(e)
      const prods = new Map((await this.procRepo.packProducts([...new Set((lines ?? []).map((l) => l.productId))], client)).map((p) => [p.id, p]))
      const clean = (lines ?? []).map((l) => {
        const p = prods.get(l.productId)
        if (!p || p.is_active === false) throw new BusinessError('One of the packs no longer exists.', 404, 'PRODUCT_NOT_FOUND')
        if (p.id === e.product_id) throw new BusinessError('A purchase cannot be repacked into itself.', 400, 'SAME_PRODUCT')
        if (!p.product_family_id || p.product_family_id !== e.product_family_id) throw new BusinessError(`${p.name} is not a pack size of ${e.product_name}.`, 409, 'NOT_SAME_FAMILY')
        if (e.destination_shop_id && l.shopId !== e.destination_shop_id) throw new BusinessError('This purchase is dedicated to one store and cannot be sent to another.', 409, 'DEDICATED_STORE')
        return { shopId: l.shopId, productId: p.id, name: p.name, packs: l.packs, packSize: p.pack_size, packUnit: p.pack_unit }
      })
      const plan = planRepack({ unitSize: e.pack_size, unit: e.pack_unit, price: Number(e.unit_price), available: fig.available }, { unitsUsed, lines: clean })
      const conversionId = await this.procRepo.insertConversion(client, { entryId, unitsUsed, unitSize: e.pack_size, gramsUsed: plan.gramsUsed, gramsPacked: plan.gramsPacked, gramsLost: plan.gramsLost, note: note?.trim() || null, actorId: actor.userId })
      const shopIds = new Set()
      for (const l of plan.lines) {
        const shop = await this.procRepo.shop(l.shopId, client)
        if (!shop || !shop.is_active) throw new BusinessError(`${shop?.name ?? 'That store'} is not active.`, 409, 'SHOP_INACTIVE')
        const sp = await this.procRepo.ensureShopProduct(client, l.shopId, l.productId)
        if (!sp) throw new BusinessError(`${l.name} was removed from ${shop.name}. Add it back first.`, 409, 'PRODUCT_REMOVED_FROM_STORE')
        const movement = await this.procRepo.applyStock(client, {
          shopProductId: sp.id, delta: l.packs, type: 'PROCUREMENT_RECEIPT', reason: `Repacked from procurement #${e.entry_no} (${e.vendor_name})`,
          actor: { userId: actor.userId }, metadata: { procurementEntryId: e.id, entryNo: Number(e.entry_no), conversionId, unitCost: l.unitCost, packSize: l.packSize },
        })
        await this.procRepo.setCostPrice(client, sp.id, Math.round(l.unitCost * 100) / 100)
        await this.procRepo.insertConversionLine(client, { conversionId, shopId: l.shopId, productId: l.productId, shopProductId: sp.id, packs: l.packs, packSize: l.packSize, unitCost: l.unitCost, movementId: movement.id })
        shopIds.add(l.shopId)
      }
      const detail = { unitsUsed, gramsUsed: plan.gramsUsed, gramsPacked: plan.gramsPacked, gramsLost: plan.gramsLost, packs: plan.lines.map((l) => ({ product: l.name, packs: l.packs })) }
      await this.procRepo.logEvent(client, entryId, actor.userId, 'REPACKED', detail)
      await emitInTx(client, 'procurement.repack', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: entryId, after: { conversionId, ...detail } })
      return { shopIds: [...shopIds], productIds: [e.product_id, ...plan.lines.map((l) => l.productId)] }
    })
    await invalidateCatalogCaches({ shopIds: touched.shopIds, productIds: touched.productIds })
    return this.procurement.detail(entryId)
  }

  /** Undo a repack: possible only while every pack is still on the shelf (nothing sold). The bulk units become free again. */
  async reverse(conversionId, actor) {
    const info = await withTransaction(async (client) => {
      const c = await this.procRepo.conversionForUpdate(client, conversionId)
      if (!c) throw new BusinessError('Repack not found.', 404, 'CONVERSION_NOT_FOUND')
      if (c.status !== 'APPLIED') throw new BusinessError('That repack was already undone.', 409, 'ALREADY_REVERSED')
      const e = await this.procRepo.lockEntry(client, c.entry_id)
      const lines = await this.procRepo.conversionLines(client, conversionId)
      const shops = []
      for (const l of lines) {
        try {
          const m = await this.procRepo.applyStock(client, {
            shopProductId: l.shop_product_id, delta: -l.packs, type: 'PROCUREMENT_REVERSAL', reason: `Undid repack of procurement #${e.entry_no}`,
            actor: { userId: actor.userId }, metadata: { procurementEntryId: e.id, conversionId },
          })
          await this.procRepo.setLineReversal(client, l.id, m.id)
        } catch (err) {
          if (err?.code === 'STOCK_NEGATIVE_FORBIDDEN') throw new BusinessError(`Some ${l.product_name} packs were already sold, so this repack cannot be undone.`, 409, 'PACKS_ALREADY_SOLD')
          throw err
        }
        shops.push(l.shop_id)
      }
      await this.procRepo.markConversionReversed(client, conversionId, actor.userId)
      await this.procRepo.logEvent(client, e.id, actor.userId, 'REPACK_UNDONE', { conversionId })
      await emitInTx(client, 'procurement.repack.reverse', { actor_user_id: actor.userId, actor_role: 'ADMIN', target_type: 'procurement_entry', target_id: e.id, after: { conversionId } })
      return { entryId: e.id, shopIds: shops, productIds: [e.product_id, ...lines.map((l) => l.product_id)] }
    })
    await invalidateCatalogCaches({ shopIds: info.shopIds, productIds: info.productIds })
    return this.procurement.detail(info.entryId)
  }
}
