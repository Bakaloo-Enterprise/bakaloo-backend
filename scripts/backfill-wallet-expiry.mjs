// One-off backfill: applies the wallet expiry rules (migration 158) to
// prize/cashback credits customers won BEFORE expiry existed, e.g. the last
// 5 days of Spin & Win, Scratch Card, coupon and offer cashback.
//
//   node scripts/backfill-wallet-expiry.mjs --days=5              # DRY RUN (default): lists who is affected
//   node scripts/backfill-wallet-expiry.mjs --days=5 --apply      # actually creates the expiring credits
//
// Options:
//   --days=N         look at credits won in the last N days (default 5)
//   --min-notice=N   a credit whose expiry (win date + the type's configured
//                    days) is already past or sooner than N days from now is
//                    given N days from now instead, so nobody loses money
//                    without warning (default 2)
//
// Rules (same as live credits): validity comes from Settings -> Wallet ->
// Expiry for that type (0 days = never expires, so it is skipped). The credit
// is treated as already partly spent if the customer debited money since
// winning it (bonus is assumed spent first, matching the live spending rule).
// Never touches top-ups/refunds. Idempotent: a credit that already has a
// lot is skipped, so re-running is safe. Does NOT send notifications by
// itself; the regular reminder/expiry worker handles those afterwards.
import 'dotenv/config'
import { query, getClient, closePool } from '../src/config/database.js'
import { WalletSettingsService } from '../src/modules/wallet-settings/wallet-settings.service.js'
import { LOT_LABELS, formatDateIst } from '../src/modules/wallet/wallet-lots.js'

const arg = (name, dflt) => {
  const v = process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
  return v === undefined ? dflt : Number(v)
}
const DAYS = arg('days', 5)
const MIN_NOTICE = arg('min-notice', 2)
const APPLY = process.argv.includes('--apply')
const FIELD = { SPIN: 'expirySpinDays', SCRATCH: 'expiryScratchDays', COUPON: 'expiryCouponDays', OFFER: 'expiryOfferDays' }

const settings = new WalletSettingsService()

async function main() {
  const cfg = await settings.getConfig()
  if (!cfg.expiryEnabled) {
    console.log('Expiry is switched OFF in Settings -> Wallet Settings. Turn it on first, then re-run.')
    return
  }
  const now = new Date()

  // Candidate credits: completed prize/cashback credits with no lot yet.
  const { rows } = await query(
    `SELECT wt.id, wt.wallet_id, w.user_id, wt.amount, wt.description, wt.created_at, wt.source_id,
            wt.sub_type, cb.source_type AS cashback_source
     FROM wallet_transactions wt
     JOIN wallets w ON w.id = wt.wallet_id
     LEFT JOIN cashback_transactions cb ON cb.id = wt.source_id AND wt.sub_type = 'CASHBACK'
     WHERE wt.type = 'CREDIT' AND COALESCE(wt.status, 'COMPLETED') = 'COMPLETED'
       AND wt.sub_type IN ('SCRATCH', 'CASHBACK')
       AND wt.created_at >= NOW() - make_interval(days => $1::int)
       AND NOT EXISTS (SELECT 1 FROM wallet_credit_lots l WHERE l.credit_tx_id = wt.id)
     ORDER BY w.user_id, wt.created_at`,
    [DAYS]
  )

  const plan = []
  const spentCache = new Map() // user -> money debited since each credit, consumed oldest-first
  for (const tx of rows) {
    const source =
      tx.sub_type === 'CASHBACK'
        ? (tx.cashback_source === 'COUPON' ? 'COUPON' : 'OFFER')
        : (/spin/i.test(tx.description || '') ? 'SPIN' : 'SCRATCH')
    const days = cfg[FIELD[source]]
    if (!(days > 0)) continue // this type never expires

    let expiresAt = WalletSettingsService.endOfDayIst(new Date(tx.created_at), days)
    const floor = WalletSettingsService.endOfDayIst(now, MIN_NOTICE)
    if (expiresAt < floor) expiresAt = floor

    plan.push({ tx, source, expiresAt })
  }

  // Work out how much of each credit is still unspent. Debits after the win
  // are charged against the user's newest-first... oldest-first bonus, which
  // mirrors "expiring credit is spent first".
  const byUser = new Map()
  for (const p of plan) {
    if (!byUser.has(p.tx.user_id)) byUser.set(p.tx.user_id, [])
    byUser.get(p.tx.user_id).push(p)
  }
  for (const [userId, items] of byUser) {
    const { rows: w } = await query(
      `SELECT w.id, w.balance,
              COALESCE((SELECT SUM(remaining_amount) FROM wallet_credit_lots
                        WHERE wallet_id = w.id AND status = 'ACTIVE'), 0) AS lots
       FROM wallets w WHERE w.user_id = $1`, [userId])
    const { rows: d } = await query(
      `SELECT COALESCE(SUM(amount), 0) AS spent FROM wallet_transactions
       WHERE wallet_id = $1 AND type = 'DEBIT' AND COALESCE(status, 'COMPLETED') = 'COMPLETED'
         AND created_at >= $2`, [w[0].id, items[0].tx.created_at])
    let spent = parseFloat(d[0].spent)
    // Never put more under expiry than the wallet can actually cover.
    let room = Math.max(0, parseFloat(w[0].balance) - parseFloat(w[0].lots))
    for (const p of items) {
      const amount = parseFloat(p.tx.amount)
      const usedUp = Math.min(amount, spent)
      spent -= usedUp
      p.remaining = Math.min(amount - usedUp, room)
      room -= p.remaining
      p.remaining = Math.round(p.remaining * 100) / 100
    }
  }

  const live = plan.filter((p) => p.remaining > 0)
  console.log(`\nCredits from the last ${DAYS} day(s) eligible for expiry: ${live.length} (${new Set(live.map((p) => p.tx.user_id)).size} customers)`)
  let total = 0
  for (const p of live) {
    total += p.remaining
    console.log(
      `  ${String(p.tx.user_id).slice(0, 8)}  ${LOT_LABELS[p.source].padEnd(18)} won ₹${p.tx.amount} on ${formatDateIst(p.tx.created_at)}` +
      `  -> ₹${p.remaining} will expire ${formatDateIst(p.expiresAt)}`
    )
  }
  console.log(`Total amount put under expiry: ₹${total.toFixed(2)}`)

  if (!APPLY) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to do it.')
    return
  }

  let done = 0
  for (const p of live) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT id FROM wallets WHERE id = $1 FOR UPDATE`, [p.tx.wallet_id])
      const { rowCount } = await client.query(
        `INSERT INTO wallet_credit_lots
           (wallet_id, user_id, source_type, original_amount, remaining_amount, expires_at,
            credit_tx_id, source_id, created_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
         WHERE NOT EXISTS (SELECT 1 FROM wallet_credit_lots WHERE credit_tx_id = $7)`,
        [p.tx.wallet_id, p.tx.user_id, p.source, p.tx.amount, p.remaining, p.expiresAt,
         p.tx.id, p.tx.source_id, p.tx.created_at]
      )
      if (rowCount) {
        await client.query(`UPDATE wallet_transactions SET expires_at = $2 WHERE id = $1`, [p.tx.id, p.expiresAt])
        done++
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      console.error(`  FAILED for credit ${p.tx.id}: ${err.message}`)
    } finally {
      client.release()
    }
  }
  console.log(`\nApplied: ${done} credit(s) now expire on schedule. The reminder/expiry worker takes it from here.`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closePool().then(() => process.exit()))
