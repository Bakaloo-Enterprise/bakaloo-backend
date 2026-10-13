/**
 * Expiring wallet credits (migration 158), against a real database.
 *   WA_CRM_DB_TEST=1 npx vitest run tests/integration/wallet-expiry.db.test.js
 *
 * Covers the money rules end to end: bonus expires but top-ups never do,
 * spending order, partial use, refunds, transfers, clawbacks, the worker pass
 * and concurrent sweeps.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const enabled = process.env.WA_CRM_DB_TEST === '1'
const PH = (n) => `9999041${String(n).padStart(3, '0')}`
const KEYS = [
  'wallet_expiry_enabled', 'wallet_expiry_days_spin', 'wallet_expiry_days_scratch',
  'wallet_expiry_days_coupon', 'wallet_expiry_days_offer', 'wallet_expiry_days_admin',
  'wallet_expiry_reminder_days', 'wallet_transfers_enabled', 'wallet_max_balance',
]

describe.skipIf(!enabled)('Wallet credit expiry', () => {
  let query, closePool, WalletService, WalletRepository, WalletSettingsService, runWalletExpiryPass
  let svc, repo, savedSettings, seq = 0

  const setSetting = (key, value) =>
    query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
      [key, JSON.stringify(value)],
    )

  async function cleanup() {
    const users = `(SELECT id FROM users WHERE phone LIKE '9999041%')`
    await query(`DELETE FROM wallet_lot_consumptions WHERE lot_id IN (SELECT id FROM wallet_credit_lots WHERE user_id IN ${users})`)
    await query(`DELETE FROM wallet_credit_lots WHERE user_id IN ${users}`)
    await query(`DELETE FROM wallet_transactions WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id IN ${users})`)
    await query(`DELETE FROM orders WHERE user_id IN ${users}`)
    await query(`DELETE FROM notifications WHERE user_id IN ${users}`)
    await query(`DELETE FROM wallets WHERE user_id IN ${users}`)
    await query(`DELETE FROM users WHERE phone LIKE '9999041%'`)
  }

  async function newUser() {
    const n = ++seq
    const { rows } = await query(
      `INSERT INTO users (phone, name, role) VALUES ($1, $2, 'CUSTOMER') RETURNING id`,
      [PH(n), `Expiry T${n}`],
    )
    return rows[0].id
  }

  const lotsOf = async (userId) =>
    (await query(`SELECT * FROM wallet_credit_lots WHERE user_id = $1 ORDER BY created_at, id`, [userId])).rows
  const txsOf = async (userId) =>
    (await query(
      `SELECT wt.* FROM wallet_transactions wt JOIN wallets w ON w.id = wt.wallet_id
       WHERE w.user_id = $1 ORDER BY wt.created_at, wt.id`, [userId])).rows
  const expireNow = (lotId) =>
    query(`UPDATE wallet_credit_lots SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [lotId])
  const debit = async (userId, amount, orderId) => {
    const { getClient } = await import('../../src/config/database.js')
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const r = await svc.debitForOrder(client, userId, { amount, orderId, orderNumber: 'T-1' })
      await client.query('COMMIT')
      return r
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../src/config/database.js'))
    ;({ WalletService } = await import('../../src/modules/wallet/wallet.service.js'))
    ;({ WalletRepository } = await import('../../src/modules/wallet/wallet.repository.js'))
    ;({ WalletSettingsService } = await import('../../src/modules/wallet-settings/wallet-settings.service.js'))
    ;({ runWalletExpiryPass } = await import('../../src/workers/wallet-expiry.worker.js'))
    repo = new WalletRepository()
    svc = new WalletService(repo)
    savedSettings = (await query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [KEYS])).rows
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    for (const k of KEYS) await query(`DELETE FROM app_settings WHERE key = $1`, [k])
    for (const r of savedSettings) await setSetting(r.key, r.value)
    await closePool()
  })

  beforeEach(async () => {
    await setSetting('wallet_expiry_enabled', true)
    await setSetting('wallet_expiry_days_spin', 10)
    await setSetting('wallet_expiry_days_scratch', 5)
    await setSetting('wallet_expiry_days_coupon', 20)
    await setSetting('wallet_expiry_days_offer', 0)
    await setSetting('wallet_expiry_days_admin', 30)
    await setSetting('wallet_expiry_reminder_days', 3)
    await setSetting('wallet_max_balance', 100000)
  })

  it('expiry date lands on the end of the last valid day in IST', () => {
    // 12 Oct 2026 22:00 IST (= 16:30 UTC) + 10 days -> 22 Oct 23:59:59 IST
    const end = WalletSettingsService.endOfDayIst(new Date('2026-10-12T16:30:00Z'), 10)
    expect(end.toISOString()).toBe('2026-10-22T18:29:59.000Z')
    // 13 Oct 2026 00:30 IST (= 12 Oct 19:00 UTC) is already the 13th in IST
    const end2 = WalletSettingsService.endOfDayIst(new Date('2026-10-12T19:00:00Z'), 1)
    expect(end2.toISOString()).toBe('2026-10-14T18:29:59.000Z')
  })

  it('master switch off, 0 days, or no source => the credit never expires', async () => {
    const u = await newUser()
    await setSetting('wallet_expiry_enabled', false)
    const r1 = await svc.addMoney(u, { amount: 100, expirySource: 'SPIN' })
    expect(r1.success).toBe(true)
    expect(r1.transaction.expiresAt).toBeNull()

    await setSetting('wallet_expiry_enabled', true)
    const r2 = await svc.addMoney(u, { amount: 50, expirySource: 'OFFER' }) // 0 days
    const r3 = await svc.addMoney(u, { amount: 25 }) // top-up-style, no source
    expect(r2.transaction.expiresAt).toBeNull()
    expect(r3.transaction.expiresAt).toBeNull()
    expect(await lotsOf(u)).toHaveLength(0)
    expect((await svc.getWallet(u)).balance).toBe(175)
  })

  it('spin / scratch / coupon credits become lots with the configured validity and a dated message', async () => {
    const u = await newUser()
    const spin = await svc.addMoney(u, { amount: 250, description: 'Spin & Win prize', subType: 'SCRATCH', expirySource: 'SPIN' })
    await svc.addMoney(u, { amount: 20, description: 'Scratch Card prize', subType: 'SCRATCH', expirySource: 'SCRATCH' })
    await svc.addMoney(u, { amount: 40, description: 'Cashback — coupon', subType: 'CASHBACK', expirySource: 'COUPON' })

    const lots = await lotsOf(u)
    expect(lots.map((l) => l.source_type).sort()).toEqual(['COUPON', 'SCRATCH', 'SPIN'])
    const days = (l) => Math.round((new Date(l.expires_at) - Date.now()) / 86_400_000)
    expect(days(lots.find((l) => l.source_type === 'SPIN'))).toBeGreaterThanOrEqual(10)
    expect(days(lots.find((l) => l.source_type === 'SCRATCH'))).toBeGreaterThanOrEqual(5)
    expect(spin.transaction.description).toMatch(/Spin & Win prize \(valid till \d/)
    expect(spin.transaction.expiresAt).toBeTruthy()

    const w = await svc.getWallet(u)
    expect(w.balance).toBe(310)
    expect(w.expiringBalance).toBe(310)
    expect(w.permanentBalance).toBe(0)
    expect(new Date(w.nextExpiry.expiresAt) < new Date(lots.find((l) => l.source_type === 'SPIN').expires_at)).toBe(true)
  })

  it('spending uses bonus first (soonest expiry first), then permanent money', async () => {
    const u = await newUser()
    await svc.addMoney(u, { amount: 100 }) // permanent
    await svc.addMoney(u, { amount: 250, expirySource: 'SPIN' }) // 10d
    await svc.addMoney(u, { amount: 20, expirySource: 'SCRATCH' }) // 5d  <- expires first

    await debit(u, 60)
    let lots = await lotsOf(u)
    const scratch = lots.find((l) => l.source_type === 'SCRATCH')
    const spin = lots.find((l) => l.source_type === 'SPIN')
    expect(Number(scratch.remaining_amount)).toBe(0)
    expect(scratch.status).toBe('EXHAUSTED')
    expect(Number(spin.remaining_amount)).toBe(210) // 20 from scratch, 40 from spin

    await debit(u, 300) // 210 spin + 90 permanent
    lots = await lotsOf(u)
    expect(lots.every((l) => l.status === 'EXHAUSTED')).toBe(true)
    const w = await svc.getWallet(u)
    expect(w.balance).toBe(10) // 370 - 60 - 300
    expect(w.expiringBalance).toBe(0)
    expect(w.permanentBalance).toBe(10)
  })

  it('an expired credit is removed with a clear history line; top-ups are untouched', async () => {
    const u = await newUser()
    await svc.addMoney(u, { amount: 100 })
    await svc.addMoney(u, { amount: 250, description: 'Spin & Win prize', expirySource: 'SPIN' })
    const keep = await svc.addMoney(u, { amount: 20, expirySource: 'SCRATCH' })
    const [spin] = await lotsOf(u)
    await expireNow(spin.id)

    const w = await svc.getWallet(u) // read path sweeps lazily
    expect(w.balance).toBe(120)
    expect(w.permanentBalance).toBe(100)
    expect(w.expiringBalance).toBe(20)

    const expiryTx = (await txsOf(u)).find((t) => t.sub_type === 'EXPIRY')
    expect(expiryTx.type).toBe('DEBIT')
    expect(Number(expiryTx.amount)).toBe(250)
    expect(expiryTx.description).toMatch(/^₹250 Spin & Win prize expired \(valid till /)
    expect(Number(expiryTx.balance_after)).toBe(120)
    expect(keep.success).toBe(true)

    const after = (await lotsOf(u)).find((l) => l.id === spin.id)
    expect(after.status).toBe('EXPIRED')
    expect(Number(after.expired_amount)).toBe(250)
    expect(after.expired_tx_id).toBe(expiryTx.id)
  })

  it('a partly-spent credit expires only what is left', async () => {
    const u = await newUser()
    await svc.addMoney(u, { amount: 100, expirySource: 'SPIN' })
    await debit(u, 30)
    const [lot] = await lotsOf(u)
    await expireNow(lot.id)
    await svc.getWallet(u)
    const tx = (await txsOf(u)).find((t) => t.sub_type === 'EXPIRY')
    expect(Number(tx.amount)).toBe(70)
    expect(tx.description).toMatch(/₹70 of your ₹100 Spin & Win prize expired unused/)
    expect((await svc.getWallet(u)).balance).toBe(0)
  })

  it('an expired-but-not-yet-swept credit can never be spent', async () => {
    const u = await newUser()
    await svc.addMoney(u, { amount: 50 }) // permanent
    await svc.addMoney(u, { amount: 100, expirySource: 'SPIN' })
    const [lot] = await lotsOf(u)
    await expireNow(lot.id) // lapsed, worker has not run

    await expect(debit(u, 60)).rejects.toThrow(/Insufficient wallet balance/)
    const ok = await debit(u, 50)
    expect(ok.wallet.balance).toBe(0)
    expect((await lotsOf(u))[0].status).toBe('EXPIRED')
  })

  it('transfers can only move permanent money, not bonus', async () => {
    const a = await newUser()
    const b = await newUser()
    await setSetting('wallet_transfers_enabled', true)
    await svc.addMoney(a, { amount: 40 })
    await svc.addMoney(a, { amount: 200, expirySource: 'SPIN' })

    const tooMuch = await svc.transfer(a, { phone: PH(seq), amount: 100 })
    expect(tooMuch.success).toBe(false)
    expect(tooMuch.message).toMatch(/Only ₹40 of your wallet balance can be transferred/)

    const ok = await svc.transfer(a, { phone: PH(seq), amount: 40 })
    expect(ok.success).toBe(true)
    const wa = await svc.getWallet(a)
    expect(wa.balance).toBe(200)
    expect(wa.expiringBalance).toBe(200) // bonus lot untouched by the transfer
    const wb = await svc.getWallet(b)
    expect(wb.permanentBalance).toBe(40)
    expect(wb.expiringBalance).toBe(0)
  })

  it('cashback clawback reverses the cashback\'s own lot first', async () => {
    const u = await newUser()
    const srcId = '11111111-1111-4111-8111-111111111111'
    await svc.addMoney(u, { amount: 100 })
    await svc.addMoney(u, { amount: 30, subType: 'CASHBACK', sourceId: srcId, expirySource: 'COUPON' })
    await svc.addMoney(u, { amount: 60, expirySource: 'SPIN' }) // sooner-expiring lot must stay untouched
    const r = await svc.deductMoney(u, { amount: 30, subType: 'CASHBACK', sourceId: srcId })
    expect(r.success).toBe(true)
    const lots = await lotsOf(u)
    expect(lots.find((l) => l.source_type === 'COUPON').status).toBe('EXHAUSTED')
    expect(Number(lots.find((l) => l.source_type === 'SPIN').remaining_amount)).toBe(60)
    expect((await svc.getWallet(u)).balance).toBe(160)
  })

  it('refunding an order paid with bonus returns the bonus to its credit, not to permanent money', async () => {
    const u = await newUser()
    await svc.addMoney(u, { amount: 100 })
    await svc.addMoney(u, { amount: 80, expirySource: 'SPIN' })
    const orderId = (await query(
      `INSERT INTO orders (order_number, user_id, items, subtotal, total_amount, delivery_address)
       VALUES ($1, $2, '[]'::jsonb, 150, 150, '{}'::jsonb) RETURNING id`,
      [`T-EXP-${seq}`, u],
    )).rows[0].id

    await debit(u, 150, orderId) // 80 bonus + 70 permanent
    let w = await svc.getWallet(u)
    expect(w.balance).toBe(30)
    expect(w.expiringBalance).toBe(0)

    const refund = await svc.addMoney(u, { amount: 150, subType: 'REFUND', orderId, description: 'Refund' })
    expect(refund.success).toBe(true)
    w = await svc.getWallet(u)
    expect(w.balance).toBe(180)
    expect(w.expiringBalance).toBe(80) // bonus back in its lot, still expiring
    expect(w.permanentBalance).toBe(100)
    const lot = (await lotsOf(u))[0]
    expect(lot.status).toBe('ACTIVE')
    expect(Number(lot.remaining_amount)).toBe(80)

    // a second refund for the same order can't restore more than was taken
    await svc.addMoney(u, { amount: 150, subType: 'REFUND', orderId, description: 'Refund again' })
    expect((await svc.getWallet(u)).expiringBalance).toBe(80)
  })

  it('refund after the bonus already lapsed keeps the money as permanent balance', async () => {
    const u = await newUser()
    await svc.addMoney(u, { amount: 80, expirySource: 'SPIN' })
    const orderId = (await query(
      `INSERT INTO orders (order_number, user_id, items, subtotal, total_amount, delivery_address)
       VALUES ($1, $2, '[]'::jsonb, 80, 80, '{}'::jsonb) RETURNING id`,
      [`T-EXP-R-${seq}`, u],
    )).rows[0].id
    await debit(u, 80, orderId)
    const [lot] = await lotsOf(u)
    await expireNow(lot.id)
    await svc.addMoney(u, { amount: 80, subType: 'REFUND', orderId })
    const w = await svc.getWallet(u)
    expect(w.balance).toBe(80)
    expect(w.permanentBalance).toBe(80)
    expect(w.expiringBalance).toBe(0)
  })

  it('admin bonus credit expires; a plain admin credit does not', async () => {
    const u = await newUser()
    const plain = await svc.adminCredit(u, { amount: 50, description: 'Goodwill' })
    const bonus = await svc.adminCredit(u, { amount: 70, isBonus: true, expiryDays: 2 })
    expect(plain.transaction.expiresAt).toBeNull()
    expect(bonus.transaction.expiresAt).toBeTruthy()
    expect(bonus.transaction.description).toMatch(/^Bonus credit \(valid till /)
    const w = await svc.getWallet(u)
    expect(w.permanentBalance).toBe(50)
    expect(w.expiringBalance).toBe(70)
  })

  it('worker: sweeps idle wallets once, notifies once, and sends one reminder', async () => {
    const idle = await newUser()
    await svc.addMoney(idle, { amount: 100 })
    await svc.addMoney(idle, { amount: 90, expirySource: 'SPIN' })
    const [lot] = (await lotsOf(idle)).slice(0)
    await expireNow(lot.id)

    const remind = await newUser()
    await svc.addMoney(remind, { amount: 60, expirySource: 'SCRATCH' })
    const [rl] = await lotsOf(remind)
    // issued 4 days ago with 5 days validity -> expires in ~1 day, validity > reminder window
    await query(
      `UPDATE wallet_credit_lots SET created_at = NOW() - INTERVAL '4 days',
              expires_at = NOW() + INTERVAL '1 day' WHERE id = $1`, [rl.id])

    const r1 = await runWalletExpiryPass()
    expect(r1.expiredWallets).toBeGreaterThanOrEqual(1)
    const swept = (await lotsOf(idle))[0]
    expect(swept.status).toBe('EXPIRED')
    expect(swept.expired_notified_at).not.toBeNull()
    expect((await svc.getWallet(idle)).balance).toBe(100)
    expect((await lotsOf(remind))[0].reminder_sent_at).not.toBeNull()

    const notes = (await query(`SELECT title, body FROM notifications WHERE user_id = ANY($1)`, [[idle, remind]])).rows
    expect(notes.some((n) => /expired/i.test(n.title) && /₹90/.test(n.body))).toBe(true)
    expect(notes.some((n) => /soon/i.test(n.title) && /₹60/.test(n.body))).toBe(true)

    // second pass: nothing to do for these wallets, no duplicate notifications
    await runWalletExpiryPass()
    const again = (await query(`SELECT 1 FROM notifications WHERE user_id = ANY($1)`, [[idle, remind]])).rows
    expect(again).toHaveLength(notes.length)
    expect((await txsOf(idle)).filter((t) => t.sub_type === 'EXPIRY')).toHaveLength(1)
  })

  it('a short-lived credit does not get an instant "expiring soon" reminder', async () => {
    const u = await newUser()
    await svc.addMoney(u, { amount: 30, expirySource: 'SCRATCH' }) // 5d validity, reminder window 3d, just issued
    const [lot] = await lotsOf(u)
    await query(`UPDATE wallet_credit_lots SET expires_at = NOW() + INTERVAL '2 days' WHERE id = $1`, [lot.id])
    await runWalletExpiryPass()
    expect((await lotsOf(u))[0].reminder_sent_at).toBeNull()
  })

  it('concurrent sweeps of the same wallet expire a credit exactly once', async () => {
    const u = await newUser()
    await svc.addMoney(u, { amount: 40 })
    await svc.addMoney(u, { amount: 60, expirySource: 'SPIN' })
    const [lot] = await lotsOf(u)
    await expireNow(lot.id)
    const wallet = await repo.getOrCreate(u)
    await Promise.all([
      repo.expireDueForWallet(wallet.id),
      repo.expireDueForWallet(wallet.id),
      repo.expireDueForWallet(wallet.id),
    ])
    expect((await txsOf(u)).filter((t) => t.sub_type === 'EXPIRY')).toHaveLength(1)
    expect((await svc.getWallet(u)).balance).toBe(40)
  })

  it('invariant: balance == permanent + active lots after a mixed sequence', async () => {
    const u = await newUser()
    await svc.addMoney(u, { amount: 100 })
    await svc.addMoney(u, { amount: 25, expirySource: 'SPIN' })
    await svc.addMoney(u, { amount: 15, expirySource: 'SCRATCH' })
    await debit(u, 20)
    await svc.addMoney(u, { amount: 10, expirySource: 'COUPON' })
    const { rows } = await query(
      `SELECT w.balance, COALESCE((SELECT SUM(remaining_amount) FROM wallet_credit_lots
               WHERE wallet_id = w.id AND status = 'ACTIVE'), 0) AS lots
       FROM wallets w WHERE w.user_id = $1`, [u])
    expect(Number(rows[0].lots)).toBeLessThanOrEqual(Number(rows[0].balance))
    expect(Number(rows[0].balance)).toBe(130)
    expect(Number(rows[0].lots)).toBe(30) // 25+15+10 minus the 20 spent from bonus
  })

  describe('HTTP', () => {
    let app, custToken, adminToken, cust
    const call = (method, url, { token, payload } = {}) =>
      app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} })

    beforeAll(async () => {
      const { signAccessToken } = await import('../../src/utils/jwt.js')
      const { buildApp } = await import('../../src/app.js')
      app = await buildApp()
      await app.ready()
      cust = await newUser()
      custToken = signAccessToken({ id: cust, phone: PH(seq), role: 'CUSTOMER' })
      const n = ++seq
      const adminId = (await query(
        `INSERT INTO users (phone,name,email,role,platform_role) VALUES ($1,'Exp Admin',$2,'ADMIN','SUPER_ADMIN') RETURNING id`,
        [PH(n), `${PH(n)}@t.local`],
      )).rows[0].id
      adminToken = signAccessToken({ id: adminId, phone: PH(n), role: 'ADMIN', platform_role: 'SUPER_ADMIN' })
    })
    afterAll(async () => { await app.close() })

    it('GET /wallet exposes permanent vs expiring balance; /wallet/expiry lists credits', async () => {
      await svc.addMoney(cust, { amount: 100 })
      await svc.addMoney(cust, { amount: 250, description: 'Spin & Win prize', expirySource: 'SPIN' })
      const w = (await call('GET', '/api/v1/wallet', { token: custToken })).json()
      expect(w.data.balance).toBe(350)
      expect(w.data.permanentBalance).toBe(100)
      expect(w.data.expiringBalance).toBe(250)
      expect(w.data.nextExpiry.amount).toBe(250)

      const e = (await call('GET', '/api/v1/wallet/expiry', { token: custToken })).json()
      expect(e.data.credits).toHaveLength(1)
      expect(e.data.credits[0]).toMatchObject({ sourceType: 'SPIN', label: 'Spin & Win prize', remainingAmount: 250 })

      const tx = (await call('GET', '/api/v1/wallet/transactions', { token: custToken })).json()
      const spinTx = tx.data.find((t) => t.amount === 250)
      expect(spinTx.expiresAt).toBeTruthy()
      expect(spinTx.description).toMatch(/valid till/)
      expect(tx.data.find((t) => t.amount === 100).expiresAt).toBeNull()
    })

    it('expired credit shows up in the customer history as a DEBIT with the message', async () => {
      const [lot] = await lotsOf(cust)
      await expireNow(lot.id)
      const tx = (await call('GET', '/api/v1/wallet/transactions', { token: custToken })).json()
      const expired = tx.data.find((t) => /expired/.test(t.description))
      expect(expired.type).toBe('DEBIT')
      expect(expired.amount).toBe(250)
      expect(expired.description).toMatch(/^₹250 Spin & Win prize expired \(valid till /)
      const w = (await call('GET', '/api/v1/wallet', { token: custToken })).json()
      expect(w.data.balance).toBe(100)
    })

    it('admin settings round-trip and validate; stats include expiry numbers', async () => {
      const put = await call('PUT', '/api/v1/admin/wallet-settings', {
        token: adminToken,
        payload: { expiryEnabled: true, expirySpinDays: 15, expiryScratchDays: 7, expiryReminderDays: 2 },
      })
      expect(put.statusCode).toBe(200)
      const got = (await call('GET', '/api/v1/admin/wallet-settings', { token: adminToken })).json().data
      expect(got).toMatchObject({ expiryEnabled: true, expirySpinDays: 15, expiryScratchDays: 7, expiryReminderDays: 2 })

      const bad = await call('PUT', '/api/v1/admin/wallet-settings', { token: adminToken, payload: { expirySpinDays: -1 } })
      expect(bad.statusCode).toBe(400)

      const stats = (await call('GET', '/api/v1/wallet/admin/stats', { token: adminToken })).json().data
      expect(stats).toHaveProperty('expiringBalance')
      expect(stats).toHaveProperty('totalExpired')
      expect(stats.totalExpired).toBeGreaterThanOrEqual(250)
    })

    it('admin credit: bonus expires, plain does not; admin transactions expose subType + expiresAt', async () => {
      const bonus = await call('POST', `/api/v1/wallet/admin/${cust}/credit`, {
        token: adminToken, payload: { amount: 40, isBonus: true, expiryDays: 3 },
      })
      expect(bonus.statusCode).toBe(200)
      expect(bonus.json().data.transaction.expiresAt).toBeTruthy()
      const plain = await call('POST', `/api/v1/wallet/admin/${cust}/credit`, {
        token: adminToken, payload: { amount: 15, description: 'Goodwill' },
      })
      expect(plain.json().data.transaction.expiresAt).toBeNull()

      const list = (await call('GET', `/api/v1/wallet/admin/transactions?userId=${cust}&limit=50`, { token: adminToken })).json()
      const exp = list.data.find((t) => t.subType === 'EXPIRY')
      expect(exp).toBeTruthy()
      expect(list.data.find((t) => t.amount === 40).expiresAt).toBeTruthy()
    })
  })
})
