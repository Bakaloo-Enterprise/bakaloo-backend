/**
 * Operations ERP — Accounting on a real Postgres. Opt-in:  WA_CRM_DB_TEST=1 npx vitest run tests/integration/erp-accounting.db.test.js
 * One hand-worked month (2026-03); every expected figure is on paper in the comments. Sales profit is a canned stub (the stock
 * valuation has its own tests) so this suite pins the accounting on top of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PH = (n) => `9999023${String(n).padStart(3, '0')}`
const at = (hhmm, day) => `${day} ${hhmm}:00+05:30`

describe.skipIf(!enabled)('Accounting', () => {
  let query, closePool, acc, user, admin, vendor, shop
  let n = 0
  const actor = () => ({ userId: admin })

  async function cleanup() {
    await query(`DELETE FROM erp_expenses WHERE note LIKE 'T23%' OR party LIKE 'T23%' OR created_by IN (SELECT id FROM users WHERE phone LIKE '9999023%')`)
    await query(`DELETE FROM erp_cash_entries WHERE note LIKE 'T23%' OR created_by IN (SELECT id FROM users WHERE phone LIKE '9999023%')`)
    await query(`DELETE FROM accounting_periods WHERE month = '2026-02'`)
    await query(`DELETE FROM vendor_payments WHERE reference LIKE 'T23%'`)
    await query(`DELETE FROM order_b2b_settlements WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'T23-%')`)
    await query(`DELETE FROM payments WHERE razorpay_order_id LIKE 'T23%'`)
    await query(`DELETE FROM orders WHERE order_number LIKE 'T23-%'`)
    await query(`DELETE FROM vendors WHERE name LIKE 'T23 %'`)
    await query(`DELETE FROM shops WHERE slug LIKE 't23-shop-%'`)
    await query(`DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE phone LIKE '9999023%')`)
    await query(`DELETE FROM users WHERE phone LIKE '9999023%'`)
  }
  async function order({ method, status = 'DELIVERED', pay = 'PAID', total, day, gstin = null }) {
    return (await query(
      `INSERT INTO orders (order_number,user_id,shop_id,status,items,subtotal,total_amount,delivery_address,payment_method,payment_status,created_at,delivered_at,buyer_gstin,b2b_approval_status,b2b_approved_at)
       VALUES ($1,$2,$3,$4::order_status,'[]'::jsonb,$5,$5,'{}'::jsonb,$6,$7,$8,$8,$9,$10,$8) RETURNING id`,
      [`T23-${++n}`, user, shop, status, total, method, pay, at('11:00', day), gstin, gstin ? 'APPROVED' : null])).rows[0].id
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    const { AccountingRepository } = await import('../../src/modules/erp/accounting.repository.js')
    const { AccountingService } = await import('../../src/modules/erp/accounting.service.js')
    const { MonthlyRepository } = await import('../../src/modules/procurement/monthly.repository.js')
    const { PeriodsRepository } = await import('../../src/modules/procurement/periods.repository.js')
    const { PeriodsService } = await import('../../src/modules/procurement/periods.service.js')
    await cleanup()
    const periodsRepo = new PeriodsRepository()
    const monthlyRepo = new MonthlyRepository()
    const monthly = { build: async () => ({ summary: { profit: { sales: 10000, cogs: 7000, gross: 3000, loss: 200, afterLoss: 2800 } }, closed: null, exceptions: [] }) }
    acc = new AccountingService({ repo: new AccountingRepository(), monthly, monthlyRepo, periods: new PeriodsService({ repo: periodsRepo, monthly }), now: () => new Date('2026-03-20T12:00:00+05:30') })
    admin = (await query(`INSERT INTO users (phone,name,email,role) VALUES ($1,'T23 Admin',$2,'ADMIN') RETURNING id`, [PH(1), `${PH(1)}@t.local`])).rows[0].id
    user = (await query(`INSERT INTO users (phone,name,email,role) VALUES ($1,'T23 Customer',$2,'CUSTOMER') RETURNING id`, [PH(2), `${PH(2)}@t.local`])).rows[0].id
    shop = (await query(`INSERT INTO shops (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active) VALUES ('T23 Shop','t23-shop-1','T23S','DB 23','Kolkata','WB','700091',22.5,88.3,true) RETURNING id`)).rows[0].id
    vendor = (await query(`INSERT INTO vendors (name) VALUES ('T23 Vendor') RETURNING id`)).rows[0].id

    // cash on delivery: 500 + 300 delivered in March, plus a 999 one delivered in FEBRUARY (must not count)
    await order({ method: 'COD', total: 500, day: '2026-03-05' }); await order({ method: 'COD', total: 300, day: '2026-03-06' }); await order({ method: 'COD', total: 999, day: '2026-02-27' })
    // online: captured 700 + 500 = 1,200 in March; 100 of it refunded through the gateway in March; one payment still pending (not money)
    const o1 = await order({ method: 'ONLINE', total: 700, day: '2026-03-07' }); const o2 = await order({ method: 'ONLINE', total: 500, day: '2026-03-08' }); const o3 = await order({ method: 'ONLINE', total: 80, day: '2026-03-09', status: 'PENDING', pay: 'PENDING' })
    const pay = (o, amount, status, day, refund = null) => query(`INSERT INTO payments (order_id, user_id, razorpay_order_id, amount, status, refund_amount, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [o, user, `T23-${o}`, amount, status, refund, at('11:00', day), at('15:00', refund ? '2026-03-15' : day)])
    await pay(o1, 700, 'PAID', '2026-03-07'); await pay(o2, 500, 'REFUNDED', '2026-03-08', 100); await pay(o3, 80, 'PENDING', '2026-03-09')
    // business customer paid 1,000 cash and 2,000 UPI on 03-12
    const b = await order({ method: 'B2B_CREDIT', pay: 'PENDING', total: 5000, day: '2026-03-02', gstin: '19ABCDE1234F1Z5' })
    await query(`INSERT INTO order_b2b_settlements (order_id, method, amount, created_at) VALUES ($1,'CASH',1000,$2),($1,'UPI',2000,$2)`, [b, at('10:00', '2026-03-12')])
    // paid suppliers: 400 cash and 600 UPI in March, plus a cancelled 777
    await query(`INSERT INTO vendor_payments (vendor_id, amount, method, paid_on, reference) VALUES ($1,400,'CASH','2026-03-10','T23-a'),($1,600,'UPI','2026-03-11','T23-b')`, [vendor])
    await query(`INSERT INTO vendor_payments (vendor_id, amount, method, paid_on, reference, voided_at, void_reason) VALUES ($1,777,'CASH','2026-03-11','T23-c',NOW(),'typo')`, [vendor])
  })
  afterAll(async () => { await cleanup(); await closePool() })

  describe('recording', () => {
    it('saves expenses with the right fixed/variable kind and keeps who did it', async () => {
      await acc.createExpense({ spentOn: '2026-03-01', category: 'RENT', amount: 5000, paidVia: 'BANK', party: 'T23 Landlord' }, actor())
      await acc.createExpense({ spentOn: '2026-03-03', category: 'PACKING', amount: 300, paidVia: 'CASH', note: 'T23 bags', shopId: shop }, actor())
      const wrong = await acc.createExpense({ spentOn: '2026-03-04', category: 'OTHER', amount: 999, paidVia: 'CASH', note: 'T23 wrong entry' }, actor())
      const list = await acc.listExpenses({ from: '2026-03-01', to: '2026-03-31' })
      expect(list.items.map((e) => [e.category, e.kind, e.amount])).toEqual(expect.arrayContaining([['RENT', 'FIXED', 5000], ['PACKING', 'VARIABLE', 300], ['OTHER', 'VARIABLE', 999]]))
      // a wrong entry is cancelled, not deleted: it stays visible with who/why but leaves the totals
      await acc.voidExpense(wrong.id, 'Typed twice', actor())
      const after = await acc.listExpenses({ from: '2026-03-01', to: '2026-03-31' })
      expect(after.total).toBe(5300)
      const withVoided = await acc.listExpenses({ from: '2026-03-01', to: '2026-03-31', includeVoided: true })
      expect(withVoided.items.find((e) => e.id === wrong.id)).toMatchObject({ voided: true, voidReason: 'Typed twice' })
    })
    it('records the owner’s cash book', async () => {
      const c = (entryOn, kind, account, amount) => acc.createCash({ entryOn, kind, account, amount, note: 'T23' }, actor())
      await c('2026-03-01', 'OPENING_BALANCE', 'CASH', 10000); await c('2026-03-01', 'OPENING_BALANCE', 'BANK', 50000)
      await c('2026-03-02', 'OWNER_CAPITAL', 'BANK', 20000); await c('2026-03-13', 'OWNER_DRAWING', 'CASH', 1500)
      await c('2026-03-14', 'BANK_DEPOSIT', undefined, 5000); await c('2026-03-16', 'OTHER_INCOME', 'CASH', 250)
      expect((await acc.listCash({ from: '2026-03-01', to: '2026-03-31' })).items).toHaveLength(6)
    })
    it('refuses bad input with a plain reason', async () => {
      const bad = (p) => acc.createExpense({ spentOn: '2026-03-05', category: 'RENT', amount: 10, paidVia: 'CASH', ...p }, actor())
      await expect(bad({ amount: 0 })).rejects.toThrow(/more than zero/)
      await expect(bad({ amount: 1.234 })).rejects.toThrow(/2 decimals/)
      await expect(bad({ category: 'NOPE' })).rejects.toThrow(/what the money was spent on/)
      await expect(bad({ paidVia: 'CHEQUE' })).rejects.toThrow(/cash, UPI or bank/)
      await expect(bad({ spentOn: '2026-03-25' })).rejects.toThrow(/not come yet/)
      await expect(bad({ spentOn: '2026-02-30' })).rejects.toThrow(/real date/)
      await expect(bad({ shopId: '11111111-1111-1111-1111-111111111111' })).rejects.toThrow(/store does not exist/)
      await expect(acc.createCash({ entryOn: '2026-03-05', kind: 'OWNER_CAPITAL', amount: 10 }, actor())).rejects.toThrow(/cash box or bank/)
      await expect(acc.createCash({ entryOn: '2026-03-05', kind: 'NOPE', amount: 10 }, actor())).rejects.toThrow(/what kind/)
    })
    it('cancelling needs a reason and works once', async () => {
      const { id } = await acc.createExpense({ spentOn: '2026-03-05', category: 'OTHER', amount: 12, paidVia: 'CASH', note: 'T23 once' }, actor())
      await expect(acc.voidExpense(id, '  ', actor())).rejects.toThrow(/Say why/)
      await acc.voidExpense(id, 'Mistake', actor())
      await expect(acc.voidExpense(id, 'Again', actor())).rejects.toThrow(/already cancelled/)
      await expect(acc.voidExpense('11111111-1111-1111-1111-111111111111', 'x', actor())).rejects.toThrow(/not found/)
    })
    it('will not touch a closed month', async () => {
      await query(`INSERT INTO accounting_periods (month, snapshot) VALUES ('2026-02', '{}'::jsonb)`)
      await expect(acc.createExpense({ spentOn: '2026-02-15', category: 'RENT', amount: 10, paidVia: 'CASH' }, actor())).rejects.toThrow(/closed/)
      await expect(acc.createCash({ entryOn: '2026-02-15', kind: 'OTHER_INCOME', account: 'CASH', amount: 10 }, actor())).rejects.toThrow(/closed/)
    })
  })

  // Expenses in March: rent 5,000 (bank) + packing 300 (cash) = 5,300 (the cancelled 999 and 12 do not count).
  // CASH in:  COD 500 + 300 = 800 (the 999 delivered in Feb is not March), business cash 1,000, other income 250  = 2,050
  // CASH out: suppliers 400 (777 cancelled), packing 300, drawings 1,500, deposit 5,000                          = 7,200 → net −5,150
  // BANK in:  gateway 700 + 500 = 1,200 (pending 80 is not money), business UPI 2,000, capital 20,000, deposit 5,000 = 28,200
  // BANK out: gateway refund 100, suppliers UPI 600, rent 5,000                                                   = 5,700 → net +22,500
  // balances: cash 10,000 − 5,150 = 4,850; bank 50,000 + 22,500 = 72,500.
  describe('the month', () => {
    let s
    beforeAll(async () => { s = await acc.summary({ month: '2026-03' }) })
    it('profit and loss = stock profit − running costs + other income', () => {
      expect(s.pnl).toMatchObject({ sales: 10000, gross: 3000, afterWastage: 2800, operatingProfit: -2500, otherIncome: 250, netProfit: -2250 })
      expect(s.pnl.expenses).toMatchObject({ fixed: 5000, variable: 300, total: 5300 })
    })
    it('cash box: where it came from and where it went', () => {
      expect(s.position.CASH).toMatchObject({ totalIn: 2050, totalOut: 7200, net: -5150 })
      expect(s.position.CASH.in.map((x) => [x.label, x.amount])).toEqual(expect.arrayContaining([['Cash on delivery collected', 800], ['Business customers paid', 1000], ['Other income', 250]]))
    })
    it('bank: card/UPI money in, refunds and bills out', () => {
      expect(s.position.BANK).toMatchObject({ totalIn: 28200, totalOut: 5700, net: 22500 })
      expect(s.position.BANK.out.map((x) => [x.label, x.amount])).toEqual(expect.arrayContaining([['Refunded through the payment gateway', 100], ['Paid to suppliers', 600], ['Running costs', 5000]]))
    })
    it('balances start from the opening balance', () => {
      expect(s.position.CASH).toMatchObject({ opening: { on: '2026-03-01', amount: 10000 }, balance: 4850 })
      expect(s.position.BANK).toMatchObject({ opening: { on: '2026-03-01', amount: 50000 }, balance: 72500 })
    })
    it('moving cash to the bank changes neither the total nor the profit', () => {
      expect(s.position.CASH.net + s.position.BANK.net).toBe(17350) // −5,150 + 22,500
    })
    it('the money log adds up to the same in and out', async () => {
      const j = await acc.journal({ month: '2026-03' })
      expect(j.totals).toEqual({ CASH: { in: 2050, out: 7200 }, BANK: { in: 28200, out: 5700 } })
      expect(j.rows.length).toBeGreaterThan(8)
      expect(j.rows.every((r, i, a) => i === 0 || a[i - 1].date <= r.date)).toBe(true)
    })
    it('without an opening balance it shows the movement only', async () => {
      const feb = await acc.summary({ month: '2026-02' }) // the opening balances are dated 1 March, after February
      expect(feb.position.CASH.balance).toBeNull()
      expect(feb.position.BANK.opening).toBeNull()
      expect(feb.warnings.join(' ')).toMatch(/opening balance/i)
    })
  })
})
