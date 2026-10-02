#!/usr/bin/env node
/**
 * Make (or remove) a Developer Super Admin.
 *
 *   node scripts/make-developer.mjs you@example.com            # make developer
 *   node scripts/make-developer.mjs you@example.com --activate # also re-activate a deactivated account
 *   node scripts/make-developer.mjs you@example.com --remove   # remove developer access
 *
 * The person must already be an active dashboard user. If they are not an HQ Super Admin / Admin yet they are
 * promoted to SUPER_ADMIN so the developer role can reach every function. This is the ONLY way to create the first
 * developer; after that developers can add others from Dashboard → Developer.
 */
import { query, closePool } from '../src/config/database.js'

const email = process.argv[2]
const remove = process.argv.includes('--remove')
const activate = process.argv.includes('--activate')
if (!email || email.startsWith('--')) {
  console.error('Usage: node scripts/make-developer.mjs <email> [--remove]')
  process.exit(1)
}
try {
  const { rows } = await query(`SELECT id, name AS full_name, email, platform_role, is_developer, is_active FROM users WHERE lower(email) = lower($1)`, [email])
  if (rows.length !== 1) throw new Error(`Expected exactly one user with email ${email}, found ${rows.length}.`)
  const u = rows[0]
  if (!u.is_active && !activate && !remove) throw new Error(`${email} is deactivated. Re-run with --activate to turn the account back on.`)
  if (remove) {
    await query(`UPDATE users SET is_developer = false WHERE id = $1`, [u.id])
    console.log(`Removed developer access from ${u.email}`)
  } else {
    const promote = !['SUPER_ADMIN', 'ADMIN'].includes(u.platform_role)
    await query(
      `UPDATE users SET is_developer = true, is_active = true, role = 'ADMIN', platform_role = CASE WHEN platform_role IN ('SUPER_ADMIN','ADMIN') THEN platform_role ELSE 'SUPER_ADMIN' END WHERE id = $1`,
      [u.id],
    )
    console.log(`${u.email} is now a Developer Super Admin${promote ? ' (also promoted to SUPER_ADMIN)' : ''}.`)
  }
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
} finally {
  await closePool()
}
