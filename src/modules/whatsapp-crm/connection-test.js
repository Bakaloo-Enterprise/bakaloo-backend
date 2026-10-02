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

const step = (id, label, status, summary, extra = {}) => ({ id, label, status, summary, ...extra })

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
export async function runConnectionTest({ config, http, webhook = { lastReceivedAt: null, last7d: 0 }, sendTo = null, now = () => new Date() }) {
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
      if (id === 'webhook') checks.push(webhookCheck(config, webhook, now))
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

  // 5 ─ webhook
  checks.push(webhookCheck(config, webhook, now))

  // 6 ─ optional real message
  if (sendTo) {
    try {
      const { data } = await http.post(`/${config.phoneNumberId}/messages`, { messaging_product: 'whatsapp', to: sendTo, type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } })
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

function webhookCheck(config, webhook, now) {
  const needs = []
  if (!config.verifyToken) needs.push('a Verify token')
  if (!config.appSecret) needs.push('the App Secret')
  if (needs.length) {
    return step('webhook', 'Incoming messages (webhook)', 'warn', `Customer replies cannot be received yet — ${needs.join(' and ')} ${needs.length > 1 ? 'are' : 'is'} missing.`, {
      problem: { title: 'Set up the webhook to receive replies', cause: 'The webhook is how Meta sends us customer replies and “delivered / read” updates. It needs the verify token and the App Secret.', fixes: ['Add the Verify token and App Secret above.', 'Then paste the Callback URL and Verify token into Meta → WhatsApp → Configuration → Webhook and subscribe to “messages”.'], technical: {}, docs: null },
    })
  }
  if (webhook.lastReceivedAt) {
    const age = now().getTime() - new Date(webhook.lastReceivedAt).getTime()
    return step('webhook', 'Incoming messages (webhook)', age > 14 * DAY ? 'warn' : 'pass', `Last message / update from Meta arrived ${ago(age)}.`, { details: { lastReceivedAt: new Date(webhook.lastReceivedAt).toISOString(), last7d: webhook.last7d } })
  }
  return step('webhook', 'Incoming messages (webhook)', 'warn', 'Nothing has arrived from Meta yet.', {
    problem: { title: 'No incoming message received yet', cause: 'Either the webhook is not connected in Meta, or no customer has written yet.', fixes: ['Meta → WhatsApp → Configuration → Webhook: paste the Callback URL and Verify token shown below, then “Verify and save”.', 'Subscribe to the “messages” field.', 'Send a WhatsApp message to your business number from your own phone and test again.'], technical: {}, docs: null },
  })
}
