import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Repacking bulk stock into pack sizes, against a real database (opt-in):
 *   MONEY_DB_TEST=1 npx vitest run --no-file-parallelism tests/integration/repack.db.test.js
 * Story (cost ₹30 per kg): buy 50 kg of loose potatoes. Make 10 × 1 kg + 4 × 500 g for store A (12 kg used, nothing lost),
 * then 9 × 500 g for store B from 5 kg (4.5 kg packed, 500 g lost = ₹15). Sell 2 × 1 kg at store A for ₹40 each.
 *   shelves: A 1 kg 8 × 30 = 240, A 500 g 4 × 15 = 60, B 500 g 9 × 15 = 135  → 435
 *   warehouse: 50 − 12 − 5 = 33 kg × 30 = 990                                → 1425 = 1500 bought − 60 cost of sales − 15 lost
 */
const RUN = process.env.MONEY_DB_TEST === '1'
const d = RUN ? describe : describe.skip

d('repacking bulk into packs (real DB)', () => {
  const tag = `zzr${Date.now().toString(36)}`
  const S = {}
  let q

  beforeAll(async () => {
    const imp = (p) => import(`../../src/${p}`)
    ;({ query: q } = await imp('config/database.js'))
    const { ProcurementService } = await imp('modules/procurement/procurement.service.js')
    const { ProcurementRepository } = await imp('modules/procurement/procurement.repository.js')
    const { ConversionService } = await imp('modules/procurement/conversion.service.js')
    const { MonthlyService } = await imp('modules/procurement/monthly.service.js')
    const { MonthlyRepository } = await imp('modules/procurement/monthly.repository.js')
    const { ValuationService } = await imp('modules/procurement/valuation.service.js')
    const { ValuationRepository } = await imp('modules/procurement/valuation.repository.js')
    const { PeriodsRepository } = await imp('modules/procurement/periods.repository.js')
    const { AdminOrdersRepository } = await imp('modules/admin/orders/orders.repository.js')
    const { AdminOrdersService } = await imp('modules/admin/orders/orders.service.js')
    const rep = new ProcurementRepository()
    S.proc = new ProcurementService({ repo: rep })
    S.conv = new ConversionService({ procRepo: rep, procurement: S.proc })
    S.monthly = new MonthlyService({ repo: new MonthlyRepository(), valuation: new ValuationService({ repo: new ValuationRepository() }), periods: new PeriodsRepository() })
    S.orders = new AdminOrdersService(new AdminOrdersRepository(), { io: { to: () => ({ emit() {} }), emit() {} } })
    S.admin = (await q(`SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`)).rows[0].id
    S.cust = (await q(`SELECT id FROM users WHERE role = 'CUSTOMER' LIMIT 1`)).rows[0].id
    S.a = { userId: S.admin }
    const shop = (n) => q(`INSERT INTO shops (name, slug, branch_code, is_active, address_line1, city, state, pincode, lat, lng) VALUES ($1,$2,$3,true,'1 Rd','K','WB','700001',22.5,88.3) RETURNING id`, [`${tag} ${n}`, `${tag}-${n}`, `${tag}${n}`.slice(0, 20)]).then((r) => r.rows[0].id)
    S.A = await shop('a'); S.B = await shop('b')
    S.fam = (await q(`INSERT INTO product_families (name, slug) VALUES ($1,$2) RETURNING id`, [`${tag} potato`, `${tag}-potato`])).rows[0].id
    const prod = (name, slug, size, nq) => q(`INSERT INTO products (name, slug, price, sale_price, stock_quantity, product_family_id, net_quantity, pack_size, pack_unit) VALUES ($1,$2,40,40,0,$3,$4,$5,'G') RETURNING id`, [name, `${tag}-${slug}`, S.fam, nq, size]).then((r) => r.rows[0].id)
    S.bulk = await prod(`${tag} loose`, 'loose', 1000, '1 kg')
    S.kg = await prod(`${tag} 1kg pack`, 'kg', 1000, '1 kg')
    S.half = await prod(`${tag} 500g pack`, 'half', 500, '500 g')
    S.other = (await q(`INSERT INTO products (name, slug, price, stock_quantity, pack_size, pack_unit) VALUES ($1,$2,10,0,1000,'G') RETURNING id`, [`${tag} onion`, `${tag}-onion`])).rows[0].id
    for (const sh of [S.A, S.B]) for (const pid of [S.kg, S.half]) await q(`INSERT INTO shop_products (shop_id, product_id, stock_quantity, low_stock_threshold) VALUES ($1,$2,0,0)`, [sh, pid])
    S.vendor = await S.proc.createVendor({ name: `${tag} vendor` }, S.admin)
    let e = await S.proc.createEntry({ productId: S.bulk, vendorId: S.vendor.id, expectedQty: 50, unitPrice: 30, ordered: true }, S.a)
    S.entry = await S.proc.receive(e.id, { receivedQty: 50, rejectedQty: 0 }, S.a)
  })

  afterAll(async () => {
    if (!RUN || !S.fam) return
    const prods = [S.bulk, S.kg, S.half, S.other]
    const shops = [S.A, S.B]
    const orderIds = (await q(`SELECT id FROM orders WHERE shop_id = ANY($1::uuid[])`, [shops])).rows.map((r) => r.id)
    const entries = `SELECT id FROM procurement_entries WHERE product_id = ANY($1::uuid[])`
    await q(`DELETE FROM order_b2b_settlements WHERE order_id = ANY($1::uuid[])`, [orderIds])
    await q(`DELETE FROM order_status_history WHERE order_id = ANY($1::uuid[])`, [orderIds])
    await q(`DELETE FROM stock_movements WHERE product_id = ANY($1::uuid[])`, [prods])
    await q(`DELETE FROM order_items WHERE order_id = ANY($1::uuid[])`, [orderIds])
    await q(`DELETE FROM orders WHERE id = ANY($1::uuid[])`, [orderIds])
    await q(`DELETE FROM procurement_conversions WHERE entry_id IN (${entries})`, [prods])
    await q(`DELETE FROM procurement_allocations WHERE entry_id IN (${entries})`, [prods])
    await q(`DELETE FROM procurement_events WHERE entry_id IN (${entries})`, [prods])
    await q(`DELETE FROM procurement_adjustments WHERE entry_id IN (${entries})`, [prods])
    await q(`DELETE FROM procurement_entries WHERE product_id = ANY($1::uuid[])`, [prods])
    await q(`DELETE FROM shop_products WHERE product_id = ANY($1::uuid[])`, [prods])
    await q(`DELETE FROM vendors WHERE id = $1`, [S.vendor.id])
    await q(`DELETE FROM products WHERE id = ANY($1::uuid[])`, [prods])
    await q(`DELETE FROM product_families WHERE id = $1`, [S.fam])
    await q(`DELETE FROM shops WHERE id = ANY($1::uuid[])`, [shops])
  })

  const stock = async (shop, product) => (await q(`SELECT stock_quantity q, cost_price::float c FROM shop_products WHERE shop_id = $1 AND product_id = $2`, [shop, product])).rows[0]
  const free = async () => (await S.proc.detail(S.entry.id)).available

  it('lists the other pack sizes of the family with what each would cost', async () => {
    const p = await S.conv.preview(S.entry.id)
    expect(p).toMatchObject({ available: 50, unitSize: 1000, unit: 'G', costPerGram: 0.03, blocked: null })
    expect(p.targets.map((t) => [t.label, t.cost])).toEqual([['500 g', 15], ['1 kg', 30]])
  })

  it('makes packs: grams in = grams out, stock lands on the shelf, cost follows weight', async () => {
    const done = await S.conv.convert(S.entry.id, { unitsUsed: 12, lines: [{ shopId: S.A, productId: S.kg, packs: 10 }, { shopId: S.A, productId: S.half, packs: 4 }] }, S.a)
    expect(done.available).toBe(38)
    expect(done.conversions).toEqual([expect.objectContaining({ unitsUsed: 12, gramsUsed: 12000, gramsPacked: 12000, gramsLost: 0, status: 'APPLIED' })])
    expect(await stock(S.A, S.kg)).toEqual({ q: 10, c: 30 })
    expect(await stock(S.A, S.half)).toEqual({ q: 4, c: 15 })
    const m = (await q(`SELECT metadata FROM stock_movements WHERE product_id = $1 AND type = 'PROCUREMENT_RECEIPT'`, [S.half])).rows[0].metadata
    expect(m).toMatchObject({ unitCost: 15, packSize: 500 })
  })

  it('records what is lost on the way, and refuses packs that do not fit', async () => {
    const done = await S.conv.convert(S.entry.id, { unitsUsed: 5, lines: [{ shopId: S.B, productId: S.half, packs: 9 }] }, S.a)
    expect(done.available).toBe(33)
    expect(done.conversions.at(-1)).toMatchObject({ gramsUsed: 5000, gramsPacked: 4500, gramsLost: 500 })
    await expect(S.conv.convert(S.entry.id, { unitsUsed: 1, lines: [{ shopId: S.B, productId: S.kg, packs: 2 }] }, S.a)).rejects.toMatchObject({ code: 'NOT_ENOUGH_BULK' })
    await expect(S.conv.convert(S.entry.id, { unitsUsed: 99, lines: [{ shopId: S.B, productId: S.kg, packs: 1 }] }, S.a)).rejects.toMatchObject({ code: 'OVER_ALLOCATION' })
    await expect(S.conv.convert(S.entry.id, { unitsUsed: 1, lines: [{ shopId: S.B, productId: S.other, packs: 1 }] }, S.a)).rejects.toMatchObject({ code: 'NOT_SAME_FAMILY' })
    await expect(S.conv.convert(S.entry.id, { unitsUsed: 1, lines: [{ shopId: S.B, productId: S.bulk, packs: 1 }] }, S.a)).rejects.toMatchObject({ code: 'SAME_PRODUCT' })
    expect(await free()).toBe(33)
    expect(await stock(S.B, S.half)).toEqual({ q: 9, c: 15 })
  })

  it('profit and stock value follow the packs: ₹1425 held = 1500 bought − 60 cost of sales − 15 lost', async () => {
    await S.orders.createManualOrder({ userId: S.cust, shopId: S.A, items: [{ productId: S.kg, quantity: 2 }], paymentMethod: 'COD', deliveryAddress: { city: 'K' } }, S.admin, 'ip')
    const d1 = await S.monthly.buildLive('2026-10')
    const v = d1.valuation
    const mine = v.byProduct.find((x) => x.productId === S.kg)
    expect(mine).toMatchObject({ units: 2, sales: 80, cogs: 60, stockQty: 8, stockValue: 240 })
    const wh = v.warehouseRows.filter((w) => w.vendor === `${tag} vendor`)
    expect(wh).toEqual([expect.objectContaining({ units: 33, price: 30, value: 990 })])
    expect(v.checks.transfer.ok).toBe(true)
    expect(v.rollForward.difference).toBe(0)
    expect(d1.exceptions.map((e) => e.code)).not.toContain('ROLL_FORWARD')
    // this test's own shelves are worth 240 + 60 + 135 = 435
    const shelves = v.byShop.filter((s) => [S.A, S.B].includes(s.shopId)).reduce((n, s) => n + s.closingValue, 0)
    expect(shelves).toBe(435)
    expect(v.profit.loss).toBeGreaterThanOrEqual(15) // the 500 g that did not fit in a pack
  })

  it('undoes a repack only while every pack is still on the shelf', async () => {
    const detail = await S.proc.detail(S.entry.id)
    const [first, second] = detail.conversions
    await expect(S.conv.reverse(first.id, S.a)).rejects.toMatchObject({ code: 'PACKS_ALREADY_SOLD' }) // 2 of the 10 × 1 kg packs were sold
    expect(await stock(S.A, S.kg)).toEqual({ q: 8, c: 30 }) // the refused attempt changed nothing
    const undone = await S.conv.reverse(second.id, S.a)
    expect(undone.available).toBe(38)
    expect(await stock(S.B, S.half)).toEqual({ q: 0, c: 15 })
    await expect(S.conv.reverse(second.id, S.a)).rejects.toMatchObject({ code: 'ALREADY_REVERSED' })
  })

  it('a purchase with a repack cannot be cancelled', async () => {
    await expect(S.proc.cancel(S.entry.id, S.a)).rejects.toMatchObject({ code: 'ENTRY_IN_USE' })
  })

  it('sets and validates a pack size', async () => {
    expect(await S.conv.setPackSize(S.other, { size: 1500, unit: 'G' })).toMatchObject({ packSize: 1500, label: '1.5 kg' })
    await expect(S.conv.setPackSize(S.other, { size: 0, unit: 'G' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(S.conv.setPackSize('00000000-0000-0000-0000-000000000000', { size: 5, unit: 'G' })).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' })
  })
})
