/**
 * Store Fulfillment POS (Phase 11). Real Postgres, opt-in:
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/pos.db.test.js
 * Uses the REAL shop-order and rider-assignment services (so status rules, pickup tokens and audit rows are the
 * production ones). Realtime is a recording fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PH = (n) => `9999015${String(n).padStart(3, '0')}`

describe.skipIf(!enabled)('Store Fulfillment POS', () => {
  let query, closePool, repo, svc, T
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  let emitted = []
  let clock = new Date()
  let shop, shopB, mgr, picker, picker2, packer, allround, viewer, outsider, cust, rider1, rider2, rice, oil, salt

  const mkUser = async (n, name, role = 'ADMIN') => (await query(`INSERT INTO users (phone,name,email,role) VALUES ($1,$2,$3,$4) RETURNING id`, [PH(n), name, `${PH(n)}@t.local`, role])).rows[0].id
  const mkShop = async (code) => (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ($1,$2,$3,'DB 12','Kolkata','WB','700091',22.5,88.3,true) RETURNING id`, [`T11 Shop ${code}`, `t11-shop-${code}`, code])).rows[0].id
  const staffOf = (userId, shopId, role, station = null) => query(`INSERT INTO shop_staff (user_id, shop_id, role, pos_station) VALUES ($1,$2,$3,$4)`, [userId, shopId, role, station])
  const mkProduct = async (name, barcode, sku) => (await query(`INSERT INTO products (name, slug, price, barcode, sku, net_quantity) VALUES ($1,$2,100,$3,$4,'1 unit') RETURNING id`, [name, `t11-${sku ?? name}`.toLowerCase().replace(/\W+/g, '-') + '-' + Date.now() % 1e6, barcode, sku])).rows[0].id
  const mkRider = async (n, name, { online = true } = {}) => {
    const id = await mkUser(n, name, 'RIDER')
    await query(`INSERT INTO rider_profiles (user_id, is_approved, is_online) VALUES ($1,true,$2)`, [id, online])
    return id
  }
  let orderN = 0
  /** A CONFIRMED order for `shopId` with the given [productId, qty] lines. */
  async function mkOrder(items, { shopId = shop, status = 'CONFIRMED', payment = 'PAID' } = {}) {
    const total = items.reduce((n, [, q]) => n + q * 100, 0)
    const id = (await query(
      `INSERT INTO orders (order_number, user_id, shop_id, status, items, subtotal, total_amount, delivery_address, payment_method, payment_status)
       VALUES ($1,$2,$3,$4::order_status,'[]'::jsonb,$5,$5,$6::jsonb,'COD',$7) RETURNING id`,
      [`T11-${Date.now() % 1e7}-${++orderN}`, cust, shopId, status, total, JSON.stringify({ addressLine1: '12 Flat 4B', addressLine2: 'Salt Lake Sector 5', city: 'Kolkata', pincode: '700091', receiverName: 'Priya', receiverPhone: '9876543210' }), payment],
    )).rows[0].id
    for (const [pid, q] of items) {
      const name = (await query(`SELECT name FROM products WHERE id = $1`, [pid])).rows[0].name
      await query(`INSERT INTO order_items (order_id, product_id, name, price, quantity, unit, total, shop_id) VALUES ($1,$2,$3,100,$4,'1 unit',$5,$6)`, [id, pid, name, q, q * 100, shopId])
    }
    await query(`INSERT INTO order_status_history (order_id, from_status, to_status, changed_at) VALUES ($1,'PENDING',$2::order_status, $3)`, [id, status, clock])
    return id
  }
  const lineOf = async (orderId, name) => (await query(`SELECT * FROM pos_lines WHERE order_id = $1 AND name = $2`, [orderId, name])).rows[0]
  const statusOf = async (orderId) => (await query(`SELECT status FROM orders WHERE id = $1`, [orderId])).rows[0].status
  const event = (kind) => (e) => e.kind === kind

  /** Take an order all the way to PACKED with the given packer. */
  async function packedOrder(opts = {}) {
    const o = await mkOrder([[rice, 2], [oil, 1]])
    await svc.startPick(picker, shop, o)
    await svc.scan(picker, shop, o, { stage: 'PICK', code: 'RICE5' })
    await svc.scan(picker, shop, o, { stage: 'PICK', code: 'RICE5' })
    await svc.scan(picker, shop, o, { stage: 'PICK', code: '8900000000002' })
    await svc.finishPick(picker, shop, o)
    await svc.startPack(packer, shop, o)
    await svc.scan(packer, shop, o, { stage: 'PACK', code: 'RICE5' })
    await svc.scan(packer, shop, o, { stage: 'PACK', code: 'RICE5' })
    await svc.scan(packer, shop, o, { stage: 'PACK', code: '8900000000002' })
    await svc.finishPack(packer, shop, o, { packageCount: opts.packages ?? 1 })
    return o
  }

  async function cleanup() {
    await query(`DELETE FROM audit_logs WHERE actor_shop_id IN (SELECT id FROM shops WHERE slug LIKE 't11-shop-%')`)
    await query(`DELETE FROM pos_print_jobs WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't11-shop-%')`)
    await query(`DELETE FROM pos_attention_resolutions WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't11-shop-%')`)
    await query(`DELETE FROM qr_scan_logs WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'T11-%')`)
    await query(`DELETE FROM orders WHERE order_number LIKE 'T11-%'`)
    await query(`DELETE FROM pos_printers WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't11-shop-%')`)
    await query(`DELETE FROM pos_events WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't11-shop-%')`)
    await query(`DELETE FROM products WHERE slug LIKE 't11-%'`)
    await query(`DELETE FROM rider_profiles WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '9999015%')`)
    await query(`DELETE FROM rider_assignment_log WHERE rider_id IN (SELECT id FROM users WHERE phone LIKE '9999015%')`)
    await query(`DELETE FROM shop_staff WHERE shop_id IN (SELECT id FROM shops WHERE slug LIKE 't11-shop-%')`)
    await query(`DELETE FROM shops WHERE slug LIKE 't11-shop-%'`)
    await query(`DELETE FROM users WHERE phone LIKE '9999015%'`)
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { PosRepository } = await import('../../src/modules/pos/pos.repository.js')
    const { PosService } = await import('../../src/modules/pos/pos.service.js')
    const { ShopOrdersRepository } = await import('../../src/modules/shop-orders/repository.js')
    const { ShopOrdersService } = await import('../../src/modules/shop-orders/service.js')
    const { FinalizeAssignmentService } = await import('../../src/modules/rider-assignment/finalize-assignment.service.js')
    repo = new PosRepository()
    T = await import('../../src/modules/pos/pos.rules.js')
    svc = new PosService({
      repo, logger, now: () => clock,
      shopOrders: new ShopOrdersService(new ShopOrdersRepository(), { fastify: null }),
      finalize: new FinalizeAssignmentService(null),
      emit: (shopId, payload) => emitted.push({ shopId, ...payload }),
    })
  })

  beforeEach(async () => {
    await cleanup()
    emitted = []
    clock = new Date()
    shop = await mkShop('P1'); shopB = await mkShop('P2')
    mgr = await mkUser(1, 'T11 Mira Manager'); picker = await mkUser(2, 'T11 Pia Picker'); picker2 = await mkUser(3, 'T11 Paul Picker')
    packer = await mkUser(4, 'T11 Kiran Packer'); allround = await mkUser(5, 'T11 Asha Allround'); viewer = await mkUser(6, 'T11 Vik Viewer'); outsider = await mkUser(7, 'T11 Olga Other')
    cust = await mkUser(8, 'T11 Customer', 'CUSTOMER')
    await staffOf(mgr, shop, 'SHOP_MANAGER'); await staffOf(picker, shop, 'SHOP_STAFF', 'PICKER'); await staffOf(picker2, shop, 'SHOP_STAFF', 'PICKER')
    await staffOf(packer, shop, 'SHOP_STAFF', 'PACKER'); await staffOf(allround, shop, 'SHOP_STAFF'); await staffOf(viewer, shop, 'SHOP_VIEWER'); await staffOf(outsider, shopB, 'SHOP_MANAGER')
    rider1 = await mkRider(20, 'T11 Ravi Rider'); rider2 = await mkRider(21, 'T11 Raju Rider')
    rice = await mkProduct('T11 Rice 5kg', '8900000000001', 'RICE5'); oil = await mkProduct('T11 Oil 1L', '8900000000002', 'OIL1'); salt = await mkProduct('T11 Salt 1kg', null, null)
  })
  afterAll(async () => { await cleanup(); await closePool() })

  // ═══ who may do what ═══════════════════════════════════════════
  describe('roles and stations', () => {
    it('reports each person’s abilities', async () => {
      expect((await svc.me(mgr, shop)).abilities).toMatchObject({ manage: true, pick: true, pack: true })
      expect((await svc.me(picker, shop)).abilities).toEqual({ view: true, pick: true, pack: false, handover: false, reprint: false, manage: false })
      expect((await svc.me(packer, shop)).abilities).toMatchObject({ pick: false, pack: true, handover: true, reprint: true, manage: false })
      expect((await svc.me(allround, shop)).abilities).toMatchObject({ pick: true, pack: true, manage: false })
      expect((await svc.me(viewer, shop)).abilities).toMatchObject({ view: true, pick: false, pack: false })
    })
    it('a picker cannot pack, a packer cannot pick, a viewer can do nothing', async () => {
      const o = await mkOrder([[rice, 1]])
      await expect(svc.startPick(packer, shop, o)).rejects.toMatchObject({ statusCode: 403 })
      await expect(svc.startPick(viewer, shop, o)).rejects.toMatchObject({ statusCode: 403 })
      await svc.startPick(picker, shop, o)
      await expect(svc.startPack(picker, shop, o)).rejects.toMatchObject({ statusCode: 403 })
      await expect(svc.assignRider(picker, shop, o, rider1)).rejects.toMatchObject({ statusCode: 403 })
      await expect(svc.performance(picker, shop)).rejects.toMatchObject({ statusCode: 403 })
    })
    it('staff of another store see nothing of this store’s orders (404, not 403)', async () => {
      const o = await mkOrder([[rice, 1]])
      await expect(svc.detail(outsider, shop, o)).rejects.toMatchObject({ statusCode: 403 }) // not on this store's team: no abilities here
      await expect(svc.detail(outsider, shopB, o)).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' })
      await expect(svc.startPick(outsider, shopB, o)).rejects.toMatchObject({ statusCode: 404 })
    })
    it('only managers set stations, and only on staff members', async () => {
      await expect(svc.setStation(picker, shop, packer, 'PICKER')).rejects.toMatchObject({ statusCode: 403 })
      await svc.setStation(mgr, shop, allround, 'PACKER')
      expect((await svc.me(allround, shop)).abilities.pick).toBe(false)
      await expect(svc.setStation(mgr, shop, mgr, 'PICKER')).rejects.toMatchObject({ code: 'NOT_STAFF' })
      await expect(svc.setStation(mgr, shop, outsider, 'PICKER')).rejects.toMatchObject({ statusCode: 404 })
      await expect(svc.setStation(mgr, shop, allround, 'BOSS')).rejects.toMatchObject({ code: 'VALIDATION' })
      await svc.setStation(mgr, shop, allround, null)
      expect((await svc.me(allround, shop)).abilities.pick).toBe(true)
    })
    it('a job can only be given to someone who does it', async () => {
      const o = await mkOrder([[rice, 1]])
      await expect(svc.assignPerson(mgr, shop, o, { role: 'PICKER', userId: packer })).rejects.toMatchObject({ code: 'WRONG_STATION' })
      await expect(svc.assignPerson(mgr, shop, o, { role: 'PICKER', userId: viewer })).rejects.toMatchObject({ code: 'WRONG_STATION' })
      await expect(svc.assignPerson(mgr, shop, o, { role: 'PICKER', userId: outsider })).rejects.toMatchObject({ code: 'STAFF_NOT_FOUND' })
      await expect(svc.assignPerson(picker, shop, o, { role: 'PICKER', userId: picker })).rejects.toMatchObject({ statusCode: 403 })
      const d = await svc.assignPerson(mgr, shop, o, { role: 'PICKER', userId: picker })
      expect(d.fulfillment.picker.name).toBe('T11 Pia Picker')
      expect(d.status).toBe('CONFIRMED') // assigned, not started
    })
  })

  // ═══ picking ═══════════════════════════════════════════════════
  describe('picking and scanning', () => {
    it('starting snapshots the pick list from the order, moves the order to PREPARING and logs it', async () => {
      const o = await mkOrder([[rice, 2], [oil, 1]])
      const d = await svc.startPick(picker, shop, o)
      expect(await statusOf(o)).toBe('PREPARING')
      expect(d.lane).toBe('PICKING')
      expect(d.fulfillment).toMatchObject({ stage: 'PICKING', picker: { name: 'T11 Pia Picker' } })
      expect(d.lines.map((l) => [l.name, l.required, l.barcode])).toEqual([['T11 Oil 1L', 1, '8900000000002'], ['T11 Rice 5kg', 2, '8900000000001']])
      expect((await query(`SELECT to_status FROM order_status_history WHERE order_id = $1 ORDER BY changed_at`, [o])).rows.map((r) => r.to_status)).toContain('PREPARING')
      expect(emitted.some((e) => e.orderId === o && e.kind === 'pick_started')).toBe(true)
    })
    it('starting twice is harmless; payment-failed and cancelled orders cannot be started', async () => {
      const o = await mkOrder([[rice, 1]])
      await svc.startPick(picker, shop, o); await svc.startPick(picker, shop, o)
      expect((await query(`SELECT COUNT(*)::int n FROM pos_lines WHERE order_id = $1`, [o])).rows[0].n).toBe(1)
      const bad = await mkOrder([[rice, 1]], { payment: 'FAILED' })
      await expect(svc.startPick(picker, shop, bad)).rejects.toMatchObject({ code: 'PAYMENT_PROBLEM' })
      const dead = await mkOrder([[rice, 1]], { status: 'CANCELLED' })
      await expect(svc.startPick(picker, shop, dead)).rejects.toMatchObject({ code: 'ORDER_CANCELLED' })
    })
    it('a correct scan counts; the line completes when every unit is collected', async () => {
      const o = await mkOrder([[rice, 2]])
      await svc.startPick(picker, shop, o)
      expect((await svc.scan(picker, shop, o, { stage: 'PICK', code: ' 8900000000001\r\n' })).line).toMatchObject({ picked: 1, status: 'PENDING' })
      expect((await svc.scan(picker, shop, o, { stage: 'PICK', code: 'rice5' })).line).toMatchObject({ picked: 2, status: 'PICKED' })
    })
    it('a wrong scan is refused with a clear message, counted, and never silently accepted', async () => {
      const o = await mkOrder([[rice, 1]])
      await svc.startPick(picker, shop, o)
      await expect(svc.scan(picker, shop, o, { stage: 'PICK', code: '8901111111111' })).rejects.toMatchObject({ statusCode: 409, code: 'WRONG_ITEM', message: expect.stringMatching(/not on this order/) })
      expect((await lineOf(o, 'T11 Rice 5kg')).picked_qty).toBe(0)
      expect((await query(`SELECT result FROM pos_scans WHERE order_id = $1`, [o])).rows.map((r) => r.result)).toEqual(['WRONG_ITEM'])
      expect((await svc.timeline(mgr, shop, o)).some((t) => t.kind === 'SCAN_REJECTED')).toBe(true)
    })
    it('scanning more than ordered is refused', async () => {
      const o = await mkOrder([[rice, 1]])
      await svc.startPick(picker, shop, o)
      await svc.scan(picker, shop, o, { stage: 'PICK', code: 'RICE5' })
      await expect(svc.scan(picker, shop, o, { stage: 'PICK', code: 'RICE5' })).rejects.toMatchObject({ code: 'OVER_QTY' })
      expect((await lineOf(o, 'T11 Rice 5kg')).picked_qty).toBe(1)
    })
    it('two scans of the last unit at once: exactly one counts', async () => {
      const o = await mkOrder([[rice, 1]])
      await svc.startPick(picker, shop, o)
      const res = await Promise.allSettled([svc.scan(picker, shop, o, { stage: 'PICK', code: 'RICE5' }), svc.scan(picker, shop, o, { stage: 'PICK', code: 'RICE5' })])
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect((await lineOf(o, 'T11 Rice 5kg')).picked_qty).toBe(1)
    })
    it('an item without a barcode is confirmed by hand and counted as MANUAL', async () => {
      const o = await mkOrder([[salt, 3]])
      await svc.startPick(picker, shop, o)
      await expect(svc.scan(picker, shop, o, { stage: 'PICK', code: 'whatever' })).rejects.toMatchObject({ code: 'WRONG_ITEM' })
      const line = await lineOf(o, 'T11 Salt 1kg')
      expect((await svc.confirmLine(picker, shop, o, line.id, { stage: 'PICK', qty: 2 })).line.picked).toBe(2)
      expect((await svc.confirmLine(picker, shop, o, line.id, { stage: 'PICK', qty: 99 })).line).toMatchObject({ picked: 3, status: 'PICKED' }) // capped at what is needed
      await expect(svc.confirmLine(picker, shop, o, line.id, { stage: 'PICK' })).rejects.toMatchObject({ code: 'OVER_QTY' })
      expect((await query(`SELECT COUNT(*)::int n FROM pos_scans WHERE order_id = $1 AND result = 'MANUAL'`, [o])).rows[0].n).toBe(2)
    })
    it('someone else’s order stays theirs — except for a manager', async () => {
      const o = await mkOrder([[rice, 1]])
      await svc.assignPerson(mgr, shop, o, { role: 'PICKER', userId: picker })
      await expect(svc.startPick(picker2, shop, o)).rejects.toMatchObject({ code: 'OWNED_BY_OTHER' })
      await svc.startPick(picker, shop, o)
      await expect(svc.scan(picker2, shop, o, { stage: 'PICK', code: 'RICE5' })).rejects.toMatchObject({ code: 'OWNED_BY_OTHER' })
      await expect(svc.scan(mgr, shop, o, { stage: 'PICK', code: 'RICE5' })).resolves.toMatchObject({ ok: true })
    })
    it('an unassigned order is claimed by whoever starts it', async () => {
      const o = await mkOrder([[rice, 1]])
      expect((await svc.startPick(allround, shop, o)).fulfillment.picker.name).toBe('T11 Asha Allround')
      await expect(svc.startPick(picker, shop, o)).rejects.toMatchObject({ code: 'OWNED_BY_OTHER' })
    })
    it('scanning before starting, or after the order was cancelled, is refused', async () => {
      const o = await mkOrder([[rice, 1]])
      await expect(svc.scan(picker, shop, o, { stage: 'PICK', code: 'RICE5' })).rejects.toMatchObject({ statusCode: 409 })
      await svc.startPick(picker, shop, o)
      await query(`UPDATE orders SET status = 'CANCELLED' WHERE id = $1`, [o])
      await expect(svc.scan(picker, shop, o, { stage: 'PICK', code: 'RICE5' })).rejects.toMatchObject({ code: 'ORDER_CANCELLED' })
    })
  })

  // ═══ missing items ═════════════════════════════════════════════
  describe('missing items — the picker reports, a manager decides', () => {
    async function withMissingOil() {
      const o = await mkOrder([[rice, 1], [oil, 1]])
      await svc.startPick(picker, shop, o)
      await svc.scan(picker, shop, o, { stage: 'PICK', code: 'RICE5' })
      const oilLine = await lineOf(o, 'T11 Oil 1L')
      await svc.reportMissing(picker, shop, o, oilLine.id, { note: 'shelf empty' })
      return { o, oilLine }
    }
    it('reporting blocks finishing and lands in the attention queue; the picker cannot decide', async () => {
      const { o, oilLine } = await withMissingOil()
      await expect(svc.finishPick(picker, shop, o)).rejects.toMatchObject({ code: 'PICK_INCOMPLETE', details: { blockers: [{ name: 'T11 Oil 1L', reason: 'MISSING_UNDECIDED' }] } })
      await expect(svc.decideMissing(picker, shop, o, oilLine.id, { decision: 'REMOVE' })).rejects.toMatchObject({ statusCode: 403 })
      const att = await svc.attention(mgr, shop)
      expect(att.items.find((i) => i.kind === 'MISSING_ITEM')).toMatchObject({ orderId: o, text: 'T11 Oil 1L: 1 missing — shelf empty', severity: 'HIGH' })
      expect((await svc.board(mgr, shop)).lanes.find((l) => l.id === 'PICKING').orders[0].flags.missing).toBe(true)
    })
    it('REMOVE settles it: picking can finish and nothing is packed for that line', async () => {
      const { o, oilLine } = await withMissingOil()
      const d = await svc.decideMissing(mgr, shop, o, oilLine.id, { decision: 'REMOVE', note: 'customer will be refunded' })
      expect(d.lines.find((l) => l.name === 'T11 Oil 1L')).toMatchObject({ status: 'RESOLVED', decision: 'REMOVE', packTarget: 0 })
      await svc.finishPick(picker, shop, o)
      expect((await svc.attention(mgr, shop)).items.some((i) => i.kind === 'MISSING_ITEM')).toBe(false)
    })
    it('REPLACE needs to say what replaces it, and packs the full approved quantity', async () => {
      const { o, oilLine } = await withMissingOil()
      await expect(svc.decideMissing(mgr, shop, o, oilLine.id, { decision: 'REPLACE' })).rejects.toMatchObject({ code: 'VALIDATION' })
      const d = await svc.decideMissing(mgr, shop, o, oilLine.id, { decision: 'REPLACE', note: 'Sunflower oil 1L' })
      expect(d.lines.find((l) => l.name === 'T11 Oil 1L').packTarget).toBe(1)
    })
    it('a decision can only be made once, and only on a missing item', async () => {
      const { o, oilLine } = await withMissingOil()
      await svc.decideMissing(mgr, shop, o, oilLine.id, { decision: 'REMOVE' })
      await expect(svc.decideMissing(mgr, shop, o, oilLine.id, { decision: 'REFUND' })).rejects.toMatchObject({ code: 'CONFLICT' })
      const riceLine = await lineOf(o, 'T11 Rice 5kg')
      await expect(svc.decideMissing(mgr, shop, o, riceLine.id, { decision: 'REMOVE' })).rejects.toMatchObject({ code: 'CONFLICT' })
    })
    it('a partly picked line keeps what was collected', async () => {
      const o = await mkOrder([[rice, 3]])
      await svc.startPick(picker, shop, o)
      await svc.scan(picker, shop, o, { stage: 'PICK', code: 'RICE5' }); await svc.scan(picker, shop, o, { stage: 'PICK', code: 'RICE5' })
      const line = await lineOf(o, 'T11 Rice 5kg')
      await svc.reportMissing(picker, shop, o, line.id, { note: 'only 2 on shelf' })
      const d = await svc.decideMissing(mgr, shop, o, line.id, { decision: 'REFUND' })
      expect(d.lines[0]).toMatchObject({ picked: 2, required: 3, packTarget: 2 })
    })
    it('finishing picking with items not collected is refused and lists them', async () => {
      const o = await mkOrder([[rice, 2], [oil, 1]])
      await svc.startPick(picker, shop, o)
      await svc.scan(picker, shop, o, { stage: 'PICK', code: 'RICE5' })
      await expect(svc.finishPick(picker, shop, o)).rejects.toMatchObject({ code: 'PICK_INCOMPLETE', details: { blockers: expect.arrayContaining([expect.objectContaining({ reason: 'NOT_PICKED' })]) } })
    })
  })

  // ═══ packing ═══════════════════════════════════════════════════
  describe('packing and verification', () => {
    async function readyToPack() {
      const o = await mkOrder([[rice, 2], [oil, 1]])
      await svc.startPick(picker, shop, o)
      for (const c of ['RICE5', 'RICE5', 'OIL1']) await svc.scan(picker, shop, o, { stage: 'PICK', code: c })
      await svc.finishPick(picker, shop, o)
      return o
    }
    it('after picking the order waits in Packing; a picker cannot take it, a packer can', async () => {
      const o = await readyToPack()
      expect((await svc.detail(mgr, shop, o)).lane).toBe('PACKING')
      await expect(svc.startPack(picker, shop, o)).rejects.toMatchObject({ statusCode: 403 })
      expect((await svc.startPack(packer, shop, o)).fulfillment.packer.name).toBe('T11 Kiran Packer')
    })
    it('packing needs every item verified — a wrong scan is refused, an unverified item blocks finishing', async () => {
      const o = await readyToPack()
      await svc.startPack(packer, shop, o)
      await expect(svc.scan(packer, shop, o, { stage: 'PACK', code: '8901111111111' })).rejects.toMatchObject({ code: 'WRONG_ITEM' })
      await svc.scan(packer, shop, o, { stage: 'PACK', code: 'RICE5' })
      await expect(svc.finishPack(packer, shop, o)).rejects.toMatchObject({ code: 'PACK_INCOMPLETE', details: { blockers: expect.arrayContaining([expect.objectContaining({ name: 'T11 Rice 5kg', needed: 1 }), expect.objectContaining({ name: 'T11 Oil 1L' })]) } })
      expect(await statusOf(o)).toBe('PREPARING')
    })
    it('packing cannot start before picking has finished', async () => {
      const o = await mkOrder([[rice, 1]])
      await svc.startPick(picker, shop, o)
      await expect(svc.startPack(packer, shop, o)).rejects.toMatchObject({ code: 'WRONG_STAGE' })
    })
    it('finishing moves the order to PACKED and queues the invoice for the default printer', async () => {
      await svc.addPrinter(mgr, shop, { name: 'Counter printer', paperMm: 80 })
      const o = await packedOrder({ packages: 2 })
      expect(await statusOf(o)).toBe('PACKED')
      const d = await svc.detail(mgr, shop, o)
      expect(d).toMatchObject({ lane: 'READY', fulfillment: { stage: 'DONE', packages: 2 } })
      expect(d.printJobs.map((j) => [j.kind, j.status])).toEqual([['INVOICE', 'QUEUED']])
      expect(d.printJobs[0].printerName).toBe('Counter printer')
      expect(d.can).toMatchObject({ assignRider: true, finishPack: false })
    })
    it('finishing twice does not print twice', async () => {
      const o = await packedOrder()
      await svc.finishPack(packer, shop, o)
      expect((await query(`SELECT COUNT(*)::int n FROM pos_print_jobs WHERE order_id = $1 AND kind = 'INVOICE'`, [o])).rows[0].n).toBe(1)
    })
    it('when every item was removed there is nothing to pack', async () => {
      const o = await mkOrder([[oil, 1]])
      await svc.startPick(picker, shop, o)
      const line = await lineOf(o, 'T11 Oil 1L')
      await svc.reportMissing(picker, shop, o, line.id, { note: 'none' }); await svc.decideMissing(mgr, shop, o, line.id, { decision: 'REFUND' })
      await svc.finishPick(picker, shop, o); await svc.startPack(packer, shop, o)
      await expect(svc.finishPack(packer, shop, o)).rejects.toMatchObject({ code: 'NOTHING_TO_PACK' })
    })
    it('packing is verified against what was picked, so a replacement is confirmed by hand', async () => {
      const o = await mkOrder([[oil, 1]])
      await svc.startPick(picker, shop, o)
      const line = await lineOf(o, 'T11 Oil 1L')
      await svc.reportMissing(picker, shop, o, line.id, { note: 'out' }); await svc.decideMissing(mgr, shop, o, line.id, { decision: 'REPLACE', note: 'Sunflower oil' })
      await svc.finishPick(picker, shop, o); await svc.startPack(packer, shop, o)
      await expect(svc.scan(packer, shop, o, { stage: 'PACK', code: '8900000000002' })).resolves.toMatchObject({ ok: true }) // the same shelf code is accepted; a different one is not
      expect((await svc.detail(packer, shop, o)).blockers.pack).toEqual([])
    })
  })

  // ═══ rider & handover ══════════════════════════════════════════
  describe('rider assignment and handover', () => {
    it('only managers assign, only a packed order, only a rider this store may use', async () => {
      const o = await mkOrder([[rice, 1]])
      await expect(svc.assignRider(mgr, shop, o, rider1)).rejects.toMatchObject({ code: 'WRONG_STAGE' })
      const p = await packedOrder()
      await expect(svc.assignRider(packer, shop, p, rider1)).rejects.toMatchObject({ statusCode: 403 })
      await expect(svc.assignRider(mgr, shop, p, cust)).rejects.toMatchObject({ code: 'RIDER_NOT_FOUND' })
      await query(`UPDATE rider_profiles SET shop_id = $2 WHERE user_id = $1`, [rider2, shopB])
      await expect(svc.assignRider(mgr, shop, p, rider2)).rejects.toMatchObject({ code: 'RIDER_NOT_FOUND' }) // belongs to another store
    })
    it('assigning mints a pickup token and queues one label per package', async () => {
      const p = await packedOrder({ packages: 2 })
      const d = await svc.assignRider(mgr, shop, p, rider1)
      expect(d).toMatchObject({ lane: 'WAITING_RIDER', rider: { name: 'T11 Ravi Rider', pickup: 'ACTIVE' } })
      expect(d.printJobs.filter((j) => j.kind === 'LABEL').map((j) => [j.packageNo, j.packageTotal, j.status])).toEqual(expect.arrayContaining([[1, 2, 'QUEUED'], [2, 2, 'QUEUED']]))
      expect((await query(`SELECT COUNT(*)::int n FROM order_pickup_tokens WHERE order_id = $1 AND status = 'ACTIVE'`, [p])).rows[0].n).toBe(1)
    })
    it('re-assigning kills the old QR and the old labels, and queues fresh ones for the new rider', async () => {
      const p = await packedOrder()
      await svc.assignRider(mgr, shop, p, rider1)
      const before = (await query(`SELECT token FROM order_pickup_tokens WHERE order_id = $1 AND status = 'ACTIVE'`, [p])).rows[0].token
      const d = await svc.assignRider(mgr, shop, p, rider2)
      expect(d.rider.name).toBe('T11 Raju Rider')
      expect((await query(`SELECT status FROM order_pickup_tokens WHERE token = $1`, [before])).rows[0].status).toBe('REVOKED')
      const labels = d.printJobs.filter((j) => j.kind === 'LABEL')
      expect(labels.map((j) => j.status).sort()).toEqual(['CANCELLED', 'QUEUED'])
      expect((await svc.timeline(mgr, shop, p)).find((t) => t.kind === 'RIDER_ASSIGNED' && /replacing T11 Ravi/.test(t.text))).toBeTruthy()
    })
    it('assigning the same rider again changes nothing', async () => {
      const p = await packedOrder()
      await svc.assignRider(mgr, shop, p, rider1)
      await svc.assignRider(mgr, shop, p, rider1)
      expect((await query(`SELECT COUNT(*)::int n FROM pos_print_jobs WHERE order_id = $1 AND kind = 'LABEL'`, [p])).rows[0].n).toBe(1)
    })
    it('the printed label carries the rider’s real, current pickup QR and no customer details', async () => {
      const p = await packedOrder()
      await svc.assignRider(mgr, shop, p, rider1)
      const job = (await svc.jobs(mgr, shop, { status: 'QUEUED' })).find((j) => j.kind === 'LABEL')
      const doc = await svc.document(packer, shop, job.id)
      expect(doc.html).toMatch(/Pickup QR/)
      expect(doc.html).toContain('Rider: T11 Ravi Rider')
      expect(doc.html).not.toMatch(/Priya|9876543210|Flat 4B/)
      expect(doc.html).toContain('Salt Lake Sector 5, Kolkata 700091')
    })
    it('handover needs the rider to have scanned first, is recorded once, and names the staff member', async () => {
      const p = await packedOrder()
      await svc.assignRider(mgr, shop, p, rider1)
      await expect(svc.handover(packer, shop, p)).rejects.toMatchObject({ code: 'NOT_SCANNED', message: expect.stringMatching(/Ravi/) })
      await query(`UPDATE order_pickup_tokens SET status = 'VERIFIED', verified_at = NOW(), verified_by_rider_id = $2 WHERE order_id = $1 AND status = 'ACTIVE'`, [p, rider1]) // the rider scanned
      const d = await svc.handover(packer, shop, p)
      expect(d.handover).toMatchObject({ by: 'T11 Kiran Packer', scan: 'VERIFIED' })
      await svc.handover(allround, shop, p)
      expect((await query(`SELECT COUNT(*)::int n FROM pos_handovers WHERE order_id = $1`, [p])).rows[0].n).toBe(1)
      await expect(svc.handover(picker, shop, p)).rejects.toMatchObject({ statusCode: 403 })
    })
    it('a revoked or missing pickup QR cannot be handed over', async () => {
      const p = await packedOrder()
      await expect(svc.handover(packer, shop, p)).rejects.toMatchObject({ code: 'NO_RIDER' })
      await svc.assignRider(mgr, shop, p, rider1)
      await query(`UPDATE order_pickup_tokens SET status = 'REVOKED' WHERE order_id = $1`, [p])
      await expect(svc.handover(packer, shop, p)).rejects.toMatchObject({ code: 'NO_VALID_PICKUP' })
    })
    it('rider operations view: Available / Offline / Assigned → Coming → At store → Picked up → On delivery', async () => {
      await query(`UPDATE rider_profiles SET is_online = false WHERE user_id = $1`, [rider2])
      const states = async () => Object.fromEntries((await svc.riders(mgr, shop)).filter((r) => r.name.startsWith('T11')).map((r) => [r.name.replace('T11 ', ''), r.state]))
      expect(await states()).toEqual({ 'Ravi Rider': 'AVAILABLE', 'Raju Rider': 'OFFLINE' })
      const p = await packedOrder()
      await svc.assignRider(mgr, shop, p, rider1)
      expect((await states())['Ravi Rider']).toBe('COMING_TO_STORE')
      await query(`UPDATE order_pickup_tokens SET status = 'VERIFIED' WHERE order_id = $1 AND status = 'ACTIVE'`, [p])
      expect((await states())['Ravi Rider']).toBe('AT_STORE')
      await query(`UPDATE delivery_assignments SET status = 'PICKED_UP', picked_up_at = NOW() WHERE order_id = $1 AND status <> 'CANCELLED'`, [p])
      expect((await states())['Ravi Rider']).toBe('PICKED_UP')
      await query(`UPDATE delivery_assignments SET status = 'IN_TRANSIT' WHERE order_id = $1 AND status <> 'CANCELLED'`, [p])
      expect((await states())['Ravi Rider']).toBe('ON_DELIVERY')
    })
    it('after pickup the order cannot be re-assigned', async () => {
      const p = await packedOrder()
      await svc.assignRider(mgr, shop, p, rider1)
      await query(`UPDATE delivery_assignments SET status = 'PICKED_UP', picked_up_at = NOW() WHERE order_id = $1 AND status <> 'CANCELLED'`, [p])
      await expect(svc.assignRider(mgr, shop, p, rider2)).rejects.toMatchObject({ code: 'ALREADY_PICKED_UP' })
    })
  })

  // ═══ printing ══════════════════════════════════════════════════
  describe('printers and the print queue', () => {
    it('the first printer becomes the default; a new default replaces it; names are unique per store', async () => {
      let list = await svc.addPrinter(mgr, shop, { name: 'Counter' })
      expect(list[0]).toMatchObject({ name: 'Counter', isDefault: true, paperMm: 80, online: false })
      list = await svc.addPrinter(mgr, shop, { name: 'Packing bench', paperMm: 58, isDefault: true })
      expect(list.map((p) => [p.name, p.isDefault])).toEqual([['Packing bench', true], ['Counter', false]])
      await expect(svc.addPrinter(mgr, shop, { name: 'counter' })).rejects.toMatchObject({ statusCode: 409, code: 'DUPLICATE_PRINTER' })
      await expect(svc.addPrinter(packer, shop, { name: 'Other' })).rejects.toMatchObject({ statusCode: 403 })
    })
    it('removing the default hands the role to another printer; queued jobs go back to “any printer”', async () => {
      const a = (await svc.addPrinter(mgr, shop, { name: 'A' }))[0]
      await svc.addPrinter(mgr, shop, { name: 'B' })
      const o = await packedOrder()
      expect((await svc.jobs(mgr, shop))[0].printerName).toBe('A')
      const list = await svc.removePrinter(mgr, shop, a.id)
      expect(list.map((p) => [p.name, p.isDefault])).toEqual([['B', true]])
      expect((await svc.jobs(mgr, shop))[0].printerId).toBeNull()
      void o
    })
    it('a station that reports in is online; silence for 90 seconds is offline', async () => {
      const p = (await svc.addPrinter(mgr, shop, { name: 'Counter' }))[0]
      await svc.heartbeat(packer, shop, p.id)
      expect((await svc.printers(mgr, shop))[0].online).toBe(true)
      clock = new Date(Date.now() + 120_000)
      expect((await svc.printers(mgr, shop))[0].online).toBe(false)
      await expect(svc.heartbeat(packer, shop, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ statusCode: 404 })
    })
    it('only one station can take a queued job', async () => {
      await packedOrder()
      const job = (await svc.jobs(mgr, shop))[0]
      const res = await Promise.allSettled([svc.claimJob(packer, shop, job.id), svc.claimJob(allround, shop, job.id)])
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(res.find((r) => r.status === 'rejected').reason).toMatchObject({ code: 'JOB_TAKEN' })
    })
    it('a job is PRINTED only when the station says so, and FAILED when it reports a problem', async () => {
      await packedOrder()
      const job = (await svc.jobs(mgr, shop))[0]
      await expect(svc.reportJob(packer, shop, job.id, { ok: true })).rejects.toMatchObject({ code: 'NOT_PRINTING' }) // nobody took it yet
      await svc.claimJob(packer, shop, job.id)
      const failed = await svc.reportJob(packer, shop, job.id, { ok: false, error: 'Out of paper' })
      expect(failed).toMatchObject({ status: 'FAILED', error: 'Out of paper', attempts: 1, canRetry: true })
      const att = await svc.attention(mgr, shop)
      expect(att.items.find((i) => i.kind === 'PRINT_FAILED')).toMatchObject({ text: 'Invoice did not print: Out of paper', jobId: job.id })
      await svc.retryJob(packer, shop, job.id)
      await svc.claimJob(packer, shop, job.id)
      expect(await svc.reportJob(packer, shop, job.id, { ok: true })).toMatchObject({ status: 'PRINTED', attempts: 2 })
      expect((await svc.attention(mgr, shop)).items.some((i) => i.kind === 'PRINT_FAILED')).toBe(false)
    })
    it('retries are bounded, a printed job cannot be “retried” but can be reprinted as a new job', async () => {
      await packedOrder()
      const job = (await svc.jobs(mgr, shop))[0]
      for (let i = 0; i < T.MAX_PRINT_ATTEMPTS; i++) {
        await svc.claimJob(packer, shop, job.id)
        await svc.reportJob(packer, shop, job.id, { ok: false, error: 'jam' })
        if (i < T.MAX_PRINT_ATTEMPTS - 1) await svc.retryJob(packer, shop, job.id)
      }
      await expect(svc.retryJob(packer, shop, job.id)).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' })
      const copy = await svc.reprint(packer, shop, job.id)
      expect(copy).toMatchObject({ status: 'QUEUED', reprintOf: job.id, attempts: 0 })
      await expect(svc.retryJob(packer, shop, copy.id)).rejects.toMatchObject({ code: 'NOT_FAILED' })
      await expect(svc.reprint(packer, shop, copy.id)).rejects.toMatchObject({ code: 'STILL_QUEUED' })
      await expect(svc.reprint(picker, shop, job.id)).rejects.toMatchObject({ statusCode: 403 })
    })
    it('a job a station took but never confirmed becomes FAILED, not “printing” forever', async () => {
      await packedOrder()
      const job = (await svc.jobs(mgr, shop))[0]
      await svc.claimJob(packer, shop, job.id)
      await query(`UPDATE pos_print_jobs SET claimed_at = NOW() - interval '5 minutes' WHERE id = $1`, [job.id])
      const j = (await svc.jobs(mgr, shop)).find((x) => x.id === job.id)
      expect(j).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/did not confirm/) })
    })
    it('a label cannot be reprinted when there is no valid QR', async () => {
      const p = await packedOrder()
      await svc.assignRider(mgr, shop, p, rider1)
      const label = (await svc.jobs(mgr, shop)).find((j) => j.kind === 'LABEL')
      await svc.claimJob(packer, shop, label.id); await svc.reportJob(packer, shop, label.id, { ok: true })
      await query(`UPDATE order_pickup_tokens SET status = 'REVOKED' WHERE order_id = $1`, [p])
      await expect(svc.reprint(packer, shop, label.id)).rejects.toMatchObject({ code: 'NO_VALID_PICKUP' })
    })
    it('the invoice shows the order, escaped, in the right paper size; a test page can be sent to a printer', async () => {
      const pr = (await svc.addPrinter(mgr, shop, { name: 'Narrow', paperMm: 58 }))[0]
      await packedOrder()
      const inv = (await svc.jobs(mgr, shop)).find((j) => j.kind === 'INVOICE')
      const doc = await svc.document(packer, shop, inv.id)
      expect(doc).toMatchObject({ kind: 'INVOICE', paperMm: 58 })
      expect(doc.html).toContain('T11 Rice 5kg')
      expect(doc.html).toContain('T11 Shop P1')
      await svc.testPrint(mgr, shop, pr.id)
      expect((await svc.jobs(mgr, shop)).some((j) => j.kind === 'TEST' && j.status === 'QUEUED')).toBe(true)
      await expect(svc.testPrint(packer, shop, pr.id)).rejects.toMatchObject({ statusCode: 403 })
    })
    it('print jobs of another store do not exist here', async () => {
      await packedOrder()
      const job = (await svc.jobs(mgr, shop))[0]
      await expect(svc.claimJob(outsider, shopB, job.id)).rejects.toMatchObject({ code: 'JOB_TAKEN' })
      await expect(svc.document(outsider, shopB, job.id)).rejects.toMatchObject({ statusCode: 404 })
      expect(await svc.jobs(outsider, shopB)).toEqual([])
    })
  })

  // ═══ the live board ════════════════════════════════════════════
  describe('the live board', () => {
    const laneOf = (b, id) => b.lanes.find((l) => l.id === id).orders.map((o) => o.orderNumber)
    it('puts every active order in its lane and leaves finished ones off', async () => {
      const a = await mkOrder([[rice, 1]])                                   // New
      const b = await mkOrder([[rice, 1]]); await svc.startPick(picker, shop, b)  // Picking
      const c = await mkOrder([[rice, 1]]); await svc.startPick(picker, shop, c); await svc.scan(picker, shop, c, { stage: 'PICK', code: 'RICE5' }); await svc.finishPick(picker, shop, c) // Packing
      const d = await packedOrder()                                          // Ready
      const e = await packedOrder(); await svc.assignRider(mgr, shop, e, rider1)  // Waiting for rider
      const f = await packedOrder(); await svc.assignRider(mgr, shop, f, rider2)
      await query(`UPDATE orders SET status = 'OUT_FOR_DELIVERY' WHERE id = $1`, [f]); await query(`UPDATE delivery_assignments SET status = 'PICKED_UP', picked_up_at = NOW() WHERE order_id = $1 AND status <> 'CANCELLED'`, [f]) // Picked up
      const g = await mkOrder([[rice, 1]], { status: 'DELIVERED' }); const h = await mkOrder([[rice, 1]], { status: 'CANCELLED' }); const i = await mkOrder([[rice, 1]], { status: 'PENDING' })
      const nums = Object.fromEntries((await query(`SELECT id, order_number FROM orders WHERE id = ANY($1)`, [[a, b, c, d, e, f, g, h, i]])).rows.map((r) => [r.id, r.order_number]))
      const board = await svc.board(mgr, shop)
      expect(board.lanes.map((l) => l.id)).toEqual(['NEW', 'PICKING', 'PACKING', 'READY', 'WAITING_RIDER', 'PICKED_UP', 'OUT_FOR_DELIVERY'])
      expect(laneOf(board, 'NEW')).toEqual([nums[a]])
      expect(laneOf(board, 'PICKING')).toEqual([nums[b]])
      expect(laneOf(board, 'PACKING')).toEqual([nums[c]])
      expect(laneOf(board, 'READY')).toEqual([nums[d]])
      expect(laneOf(board, 'WAITING_RIDER')).toEqual([nums[e]])
      expect(laneOf(board, 'PICKED_UP')).toEqual([nums[f]])
      expect(board.totals.active).toBe(6)
    })
    it('only this store’s orders appear', async () => {
      await mkOrder([[rice, 1]])
      await mkOrder([[rice, 1]], { shopId: shopB })
      expect((await svc.board(mgr, shop)).totals.active).toBe(1)
      expect((await svc.board(outsider, shopB)).totals.active).toBe(1)
    })
    it('shows who has it, the area (no customer details), progress, and how long it has waited', async () => {
      const o = await mkOrder([[rice, 2], [oil, 1]])
      await svc.startPick(picker, shop, o); await svc.scan(picker, shop, o, { stage: 'PICK', code: 'RICE5' })
      clock = new Date(Date.now() + 25 * 60_000)
      const card = (await svc.board(viewer, shop)).lanes.find((l) => l.id === 'PICKING').orders[0]
      expect(card).toMatchObject({ picker: { name: 'T11 Pia Picker' }, area: 'Salt Lake Sector 5, Kolkata 700091', items: { lines: 2, units: 3 }, progress: { done: 0, total: 2 }, late: true })
      expect(card.waitingMinutes).toBeGreaterThanOrEqual(24)
      expect(JSON.stringify(card)).not.toMatch(/Priya|9876543210|Flat 4B/)
    })
    it('the oldest order in a lane is listed first, and the printing summary is on the board', async () => {
      const a = await mkOrder([[rice, 1]]); clock = new Date(Date.now() + 60_000); const b = await mkOrder([[rice, 1]])
      const names = (await query(`SELECT id, order_number FROM orders WHERE id IN ($1,$2)`, [a, b])).rows
      const board = await svc.board(mgr, shop)
      expect(laneOf(board, 'NEW')[0]).toBe(names.find((r) => r.id === a).order_number)
      expect(board.printing).toEqual({ printers: 0, online: 0, queued: 0, failed: 0 })
    })
    it('anyone on the team can look, nobody else', async () => {
      await expect(svc.board(viewer, shop)).resolves.toBeTruthy()
      await expect(svc.board(outsider, shop)).rejects.toMatchObject({ statusCode: 403 })
      await expect(svc.board(cust, shop)).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  // ═══ needs attention ═══════════════════════════════════════════
  describe('needs attention', () => {
    it('flags orders waiting too long — and stops flagging once they move on', async () => {
      const o = await mkOrder([[rice, 1]])
      expect((await svc.attention(mgr, shop)).items.some((i) => i.kind === 'DELAY')).toBe(false)
      clock = new Date(Date.now() + 8 * 60_000)
      const d = (await svc.attention(mgr, shop)).items.find((i) => i.kind === 'DELAY')
      expect(d).toMatchObject({ orderId: o, text: expect.stringMatching(/Waiting \d+ min in New/), ref: 'NEW' })
      await svc.startPick(picker, shop, o)
      expect((await svc.attention(mgr, shop)).items.some((i) => i.kind === 'DELAY')).toBe(false)
    })
    it('a packed order with no rider is flagged after 5 minutes', async () => {
      const o = await packedOrder()
      expect((await svc.attention(mgr, shop)).items.some((i) => i.kind === 'NO_RIDER')).toBe(false)
      clock = new Date(Date.now() + 6 * 60_000)
      expect((await svc.attention(mgr, shop)).items.find((i) => i.kind === 'NO_RIDER')).toMatchObject({ orderId: o, severity: 'HIGH' })
      await svc.assignRider(mgr, shop, o, rider1)
      expect((await svc.attention(mgr, shop)).items.some((i) => i.kind === 'NO_RIDER')).toBe(false)
    })
    it('a rejected rider QR scan shows up with the reason', async () => {
      const o = await packedOrder(); await svc.assignRider(mgr, shop, o, rider1)
      await query(`INSERT INTO qr_scan_logs (order_id, rider_id, result, failure_reason) VALUES ($1,$2,'REJECTED','WRONG_RIDER')`, [o, rider2])
      expect((await svc.attention(mgr, shop)).items.find((i) => i.kind === 'QR_REJECTED')).toMatchObject({ text: 'Pickup QR rejected: wrong rider' })
    })
    it('a pickup with no store handover record is flagged', async () => {
      const o = await packedOrder(); await svc.assignRider(mgr, shop, o, rider1)
      await query(`UPDATE delivery_assignments SET status = 'PICKED_UP', picked_up_at = NOW() WHERE order_id = $1 AND status <> 'CANCELLED'`, [o])
      expect((await svc.attention(mgr, shop)).items.some((i) => i.kind === 'UNRELEASED_PICKUP')).toBe(true)
      await query(`UPDATE order_pickup_tokens SET status = 'VERIFIED' WHERE order_id = $1 AND status = 'ACTIVE'`, [o])
      await svc.handover(packer, shop, o)
      expect((await svc.attention(mgr, shop)).items.some((i) => i.kind === 'UNRELEASED_PICKUP')).toBe(false)
    })
    it('wrong scans, payment problems and orders cancelled mid-pick are flagged', async () => {
      const o = await mkOrder([[rice, 1]]); await svc.startPick(picker, shop, o)
      await expect(svc.scan(picker, shop, o, { stage: 'PICK', code: 'NOPE' })).rejects.toBeTruthy()
      await expect(svc.scan(picker, shop, o, { stage: 'PICK', code: 'NOPE2' })).rejects.toBeTruthy()
      expect((await svc.attention(mgr, shop)).items.find((i) => i.kind === 'WRONG_SCAN').text).toBe('2 wrong scans while picking')
      await query(`UPDATE orders SET payment_status = 'FAILED' WHERE id = $1`, [o])
      expect((await svc.attention(mgr, shop)).items.some((i) => i.kind === 'PAYMENT_PROBLEM')).toBe(true)
      await query(`UPDATE orders SET payment_status = 'PAID', status = 'CANCELLED', updated_at = NOW() WHERE id = $1`, [o])
      expect((await svc.attention(mgr, shop)).items.some((i) => i.kind === 'CANCELLED_IN_PROGRESS')).toBe(true)
    })
    it('a printer that has gone quiet while prints wait is reported', async () => {
      await svc.addPrinter(mgr, shop, { name: 'Counter' })
      await packedOrder()
      await query(`UPDATE pos_print_jobs SET created_at = NOW() - interval '10 minutes' WHERE shop_id = $1 AND status = 'QUEUED'`, [shop])
      const item = (await svc.attention(mgr, shop)).items.find((i) => i.kind === 'PRINTER_OFFLINE')
      expect(item).toMatchObject({ resolvable: false, text: 'Counter is offline — 1 print waiting' })
      const p = (await svc.printers(mgr, shop))[0]
      await svc.heartbeat(packer, shop, p.id)
      expect((await svc.attention(mgr, shop)).items.some((i) => i.kind === 'PRINTER_OFFLINE')).toBe(false)
    })
    it('with no printer at all, waiting prints say so', async () => {
      await packedOrder()
      await query(`UPDATE pos_print_jobs SET created_at = NOW() - interval '10 minutes' WHERE shop_id = $1`, [shop])
      expect((await svc.attention(mgr, shop)).items.find((i) => i.kind === 'PRINTER_OFFLINE').text).toMatch(/no printer is set up/)
    })
    it('a manager resolves an item with a note; it stays resolved and is in the audit trail; nobody else can', async () => {
      const o = await mkOrder([[rice, 1]])
      clock = new Date(Date.now() + 8 * 60_000)
      const item = (await svc.attention(mgr, shop)).items.find((i) => i.kind === 'DELAY')
      await expect(svc.resolveAttention(picker, shop, { orderId: o, kind: item.kind, ref: item.ref })).rejects.toMatchObject({ statusCode: 403 })
      const after = await svc.resolveAttention(mgr, shop, { orderId: o, kind: item.kind, ref: item.ref, note: 'customer asked to wait' })
      expect(after.items.some((i) => i.kind === 'DELAY')).toBe(false)
      expect((await svc.timeline(mgr, shop, o)).some((t) => /resolved: Order is waiting too long — customer asked to wait/.test(t.text))).toBe(true)
      await expect(svc.resolveAttention(mgr, shop, { orderId: o, kind: 'NOPE' })).rejects.toMatchObject({ code: 'VALIDATION' })
    })
    it('most urgent first', async () => {
      const o = await mkOrder([[rice, 1], [oil, 1]]); await svc.startPick(picker, shop, o)
      const l = await lineOf(o, 'T11 Oil 1L'); await svc.reportMissing(picker, shop, o, l.id, { note: 'x' })
      clock = new Date(Date.now() + 30 * 60_000)
      const kinds = (await svc.attention(mgr, shop)).items.map((i) => i.kind)
      expect(kinds[0]).toBe('MISSING_ITEM')
      expect(kinds).toContain('DELAY')
    })
  })

  // ═══ audit trail & performance ═════════════════════════════════
  describe('audit trail', () => {
    it('one chronological story: who did what, from order received to handover', async () => {
      const o = await packedOrder()
      await svc.assignRider(mgr, shop, o, rider1)
      await query(`UPDATE order_pickup_tokens SET status = 'VERIFIED' WHERE order_id = $1 AND status = 'ACTIVE'`, [o])
      await query(`INSERT INTO qr_scan_logs (order_id, rider_id, result) VALUES ($1,$2,'SUCCESS')`, [o, rider1])
      await svc.handover(packer, shop, o)
      const t = await svc.timeline(viewer, shop, o)
      const texts = t.map((x) => x.text)
      const at = (re) => texts.findIndex((x) => re.test(x))
      expect(at(/started picking/)).toBeGreaterThanOrEqual(0)
      expect(at(/started picking/)).toBeLessThan(at(/finished picking/))
      expect(at(/finished picking/)).toBeLessThan(at(/started packing/))
      expect(at(/started packing/)).toBeLessThan(at(/completed packing/))
      expect(at(/completed packing/)).toBeLessThan(at(/assigned/i))
      expect(texts.join('|')).toMatch(/T11 Pia Picker started picking/)
      expect(texts.join('|')).toMatch(/Order .*being prepared/)
      expect(texts.join('|')).toMatch(/Ravi Rider scanned the pickup QR — verified/)
      expect(texts.join('|')).toMatch(/T11 Kiran Packer handed the package to T11 Ravi Rider/)
      expect([...t].map((x) => new Date(x.at).getTime())).toEqual([...t].map((x) => new Date(x.at).getTime()).sort((a, b) => a - b))
    })
    it('another store cannot read it', async () => {
      const o = await mkOrder([[rice, 1]])
      await expect(svc.timeline(outsider, shopB, o)).rejects.toMatchObject({ statusCode: 404 })
    })
  })

  describe('performance', () => {
    it('adds up picked/packed orders, times, mistakes, missing reports, rider wait and reassignments', async () => {
      const t0 = new Date()
      const done = async (pickMin, packMin) => {
        const o = await packedOrder()
        const base = new Date(t0.getTime() - 3_600_000)
        await query(`UPDATE pos_fulfillments SET pick_started_at = $2, pick_finished_at = $3, pack_started_at = $3, pack_finished_at = $4 WHERE order_id = $1`, [o, base, new Date(base.getTime() + pickMin * 60_000), new Date(base.getTime() + (pickMin + packMin) * 60_000)])
        return o
      }
      const o1 = await done(10, 4), o2 = await done(20, 6)
      // a wrong scan by the picker on a third order, and a missing report
      const o3 = await mkOrder([[rice, 1], [oil, 1]]); await svc.startPick(picker, shop, o3)
      await expect(svc.scan(picker, shop, o3, { stage: 'PICK', code: 'NOPE' })).rejects.toBeTruthy()
      await svc.reportMissing(picker, shop, o3, (await lineOf(o3, 'T11 Oil 1L')).id, { note: 'out' })
      // rider: assigned + picked up 12 minutes after packing finished; one reassignment
      await svc.assignRider(mgr, shop, o1, rider1); await svc.assignRider(mgr, shop, o1, rider2)
      await query(`UPDATE delivery_assignments SET status = 'PICKED_UP', picked_up_at = (SELECT pack_finished_at + interval '12 minutes' FROM pos_fulfillments WHERE order_id = $1) WHERE order_id = $1 AND status <> 'CANCELLED'`, [o1])
      void o2

      const r = await svc.performance(mgr, shop)
      expect(r.totals).toMatchObject({ pickedOrders: 2, packedOrders: 2, avgPickMinutes: 15, avgPackMinutes: 5, scanMistakes: 1, missingReports: 1, reassignments: 1, riderWaitMedianMinutes: 12, riderWaitSamples: 1 })
      const pia = r.people.find((p) => p.name === 'T11 Pia Picker')
      expect(pia).toMatchObject({ picked: { orders: 2, avgMinutes: 15, medianMinutes: 15 }, missingReports: 1 })
      expect(pia.scans).toMatchObject({ mistakes: 1 })
      expect(pia.scans.mistakeRate).toBeGreaterThan(0)
      expect(r.people.find((p) => p.name === 'T11 Kiran Packer')).toMatchObject({ packed: { orders: 2, avgMinutes: 5 } })
    })
    it('only managers see it; the range is validated', async () => {
      await expect(svc.performance(viewer, shop)).rejects.toMatchObject({ statusCode: 403 })
      await expect(svc.performance(mgr, shop, { from: '2026-10-05', to: '2026-10-01' })).rejects.toMatchObject({ code: 'VALIDATION' })
      expect((await svc.performance(mgr, shop)).totals.pickedOrders).toBe(0)
    })
  })
})
