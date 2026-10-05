import { explainMetaError, parseGraphError } from './meta-errors.js'

/**
 * "Test connection": asks Meta the questions that decide whether WhatsApp will work, and explains every failure.
 * No secrets ever appear in the result. `http` is an axios-like client already pointed at the Graph API with the
 * access token attached, so this file is testable with a fake.
 *
 * Overall level:  READY  – can send, templates + token fine
 *                 PARTIAL – can send, something else needs attention (templates, token expiry, webhook)
 *                 FAILED – cannot send
 * `ok` (= "connected") means Meta accepted the token and the Phone number ID.
 */

const DAY = 86_400_000

/** Every check has the same shape; a problem written in plain words (no Meta error behind it) still carries empty technical details. */
const step = (id, label, status, summary, extra = {}) => ({
  id, label, status, summary, ...extra,
  ...(extra.problem ? { problem: { technical: {}, docs: null, ...extra.problem, fixes: extra.problem.fixes ?? [] } } : {}),
})

function ago(ms) {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

/**
 * @param {{ config: { phoneNumberId?: string|null, wabaId?: string|null, appId?: string|null, accessToken?: string|null, appSecret?: string|null, verifyToken?: string|null },
 *           http: { get: Function, post: Function },
 *           webhook?: { lastReceivedAt: Date|null, last7d: number },
 *           sendTo?: string|null, now?: () => Date }} a
 */
export async function runConnectionTest({ config, http, webhook = { lastReceivedAt: null, last7d: 0 }, callbackUrl = null, sendTo = null, now = () => new Date() }) {
  const started = now().getTime()
  const checks = []
  const finish = (ok, level, headline) => ({ ok, level, headline, checks, testedAt: now().toISOString(), durationMs: now().getTime() - started })

  // 1 ─ do we even have the two values needed to send?
  const missing = []
  if (!config.accessToken) missing.push('Access token')
  if (!config.phoneNumberId) missing.push('Phone number ID')
  if (missing.length) {
    checks.push(step('credentials', 'Details entered', 'fail', `Still missing: ${missing.join(' and ')}.`, {
      problem: { title: 'Some details are missing', cause: 'WhatsApp needs at least the Access token and the Phone number ID to send messages.', fixes: ['Fill in the missing fields above and press “Save & test connection”.'], technical: {}, docs: null },
    }))
    return finish(false, 'FAILED', 'Not connected — some details are missing.')
  }
  checks.push(step('credentials', 'Details entered', 'pass', 'Access token and Phone number ID are saved.'))

  // 2 ─ token + phone number id (this is the "200" that decides connected)
  let phoneOk = false
  let phoneInfo = null
  try {
    const { data } = await http.get(`/${config.phoneNumberId}`, { params: { fields: 'display_phone_number,verified_name,quality_rating' } })
    phoneInfo = { number: data.display_phone_number ?? null, name: data.verified_name ?? null, quality: data.quality_rating ?? null }
    phoneOk = true
    // Extra detail — useful but never a reason to fail.
    try {
      const more = await http.get(`/${config.phoneNumberId}`, { params: { fields: 'code_verification_status,name_status,messaging_limit_tier,platform_type,throughput' } })
      phoneInfo = { ...phoneInfo, verification: more.data.code_verification_status ?? null, nameStatus: more.data.name_status ?? null, limitTier: more.data.messaging_limit_tier ?? null, platform: more.data.platform_type ?? null }
    } catch { /* optional */ }
    checks.push(step('phone', 'Access token & Phone number ID', 'pass', `Meta confirmed ${phoneInfo.number ?? 'your number'}${phoneInfo.name ? ` (“${phoneInfo.name}”)` : ''}.`, { details: phoneInfo }))
  } catch (err) {
    const problem = parseGraphError(err)
    let explained = explainMetaError(problem, { step: 'phone' })
    // Most common slip: the Business Account ID was pasted where the Phone number ID belongs.
    if (problem.code === 100 || problem.subcode === 33) {
      try {
        const probe = await http.get(`/${config.phoneNumberId}/phone_numbers`, { params: { fields: 'id,display_phone_number', limit: 5 } })
        const list = (probe.data?.data ?? []).map((n) => `${n.display_phone_number} → ID ${n.id}`)
        if (list.length) {
          explained = {
            ...explained,
            title: 'That is a Business Account ID, not a Phone number ID',
            cause: 'You pasted the WhatsApp Business Account ID into the Phone number ID box. They sit next to each other in Meta, so this is an easy mix-up.',
            fixes: [`Use one of these as the Phone number ID: ${list.join('; ')}.`, 'Put the number you pasted now into the “WhatsApp Business Account ID” box instead.'],
          }
        }
      } catch { /* not a WABA id either — keep the generic explanation */ }
    }
    checks.push(step('phone', 'Access token & Phone number ID', 'fail', explained.title, { problem: explained }))
  }

  if (!phoneOk) {
    for (const [id, label] of [['waba', 'WhatsApp Business Account'], ['templates', 'Message templates'], ['token', 'Token lifetime'], ['webhook', 'Incoming messages (webhook)']]) {
      if (id === 'webhook') checks.push(await webhookCheck(config, webhook, now, http, callbackUrl, false))
      else checks.push(step(id, label, 'skip', 'Skipped until the access token and Phone number ID work.'))
    }
    return finish(false, 'FAILED', 'Not connected — Meta did not accept the access token / Phone number ID.')
  }

  // 3 ─ business account + templates
  if (config.wabaId) {
    try {
      const { data } = await http.get(`/${config.wabaId}`, { params: { fields: 'name,currency,timezone_id' } })
      checks.push(step('waba', 'WhatsApp Business Account', 'pass', `Found “${data.name ?? 'your account'}”${data.currency ? ` · billing currency ${data.currency}` : ''}.`, { details: { name: data.name ?? null, currency: data.currency ?? null } }))
      try {
        await http.get(`/${config.wabaId}/message_templates`, { params: { limit: 1, fields: 'name,status' } })
        checks.push(step('templates', 'Message templates', 'pass', 'Templates can be listed, created and sent.'))
      } catch (err) {
        checks.push(step('templates', 'Message templates', 'fail', 'Templates are not available yet.', { problem: explainMetaError(parseGraphError(err), { step: 'templates' }) }))
      }
    } catch (err) {
      const explained = explainMetaError(parseGraphError(err), { step: 'waba' })
      checks.push(step('waba', 'WhatsApp Business Account', 'fail', explained.title, { problem: explained }))
      checks.push(step('templates', 'Message templates', 'skip', 'Skipped until the Business Account ID works.'))
    }
  } else {
    checks.push(step('waba', 'WhatsApp Business Account', 'warn', 'Not entered. Messages can be sent, but templates (needed to start conversations) will not work.', {
      problem: { title: 'Add your WhatsApp Business Account ID', cause: 'It is needed to create and list message templates.', fixes: ['Meta → WhatsApp → API Setup: copy “WhatsApp Business Account ID” and paste it above.'], technical: {}, docs: null },
    }))
    checks.push(step('templates', 'Message templates', 'skip', 'Needs the Business Account ID.'))
  }

  // 4 ─ token lifetime (only possible with the App ID + App Secret)
  checks.push(await tokenCheck(config, http, now))

  // 5 ─ webhook (is Meta actually set up to send customer messages to us?)
  checks.push(await webhookCheck(config, webhook, now, http, callbackUrl, true))

  // 6 ─ optional real message
  if (sendTo) {
    try {
      const { data } = await http.post(`/${config.phoneNumberId}/messages`, { messaging_product: 'whatsapp', to: sendTo, type: 'text', text: { body: 'Test message from Bakaloo: your WhatsApp connection is working. ✅' } })
      checks.push(step('message', 'Test message', 'pass', `Meta accepted a test message to ${sendTo}. It should reach WhatsApp in a few seconds.`, { details: { wamid: data?.messages?.[0]?.id ?? null } }))
    } catch (err) {
      const explained = explainMetaError(parseGraphError(err), { step: 'send' })
      checks.push(step('message', 'Test message', 'fail', explained.title, { problem: explained }))
    }
  }

  const bad = checks.filter((c) => c.status === 'fail' || c.status === 'warn')
  if (bad.length === 0) return finish(true, 'READY', 'Connected — everything checks out.')
  return finish(true, 'PARTIAL', `Connected — ${bad.length} thing${bad.length === 1 ? '' : 's'} to look at.`)
}

async function tokenCheck(config, http, now) {
  if (!config.appId || !config.appSecret) {
    return step('token', 'Token lifetime', 'skip', 'Add the App ID and App Secret to see when your token expires and which permissions it has.')
  }
  try {
    // The app token goes in the query string; the user-token Authorization header the client adds must not be sent here.
    const { data } = await http.get('/debug_token', { params: { input_token: config.accessToken, access_token: `${config.appId}|${config.appSecret}` }, headers: { Authorization: false } })
    const d = data?.data ?? {}
    if (d.is_valid === false) {
      const explained = explainMetaError({ httpStatus: 400, code: 190, subcode: /expired/i.test(d.error?.message ?? '') ? 463 : null, message: d.error?.message ?? 'Token is not valid' })
      return step('token', 'Token lifetime', 'fail', explained.title, { problem: explained })
    }
    const scopes = Array.isArray(d.scopes) ? d.scopes : []
    const expiresAt = d.expires_at ? new Date(d.expires_at * 1000) : null
    const details = { type: d.type ?? null, expiresAt: expiresAt?.toISOString() ?? null, scopes }
    const lacks = ['whatsapp_business_messaging', 'whatsapp_business_management'].filter((s) => scopes.length > 0 && !scopes.includes(s))
    if (lacks.length) {
      return step('token', 'Token lifetime', 'warn', `The token is missing permission: ${lacks.join(', ')}.`, {
        details, problem: { title: 'The token is missing a WhatsApp permission', cause: `Without ${lacks.join(' and ')} some actions will be refused.`, fixes: ['Create the token again from a system user and tick both whatsapp_business_messaging and whatsapp_business_management.'], technical: { scopes }, docs: null },
      })
    }
    if (expiresAt) {
      const left = expiresAt.getTime() - now().getTime()
      const soon = left < 7 * DAY
      return step('token', 'Token lifetime', soon ? 'warn' : 'pass', soon ? `Temporary token — expires ${left < 0 ? 'already' : `in ${Math.max(1, Math.round(left / 3_600_000))} hours`}.` : `Valid until ${expiresAt.toLocaleDateString('en-IN')}.`, {
        details, ...(soon ? { problem: { title: 'This token will stop working soon', cause: 'Tokens from the “API Setup” page last only 24 hours, so WhatsApp would stop working tomorrow.', fixes: ['Create a permanent token from a system user (Business Settings → System users → Generate token → expiry “Never”).', 'Paste it above and press “Save & test connection”.'], technical: {}, docs: null } } : {}),
      })
    }
    return step('token', 'Token lifetime', 'pass', 'Permanent token (never expires) with the right permissions.', { details })
  } catch (err) {
    const problem = parseGraphError(err)
    return step('token', 'Token lifetime', 'warn', 'Could not check the token with this App ID / App Secret.', {
      problem: { ...explainMetaError(problem, { step: 'token' }), title: 'The App ID or App Secret does not match', cause: 'Meta could not use this App ID + App Secret to look at the token. One of them is probably wrong, or they belong to another app.', fixes: ['Meta → App settings → Basic: copy the App ID and App Secret again.', 'These two are optional — your messages are not affected.'] },
    })
  }
}

/**
 * Replies only reach the inbox when ALL of these are true, so each one is checked and named:
 *   1. a Verify token and the App Secret are saved here (the App Secret signs every event Meta sends; without it we reject them all)
 *   2. the Business Account is subscribed to the app, so Meta forwards its messages
 *   3. the app's webhook points at us and includes "messages"
 *   4. an event has really arrived
 * 2 and 3 are asked of Meta when the details needed to ask are saved.
 */
async function webhookCheck(config, webhook, now, http, callbackUrl, canAsk) {
  const label = 'Incoming messages (webhook)'
  const needs = []
  if (!config.verifyToken) needs.push('a Verify token')
  if (!config.appSecret) needs.push('the App Secret')
  if (needs.length) {
    return step('webhook', label, 'warn', `Customer replies cannot be received yet — ${needs.join(' and ')} ${needs.length > 1 ? 'are' : 'is'} missing.`, {
      problem: {
        title: 'Customer replies are blocked until the App Secret is saved',
        cause: 'Meta signs every message it sends us with your App Secret, and we refuse anything we cannot check. With no App Secret saved, every reply would be rejected, so nothing would show in the inbox.',
        fixes: [
          'Meta → App settings → Basic → copy the “App secret” (and the “App ID”) and paste them above, then press “Save only”.',
          'Then press “Connect replies automatically” in the Receive replies box — it tells Meta where to send replies and subscribes to messages for you.',
        ],
      },
    })
  }

  // Ask Meta (only possible once the Business Account ID is saved).
  const asked = []
  if (canAsk && http && config.wabaId) {
    try {
      const { data } = await http.get(`/${config.wabaId}/subscribed_apps`)
      const apps = Array.isArray(data?.data) ? data.data : []
      const mine = config.appId ? apps.some((a) => String(a?.whatsapp_business_api_data?.id ?? a?.id ?? '') === String(config.appId)) : apps.length > 0
      if (!mine) {
        return step('webhook', label, 'warn', 'Meta is not forwarding this WhatsApp number’s messages to your app yet.', {
          problem: {
            title: 'Your Business Account is not subscribed to your app',
            cause: 'Even with the webhook address saved in Meta, Meta only sends events for a Business Account that has been subscribed to the app. Yours has not been, so no customer reply is ever sent to us.',
            fixes: ['Press “Connect replies automatically” in the Receive replies box — it subscribes the account for you.', 'Or call Meta’s “subscribed_apps” for your Business Account yourself.'],
          },
        })
      }
      asked.push('Business Account is subscribed to your app')
    } catch { /* could not ask — fall through to what we know locally */ }
  }
  if (canAsk && http && config.appId && config.appSecret) {
    try {
      const { data } = await http.get(`/${config.appId}/subscriptions`, { params: { access_token: `${config.appId}|${config.appSecret}` }, headers: { Authorization: false } })
      const sub = (Array.isArray(data?.data) ? data.data : []).find((x) => x?.object === 'whatsapp_business_account')
      const fields = (sub?.fields ?? []).map((f) => (typeof f === 'string' ? f : f?.name))
      if (!sub || sub.active === false || !fields.includes('messages')) {
        return step('webhook', label, 'warn', 'Your Meta app is not set to send customer messages to us yet.', {
          problem: {
            title: 'The webhook is not subscribed to “messages”',
            cause: !sub ? 'Meta has no webhook saved for WhatsApp on this app.' : 'The webhook exists, but “messages” is not ticked, so customer replies are not sent.',
            fixes: ['Press “Connect replies automatically” in the Receive replies box.', 'Or in Meta → WhatsApp → Configuration → Webhook fields, press Subscribe next to “messages”.'],
          },
        })
      }
      if (callbackUrl && sub.callback_url && sub.callback_url.replace(/\/+$/, '') !== callbackUrl.replace(/\/+$/, '')) {
        return step('webhook', label, 'warn', 'Meta is sending events to a different address.', {
          details: { metaCallbackUrl: sub.callback_url, expected: callbackUrl },
          problem: { title: 'The webhook address in Meta is different', cause: `Meta sends to ${sub.callback_url}, but this server expects ${callbackUrl}.`, fixes: ['Press “Connect replies automatically” to point Meta at the right address.'] },
        })
      }
      asked.push('webhook is subscribed to messages')
    } catch { /* could not ask */ }
  }

  if (webhook.lastReceivedAt) {
    const age = now().getTime() - new Date(webhook.lastReceivedAt).getTime()
    return step('webhook', label, age > 14 * DAY ? 'warn' : 'pass', `Last message / update from Meta arrived ${ago(age)}.`, { details: { lastReceivedAt: new Date(webhook.lastReceivedAt).toISOString(), last7d: webhook.last7d, confirmed: asked } })
  }
  return step('webhook', label, 'warn', asked.length ? 'Set up in Meta — nothing has arrived yet. Send a WhatsApp message to your number to confirm.' : 'Nothing has arrived from Meta yet.', {
    details: { confirmed: asked },
    problem: { title: 'No incoming message received yet', cause: asked.length ? 'Meta says it is set up. Either no customer has written since, or the message is still on its way.' : 'Either the webhook is not connected in Meta, or no customer has written yet.', fixes: ['Press “Connect replies automatically” (needs App ID + App Secret), or in Meta → WhatsApp → Configuration → Webhook paste the Callback URL and Verify token, Verify and save, then subscribe to “messages”.', 'Send a WhatsApp message to your business number and check again.'] },
  })
}
