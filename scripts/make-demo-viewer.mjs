#!/usr/bin/env node
/**
 * Create (or remove) a Demo Viewer dashboard login.
 *
 *   node scripts/make-demo-viewer.mjs demo@example.com "Demo Reviewer"   # create / update, prints a temp password
 *   node scripts/make-demo-viewer.mjs demo@example.com --remove          # turn the restriction off for that account
 *
 * A demo viewer signs in like any admin and can open every screen, but only sees the customers marked with
 * scripts/set-demo-customers.mjs; every other customer's data is absent and contact numbers are blurred.
 */
import crypto from 'node:crypto'
import bcrypt from 'bcrypt'
import { query, closePool } from '../src/config/database.js'

const [email, nameArg] = process.argv.slice(2)
const remove = process.argv.includes('--remove')
if (!email || email.startsWith('--')) {
  console.error('Usage: node scripts/make-demo-viewer.mjs <email> ["Full Name"] [--remove]')
  process.exit(1)
}
try {
  if (remove) {
    const { rowCount } = await query(`UPDATE users SET is_demo_viewer = false, session_version = COALESCE(session_version, 0) + 1 WHERE lower(email) = lower($1)`, [email])
    console.log(rowCount ? `${email} is no longer a demo viewer.` : `No user with email ${email}.`)
  } else {
    const name = nameArg && !nameArg.startsWith('--') ? nameArg : 'Demo Viewer'
    const temp = crypto.randomBytes(9).toString('base64url') + 'a1!'
    const hash = await bcrypt.hash(temp, 12)
    const phone = `D${crypto.randomInt(1e9, 9e9)}` // phone is NOT NULL UNIQUE; a non-dialable placeholder
    const { rows } = await query(
      `INSERT INTO users (phone, email, name, role, platform_role, password_hash, is_active, is_demo_viewer, force_password_change)
       VALUES ($1, lower($2), $3, 'ADMIN', 'ADMIN', $4, true, true, false)
       ON CONFLICT (email) DO UPDATE
         SET role = CASE WHEN users.role::text = 'CUSTOMER' THEN 'ADMIN' ELSE users.role END,
             platform_role = COALESCE(users.platform_role, 'ADMIN'), password_hash = EXCLUDED.password_hash,
             is_active = true, is_blocked = false, is_demo_viewer = true,
             session_version = COALESCE(users.session_version, 0) + 1
       RETURNING email`,
      [phone, email, name, hash],
    )
    console.log(`Demo viewer ready: ${rows[0].email}\nPassword: ${temp}\nNext: node scripts/set-demo-customers.mjs --add <phone> [<phone> ...]`)
  }
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
} finally {
  await closePool()
}
