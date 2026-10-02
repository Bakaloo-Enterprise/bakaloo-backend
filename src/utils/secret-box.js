import crypto from 'node:crypto'
import { env } from '../config/env.js'

/**
 * Encrypts small secrets (API tokens) before they are stored in the database. AES-256-GCM: tampering is detected,
 * every value gets its own random IV. The key comes from SETTINGS_ENCRYPTION_KEY, or — when that is not set — is
 * derived from JWT_ACCESS_SECRET. If the key ever changes the stored secrets cannot be read any more:
 * decrypt() then returns null and the dashboard simply asks for the value again.
 */
const PREFIX = 'v1'

function key() {
  const secret = env.SETTINGS_ENCRYPTION_KEY || env.JWT_ACCESS_SECRET
  return crypto.createHash('sha256').update(`bakaloo:secret-box:${secret}`).digest()
}

/** @returns {string} v1:<iv>:<tag>:<ciphertext> (base64 parts) */
export function encryptSecret(plain, k = key()) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv)
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':')
}

/** @returns {string|null} null when empty, malformed, tampered with, or encrypted under a different key */
export function decryptSecret(blob, k = key()) {
  if (!blob || typeof blob !== 'string') return null
  const [v, iv, tag, data] = blob.split(':')
  if (v !== PREFIX || !iv || !tag || !data) return null
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'))
    d.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8')
  } catch {
    return null
  }
}
