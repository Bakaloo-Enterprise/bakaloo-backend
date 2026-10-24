/**
 * "Tap a product, buy it": the supplier suggestions on the To-buy plan and what each supplier usually supplies.
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/procurement-quickbuy.db.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PH = (n) => `9999025${String(n).padStart(3, '0')}`

describe.skipIf(!enabled)('Quick buy suggestions', () => {
  let query, closePool, reqs, suppliers, shop, banana, rice, vA, vB, vOld, vGone
  const entry = (product, vendor, price, on, status = 'ACTIVE', qty = 10) =>
    query(`INSERT INTO procurement_entries (product_id, vendor_id, expected_qty, received_qty, unit_price, purchase_total, procured_on, invoice_ref, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'T25-x',$8,$7::date)`,
      [product, vendor, qty, status === 'ORDERED' ? 0 : qty, price, price * qty, on, status])

  async function cleanup() {
    await query(`DELETE FROM procurement_entries WHERE invoice_ref = 'T25-x'`)
    await query(`DELETE FROM shop_products WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't25-shop-%')`)
    await query(`DELETE FROM vendors WHERE name LIKE 'T25 %'`)
    await query(`DELETE FROM products WHERE slug LIKE 't25-%'`)
    await query(`DELETE FROM shops WHERE slug LIKE 't25-shop-%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { RequirementsRepository } = await import('../../src/modules/procurement/requirements.repository.js')
    const { RequirementsService } = await import('../../src/modules/procurement/requirements.service.js')
    const { SuppliersService } = await import('../../src/modules/procurement/suppliers.service.js')
    const { ProcurementRepository } = await import('../../src/modules/procurement/procurement.repository.js')
    await cleanup()
    reqs = new RequirementsService({ repo: new RequirementsRepository() })
    suppliers = new SuppliersService({ repo: new ProcurementRepository(), procurement: { vendorShape: (v) => v }, now: () => new Date('2026-03-20T12:00:00+05:30') })
    shop = (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ('T25 Shop','t25-shop-1','T25S','DB 25','Kolkata','WB','700091',22.5,88.3,true) RETURNING id`)).rows[0].id
    const mkP = async (name, slug) => (await query(`INSERT INTO products (name, slug, price, net_quantity) VALUES ($1,$2,40,'1 kg') RETURNING id`, [name, slug])).rows[0].id
    banana = await mkP('T25 Banana', 't25-banana'); rice = await mkP('T25 Basmati Rice', 't25-rice')
    // the shelf is below its low-stock line, so both are on the plan: banana 2 of 10 (short 8), rice 3 of 5 (short 2)
    await query(`INSERT INTO shop_products (shop_id, product_id, stock_quantity, low_stock_threshold, price) VALUES ($1,$2,2,10,40),($1,$3,3,5,40)`, [shop, banana, rice])
    const mkV = async (name, active = true) => (await query(`INSERT INTO vendors (name, is_active) VALUES ($1,$2) RETURNING id`, [name, active])).rows[0].id
    vA = await mkV('T25 Mandi A'); vB = await mkV('T25 Farm B'); vOld = await mkV('T25 Old Co'); vGone = await mkV('T25 Closed Co', false)
    // banana: A bought twice (40 then 44), B once (42, the most recent), Old long ago (35), a closed supplier (ignored), plus one on the way from A
    await entry(banana, vOld, 35, '2026-01-05'); await entry(banana, vA, 40, '2026-02-01'); await entry(banana, vA, 44, '2026-03-01'); await entry(banana, vB, 42, '2026-03-10'); await entry(banana, vGone, 30, '2026-03-15')
    await entry(banana, vA, 46, '2026-03-18', 'ORDERED')
    await entry(rice, vA, 410, '2026-03-02')
  })
  afterAll(async () => { await cleanup(); await closePool() })

  it('offers the suppliers we usually buy each product from, newest first, with their latest price', async () => {
    const plan = await reqs.plan()
    const b = plan.items.find((i) => i.productId === banana)
    expect(b.vendors.map((v) => v.name)).toEqual(['T25 Mandi A', 'T25 Farm B', 'T25 Old Co']) // A's order on the way (18 Mar) is the newest; the closed supplier is left out
    expect(b.vendors.find((v) => v.name === 'T25 Mandi A')).toMatchObject({ price: 46, lastOn: '2026-03-18', times: 3 }) // 40, 44 and the one on the way
    expect(b.vendors.find((v) => v.name === 'T25 Farm B')).toMatchObject({ price: 42, times: 1 })
  })
  it('remembers the last received purchase (price and supplier) for pre-filling', async () => {
    const b = (await reqs.plan()).items.find((i) => i.productId === banana)
    expect(b).toMatchObject({ lastVendor: 'T25 Farm B', lastPrice: 42 }) // received purchases only, and never a closed supplier (its newer 30-rupee purchase is skipped)
  })
  it('still lists a product with one supplier and works with none', async () => {
    const r = (await reqs.plan()).items.find((i) => i.productId === rice)
    expect(r.vendors).toHaveLength(1)
    expect(r.vendors[0]).toMatchObject({ name: 'T25 Mandi A', price: 410 })
  })
  it('shows what each supplier usually supplies', async () => {
    const p = await suppliers.payables()
    const a = p.vendors.find((v) => v.name === 'T25 Mandi A')
    // A: banana ×3, rice ×1 → most-bought first; latest purchase 18 March
    expect(a.usually).toEqual(['T25 Banana', 'T25 Basmati Rice'])
    expect(a.lastBoughtOn).toBe('2026-03-18')
    expect(p.vendors.find((v) => v.name === 'T25 Farm B').usually).toEqual(['T25 Banana'])
  })
})
