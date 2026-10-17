import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Store transfers "on the way", against a real database (opt-in):
 *   MONEY_DB_TEST=1 npx vitest run --no-file-parallelism tests/integration/transfers.db.test.js
 * Story (cost ₹30): buy 20. Send 12 to store A ON THE WAY — the store cannot sell them yet. 10 arrive; 2 are lost on the way (₹60).
 *   shelves 10 × 30 = 300, warehouse 8 × 30 = 240 → 540 = 600 bought − 60 lost.
 */
const RUN = process.env.MONEY_DB_TEST === '1'
const d = RUN ? describe : describe.skip

d('store transfers: on the way → received (real DB)', () => {
  const tag = `zzt${Date.now().toString(36)}`
  const S = {}
  let q

  beforeAll(async () => {
    const imp = (p) => import(`../../src/${p}`)
    ;({ query: q } = await imp('config/database.js'))
    const { ProcurementService } = await imp('modules/procurement/procurement.service.js')
    const { ProcurementRepository } = await imp('modules/procurement/procurement.repository.js')
    const { MonthlyService } = await imp('modules/procurement/monthly.service.js')
    const { MonthlyRepository } = await imp('modules/procurement/monthly.repository.js')
    const { ValuationService } = await imp('modules/procurement/valuation.service.js')
    const { ValuationRepository } = await imp('modules/procurement/valuation.repository.js')
    const { PeriodsRepository } = await imp('modules/procurement/periods.repository.js')
    const { AdminOrdersRepository } = await imp('modules/admin/orders/orders.repository.js')
    const { AdminOrdersService } = await imp('modules/admin/orders/orders.service.js')
    S.proc = new ProcurementService({ repo: new ProcurementRepository() })
    S.monthly = new MonthlyService({ repo: new MonthlyRepository(), valuation: new ValuationService({ repo: new ValuationRepository() }), periods: new PeriodsRepository() })
    S.orders = new AdminOrdersService(new AdminOrdersRepository(), { io: { to: () => ({ emit() {} }), emit() {} } })
    S.admin = (await q(`SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`)).rows[0].id
    S.cust = (await q(`SELECT id FROM users WHERE role = 'CUSTOMER' LIMIT 1`)).rows[0].id
    S.a = { userId: S.admin }
    S.A = (await q(`INSERT INTO shops (name, slug, branch_code, is_active, address_line1, city, state, pincode, lat, lng) VALUES ($1,$2,$3,true,'1 Rd','K','WB','700001',22.5,88.3) RETURNING id`, [`${tag} a`, `${tag}-a`, `${tag}a`.slice(0, 20)])).rows[0].id
    S.p = (await q(`INSERT INTO products (name, slug, price, sale_price, stock_quantity) VALUES ($1,$2,60,50,0) RETURNING id`, [`${tag} potato`, `${tag}-potato`])).rows[0].id
    await q(`INSERT INTO shop_products (shop_id, product_id, stock_quantity, low_stock_threshold) VALUES ($1,$2,0,0)`, [S.A, S.p])
    S.vendor = await S.proc.createVendor({ name: `${tag} vendor` }, S.admin)
    let e = await S.proc.createEntry({ productId: S.p, vendorId: S.vendor.id, expectedQty: 20, unitPrice: 30, ordered: true }, S.a)
    S.entry = await S.proc.receive(e.id, { receivedQty: 20, rejectedQty: 0 }, S.a)
  })

  afterAll(async () => {
    if (!RUN || !S.p) return
    const orderIds = (await q(`SELECT id FROM orders WHERE shop_id = $1`, [S.A])).rows.map((r) => r.id)
    await q(`DELETE FROM order_status_history WHERE order_id = ANY($1::uuid[])`, [orderIds])
    await q(`DELETE FROM stock_movements WHERE product_id = $1`, [S.p])
    await q(`DELETE FROM order_items WHERE order_id = ANY($1::uuid[])`, [orderIds])
    await q(`DELETE FROM orders WHERE id = ANY($1::uuid[])`, [orderIds])
    const entries = `SELECT id FROM procurement_entries WHERE product_id = $1`
    await q(`DELETE FROM procurement_allocations WHERE entry_id IN (${entries})`, [S.p])
    await q(`DELETE FROM procurement_events WHERE entry_id IN (${entries})`, [S.p])
    await q(`DELETE FROM procurement_adjustments WHERE entry_id IN (${entries})`, [S.p])
    await q(`DELETE FROM procurement_entries WHERE product_id = $1`, [S.p])
    await q(`DELETE FROM shop_products WHERE product_id = $1`, [S.p])
    await q(`DELETE FROM vendors WHERE id = $1`, [S.vendor.id])
    await q(`DELETE FROM products WHERE id = $1`, [S.p])
    await q(`DELETE FROM shops WHERE id = $1`, [S.A])
  })

  const shelf = async () => (await q(`SELECT stock_quantity q FROM shop_products WHERE shop_id = $1 AND product_id = $2`, [S.A, S.p])).rows[0].q
  const detail = () => S.proc.detail(S.entry.id)
  const mine = (v) => v.warehouseRows.find((w) => w.vendor === `${tag} vendor`)

  it('sending on the way takes the units out of free stock but NOT onto the shelf', async () => {
    const done = await S.proc.allocate(S.entry.id, { allocations: [{ shopId: S.A, quantity: 12 }], inTransit: true }, S.a)
    expect(done).toMatchObject({ available: 8, allocated: 12, inTransit: 12 })
    expect(await shelf()).toBe(0)
    await expect(S.orders.createManualOrder({ userId: S.cust, shopId: S.A, items: [{ productId: S.p, quantity: 1 }], paymentMethod: 'COD', deliveryAddress: { city: 'K' } }, S.admin, 'ip')).rejects.toMatchObject({ message: expect.stringMatching(/out of stock/) })
    expect((await q(`SELECT COUNT(*)::int n FROM stock_movements WHERE product_id = $1`, [S.p])).rows[0].n).toBe(0)
  })

  it('still counts the goods as ours while they are on the way', async () => {
    const d1 = await S.monthly.buildLive('2026-10')
    expect(mine(d1.valuation)).toMatchObject({ units: 20, inTransit: 12, value: 600 })
    expect(d1.valuation.rollForward.difference).toBe(0)
    expect(d1.valuation.checks.transfer.ok).toBe(true)
    expect(d1.summary.stock.inTransit).toBeGreaterThanOrEqual(360)
  })

  it('lists what is on the way, and refuses to treat it as already on the shelf', async () => {
    const list = (await S.proc.transfers()).filter((t) => t.vendor === `${tag} vendor`)
    expect(list).toEqual([expect.objectContaining({ quantity: 12, shop: `${tag} a` })])
    S.transfer = list[0]
    const [alloc] = (await detail()).allocations
    await expect(S.proc.reverseAllocation(alloc.id, S.a)).rejects.toMatchObject({ code: 'STILL_IN_TRANSIT' })
  })

  it('the store confirms: 10 of 12 arrive, 2 are written off as lost on the way', async () => {
    await expect(S.proc.receiveTransfer(S.transfer.id, { receivedQty: 13 }, S.a)).rejects.toMatchObject({ code: 'MORE_THAN_SENT' })
    await expect(S.proc.receiveTransfer(S.transfer.id, { receivedQty: 0 }, S.a)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await shelf()).toBe(0) // the refused attempts changed nothing
    const done = await S.proc.receiveTransfer(S.transfer.id, { receivedQty: 10, note: 'crate dropped' }, S.a)
    expect(await shelf()).toBe(10)
    expect(done).toMatchObject({ available: 8, allocated: 10, inTransit: 0 })
    expect(done.adjustments).toEqual([expect.objectContaining({ kind: 'WASTAGE', quantity: 2, loss: true })])
    expect((await q(`SELECT cost_price::float c FROM shop_products WHERE shop_id = $1 AND product_id = $2`, [S.A, S.p])).rows[0].c).toBe(30)
    await expect(S.proc.receiveTransfer(S.transfer.id, { receivedQty: 1 }, S.a)).rejects.toMatchObject({ code: 'NOT_IN_TRANSIT' })
  })

  it('values it right afterwards: ₹540 held = 600 bought − 60 lost', async () => {
    const v = (await S.monthly.buildLive('2026-10')).valuation
    expect(mine(v)).toMatchObject({ units: 8, inTransit: 0, value: 240 })
    const shelves = v.byShop.find((s) => s.name === `${tag} a`)
    expect(shelves).toMatchObject({ closingValue: 300 })
    expect(v.rollForward.difference).toBe(0)
    expect(v.checks.transfer.ok).toBe(true)
    expect(v.profit.loss).toBeGreaterThanOrEqual(60)
  })

  it('a transfer that never left can be cancelled and its units are free again', async () => {
    const sent = await S.proc.allocate(S.entry.id, { allocations: [{ shopId: S.A, quantity: 5 }], inTransit: true }, S.a)
    expect(sent.available).toBe(3)
    const t = (await S.proc.transfers()).find((x) => x.vendor === `${tag} vendor`)
    const back = await S.proc.cancelTransfer(t.id, S.a)
    expect(back).toMatchObject({ available: 8, inTransit: 0 })
    expect(await shelf()).toBe(10)
    await expect(S.proc.cancelTransfer(t.id, S.a)).rejects.toMatchObject({ code: 'NOT_IN_TRANSIT' })
  })

  it('sending now still works exactly as before', async () => {
    const done = await S.proc.allocate(S.entry.id, { allocations: [{ shopId: S.A, quantity: 3 }] }, S.a)
    expect(await shelf()).toBe(13)
    expect(done).toMatchObject({ available: 5, inTransit: 0 })
  })
})
