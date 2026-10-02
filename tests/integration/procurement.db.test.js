/**
 * Procurement (Phase 12). Real Postgres, opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/procurement.db.test.js
 * Uses the REAL stock path (ShopProductsRepository.applyStockChange) so ledger rows are the production ones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PH = (n) => `9999016${String(n).padStart(3, '0')}`

describe.skipIf(!enabled)('Procurement', () => {
  let query, closePool, svc, mgr, shopA, shopB, shopC, tomato, onion, clock
  const actor = () => ({ userId: mgr })

  const mkShop = async (code) => (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ($1,$2,$3,'DB 12','Kolkata','WB','700091',22.5,88.3,true) RETURNING id`, [`T12 Shop ${code}`, `t12-shop-${code}`, code])).rows[0].id
  const mkProduct = async (name, price = 40) => (await query(`INSERT INTO products (name, slug, price, net_quantity) VALUES ($1,$2,$3,'1 kg') RETURNING id`, [name, `t12-${name}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase().replace(/\W+/g, '-'), price])).rows[0].id
  const stockOf = async (shopId, productId) => Number((await query(`SELECT stock_quantity FROM shop_products WHERE shop_id=$1 AND product_id=$2`, [shopId, productId])).rows[0]?.stock_quantity ?? -1)
  const costOf = async (shopId, productId) => (await query(`SELECT cost_price FROM shop_products WHERE shop_id=$1 AND product_id=$2`, [shopId, productId])).rows[0]?.cost_price
  const moves = async (productId) => (await query(`SELECT type, quantity_delta, shop_id FROM stock_movements WHERE product_id=$1 ORDER BY created_at, id`, [productId])).rows
  const buy = (o = {}) => svc.createEntry({ productId: tomato, vendorName: 'T12 Vendor A', expectedQty: 10, unitPrice: 28, ...o }, actor())
  const split = (id, rows, extra = {}) => svc.allocate(id, { allocations: rows.map(([shopId, quantity]) => ({ shopId, quantity })), ...extra }, actor())

  async function cleanup() {
    await query(`DELETE FROM audit_logs WHERE target_type='procurement_entry' AND actor_user_id IN (SELECT id FROM users WHERE phone LIKE '9999016%')`)
    await query(`DELETE FROM orders WHERE order_number LIKE 'T12-%'`)
    await query(`DELETE FROM procurement_adjustments WHERE entry_id IN (SELECT id FROM procurement_entries WHERE product_id IN (SELECT id FROM products WHERE slug LIKE 't12-%'))`)
    await query(`DELETE FROM procurement_allocations WHERE entry_id IN (SELECT id FROM procurement_entries WHERE product_id IN (SELECT id FROM products WHERE slug LIKE 't12-%'))`)
    await query(`DELETE FROM procurement_entries WHERE product_id IN (SELECT id FROM products WHERE slug LIKE 't12-%')`)
    await query(`DELETE FROM stock_movements WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't12-shop-%')`)
    await query(`DELETE FROM shop_products WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't12-shop-%')`)
    await query(`DELETE FROM vendors WHERE name LIKE 'T12 %'`)
    await query(`DELETE FROM products WHERE slug LIKE 't12-%'`)
    await query(`DELETE FROM shops WHERE slug LIKE 't12-shop-%'`)
    await query(`DELETE FROM users WHERE phone LIKE '9999016%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { ProcurementRepository } = await import('../../src/modules/procurement/procurement.repository.js')
    const { ProcurementService } = await import('../../src/modules/procurement/procurement.service.js')
    svc = new ProcurementService({ repo: new ProcurementRepository(), now: () => clock })
  })
  beforeEach(async () => {
    await cleanup()
    clock = new Date()
    mgr = (await query(`INSERT INTO users (phone,name,email,role) VALUES ($1,'T12 Manager',$2,'ADMIN') RETURNING id`, [PH(1), `${PH(1)}@t.local`])).rows[0].id
    shopA = await mkShop('A'); shopB = await mkShop('B'); shopC = await mkShop('C')
    tomato = await mkProduct('Tomato'); onion = await mkProduct('Onion')
  })
  afterAll(async () => { await cleanup(); await closePool() })

  describe('recording a purchase', () => {
    it('10 kg at Rs 28 = Rs 280, vendor created on the fly, history started', async () => {
      const e = await buy()
      expect(e).toMatchObject({ receivedQty: 10, unitPrice: 28, purchaseTotal: 280, available: 10, allocated: 0, status: 'ACTIVE', purpose: 'RETAIL' })
      expect(e.vendor.name).toBe('T12 Vendor A')
      expect(e.history[0].kind).toBe('CREATED')
      const again = await buy({ vendorName: 't12 vendor a' })
      expect(again.vendor.id).toBe(e.vendor.id)
    })
    it('records shortage and damage at the door before anything is distributed', async () => {
      const e = await buy({ receivedQty: 9, damagedQty: 2, receivingNote: 'two crushed' })
      expect(e).toMatchObject({ shortage: 1, usable: 7, available: 7 })
    })
    it('validates the product, the vendor and a dedicated store', async () => {
      await expect(buy({ productId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' })
      await expect(buy({ vendorName: undefined })).rejects.toMatchObject({ code: 'VALIDATION' })
      await expect(buy({ vendorId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'VENDOR_NOT_FOUND' })
      await query(`UPDATE shops SET is_active=false WHERE id=$1`, [shopC])
      await expect(buy({ destinationShopId: shopC })).rejects.toMatchObject({ code: 'SHOP_INACTIVE' })
    })
    it('switched-off vendors cannot be used', async () => {
      const v = await svc.createVendor({ name: 'T12 Old Vendor' }, mgr)
      await svc.updateVendor(v.id, { isActive: false })
      await expect(buy({ vendorId: v.id, vendorName: undefined })).rejects.toMatchObject({ code: 'VENDOR_INACTIVE' })
      await expect(svc.createVendor({ name: 't12 old vendor' }, mgr)).rejects.toMatchObject({ code: 'VENDOR_EXISTS' })
    })
  })

  describe('splitting across stores', () => {
    it('the 4 + 3 + 3 example: stock rises in each store, ledger rows written, cost price follows', async () => {
      const e = await buy()
      const out = await split(e.id, [[shopA, 4], [shopB, 3], [shopC, 3]])
      expect(await stockOf(shopA, tomato)).toBe(4)
      expect(await stockOf(shopB, tomato)).toBe(3)
      expect(await stockOf(shopC, tomato)).toBe(3)
      expect(Number(await costOf(shopA, tomato))).toBe(28)
      expect(out).toMatchObject({ allocated: 10, available: 0 })
      expect((await moves(tomato)).every((m) => m.type === 'PROCUREMENT_RECEIPT')).toBe(true)
      expect(out.allocations).toHaveLength(3)
      const audit = await query(`SELECT action FROM audit_logs WHERE target_id=$1`, [e.id])
      expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['procurement.entry.create', 'procurement.allocate']))
    })
    it('can be done in steps; the remainder is what is left', async () => {
      const e = await buy()
      await split(e.id, [[shopA, 4]])
      const out = await split(e.id, [[shopB, 5]])
      expect(out.available).toBe(1)
      expect(await stockOf(shopA, tomato)).toBe(4)
    })
    it('refuses to send more than is available and changes NOTHING (all or nothing)', async () => {
      const e = await buy({ receivedQty: 10, damagedQty: 2 })
      await expect(split(e.id, [[shopA, 5], [shopB, 4]])).rejects.toMatchObject({ code: 'OVER_ALLOCATION', statusCode: 409 })
      expect(await stockOf(shopA, tomato)).toBe(-1) // no row was even created
      expect(await moves(tomato)).toHaveLength(0)
    })
    it('two simultaneous splits cannot both take the same stock', async () => {
      const e = await buy()
      const results = await Promise.allSettled([split(e.id, [[shopA, 6]]), split(e.id, [[shopB, 6]])])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.find((r) => r.status === 'rejected').reason.code).toBe('OVER_ALLOCATION')
      expect((await svc.detail(e.id)).available).toBe(4)
    })
    it('a dedicated purchase only goes to its own store', async () => {
      const e = await buy({ destinationShopId: shopA })
      expect(e.destination.id).toBe(shopA)
      await expect(split(e.id, [[shopB, 2]])).rejects.toMatchObject({ code: 'DEDICATED_STORE' })
      expect((await split(e.id, [[shopA, 2]])).allocated).toBe(2)
    })
    it('B2B-reserved stock is not sent to retail stores until released', async () => {
      const e = await buy({ purpose: 'B2B_RESERVED', reservationNote: 'Hotel Grand order' })
      expect(e.reservedFor.note).toBe('Hotel Grand order')
      await expect(split(e.id, [[shopA, 2]])).rejects.toMatchObject({ code: 'RESERVED_FOR_B2B' })
      await svc.release(e.id, actor())
      expect((await split(e.id, [[shopA, 2]])).allocated).toBe(2)
    })
    it('can reserve an existing retail purchase (but not a dedicated one)', async () => {
      const e = await buy()
      expect((await svc.reserve(e.id, { note: 'Wedding order' }, actor())).purpose).toBe('B2B_RESERVED')
      await expect(svc.reserve(e.id, {}, actor())).rejects.toMatchObject({ code: 'VALIDATION' })
      const d = await buy({ destinationShopId: shopA })
      await expect(svc.reserve(d.id, { note: 'x' }, actor())).rejects.toMatchObject({ code: 'DEDICATED_STORE' })
    })
    it('re-uses a store row that already carries the product and keeps existing stock', async () => {
      await query(`INSERT INTO shop_products (shop_id, product_id, stock_quantity) VALUES ($1,$2,5)`, [shopA, tomato])
      const e = await buy()
      await split(e.id, [[shopA, 4]])
      expect(await stockOf(shopA, tomato)).toBe(9)
    })
    it('refuses a store that removed the product, and an inactive store', async () => {
      await query(`INSERT INTO shop_products (shop_id, product_id, stock_quantity, deleted_at) VALUES ($1,$2,0,NOW())`, [shopA, tomato])
      const e = await buy()
      await expect(split(e.id, [[shopA, 1]])).rejects.toMatchObject({ code: 'PRODUCT_REMOVED_FROM_STORE' })
      await query(`UPDATE shops SET is_active=false WHERE id=$1`, [shopB])
      await expect(split(e.id, [[shopB, 1]])).rejects.toMatchObject({ code: 'SHOP_INACTIVE' })
    })
    it('can leave the store cost price alone', async () => {
      const e = await buy()
      await split(e.id, [[shopA, 2]], { updateCostPrice: false })
      expect(await costOf(shopA, tomato)).toBeNull()
    })
  })

  describe('reversing a split', () => {
    it('takes the stock back and frees it for another split', async () => {
      const e = await buy()
      const out = await split(e.id, [[shopA, 4]])
      const back = await svc.reverseAllocation(out.allocations[0].id, actor())
      expect(await stockOf(shopA, tomato)).toBe(0)
      expect(back).toMatchObject({ allocated: 0, available: 10 })
      expect(back.allocations[0].status).toBe('REVERSED')
      expect((await moves(tomato)).map((m) => m.type)).toEqual(['PROCUREMENT_RECEIPT', 'PROCUREMENT_REVERSAL'])
      await expect(svc.reverseAllocation(out.allocations[0].id, actor())).rejects.toMatchObject({ code: 'ALREADY_REVERSED' })
    })
    it('refuses once the store has sold part of it', async () => {
      const e = await buy()
      const out = await split(e.id, [[shopA, 4]])
      await query(`UPDATE shop_products SET stock_quantity = 1 WHERE shop_id=$1 AND product_id=$2`, [shopA, tomato])
      await expect(svc.reverseAllocation(out.allocations[0].id, actor())).rejects.toMatchObject({ code: 'STORE_STOCK_TOO_LOW', statusCode: 409 })
      expect((await svc.detail(e.id)).allocated).toBe(4)
    })
    it('refuses when part was already written off at the store', async () => {
      const e = await buy()
      const out = await split(e.id, [[shopA, 4]])
      await svc.adjust(e.id, { kind: 'DAMAGE', quantity: 1, shopId: shopA, reason: 'dropped' }, actor())
      await expect(svc.reverseAllocation(out.allocations[0].id, actor())).rejects.toMatchObject({ code: 'PARTLY_ADJUSTED' })
    })
    it('404 for an unknown allocation', async () => {
      await expect(svc.reverseAllocation('00000000-0000-4000-8000-000000000000', actor())).rejects.toMatchObject({ statusCode: 404 })
    })
  })

  describe('returns, damage and adjustments', () => {
    it('central damage / vendor return reduce what is left to split, not any store', async () => {
      const e = await buy()
      await svc.adjust(e.id, { kind: 'VENDOR_RETURN', quantity: 2, reason: 'wrong grade' }, actor())
      const after = await svc.adjust(e.id, { kind: 'WASTAGE', quantity: 1, reason: 'rotten' }, actor())
      expect(after).toMatchObject({ available: 7 })
      expect(after.adjustments.map((a) => [a.kind, a.loss])).toEqual([['VENDOR_RETURN', false], ['WASTAGE', true]])
      expect(await moves(tomato)).toHaveLength(0)
      await expect(svc.adjust(e.id, { kind: 'DAMAGE', quantity: 8, reason: 'x' }, actor())).rejects.toMatchObject({ code: 'OVER_ADJUSTMENT' })
    })
    it('store-level damage reduces that store’s stock and writes a ledger row', async () => {
      const e = await buy()
      await split(e.id, [[shopA, 5]])
      const after = await svc.adjust(e.id, { kind: 'DAMAGE', quantity: 2, shopId: shopA, reason: 'water leak' }, actor())
      expect(await stockOf(shopA, tomato)).toBe(3)
      expect(after.adjustments[0]).toMatchObject({ shopName: 'T12 Shop A', value: 56, loss: true })
      expect((await moves(tomato)).pop()).toMatchObject({ type: 'DAMAGED_STOCK', quantity_delta: -2 })
      await expect(svc.adjust(e.id, { kind: 'DAMAGE', quantity: 4, shopId: shopA, reason: 'x' }, actor())).rejects.toMatchObject({ code: 'OVER_STORE_QTY' })
    })
    it('refuses a store write-off the store can no longer cover (already sold)', async () => {
      const e = await buy()
      await split(e.id, [[shopA, 5]])
      await query(`UPDATE shop_products SET stock_quantity = 1 WHERE shop_id=$1 AND product_id=$2`, [shopA, tomato])
      await expect(svc.adjust(e.id, { kind: 'DAMAGE', quantity: 2, shopId: shopA, reason: 'x' }, actor())).rejects.toMatchObject({ code: 'STORE_STOCK_TOO_LOW' })
      expect((await svc.detail(e.id)).adjustments).toHaveLength(0)
    })
    it('B2B supply leaves central stock and is not a loss', async () => {
      const e = await buy({ purpose: 'B2B_RESERVED', reservationNote: 'Hotel' })
      const after = await svc.adjust(e.id, { kind: 'B2B_SUPPLY', quantity: 6, reason: 'Order B2B-9' }, actor())
      expect(after.available).toBe(4)
      expect(after.adjustments[0].loss).toBe(false)
    })
    it('needs a reason', async () => {
      const e = await buy()
      await expect(svc.adjust(e.id, { kind: 'DAMAGE', quantity: 1, reason: '  ' }, actor())).rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })

  describe('cancelling', () => {
    it('only an untouched purchase can be cancelled, and it drops out of cost reports', async () => {
      const e = await buy()
      const c = await svc.cancel(e.id, actor())
      expect(c.status).toBe('CANCELLED')
      await expect(split(e.id, [[shopA, 1]])).rejects.toMatchObject({ code: 'ENTRY_CANCELLED' })
      const rep = await svc.vendorReport({ period: 'today' })
      expect(rep.vendors.find((v) => v.name === 'T12 Vendor A')).toBeUndefined()
      const used = await buy()
      await split(used.id, [[shopA, 1]])
      await expect(svc.cancel(used.id, actor())).rejects.toMatchObject({ code: 'ENTRY_IN_USE' })
    })
  })

  describe('reports', () => {
    it('vendor view: quantity, value, average price, shortage, damage, share', async () => {
      await buy()
      await buy({ receivedQty: 8, damagedQty: 1, unitPrice: 30 })
      await buy({ vendorName: 'T12 Vendor B', productId: onion, unitPrice: 10, expectedQty: 20 })
      const rep = await svc.vendorReport({ period: 'today' })
      const a = rep.vendors.find((v) => v.name === 'T12 Vendor A')
      expect(a).toMatchObject({ entries: 2, receivedQty: 18, shortageQty: 2, damagedQty: 1, purchaseValue: 520 })
      expect(a.avgPrice).toBeCloseTo(28.89, 2)
      const b = rep.vendors.find((v) => v.name === 'T12 Vendor B')
      expect(b.purchaseValue).toBe(200)
      expect(a.sharePct + b.sharePct).toBeLessThanOrEqual(100)
      const drill = await svc.vendorReport({ period: 'today', vendorId: a.vendorId })
      expect(drill.products[0]).toMatchObject({ name: 'Tomato', receivedQty: 18, lastUnitPrice: 30 })
    })
    it('reconciliation: procured → allocated → sold → remaining, with cost beside sales value', async () => {
      const cust = (await query(`INSERT INTO users (phone,name,email,role) VALUES ($1,'T12 Cust',$2,'CUSTOMER') RETURNING id`, [PH(2), `${PH(2)}@t.local`])).rows[0].id
      const e = await buy({ receivedQty: 10, damagedQty: 1 })
      await split(e.id, [[shopA, 4], [shopB, 3]])
      await svc.adjust(e.id, { kind: 'WASTAGE', quantity: 1, reason: 'spoiled' }, actor())
      const o = (await query(`INSERT INTO orders (order_number,user_id,shop_id,status,items,subtotal,total_amount,delivery_address,payment_method,payment_status)
        VALUES ('T12-1',$1,$2,'DELIVERED','[]'::jsonb,80,80,'{}'::jsonb,'COD','PAID') RETURNING id`, [cust, shopA])).rows[0].id
      await query(`INSERT INTO order_items (order_id,product_id,name,price,quantity,unit,total,shop_id) VALUES ($1,$2,'Tomato',40,2,'1 kg',80,$3)`, [o, tomato, shopA])
      const cancelled = (await query(`INSERT INTO orders (order_number,user_id,shop_id,status,items,subtotal,total_amount,delivery_address,payment_method,payment_status)
        VALUES ('T12-2',$1,$2,'CANCELLED','[]'::jsonb,40,40,'{}'::jsonb,'COD','PAID') RETURNING id`, [cust, shopA])).rows[0].id
      await query(`INSERT INTO order_items (order_id,product_id,name,price,quantity,unit,total,shop_id) VALUES ($1,$2,'Tomato',40,1,'1 kg',40,$3)`, [cancelled, tomato, shopA])
      await query(`DELETE FROM stock_movements WHERE product_id = $1 AND type='ORDER_DEDUCTION'`, [tomato])
      const rec = await svc.reconciliation({ period: 'today' })
      const p = rec.products.find((x) => x.productId === tomato)
      expect(p).toMatchObject({ received: 10, damagedAtDoor: 1, allocated: 7, centralAdjusted: 1, availableCentral: 1, soldQty: 2, salesValue: 80, purchaseCost: 280, storeStockNow: 7 })
      expect(p.lossValue).toBe(56) // 1 damaged at the door + 1 wasted, 28 each
      const row = rec.entries[0]
      expect(row.perShop.map((s) => s.quantity)).toEqual([4, 3])
      expect(row.centralByKind).toEqual({ WASTAGE: 1 })
      // received = damaged + central adjustments + allocated + still central
      expect(p.received).toBe(p.damagedAtDoor + p.centralAdjusted + p.allocated + p.availableCentral)
    })
    it('reports can be narrowed by product', async () => {
      await buy(); await buy({ productId: onion, unitPrice: 5 })
      const rec = await svc.reconciliation({ period: 'today', productId: onion })
      expect(rec.entries).toHaveLength(1)
    })
  })
})
