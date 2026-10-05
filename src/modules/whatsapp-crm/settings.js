import crypto from 'node:crypto'
import { CrmError } from './errors.js'

/**
 * WhatsApp connection settings — pure rules (no database, no network).
 * Values saved from the dashboard win over the server's .env; anything not saved falls back to .env.
 */

export const SECRET_FIELDS = Object.freeze(['accessToken', 'verifyToken', 'appSecret'])
export const PLAIN_FIELDS = Object.freeze(['phoneNumberId', 'wabaId', 'appId'])
export const ALL_FIELDS = Object.freeze([...PLAIN_FIELDS, ...SECRET_FIELDS])

const IDS = /^\d{8,20}$/
const rules = {
  phoneNumberId: { re: IDS, msg: 'The Phone number ID is only digits (about 15 of them). It is NOT the phone number itself.' },
  wabaId: { re: IDS, msg: 'The WhatsApp Business Account ID is only digits (about 15 of them).' },
  appId: { re: IDS, msg: 'The App ID is only digits.' },
  appSecret: { re: /^[a-f0-9]{32}$/i, msg: 'The App Secret is 32 letters and digits (0-9, a-f). Copy it again from App settings → Basic.' },
  verifyToken: { re: /^[A-Za-z0-9._~-]{8,100}$/, msg: 'The verify token must be 8–100 characters: letters, digits and . _ ~ - only.' },
}

/** @param {string} t */
export function cleanAccessToken(t) {
  return String(t).trim().replace(/^bearer\s+/i, '').replace(/\s+/g, '')
}

/**
 * Validate what the person typed. undefined = leave as it is. An empty string clears a plain field but keeps a secret
 * (the form shows "saved" for secrets, so an empty box means "I did not change it"); `clear` lists secrets to remove.
 * @returns {{ values: Record<string, string|null>, errors: Record<string, string> }}  values only has fields to WRITE
 */
export function validateSettingsInput(input = {}) {
  const values = {}
  const errors = {}
  for (const f of ALL_FIELDS) {
    let v = input[f]
    if (v === undefined || v === null) continue
    v = f === 'accessToken' ? cleanAccessToken(v) : String(v).trim()
    if (v === '') {
      if (PLAIN_FIELDS.includes(f)) values[f] = null
      continue
    }
    if (f === 'accessToken') {
      if (v.length < 30 || v.length > 1000) errors[f] = 'That does not look like a full access token — it is a long text (starts with “EAA”). Copy the whole thing.'
      else values[f] = v
      continue
    }
    if (!rules[f].re.test(v)) errors[f] = rules[f].msg
    else values[f] = v
  }
  for (const f of input.clear ?? []) if (SECRET_FIELDS.includes(f)) values[f] = null
  return { values, errors }
}

/** “EAAGm0…3xYz” — enough to recognise, never enough to use. */
export function maskSecret(s, { head = 4, tail = 4 } = {}) {
  const t = String(s ?? '')
  if (!t) return ''
  if (t.length <= head + tail + 2) return '•'.repeat(t.length)
  return `${t.slice(0, head)}…${t.slice(-tail)}`
}

/** A random verify token the person can paste into Meta. */
export function generateVerifyToken() {
  return `bk_${crypto.randomBytes(18).toString('base64url')}`
}

/**
 * Merge what is saved in the dashboard with the server's .env. Dashboard wins per field.
 * @param {object|null} row   wa_settings row (secrets already decrypted into `secrets`)
 * @param {{ accessToken?: string|null, verifyToken?: string|null, appSecret?: string|null }} secrets
 * @param {object} env
 */
export function resolveConfig(row, secrets, env) {
  const pick = (saved, fromEnv) => (saved ? { value: saved, source: 'dashboard' } : fromEnv ? { value: fromEnv, source: 'server' } : { value: null, source: null })
  const f = {
    phoneNumberId: pick(row?.phone_number_id, env.WHATSAPP_PHONE_NUMBER_ID),
    wabaId: pick(row?.waba_id, env.WHATSAPP_WABA_ID),
    appId: pick(row?.app_id, null),
    accessToken: pick(secrets?.accessToken, env.WHATSAPP_ACCESS_TOKEN),
    verifyToken: pick(secrets?.verifyToken, env.WHATSAPP_VERIFY_TOKEN),
    appSecret: pick(secrets?.appSecret, env.META_APP_SECRET),
  }
  const enabledFromRow = row && row.enabled !== null && row.enabled !== undefined
  return {
    enabled: enabledFromRow ? Boolean(row.enabled) : Boolean(env.WHATSAPP_ENABLED),
    enabledSource: enabledFromRow ? 'dashboard' : 'server',
    phoneNumberId: f.phoneNumberId.value,
    wabaId: f.wabaId.value,
    appId: f.appId.value,
    accessToken: f.accessToken.value,
    verifyToken: f.verifyToken.value,
    appSecret: f.appSecret.value,
    apiVersion: env.WHATSAPP_API_VERSION ?? 'v25.0',
    baseUrl: env.WHATSAPP_API_BASE_URL ?? undefined,
    sources: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.source])),
  }
}

/** A stable fingerprint of what the Meta client depends on (so it is rebuilt only when something changed). */
export function clientKey(c) {
  return [c.accessToken, c.phoneNumberId, c.wabaId, c.appId, c.apiVersion, c.baseUrl].join('|')
}

export function assertSettingsErrors(errors) {
  if (Object.keys(errors).length > 0) throw new CrmError('Some values need a look before they can be saved.', 400, 'VALIDATION', errors)
}
