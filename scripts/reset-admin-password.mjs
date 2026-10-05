#!/usr/bin/env node
/**
 * Break-glass password reset for an existing dashboard user (use when no other admin can reset it).
 *
 *   node scripts/reset-admin-password.mjs you@example.com
 *
 * Generates a random temp password, stores its bcrypt hash (cost 12, same as team.service.js), forces a change on
 * next login and invalidates existing sessions. Prints the temp password once. Runs against whatever DB_* env the
 * process loads, so check .env first.
 */
import crypto from 'node:crypto'
import bcrypt from 'bcrypt'
import { query, closePool } from '../src/config/database.js'

const email = process.argv[2]
if (!email) {
  console.error('Usage: node scripts/reset-admin-password.mjs <email>')
  process.exit(1)
}
try {
  const tempPassword = crypto.randomBytes(12).toString('base64url') + 'a1!'
  const hash = await bcrypt.hash(tempPassword, 12)
  const { rows } = await query(
    `UPDATE users
        SET password_hash = $1, force_password_change = true, session_version = COALESCE(session_version, 0) + 1,
            is_active = true, is_blocked = false, updated_at = NOW()
      WHERE lower(email) = lower($2)
      RETURNING email`,
    [hash, email],
  )
  if (rows.length !== 1) throw new Error(`Expected exactly one user with email ${email}, found ${rows.length}. Nothing changed.`)
  console.log(`Password reset for ${rows[0].email}\nTemp password: ${tempPassword}\n(must be changed at next login)`)
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
} finally {
  await closePool()
}
