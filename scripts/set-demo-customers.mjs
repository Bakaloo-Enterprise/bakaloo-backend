#!/usr/bin/env node
/**
 * Choose which customers a demo viewer may see.
 *
 *   node scripts/set-demo-customers.mjs --list
 *   node scripts/set-demo-customers.mjs --add 9876543210 9123456789
 *   node scripts/set-demo-customers.mjs --remove 9876543210
 *   node scripts/set-demo-customers.mjs --clear
 *
 * Only real customers (role CUSTOMER) can be marked. Everything the customer owns — orders, wallet, refunds,
 * notifications, addresses, WhatsApp chat — follows automatically.
 */
import { query, closePool } from '../src/config/database.js'

const [mode, ...phones] = process.argv.slice(2)
try {
  if (mode === '--add' || mode === '--remove') {
    if (!phones.length) throw new Error('Give at least one phone number.')
    const { rows } = await query(
      `UPDATE users SET is_demo_customer = $2 WHERE phone = ANY($1::text[]) AND role::text = 'CUSTOMER' RETURNING phone, name`,
      [phones, mode === '--add'],
    )
    const found = new Set(rows.map((r) => r.phone))
    for (const r of rows) console.log(`${mode === '--add' ? 'marked' : 'unmarked'}: ${r.phone} ${r.name ?? ''}`)
    for (const p of phones) if (!found.has(p)) console.log(`not found (or not a customer): ${p}`)
  } else if (mode === '--clear') {
    const { rowCount } = await query(`UPDATE users SET is_demo_customer = false WHERE is_demo_customer`)
    console.log(`cleared ${rowCount} demo customer(s)`)
  } else if (mode === '--list') {
    const { rows } = await query(
      `SELECT u.phone, u.name, (SELECT count(*) FROM orders o WHERE o.user_id = u.id)::int AS orders FROM users u WHERE u.is_demo_customer ORDER BY u.name`,
    )
    console.table(rows)
  } else {
    console.error('Usage: node scripts/set-demo-customers.mjs --list | --add <phone...> | --remove <phone...> | --clear')
    process.exitCode = 1
  }
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
} finally {
  await closePool()
}
