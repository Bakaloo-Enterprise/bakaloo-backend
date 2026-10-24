/**
 * Data Explorer on a real Postgres. Opt-in:  WA_CRM_DB_TEST=1 npx vitest run tests/integration/erp-explorer.db.test.js
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PH = (n) => `9999024${String(n).padStart(3, '0')}`
const at = (hhmm) => `2026-03-10 ${hhmm}:00+05:30`

describe.skipIf(!enabled)('Data Explorer', () => {
  let query, closePool, explorer, A, B, evil, plain
  let n = 0
  async function order({ shop = A, user = plain, status, total, created, pay = 'PAID', history = [] }) {
    const id = (await query(
      `INSERT INTO orders (order_number,user_id,shop_id,status,items,subtotal,total_amount,delivery_address,payment_method,payment_status,created_at) VALUES ($1,$2,$3,$4::order_status,'[]'::jsonb,$5,$5,'{}'::jsonb,'ONLINE',$6,$7) RETURNING id`,
      [`T24-${++n}`, user, shop, status, total, pay, created])).rows[0].id
    for (const [from, to, time] of history) await query(`INSERT INTO order_status_history (order_id, from_status, to_status, changed_at) VALUES ($1,$2,$3,$4)`, [id, from, to, time])
    return id
  }
  async function cleanup() {
    await query(`DELETE FROM refund_requests WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'T24-%')`)
    await query(`DELETE FROM orders WHERE order_number LIKE 'T24-%'`)
    await query(`DELETE FROM shops WHERE slug LIKE 't24-shop-%'`)
    await query(`DELETE FROM users WHERE phone LIKE '9999024%'`)
  }
  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { ExplorerRepository } = await import('../../src/modules/erp/explorer.repository.js')
    const { ExplorerService } = await import('../../src/modules/erp/explorer.service.js')
    await cleanup()
    explorer = new ExplorerService({ repo: new ExplorerRepository(), now: () => new Date('2026-03-10T21:00:00+05:30') })
    const mkUser = async (i, name) => (await query(`INSERT INTO users (phone,name,email,role) VALUES ($1,$2,$3,'CUSTOMER') RETURNING id`, [PH(i), name, `${PH(i)}@t.local`])).rows[0].id
    plain = await mkUser(1, 'T24 Asha'); evil = await mkUser(2, '=HYPERLINK("http://evil.example","click")')
    const mkShop = async (c) => (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ($1,$2,$3,'DB 24','Kolkata','WB','700091',22.5,88.3,true) RETURNING id`, [`T24 Shop ${c}`, `t24-shop-${c}`, `T24${c}`])).rows[0].id
    A = await mkShop('A'); B = await mkShop('B')
    await order({ status: 'DELIVERED', total: 100, created: at('10:00') })                                         // T24-1 sale
    await order({ status: 'PENDING', total: 250, created: at('10:10'), pay: 'PENDING' })                          // T24-2 unpaid
    await order({ status: 'CANCELLED', total: 150, created: at('10:20'), history: [[null, 'CONFIRMED', at('10:21')], ['CONFIRMED', 'CANCELLED', at('10:40')]] }) // T24-3 cancelled
    await order({ status: 'REFUNDED', total: 400, created: at('10:30'), history: [['DELIVERED', 'REFUNDED', at('14:00')]] })   // T24-4 refunded by hand, in full
    const partly = await order({ status: 'REFUNDED', total: 200, created: at('10:40'), history: [['DELIVERED', 'REFUNDED', at('15:00')]] }) // T24-5 part refund
    await query(`INSERT INTO refund_requests (order_id, user_id, description, status, refund_amount, refund_to, processed_at) VALUES ($1,$2,'t','APPROVED',50,'wallet',$3)`, [partly, plain, at('15:00')])
    await order({ user: evil, status: 'DELIVERED', total: 60, created: at('11:00') })                               // T24-6 hostile name
    await order({ shop: B, status: 'DELIVERED', total: 80, created: at('12:00') })                                 // T24-7 other store
  })
  afterAll(async () => { await cleanup(); await closePool() })

  const day = { period: 'custom', from: '2026-03-10', to: '2026-03-10' }
  const byNo = (r) => Object.fromEntries(r.rows.map((x) => [x.number, x]))

  it('says for every order whether it counts as a sale, and why', async () => {
    const r = byNo(await explorer.list('orders', { ...day, shopId: A, limit: 50 }))
    expect(r['T24-1'].treatment).toBe('Sale')
    expect(r['T24-2'].treatment).toBe('Unpaid — not a sale')
    expect(r['T24-3'].treatment).toBe('Cancelled — not a sale')
    expect(r['T24-4']).toMatchObject({ treatment: 'Refunded in full — not counted', refunded: 400 })
    expect(r['T24-5']).toMatchObject({ treatment: 'Sale — part refunded', refunded: 50 })
  })
  it('keeps stores apart and counts the total for paging', async () => {
    const a = await explorer.list('orders', { ...day, shopId: A, limit: 2, offset: 0 })
    expect(a.total).toBe(6)
    expect(a.rows).toHaveLength(2)
    const b = await explorer.list('orders', { ...day, shopId: B })
    expect(b.rows.map((x) => x.number)).toEqual(['T24-7'])
  })
  it('masks customer phones', async () => {
    const r = await explorer.list('orders', { ...day, shopId: A })
    expect(r.rows.every((x) => /^\d{2}••••\d{4}$/.test(x.phone))).toBe(true)
  })
  it('searches by order number or name, treating % and _ as plain text', async () => {
    expect((await explorer.list('orders', { ...day, q: 'T24-3' })).rows.map((x) => x.number)).toEqual(['T24-3'])
    expect((await explorer.list('orders', { ...day, q: 'asha', shopId: A })).total).toBe(5)
    expect((await explorer.list('orders', { ...day, q: '%' })).total).toBe(0) // a literal percent sign, not "everything"
  })
  it('lists refunds with how they count; cancelled-then-refunded orders are flagged', async () => {
    const r = await explorer.list('refunds', { ...day, shopId: A })
    const by = Object.fromEntries(r.rows.map((x) => [x.number, x]))
    expect(by['T24-4']).toMatchObject({ refunded: 400, full: true, note: 'Refunded in full' })
    expect(by['T24-5']).toMatchObject({ refunded: 50, full: false, note: 'Part refund' })
  })
  it('exports CSV with a hostile customer name made harmless', async () => {
    const out = await explorer.exportCsv('orders', { ...day, shopId: A })
    expect(out.filename).toBe('orders-2026-03-10_to_2026-03-10.csv')
    expect(out.csv.startsWith('﻿Order,Placed,')).toBe(true)
    expect(out.csv).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`)
    expect(out.csv).not.toMatch(/(^|,)=HYPERLINK/m)
    expect(out.truncated).toBe(false)
  })
  it('rejects an unknown record type', async () => {
    await expect(explorer.list('passwords', day)).rejects.toThrow(/Unknown record type/)
  })
  it('every record type answers without error', async () => {
    for (const k of ['orders', 'lines', 'movements', 'purchases', 'refunds', 'expenses']) {
      const r = await explorer.list(k, { period: '30d', limit: 5 })
      expect(r.columns.length, k).toBeGreaterThan(3)
    }
  })
})
