import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Phase 1 foundation, against a real database (opt-in, like the WhatsApp CRM DB suites):
 *   MONEY_DB_TEST=1 npx vitest run tests/integration/money-foundation.db.test.js
 * Needs the isolated local DB (see memory: local-crm-test-environment) with all migrations applied.
 */
const RUN = process.env.MONEY_DB_TEST === '1'
const d = RUN ? describe : describe.skip

d('money foundation (real DB)', () => {
  let query, svc, ShopProductsRepository, getClient
  const tag = `ZZMF${Date.now().toString(36)}`
  const ids = { phones: [] }
  const phone = () => { const p = `9${Math.floor(100000000 + Math.random() * 899999999)}`; ids.phones.push(p); return p }

  beforeAll(async () => {
    ;({ query, getClient } = await import('../../src/config/database.js'))
    const { AdminOrdersRepository } = await import('../../src/modules/admin/orders/orders.repository.js')
    const { AdminOrdersService } = await import('../../src/modules/admin/orders/orders.service.js')
    ;({ ShopProductsRepository } = await import('../../src/modules/shop-products/shop-products.repository.js'))
    svc = new AdminOrdersService(new AdminOrdersRepository(), { io: { to: () => ({ emit() {} }), emit() {} } })
    ids.admin = (await query(`SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`)).rows[0].id
    ids.cust = (await query(`SELECT id FROM users WHERE role = 'CUSTOMER' LIMIT 1`)).rows[0].id
    const shop = (n, slug) => query(`INSERT INTO shops (name, slug, branch_code, is_active, address_line1, city, state, pincode, lat, lng) VALUES ($1,$2,$3,true,'1 Rd','K','WB','700001',22.5,88.3) RETURNING id`, [n, `${tag}-${slug}`, `${tag}${slug}`.slice(0, 20)]).then((r) => r.rows[0].id)
    ids.A = await shop(`${tag} A`, 'a')
    ids.B = await shop(`${tag} B`, 'b')
    ids.p = (await query(`INSERT INTO products (name, slug, price, sale_price, stock_quantity) VALUES ($1,$2,30,28,500) RETURNING id`, [`${tag} potato`, `${tag}-potato`])).rows[0].id
    await query(`INSERT INTO shop_products (shop_id, product_id, stock_quantity) VALUES ($1,$3,100),($2,$3,2)`, [ids.A, ids.B, ids.p])
  })

  afterAll(async () => {
    if (!RUN) return
    // Find this suite's orders FIRST (their lines are about to be deleted), then remove everything that points at them.
    const orderIds = (await query(`SELECT id FROM orders WHERE order_number LIKE 'ZZMF-%' OR shop_id = ANY($1::uuid[]) OR id IN (SELECT order_id FROM order_items WHERE product_id = $2)`, [[ids.A, ids.B], ids.p])).rows.map((r) => r.id)
    await query(`DELETE FROM order_b2b_settlements WHERE order_id = ANY($1::uuid[])`, [orderIds])
    await query(`DELETE FROM order_status_history WHERE order_id = ANY($1::uuid[])`, [orderIds])
    await query(`DELETE FROM stock_movements WHERE shop_product_id IN (SELECT id FROM shop_products WHERE product_id = $1)`, [ids.p])
    await query(`DELETE FROM order_items WHERE order_id = ANY($1::uuid[])`, [orderIds])
    await query(`DELETE FROM orders WHERE id = ANY($1::uuid[])`, [orderIds])
    await query(`DELETE FROM shop_products WHERE product_id = $1`, [ids.p])
    await query(`DELETE FROM products WHERE id = $1`, [ids.p])
    await query(`DELETE FROM users WHERE added_by_staff = $1 AND phone = ANY($2::text[])`, [ids.admin, ids.phones])
    await query(`DELETE FROM shops WHERE id = ANY($1::uuid[])`, [[ids.A, ids.B]])
  })

  const stock = async (shop) => (await query(`SELECT stock_quantity q FROM shop_products WHERE shop_id = $1 AND product_id = $2`, [shop, ids.p])).rows[0].q
  const place = (o) => svc.createManualOrder({ userId: ids.cust, items: [{ productId: ids.p, quantity: o.qty }], deliveryAddress: { city: 'K' }, ...o }, ids.admin, '127.0.0.1')

  it('a manual order takes the chosen store’s stock through the ledger, not the catalogue', async () => {
    const order = await place({ shopId: ids.A, qty: 5 })
    expect(await stock(ids.A)).toBe(95)
    expect((await query(`SELECT stock_quantity q FROM products WHERE id = $1`, [ids.p])).rows[0].q).toBe(500)
    const row = (await query(`SELECT shop_id, payment_status, total_amount::float t FROM orders WHERE id = $1`, [order.id])).rows[0]
    expect(row).toMatchObject({ shop_id: ids.A, payment_status: 'PENDING', t: 140 }) // 5 × the sale price 28
    const ledger = (await query(`SELECT type, quantity_before, quantity_after FROM stock_movements WHERE order_id = $1`, [order.id])).rows
    expect(ledger).toEqual([{ type: 'ORDER_DEDUCTION', quantity_before: 100, quantity_after: 95 }])
    expect((await query(`SELECT shop_product_id FROM order_items WHERE order_id = $1`, [order.id])).rows[0].shop_product_id).toBeTruthy()
  })

  it('refuses what a store cannot cover and changes nothing', async () => {
    const before = await stock(ids.B)
    await expect(place({ shopId: ids.B, qty: 5 })).rejects.toMatchObject({ message: expect.stringMatching(/out of stock/) })
    expect(await stock(ids.B)).toBe(before)
    await expect(place({ qty: 500 })).rejects.toMatchObject({ code: 'NO_STORE_HAS_STOCK' })
  })

  it('is paid only when the admin says the money is in hand, and a later “received” is allowed once', async () => {
    const got = await place({ shopId: ids.A, qty: 1, paymentMethod: 'MANUAL', paymentReceived: true })
    expect((await query(`SELECT payment_status FROM orders WHERE id = $1`, [got.id])).rows[0].payment_status).toBe('PAID')
    const later = await place({ shopId: ids.A, qty: 1, paymentMethod: 'MANUAL' })
    expect((await svc.markManualOrderPaid(later.id, { note: 'cash' }, ids.admin, '127.0.0.1')).payment_status).toBe('PAID')
    await expect(svc.markManualOrderPaid(later.id, {}, ids.admin, '127.0.0.1')).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a cancellation puts the stock back into the same store', async () => {
    const order = await place({ shopId: ids.A, qty: 2 })
    const before = await stock(ids.A)
    const items = (await query(`SELECT shop_product_id, quantity, name FROM order_items WHERE order_id = $1`, [order.id])).rows
    const c = await getClient()
    await c.query('BEGIN')
    await new ShopProductsRepository().restoreStockForCancelledOrder(c, { orderId: order.id, items, source: 'DASHBOARD' })
    await c.query('COMMIT')
    c.release()
    expect(await stock(ids.A)).toBe(before + 2)
  })

  it('a B2B credit order is unpaid until the recorded payments cover it, and is never refunded automatically', async () => {
    const b = (await query(`INSERT INTO orders (order_number, user_id, shop_id, items, subtotal, total_amount, delivery_address, status, payment_method, payment_status, b2b_approval_status, b2b_approved_at)
      VALUES ($1,$2,$3,'[]',1000,1000,'{}','DELIVERED','B2B_CREDIT','PENDING','APPROVED',NOW()) RETURNING id`, [`ZZMF-${tag}`, ids.cust, ids.A])).rows[0]
    const state = async () => (await query(`SELECT o.payment_status, m.received_amount::float r, m.outstanding_amount::float o FROM orders o JOIN order_money m ON m.order_id = o.id WHERE o.id = $1`, [b.id])).rows[0]
    expect(await state()).toEqual({ payment_status: 'PENDING', r: 0, o: 1000 })
    await expect(svc.refundOrder(b.id, { reason: 'x', refundTo: 'wallet' }, ids.admin, 'ip')).rejects.toMatchObject({ message: expect.stringMatching(/never paid/) })
    await svc.recordB2BSettlement(b.id, { method: 'CASH', amount: 300 }, ids.admin, 'ip')
    expect(await state()).toEqual({ payment_status: 'PENDING', r: 300, o: 700 })
    await svc.recordB2BSettlement(b.id, { method: 'UPI', amount: 700 }, ids.admin, 'ip')
    expect(await state()).toEqual({ payment_status: 'PAID', r: 1000, o: 0 })
    await expect(svc.refundOrder(b.id, { reason: 'x', refundTo: 'wallet' }, ids.admin, 'ip')).rejects.toMatchObject({ message: expect.stringMatching(/Collections/) })
  })

  describe('staff-added customers and B2B orders', () => {
    it('adds a customer who is not on the platform, labelled, and never duplicates a phone number', async () => {
      const ph = phone()
      const made = await svc.createCustomerByStaff({ name: 'Royal Biryani Owner', phone: `+91 ${ph}`, kind: 'BUSINESS', businessName: 'Royal Biryani', gstin: '19abcde1234f1z5' }, ids.admin, 'ip')
      expect(made).toMatchObject({ existing: false, kind: 'BUSINESS', businessName: 'Royal Biryani', notOnApp: true, addedByStaff: true, hasBusinessAccount: false, phone: ph, gstin: '19ABCDE1234F1Z5' })
      ids.biz = made.id
      const again = await svc.createCustomerByStaff({ name: 'Someone else', phone: ph }, ids.admin, 'ip')
      expect(again).toMatchObject({ existing: true, id: made.id })
      const found = (await svc.customerLookup('Royal')).find((c) => c.id === made.id)
      expect(found).toMatchObject({ kind: 'BUSINESS', notOnApp: true })
      const home = await svc.createCustomerByStaff({ name: 'Walk In', phone: phone() }, ids.admin, 'ip')
      expect(home).toMatchObject({ kind: 'HOME', notOnApp: true })
    })

    it.each([[{ name: 'A', phone: '9876543210' }], [{ name: 'Ok Name', phone: '123' }], [{ name: 'Ok Name', phone: '9876543210', kind: 'BUSINESS' }], [{ name: 'Ok Name', phone: '9876543210', kind: 'BUSINESS', businessName: 'Biz', gstin: 'BAD' }]])('refuses %j', async (bad) => {
      await expect(svc.createCustomerByStaff(bad, ids.admin, 'ip')).rejects.toMatchObject({ statusCode: 400 })
    })

    it('a B2B order is an approved credit order: the agreed price, stock from the store, unpaid until payments are recorded', async () => {
      const order = await svc.createManualOrder({ userId: ids.biz, shopId: ids.A, orderType: 'B2B', dueDate: '2099-01-01', items: [{ productId: ids.p, quantity: 10, unitPrice: 20 }], deliveryAddress: { city: 'K' } }, ids.admin, 'ip')
      const row = (await query(`SELECT payment_method, payment_status, b2b_approval_status, b2b_approved_by, shop_id, total_amount::float t, to_char(b2b_payment_due_date,'YYYY-MM-DD') due FROM orders WHERE id = $1`, [order.id])).rows[0]
      expect(row).toMatchObject({ payment_method: 'B2B_CREDIT', payment_status: 'PENDING', b2b_approval_status: 'APPROVED', b2b_approved_by: ids.admin, shop_id: ids.A, t: 200, due: '2099-01-01' })
      expect((await query(`SELECT type FROM stock_movements WHERE order_id = $1`, [order.id])).rows.map((r) => r.type)).toEqual(['ORDER_DEDUCTION'])
      const list = await svc.findAllB2B({ status: 'APPROVED', limit: 50 })
      expect(list.orders.find((o) => o.id === order.id)).toMatchObject({ company_name: 'Royal Biryani', customer_phone: ids.phones[0] })
      await svc.recordB2BSettlement(order.id, { method: 'UPI', amount: 200 }, ids.admin, 'ip')
      expect((await query(`SELECT payment_status FROM orders WHERE id = $1`, [order.id])).rows[0].payment_status).toBe('PAID')
    })

    it('money received when the order is taken is recorded as a real payment; too much is refused', async () => {
      const part = await svc.createManualOrder({ userId: ids.biz, shopId: ids.A, orderType: 'B2B', advance: { amount: 50, method: 'CASH' }, items: [{ productId: ids.p, quantity: 5, unitPrice: 20 }], deliveryAddress: { city: 'K' } }, ids.admin, 'ip')
      expect((await query(`SELECT received_amount::float r, outstanding_amount::float o FROM order_money WHERE order_id = $1`, [part.id])).rows[0]).toEqual({ r: 50, o: 50 })
      expect((await query(`SELECT method, amount::float a FROM order_b2b_settlements WHERE order_id = $1`, [part.id])).rows).toEqual([{ method: 'CASH', a: 50 }])
      const full = await svc.createManualOrder({ userId: ids.biz, shopId: ids.A, orderType: 'B2B', advance: { amount: 40, method: 'UPI' }, items: [{ productId: ids.p, quantity: 2, unitPrice: 20 }], deliveryAddress: { city: 'K' } }, ids.admin, 'ip')
      expect((await query(`SELECT payment_status FROM orders WHERE id = $1`, [full.id])).rows[0].payment_status).toBe('PAID')
      const before = await stock(ids.A)
      await expect(svc.createManualOrder({ userId: ids.biz, shopId: ids.A, orderType: 'B2B', advance: { amount: 500, method: 'CASH' }, items: [{ productId: ids.p, quantity: 1, unitPrice: 20 }], deliveryAddress: { city: 'K' } }, ids.admin, 'ip')).rejects.toMatchObject({ statusCode: 400 })
      expect(await stock(ids.A)).toBe(before)
    })
  })
})
