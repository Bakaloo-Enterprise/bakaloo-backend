import axios from 'axios'
import { decryptSecret, encryptSecret } from '../../utils/secret-box.js'
import { CrmError } from './errors.js'
import { explainMetaError, parseGraphError } from './meta-errors.js'
import { runConnectionTest } from './connection-test.js'
import { toWaId } from './phone.js'
import { ALL_FIELDS, assertSettingsErrors, generateVerifyToken, maskSecret, resolveConfig, validateSettingsInput } from './settings.js'

const CACHE_MS = 10_000
const TEST_LIMIT = 8 // per person per minute: the test calls Meta several times

const COLUMN = { phoneNumberId: 'phone_number_id', wabaId: 'waba_id', appId: 'app_id', accessToken: 'access_token_enc', verifyToken: 'verify_token_enc', appSecret: 'app_secret_enc' }
const CREDENTIAL_FIELDS = ['phoneNumberId', 'wabaId', 'appId', 'accessToken', 'appSecret']

/**
 * WhatsApp connection settings (dashboard → WhatsApp CRM → Settings).
 * `resolved()` is what every other part of the CRM reads: saved values first, then .env, cached for a few seconds so the
 * API and the separate worker process both pick up a change without a restart.
 */
export class WhatsappSettingsService {
  /**
   * @param {{ repo: import('./settings.repository.js').WhatsappSettingsRepository, env: object, logger?: object, now?: () => Date,
   *           makeHttp?: (cfg: object) => { get: Function, post: Function } }} deps
   */
  constructor({ repo, env, logger = console, now = () => new Date(), makeHttp = defaultHttp, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    Object.assign(this, { repo, env, logger, now, makeHttp, sleep })
    this.cache = null
    this.tests = new Map()
  }

  invalidate() { this.cache = null }

  #secrets(row) {
    return { accessToken: decryptSecret(row?.access_token_enc), verifyToken: decryptSecret(row?.verify_token_enc), appSecret: decryptSecret(row?.app_secret_enc) }
  }

  /** The effective configuration right now (dashboard value, else .env). */
  async resolved({ fresh = false } = {}) {
    if (!fresh && this.cache && this.cache.until > Date.now()) return this.cache.value
    let row = null
    try {
      row = await this.repo.get()
    } catch (err) {
      // A database hiccup must not take WhatsApp down: keep serving the last known configuration.
      this.logger.warn?.({ err: err.message }, 'Could not read WhatsApp settings')
      if (this.cache) return this.cache.value
    }
    const value = resolveConfig(row, this.#secrets(row), this.env)
    this.cache = { value, until: Date.now() + CACHE_MS }
    return value
  }

  // ─── what the settings screen shows (never a secret) ───
  async view({ origin = '', canManage = false } = {}) {
    const row = await this.repo.get()
    const cfg = resolveConfig(row, this.#secrets(row), this.env)
    const hasCore = Boolean(cfg.accessToken && cfg.phoneNumberId)
    const savedStatus = row?.connection_status ?? 'NOT_TESTED'
    const state = !hasCore ? 'NOT_CONFIGURED' : savedStatus === 'CONNECTED' ? (cfg.enabled ? 'CONNECTED' : 'DISABLED') : savedStatus === 'FAILED' ? 'FAILED' : 'SAVED'
    const secret = (name, key) => ({ configured: Boolean(cfg[key]), masked: cfg[key] ? maskSecret(cfg[key], name === 'appSecret' ? { head: 0, tail: 4 } : undefined) : '', source: cfg.sources[key] })
    const webhook = await this.repo.webhookInfo().catch(() => ({ lastReceivedAt: null, last7d: 0 }))
    return {
      canManage,
      state,
      enabled: cfg.enabled,
      enabledSource: cfg.enabledSource,
      connectedAt: row?.connected_at ?? null,
      lastTestedAt: row?.last_tested_at ?? null,
      lastTest: row?.last_test ?? null,
      apiVersion: cfg.apiVersion,
      fields: {
        phoneNumberId: { value: cfg.phoneNumberId, source: cfg.sources.phoneNumberId },
        wabaId: { value: cfg.wabaId, source: cfg.sources.wabaId },
        appId: { value: cfg.appId, source: cfg.sources.appId },
        accessToken: secret('accessToken', 'accessToken'),
        appSecret: secret('appSecret', 'appSecret'),
        // The verify token is not a credential: it is the word you paste into Meta, so managers may read it.
        verifyToken: { configured: Boolean(cfg.verifyToken), value: canManage ? cfg.verifyToken : '', source: cfg.sources.verifyToken },
      },
      webhook: { callbackUrl: origin ? `${origin}/api/webhook/whatsapp` : '/api/webhook/whatsapp', ...webhook },
    }
  }

  // ─── save ───
  async save(input, userId) {
    const { values, errors } = validateSettingsInput(input)
    assertSettingsErrors(errors)
    if (input.generateVerifyToken) values.verifyToken = generateVerifyToken()
    const patch = {}
    for (const [field, v] of Object.entries(values)) {
      if (!ALL_FIELDS.includes(field)) continue
      patch[COLUMN[field]] = v !== null && ['accessToken', 'verifyToken', 'appSecret'].includes(field) ? encryptSecret(v) : v
    }
    if (typeof input.enabled === 'boolean') patch.enabled = input.enabled
    const touchedCredentials = CREDENTIAL_FIELDS.some((f) => f in values)
    if (touchedCredentials) Object.assign(patch, { connection_status: 'NOT_TESTED', connected_at: null })
    if (Object.keys(patch).length === 0) throw new CrmError('Nothing to save — change at least one field.', 400, 'NOTHING_TO_SAVE')
    await this.repo.update(patch, userId)
    this.invalidate()
    return { savedFields: Object.keys(values), credentialsChanged: touchedCredentials }
  }

  async setEnabled(enabled, userId) {
    await this.repo.update({ enabled: Boolean(enabled) }, userId)
    this.invalidate()
  }

  async clearCredentials(userId) {
    await this.repo.update({ phone_number_id: null, waba_id: null, app_id: null, access_token_enc: null, verify_token_enc: null, app_secret_enc: null, enabled: false, connection_status: 'NOT_TESTED', connected_at: null, last_test: null, last_tested_at: null }, userId)
    this.invalidate()
  }

  // ─── test ───
  #throttle(userId) {
    const t = this.now().getTime()
    const recent = (this.tests.get(userId) ?? []).filter((x) => t - x < 60_000)
    if (recent.length >= TEST_LIMIT) throw new CrmError('You have tested a lot in the last minute. Wait a moment and try again.', 429, 'TOO_MANY_TESTS')
    this.tests.set(userId, [...recent, t])
  }

  /**
   * Ask Meta. A passing test connects WhatsApp automatically (and switches it on); a failing one records why.
   * @param {{ sendTo?: string|null }} opts  a phone number to send the sample "hello_world" message to (optional)
   */
  async test({ sendTo = null, origin = '' } = {}, userId) {
    this.#throttle(userId)
    let to = null
    if (sendTo) {
      to = toWaId(sendTo)
      if (!to) throw new CrmError('That is not a valid mobile number. Use 10 digits, like 9876543210.', 400, 'VALIDATION', { sendTo: 'Invalid number' })
    }
    const cfg = await this.resolved({ fresh: true })
    const http = cfg.accessToken && cfg.phoneNumberId ? this.makeHttp(cfg) : { get: async () => { throw new Error('not configured') }, post: async () => { throw new Error('not configured') } }
    const webhook = await this.repo.webhookInfo().catch(() => ({ lastReceivedAt: null, last7d: 0 }))
    const result = await runConnectionTest({ config: cfg, http, webhook, callbackUrl: origin ? `${origin}/api/webhook/whatsapp` : null, sendTo: to, now: this.now })

    const patch = { last_test: result, last_tested_at: this.now(), connection_status: result.ok ? 'CONNECTED' : 'FAILED' }
    if (result.ok) {
      patch.enabled = true // "if I get 200, connect automatically"
      patch.connected_at = this.now()
    }
    await this.repo.update(patch, userId)
    this.invalidate()
    return result
  }
  /**
   * Point Meta at this server and subscribe to customer messages, so replies and delivery ticks reach the inbox.
   * Needs the details saved first (access token, Business Account ID, App ID, App Secret); a verify token is made if missing.
   * Two calls: the app's webhook (callback URL + "messages" fields, signed with the app token), then the Business Account
   * subscription. Each step is reported on its own, with what to do when Meta refuses.
   */
  async connectReplies({ origin = '' } = {}, userId) {
    this.#throttle(userId)
    const cfg = await this.resolved({ fresh: true })
    const missing = []
    if (!cfg.accessToken) missing.push('Access token')
    if (!cfg.wabaId) missing.push('WhatsApp Business Account ID')
    if (!cfg.appId) missing.push('App ID')
    if (!cfg.appSecret) missing.push('App Secret')
    if (missing.length) throw new CrmError(`Save these first, then try again: ${missing.join(', ')}.`, 400, 'MISSING_DETAILS', { missing })
    if (!/^https:\/\//i.test(origin)) throw new CrmError('Meta needs a public https address to send replies to. Open the dashboard from your live site and try again.', 400, 'NEEDS_PUBLIC_URL')
    const callbackUrl = `${origin.replace(/\/+$/, '')}/api/webhook/whatsapp`

    let verifyToken = cfg.verifyToken
    if (!verifyToken) {
      verifyToken = generateVerifyToken()
      await this.repo.update({ verify_token_enc: encryptSecret(verifyToken) }, userId)
      this.invalidate()
      // Meta calls our webhook while we save; the other API process may still hold the old settings for a few seconds.
      await this.sleep(CACHE_MS + 1_000)
    }

    const http = this.makeHttp(cfg)
    const steps = []
    const run = async (id, label, fn) => {
      try {
        await fn()
        steps.push({ id, label, status: 'pass' })
        return true
      } catch (err) {
        const problem = explainMetaError(parseGraphError(err), { step: 'webhook' })
        steps.push({ id, label, status: 'fail', summary: problem.title, problem })
        return false
      }
    }

    // 1 ─ the app's webhook. Meta calls our GET handshake while saving this, so our verify token must already be live.
    const form = new URLSearchParams({ object: 'whatsapp_business_account', callback_url: callbackUrl, verify_token: verifyToken, fields: 'messages,message_template_status_update', access_token: `${cfg.appId}|${cfg.appSecret}` })
    const first = await run('app', 'Meta app sends events to this server', () => http.post(`/${cfg.appId}/subscriptions`, form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: false } }))
    // 2 ─ the Business Account forwards its messages to the app
    const second = await run('waba', 'Business Account is subscribed to your app', () => http.post(`/${cfg.wabaId}/subscribed_apps`, {}))
    return { ok: first && second, callbackUrl, steps }
  }
}

/** Real network client: Graph API with the access token attached. */
function defaultHttp(cfg) {
  return axios.create({
    baseURL: `${(cfg.baseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '')}/${cfg.apiVersion}`,
    timeout: 12_000,
    headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
  })
}
