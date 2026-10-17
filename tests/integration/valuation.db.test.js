import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Profit, stock value and month closing, against a real database (opt-in):
 *   MONEY_DB_TEST=1 npx vitest run --no-file-parallelism tests/integration/valuation.db.test.js
 * One story, told through the real services, with every figure worked out by hand:
 *   buy 20 @30 (2 thrown away at the door) and 10 @36; send 10+10 to store A (average cost 33);
 *   sell 5 to a home customer at 50 and 3 to a business at the agreed 40; 2 damaged on the shelf;
 *   deliver 3 straight from the warehouse hold to a business request priced at 45.
 */
const RUN = process.env.MONEY_DB_TEST === '1'
const d = RUN ? describe : describe.skip

d('profit, stock value and month closing (real DB)', () => {
  const tag = `zzv${Date.now().toString(36)}`
  const S = {}
  let q, getClient

  beforeAll(async () => {
    const imp = (p) => import(`../../src/${p}`)
    ;({ query: q, getClient } = await imp('config/database.js'))
    const { ProcurementService } = await imp('modules/procurement/procurement.service.js')
    const { ProcurementRepository } = await imp('modules/procurement/procurement.repository.js')
    const { SuppliersService } = await imp('modules/procurement/suppliers.service.js')
    const { DistributionService } = await imp('modules/procurement/distribution.service.js')
    const { DistributionRepository } = await imp('modules/procurement/distribution.repository.js')
    const { RequirementsService } = await imp('modules/procurement/requirements.service.js')
    const { RequirementsRepository } = await imp('modules/procurement/requirements.repository.js')
    const { MonthlyService } = await imp('modules/procurement/monthly.service.js')
    const { MonthlyRepository } = await imp('modules/procurement/monthly.repository.js')
    const { ValuationService } = await imp('modules/procurement/valuation.service.js')
    const { ValuationRepository } = await imp('modules/procurement/valuation.repository.js')
    const { PeriodsService } = await imp('modules/procurement/periods.service.js')
    const { PeriodsRepository } = await imp('modules/procurement/periods.repository.js')
    const { AdminOrdersRepository } = await imp('modules/admin/orders/orders.repository.js')
    const { AdminOrdersService } = await imp('modules/admin/orders/orders.service.js')
    const { ShopProductsRepository } = await imp('modules/shop-products/shop-products.repository.js')
    const rep = new ProcurementRepository()
    S.proc = new ProcurementService({ repo: rep })
    S.sup = new SuppliersService({ repo: rep, procurement: S.proc })
    S.dist = new DistributionService({ repo: new DistributionRepository(), procurement: S.proc, procRepo: rep })
    S.reqs = new RequirementsService({ repo: new RequirementsRepository(), distribution: S.dist })
    S.pr = new PeriodsRepository()
    S.monthly = new MonthlyService({ repo: new MonthlyRepository(), valuation: new ValuationService({ repo: new ValuationRepository() }), periods: S.pr })
    S.periods = new PeriodsService({ repo: S.pr, monthly: S.monthly })
    S.proc.periods = S.periods
    S.sup.periods = S.periods
    S.orders = new AdminOrdersService(new AdminOrdersRepository(), { io: { to: () => ({ emit() {} }), emit() {} } })
    S.stock = new ShopProductsRepository()
    S.admin = (await q(`SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`)).rows[0].id
    S.cust = (await q(`SELECT id FROM users WHERE role = 'CUSTOMER' LIMIT 1`)).rows[0].id
    S.a = { userId: S.admin }
    const shop = (n) => q(`INSERT INTO shops (name, slug, branch_code, is_active, address_line1, city, state, pincode, lat, lng) VALUES ($1,$2,$3,true,'1 Rd','K','WB','700001',22.5,88.3) RETURNING id`, [`${tag} ${n}`, `${tag}-${n}`, `${tag}${n}`.slice(0, 20)]).then((r) => r.rows[0].id)
    S.A = await shop('a')
    S.p = (await q(`INSERT INTO products (name, slug, price, sale_price, stock_quantity) VALUES ($1,$2,60,50,0) RETURNING id`, [`${tag} potato`, `${tag}-potato`])).rows[0].id
    await q(`INSERT INTO shop_products (shop_id, product_id, stock_quantity, low_stock_threshold) VALUES ($1,$2,0,0)`, [S.A, S.p])
    S.spA = (await q(`SELECT id FROM shop_products WHERE shop_id=$1 AND product_id=$2`, [S.A, S.p])).rows[0].id
    const vendor = await S.proc.createVendor({ name: `${tag} vendor` }, S.admin)
    let e1 = await S.proc.createEntry({ productId: S.p, vendorId: vendor.id, expectedQty: 20, unitPrice: 30, ordered: true }, S.a)
    e1 = await S.proc.receive(e1.id, { receivedQty: 20, rejectedQty: 2, outcome: 'WASTAGE' }, S.a)
    await S.proc.allocate(e1.id, { allocations: [{ shopId: S.A, quantity: 10 }] }, S.a)
    let e2 = await S.proc.createEntry({ productId: S.p, vendorId: vendor.id, expectedQty: 10, unitPrice: 36, ordered: true }, S.a)
    e2 = await S.proc.receive(e2.id, { receivedQty: 10, rejectedQty: 0 }, S.a)
    await S.proc.allocate(e2.id, { allocations: [{ shopId: S.A, quantity: 10 }] }, S.a)
    S.vendor = vendor
    await S.orders.createManualOrder({ userId: S.cust, shopId: S.A, items: [{ productId: S.p, quantity: 5 }], paymentMethod: 'COD', deliveryAddress: { city: 'K' } }, S.admin, 'ip')
    await S.orders.createManualOrder({ userId: S.cust, shopId: S.A, orderType: 'B2B', items: [{ productId: S.p, quantity: 3, unitPrice: 40 }], deliveryAddress: { city: 'K' } }, S.admin, 'ip')
    const c = await getClient()
    await c.query('BEGIN')
    await S.stock.applyStockChange(c, { shopProductId: S.spA, delta: -2, type: 'DAMAGED_STOCK', source: 'DASHBOARD', reason: 'dropped', actor: { userId: S.admin } })
    await c.query('COMMIT')
    c.release()
    const rq = await S.reqs.create({ customerName: `${tag} biryani`, source: 'PHONE_CALL', confirmed: true, items: [{ productId: S.p, quantity: 3, unitPrice: 45 }] }, S.admin)
    await S.dist.distribute(e1.id, { reservations: [{ requirementId: rq.id, quantity: 3 }] }, S.a)
    await S.reqs.setStatus(rq.id, 'DELIVERED', S.admin)
  })

  afterAll(async () => {
    if (!RUN || !S.p) return
    const shops = [S.A]
    const orderIds = (await q(`SELECT id FROM orders WHERE shop_id = ANY($1::uuid[])`, [shops])).rows.map((r) => r.id)
    await q(`DELETE FROM period_stock_snapshots`)
    await q(`DELETE FROM accounting_periods`)
    await q(`DELETE FROM accounting_period_log`)
    await q(`DELETE FROM b2b_reservations WHERE product_id = $1`, [S.p])
    await q(`DELETE FROM b2b_requirement_events WHERE requirement_id IN (SELECT requirement_id FROM b2b_requirement_items WHERE product_id = $1)`, [S.p])
    await q(`DELETE FROM b2b_requirements WHERE id IN (SELECT requirement_id FROM b2b_requirement_items WHERE product_id = $1)`, [S.p])
    await q(`DELETE FROM order_b2b_settlements WHERE order_id = ANY($1::uuid[])`, [orderIds])
    await q(`DELETE FROM order_status_history WHERE order_id = ANY($1::uuid[])`, [orderIds])
    await q(`DELETE FROM stock_movements WHERE shop_product_id IN (SELECT id FROM shop_products WHERE product_id = $1)`, [S.p])
    await q(`DELETE FROM order_items WHERE order_id = ANY($1::uuid[])`, [orderIds])
    await q(`DELETE FROM orders WHERE id = ANY($1::uuid[])`, [orderIds])
    const entries = `SELECT id FROM procurement_entries WHERE product_id = $1`
    await q(`DELETE FROM procurement_allocations WHERE entry_id IN (${entries})`, [S.p])
    await q(`DELETE FROM procurement_events WHERE entry_id IN (${entries})`, [S.p])
    await q(`DELETE FROM procurement_adjustments WHERE entry_id IN (${entries})`, [S.p])
    await q(`DELETE FROM vendor_payments WHERE vendor_id = $1`, [S.vendor.id])
    await q(`DELETE FROM procurement_entries WHERE product_id = $1`, [S.p])
    await q(`DELETE FROM shop_products WHERE product_id = $1`, [S.p])
    await q(`DELETE FROM vendors WHERE id = $1`, [S.vendor.id])
    await q(`DELETE FROM products WHERE id = $1`, [S.p])
    await q(`DELETE FROM shops WHERE id = ANY($1::uuid[])`, [shops])
  })

  // The report covers every shop, so figures are read for this test's own product and store only.
  const mine = (v) => ({ product: v.byProduct.find((x) => x.productId === S.p), shop: v.byShop.find((x) => x.shopId === S.A) })

  it('works out sales, cost of goods sold, wastage and profit from the stock history', async () => {
    const v = (await S.monthly.buildLive('2026-10')).valuation
    const { product, shop } = mine(v)
    expect(product).toMatchObject({ units: 8, sales: 370, cogs: 264, gross: 106, loss: 66, stockQty: 10, stockValue: 330 }) // 5@50 + 3@40; 8 units at average 33
    expect(shop).toMatchObject({ openingValue: 0, closingValue: 330, sales: 370, cogs: 264 })
  })

  it('values the warehouse at each purchase’s own price and closes the roll-forward exactly', async () => {
    const d1 = await S.monthly.buildLive('2026-10')
    const rows = d1.valuation.warehouseRows.filter((w) => w.vendor === `${tag} vendor`)
    expect(rows).toEqual([expect.objectContaining({ units: 5, price: 30, value: 150 })]) // 18 usable − 10 sent − 3 held and delivered
    expect(d1.valuation.checks.transfer.ok).toBe(true)
    expect(d1.valuation.rollForward.difference).toBe(0)
    expect(d1.exceptions.map((e) => e.code)).not.toContain('ROLL_FORWARD')
  })

  it('counts goods delivered from the warehouse hold as sales and cost, and door wastage as a loss', async () => {
    const d1 = await S.monthly.buildLive('2026-10')
    const direct = d1.valuation.byProduct.find((x) => x.productId === null)
    expect(direct).toMatchObject({ sales: 135, cogs: 90, gross: 45 }) // 3 × 45 sold, 3 × 30 cost
    expect(d1.valuation.profit.loss).toBeGreaterThanOrEqual(126) // 66 shelf damage + 60 thrown away at the door (this test's share)
  })

  it('cannot close a month that is still running', async () => {
    await expect(S.periods.close('2026-10', {}, S.a)).rejects.toMatchObject({ code: 'CANNOT_CLOSE' })
  })

  describe('closing a finished month', () => {
    beforeAll(async () => {
      const back = `interval '40 days'`
      await q(`UPDATE stock_movements SET created_at = created_at - ${back} WHERE shop_product_id IN (SELECT id FROM shop_products WHERE product_id = $1)`, [S.p])
      await q(`UPDATE procurement_entries SET created_at = created_at - ${back}, procured_on = procured_on - 40, received_at = received_at - ${back} WHERE product_id = $1`, [S.p])
      const entries = `SELECT id FROM procurement_entries WHERE product_id = $1`
      await q(`UPDATE procurement_allocations SET created_at = created_at - ${back}, applied_at = applied_at - ${back} WHERE entry_id IN (${entries})`, [S.p])
      await q(`UPDATE procurement_adjustments SET created_at = created_at - ${back} WHERE entry_id IN (${entries})`, [S.p])
      await q(`UPDATE procurement_events SET created_at = created_at - ${back} WHERE entry_id IN (${entries})`, [S.p])
      await q(`UPDATE b2b_reservations SET created_at = created_at - ${back}, closed_at = closed_at - ${back} WHERE product_id = $1`, [S.p])
      await q(`UPDATE orders SET created_at = created_at - ${back}, b2b_approved_at = b2b_approved_at - ${back} WHERE shop_id = $1`, [S.A])
    })

    it('closes, freezes the report, and starts the next month from the closed stock', async () => {
      const before = mine((await S.monthly.buildLive('2026-09')).valuation)
      expect(before.shop).toMatchObject({ sales: 370, closingValue: 330 })
      await S.periods.close('2026-09', { note: 'checked' }, S.a)
      expect((await S.periods.status('2026-09')).state).toBe('CLOSED')
      const frozen = await S.monthly.build('2026-09')
      expect(frozen.closed).toMatchObject({ month: '2026-09', note: 'checked' })
      expect(mine(frozen.valuation).shop).toMatchObject({ sales: 370, closingValue: 330 })
      const next = (await S.monthly.buildLive('2026-10')).valuation
      expect(next.stock.basis).toBe('CLOSED_MONTH')
      expect(mine(next).shop.openingValue).toBe(330)
    })

    it('refuses new records dated inside a closed month, and closing it twice', async () => {
      await expect(S.proc.createEntry({ productId: S.p, vendorId: S.vendor.id, expectedQty: 1, unitPrice: 1, procuredOn: '2026-09-10' }, S.a)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' })
      await expect(S.sup.pay(S.vendor.id, { amount: 1, method: 'CASH', paidOn: '2026-09-10' }, S.a)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' })
      await expect(S.periods.close('2026-09', {}, S.a)).rejects.toMatchObject({ code: 'ALREADY_CLOSED' })
    })

    it('reopens only with a reason, only the latest month, and keeps a log', async () => {
      await expect(S.periods.reopen('2026-09', {}, S.a)).rejects.toMatchObject({ code: 'VALIDATION' })
      await S.periods.reopen('2026-09', { reason: 'test' }, S.a)
      expect((await S.periods.status('2026-09')).state).toBe('OPEN')
      expect((await q(`SELECT COUNT(*)::int n FROM period_stock_snapshots`)).rows[0].n).toBe(0)
      expect((await S.pr.history()).map((h) => h.action).slice(0, 2)).toEqual(['REOPENED', 'CLOSED'])
    })
  })
})
