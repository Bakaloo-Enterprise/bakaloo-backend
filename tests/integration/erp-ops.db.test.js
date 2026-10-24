/**
 * Operations ERP on a real Postgres. Opt-in:  WA_CRM_DB_TEST=1 npx vitest run tests/integration/erp-ops.db.test.js
 * Every expected number is worked out on paper in the comments.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const at = (hhmm, day = '2026-03-10') => `${day} ${hhmm}:00+05:30`
const PH = (n) => `9999022${String(n).padStart(3, '0')}`
const addDay = (ymd, n) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10)

describe.skipIf(!enabled)('Operations ERP', () => {
  let query, closePool, ops, A, B, user, vendor, rice, tea, milk, spRice, spTea, spMilk
  let n = 0
  const mkShop = async (c) => (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ($1,$2,$3,'DB 22','Kolkata','WB','700091',22.5,88.3,true) RETURNING id`, [`T22 Shop ${c}`, `t22-shop-${c}`, `T22${c}`])).rows[0].id
  const mkProduct = async (name, sku, price, cost, extra = '') => (await query(`INSERT INTO products (name, slug, price, cost_price, sku, net_quantity, shelf_life ${extra ? ', target_margin_pct' : ''}) VALUES ($1,$2,$3,$4,$5,'1 unit','4 days' ${extra ? ', 20' : ''}) RETURNING id`, [name, `t22-${sku}`.toLowerCase(), price, cost, sku])).rows[0].id
  const mkSp = async (shop, product, qty, price, cost) => (await query(`INSERT INTO shop_products (shop_id, product_id, stock_quantity, price, cost_price) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [shop, product, qty, price, cost])).rows[0].id
  const mv = (shop, sp, product, type, delta, before, after, time, meta = {}, order = null, reason = null) =>
    query(`INSERT INTO stock_movements (shop_id, shop_product_id, product_id, type, quantity_delta, quantity_before, quantity_after, reason, order_id, source, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ORDER',$10::jsonb,$11)`,
      [shop, sp, product, type, delta, before, after, reason, order, JSON.stringify(meta), time])
  async function order({ shop = A, status, total, created, lines, b2b = false, history = [] }) {
    const id = (await query(
      `INSERT INTO orders (order_number,user_id,shop_id,status,items,subtotal,total_amount,delivery_address,payment_method,payment_status,created_at,delivered_at,buyer_gstin,b2b_approval_status)
       VALUES ($1,$2,$3,$4::order_status,'[]'::jsonb,$5,$5,'{}'::jsonb,'ONLINE','PAID',$6,$6,$7,$8) RETURNING id`,
      [`T22-${++n}`, user, shop, status, total, created, b2b ? '19ABCDE1234F1Z5' : null, b2b ? 'APPROVED' : null])).rows[0].id
    for (const [pid, q, price] of lines) await query(`INSERT INTO order_items (order_id,product_id,name,price,quantity,unit,total,shop_id) VALUES ($1,$2,'x',$3,$4,'1 unit',$5,$6)`, [id, pid, price, q, q * price, shop])
    for (const [from, to, time] of history) await query(`INSERT INTO order_status_history (order_id, from_status, to_status, changed_at) VALUES ($1,$2,$3,$4)`, [id, from, to, time])
    return id
  }

  async function cleanup() {
    await query(`DELETE FROM procurement_entries WHERE invoice_ref LIKE 'T22-%'`)
    await query(`DELETE FROM stock_movements WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't22-shop-%')`)
    await query(`DELETE FROM refund_requests WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'T22-%')`)
    await query(`DELETE FROM orders WHERE order_number LIKE 'T22-%'`)
    await query(`DELETE FROM shop_products WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't22-shop-%')`)
    await query(`DELETE FROM vendors WHERE name LIKE 'T22 %'`)
    await query(`DELETE FROM products WHERE slug LIKE 't22-%'`)
    await query(`DELETE FROM shops WHERE slug LIKE 't22-shop-%'`)
    await query(`DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE phone LIKE '9999022%')`)
    await query(`DELETE FROM users WHERE phone LIKE '9999022%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { OpsRepository } = await import('../../src/modules/erp/ops.repository.js')
    const { OpsService } = await import('../../src/modules/erp/ops.service.js')
    await cleanup()
    ops = new OpsService({ repo: new OpsRepository(), now: () => new Date('2026-03-10T12:00:00+05:30') })
    user = (await query(`INSERT INTO users (phone,name,email,role) VALUES ($1,'T22 Customer',$2,'CUSTOMER') RETURNING id`, [PH(1), `${PH(1)}@t.local`])).rows[0].id
    A = await mkShop('A'); B = await mkShop('B')
    vendor = (await query(`INSERT INTO vendors (name) VALUES ('T22 Vendor') RETURNING id`)).rows[0].id
    rice = await mkProduct('T22 Rice', 'RICE', 100, 60, true); tea = await mkProduct('T22 Tea', 'TEA', 50, 30); milk = await mkProduct('T22 Milk', 'MILK', 30, 20)
    spRice = await mkSp(A, rice, 73, 100, 60); spTea = await mkSp(A, tea, 3, 50, 30); spMilk = await mkSp(A, milk, 8, 30, 20)

    // ── Rice, shop A: the day-close day (2026-03-10) ──
    await mv(A, spRice, rice, 'PROCUREMENT_RECEIPT', 50, 0, 50, at('22:00', '2026-03-09'), { unitCost: 60 })
    await mv(A, spRice, rice, 'PROCUREMENT_RECEIPT', 30, 50, 80, at('06:00'), { unitCost: 62 })
    await query(`INSERT INTO procurement_entries (product_id, vendor_id, expected_qty, received_qty, unit_price, purchase_total, procured_on, invoice_ref, destination_shop_id, status, created_at) VALUES ($1,$2,30,30,62,1860,'2026-03-10','T22-INV-1',$3,'ACTIVE',$4)`, [rice, vendor, A, at('06:00')])
    const o1 = await order({ status: 'DELIVERED', total: 300, created: at('10:00'), lines: [[rice, 3, 100]] })
    await mv(A, spRice, rice, 'ORDER_DEDUCTION', -3, 80, 77, at('10:00'), {}, o1)
    const o2 = await order({ status: 'CANCELLED', total: 200, created: at('12:00', '2026-03-10').replace('12:00', '11:30'), lines: [[rice, 2, 100]], history: [[null, 'CONFIRMED', at('11:31')], ['CONFIRMED', 'CANCELLED', at('11:45')]] })
    await mv(A, spRice, rice, 'ORDER_DEDUCTION', -2, 77, 75, at('11:30'), {}, o2); await mv(A, spRice, rice, 'CANCELLATION_RESTORE', 2, 75, 77, at('11:45'), {}, o2)
    const o3 = await order({ status: 'REFUNDED', total: 100, created: at('11:00'), lines: [[rice, 1, 100]], history: [['DELIVERED', 'REFUNDED', at('11:50')]] })
    await mv(A, spRice, rice, 'ORDER_DEDUCTION', -1, 77, 76, at('11:00'), {}, o3); await mv(A, spRice, rice, 'RETURN_STOCK', 1, 76, 77, at('11:50'), {}, o3)
    await mv(A, spRice, rice, 'DAMAGED_STOCK', -4, 77, 73, at('23:50'), { reason: 'Spoilage / Rot' }, null, 'Spoilage / Rot')
    // ── Milk, shop A: a stock record that does not add up ──
    await mv(A, spMilk, milk, 'PROCUREMENT_RECEIPT', 10, 0, 10, at('20:00', '2026-03-09'), { unitCost: 20 })
    await mv(A, spMilk, milk, 'ORDER_DEDUCTION', -5, 10, 8, at('09:00')) // says −5 but the shelf went 10 → 8

    // ── 35 full days (2026-02-03 … 2026-03-09), one order a day at 15:00: rice 10, tea 10 — for the forecast ──
    for (let d = 35; d >= 1; d--) await order({ status: 'DELIVERED', total: 800, created: at('15:00', addDay('2026-03-10', -d)), lines: [[rice, 10, 100], [tea, 10, 50]] })
    // a huge business order must not move the home-delivery forecast
    await order({ status: 'DELIVERED', total: 50000, created: at('15:00', '2026-03-05'), lines: [[rice, 500, 100]], b2b: true })
    // rice on its way: 8 ordered, not yet received
    await query(`INSERT INTO procurement_entries (product_id, vendor_id, expected_qty, received_qty, unit_price, purchase_total, procured_on, invoice_ref, destination_shop_id, status, created_at) VALUES ($1,$2,8,0,60,480,'2026-03-10','T22-INV-2',$3,'ORDERED',$4)`, [rice, vendor, A, at('07:00')])
    await query(`UPDATE shop_products SET stock_quantity = 25 WHERE id = $1`, [spRice])
  })
  afterAll(async () => { await cleanup(); await closePool() })

  // Rice, 03-10: opening 50, bought 30, sold on orders that stood = 3 (o2 cancelled, o3 refunded in full are not sales),
  // the ledger shows 6 out (3+2+1), 2 + 1 back, 4 spoiled: 50 + 30 + 2 + 1 − 6 − 4 = 73 = closing. Cost = 1860 / 30 = 62.
  // revenue 300, cogs 3×62 = 186, wastage 4×62 = 248, profit = 300 − 186 − 248 = −134 → −44.7 %.
  describe('day close', () => {
    let dc, rowOf
    beforeAll(async () => { dc = await ops.dayClose({ date: '2026-03-10', shopId: A }); rowOf = (id) => dc.items.find((i) => i.productId === id) })
    it('adds the shelf up from opening to closing with no gap', () => {
      expect(rowOf(rice)).toMatchObject({ opening: 50, bought: 30, sold: 3, wasted: 4, returnedToShelf: 3, closing: 73, ledgerGap: 0 })
    })
    it('counts only orders that stood as sales', () => {
      expect(rowOf(rice)).toMatchObject({ revenue: 300, orders: 1, unitCost: 62 })
    })
    it('works out cost, wastage and profit', () => {
      expect(rowOf(rice)).toMatchObject({ cogs: 186, wasteValue: 248, profit: -134, marginPct: -44.7 })
      expect(dc.totals).toMatchObject({ revenue: 300, cogs: 186, wasteValue: 248, profit: -134, purchaseSpend: 1860 })
    })
    // 14 days before the end: handled = 50 (opening 03-09 ledger counts as bought) → bought 80 in total, 4 spoiled
    // effective cost = 62 × 80 / 76 = 65.26 → 65.26 / (1 − 0.20) = 81.58 → rounded up 82. Sold at 100 → fine.
    it('advises a price from the true cost after spoilage and the product target', () => {
      expect(rowOf(rice).price).toMatchObject({ targetMarginPct: 20, suggested: 82, advice: 'OK' })
      expect(rowOf(rice).price.effectiveCost).toBeCloseTo(65.26, 2)
    })
    it('flags a stock record that does not add up', () => {
      // milk: opening 10, 5 sold out, closing 8 → should be 5, gap +3
      expect(rowOf(milk)).toMatchObject({ opening: 10, closing: 8, ledgerGap: 3 })
      expect(dc.ledger.gaps).toBeGreaterThanOrEqual(1)
    })
    it('refuses a bad date and keeps stores apart', async () => {
      await expect(ops.dayClose({ date: '2026-02-30' })).rejects.toThrow(/Date must look like/)
      const other = await ops.dayClose({ date: '2026-03-10', shopId: B })
      expect(other.items).toHaveLength(0)
    })
  })

  describe('wastage', () => {
    it('values spoilage at the cost of the last purchase before it and groups it', async () => {
      const w = await ops.wastage({ period: 'custom', from: '2026-03-10', to: '2026-03-10', shopId: A })
      expect(w.totals).toMatchObject({ qty: 4, value: 248 }) // 4 × 62 (the 06:00 receipt), not 60
      expect(w.byReason).toEqual([expect.objectContaining({ reason: 'Spoilage / Rot', qty: 4, value: 248, sharePct: 100 })])
      expect(w.byWeekday.find((d) => d.weekday === 2).value).toBe(248) // 2026-03-10 is a Tuesday
      expect(w.daily).toEqual([{ day: '2026-03-10', value: 248, qty: 4 }])
      expect(w.products[0]).toMatchObject({ name: 'T22 Rice', qty: 4, cumulativePct: 100 })
    })
    it('flags a product wasting far more than its target', async () => {
      // handled = opening 50 + bought 30 = 80; 4 / 80 = 5 % against the 4-day default target of 8 % → not a breach
      const w = await ops.wastage({ period: 'custom', from: '2026-03-10', to: '2026-03-10', shopId: A })
      expect(w.products[0]).toMatchObject({ wastePct: 5, targetPct: 8, breach: false })
    })
  })

  // Sales history: 10 rice and 10 tea every day at 15:00 for 35 days (the 500-unit business order is ignored). Now = 12:00,
  // all of a day's selling comes at 15:00, so 100 % of today is still ahead.
  describe('forecast', () => {
    let f, row
    beforeAll(async () => { f = await ops.forecast({ shopId: A }); row = (id) => f.items.find((i) => i.productId === id) })
    it('forecasts a steady seller at its steady rate and ignores business orders', () => {
      expect(row(rice).avgPerDay).toBe(10)
      expect(row(rice).tomorrow).toBe(10)
    })
    // rice: 25 on the shelf, 10 expected today → 15 tonight, 8 on the way → (15 + 8) / 10 = 2.3 days, nothing to buy
    it('counts what is left tonight and what is on its way', () => {
      expect(row(rice)).toMatchObject({ stock: 25, incoming: 8, expectedTonight: 15, buy: 0, risk: 'OK' })
      expect(row(rice).coverDays).toBeCloseTo(2.3, 1) // 23 units against 10 a day
    })
    // tea: 3 on the shelf, 10 expected today → runs out today; for tomorrow need 10 − 0 = 10
    it('warns when a shelf empties before closing and says how much to buy', () => {
      expect(row(tea)).toMatchObject({ stock: 3, expectedTonight: 0, buy: 10, risk: 'RUNS_OUT_TODAY' })
      expect(f.totals.urgent).toBeGreaterThanOrEqual(1)
    })
    it('reports how accurate it has been', () => {
      expect(f.accuracy.accuracyPct).toBeGreaterThan(95)
    })
  })

  it('saves product targets and validates them', async () => {
    expect(await ops.setTargets(tea, { marginPct: 18, wastagePct: 6 })).toEqual({ productId: tea, marginPct: 18, wastagePct: 6 })
    await expect(ops.setTargets(tea, { marginPct: 95 })).rejects.toThrow(/between 0 and 89/)
    await expect(ops.setTargets('11111111-1111-1111-1111-111111111111', { marginPct: 10 })).rejects.toThrow(/not found/)
  })

  describe('logging wastage', () => {
    it('writes a ledger movement that every report then sees', async () => {
      // tea: 3 on the shelf → write off 2 as "Over-ripe"
      const r = await ops.logWastage({ shopId: A, productId: tea, quantity: 2, reason: 'Over-ripe', note: 'T22 crate dropped' }, { userId: user })
      expect(r).toMatchObject({ product: 'T22 Tea', removed: 2, left: 1, reason: 'Over-ripe' })
      const { rows } = await query(`SELECT type, quantity_delta, quantity_before, quantity_after, metadata->>'reason' AS reason FROM stock_movements WHERE id = $1`, [r.movementId])
      expect(rows[0]).toEqual({ type: 'DAMAGED_STOCK', quantity_delta: -2, quantity_before: 3, quantity_after: 1, reason: 'Over-ripe' })
      expect((await query(`SELECT stock_quantity FROM shop_products WHERE id = $1`, [spTea])).rows[0].stock_quantity).toBe(1)
    })
    it('refuses more than is on the shelf, bad quantities, unknown reasons and products not stocked', async () => {
      await expect(ops.logWastage({ shopId: A, productId: tea, quantity: 5, reason: 'Over-ripe' }, { userId: user })).rejects.toThrow(/Only 1 of T22 Tea/)
      await expect(ops.logWastage({ shopId: A, productId: tea, quantity: 0, reason: 'Over-ripe' }, { userId: user })).rejects.toThrow(/whole number/)
      await expect(ops.logWastage({ shopId: A, productId: tea, quantity: 1.5, reason: 'Over-ripe' }, { userId: user })).rejects.toThrow(/whole number/)
      await expect(ops.logWastage({ shopId: A, productId: tea, quantity: 1, reason: 'Fun' }, { userId: user })).rejects.toThrow(/why it was lost/)
      await expect(ops.logWastage({ shopId: B, productId: tea, quantity: 1, reason: 'Over-ripe' }, { userId: user })).rejects.toThrow(/not on this store/)
    })
    it('lists only what is on the shelf', async () => {
      const shelf = await ops.shelf(A)
      expect(shelf.find((x) => x.productId === tea)).toMatchObject({ stock: 1 })
      expect(shelf.every((x) => x.stock > 0)).toBe(true)
    })
  })
})
