/**
 * Turns whatever went wrong while talking to Meta into something a business owner can act on:
 * a short title, what actually happened, numbered steps to fix it — and the technical details kept for support.
 * Pure: takes a plain "problem" object (see parseGraphError), no network.
 */

const DOCS = 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes'

/**
 * Read an axios error (or anything thrown) into { httpStatus, code, subcode, message, type, fbtraceId, network }.
 * @param {any} err
 */
export function parseGraphError(err) {
  const e = err?.response?.data?.error
  return {
    httpStatus: err?.response?.status ?? null,
    code: e?.code ?? null,
    subcode: e?.error_subcode ?? null,
    message: e?.message ?? err?.message ?? 'Unknown error',
    type: e?.type ?? null,
    details: e?.error_data?.details ?? null,
    fbtraceId: e?.fbtrace_id ?? null,
    network: err?.response ? null : err?.code ?? (err?.request ? 'NO_RESPONSE' : null),
  }
}

/**
 * @param {ReturnType<typeof parseGraphError>} p
 * @param {{ step?: 'phone'|'waba'|'templates'|'token'|'send', fieldName?: string }} [ctx]
 * @returns {{ title: string, cause: string, fixes: string[], technical: object, docs: string }}
 */
export function explainMetaError(p, ctx = {}) {
  const technical = { httpStatus: p.httpStatus, code: p.code, subcode: p.subcode, type: p.type, message: p.message, fbtraceId: p.fbtraceId, network: p.network }
  const out = (title, cause, fixes) => ({ title, cause, fixes, technical, docs: DOCS })
  const msg = String(p.message ?? '')

  // ── could not reach Meta at all ──
  if (p.network) {
    if (['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(p.network) || /timeout/i.test(msg)) {
      return out('Meta did not answer in time', 'Our server asked Meta, but no answer came back within 12 seconds.', ['Try “Test connection” again in a minute.', 'If it keeps happening, ask your hosting provider whether outgoing connections to graph.facebook.com are blocked.', 'Check Meta’s status page: metastatus.com.'])
    }
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(p.network)) {
      return out('The server could not find Meta’s address', 'The server could not look up graph.facebook.com (a DNS / internet problem on the server).', ['Ask your hosting provider to check the server’s internet and DNS settings.', 'Then run “Test connection” again.'])
    }
    if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'NO_RESPONSE'].includes(p.network)) {
      return out('The connection to Meta was cut', 'The server could not hold a connection to Meta (a firewall or network problem on the server).', ['Check that the server allows outgoing HTTPS (port 443).', 'Run “Test connection” again.'])
    }
    if (/CERT|SSL|TLS/i.test(p.network)) {
      return out('Secure connection to Meta failed', 'The server could not verify Meta’s security certificate.', ['Check the server’s date and time are correct.', 'Update the server’s certificate store, then try again.'])
    }
    return out('Could not reach Meta', `The request never reached Meta (${p.network}).`, ['Check the server’s internet connection.', 'Run “Test connection” again.'])
  }

  // ── access token problems ──
  if (p.code === 190 || p.httpStatus === 401) {
    if (p.subcode === 463 || /expired/i.test(msg)) {
      return out('Your access token has expired', 'Meta accepted the request format but the token’s time is over. Temporary tokens from the “API Setup” page last only 24 hours.', [
        'In Meta Business Settings → Users → System users, create a system user (Admin role).',
        'Give it your WhatsApp account as an asset with full control.',
        'Click “Generate token”, tick whatsapp_business_messaging and whatsapp_business_management, and choose “Never” for expiry.',
        'Paste the new token here and run “Save & test connection”.',
      ])
    }
    if (p.subcode === 460 || p.subcode === 467 || /session|invalidated|changed the password/i.test(msg)) {
      return out('Meta cancelled this access token', 'The person who created the token changed their Facebook password or logged out everywhere, so Meta invalidated it.', ['Create a permanent token from a system user (Business Settings → System users).', 'Paste it here and test again.'])
    }
    return out('Meta does not accept this access token', 'The token is wrong, cut short, or belongs to a different app.', [
      'Copy the whole token again — it is very long and starts with “EAA”.',
      'Make sure there is no space or line break before or after it.',
      'Make sure it was created for the same app as the Phone number ID.',
    ])
  }

  // ── wrong id / object not reachable ──
  if (p.code === 100 || p.subcode === 33) {
    if (/nonexisting field|Tried accessing/i.test(msg)) {
      return out('Meta rejected a field in our request', 'The WhatsApp API version on the server does not know one of the fields we asked for.', ['This is a problem on our side, not with your details. Please share the technical details below with support.'])
    }
    if (/does not exist|cannot be loaded|Unsupported (get|post) request|missing permissions/i.test(msg) || p.subcode === 33) {
      const label = ctx.step === 'waba' || ctx.step === 'templates' ? 'WhatsApp Business Account ID' : 'Phone number ID'
      if (ctx.step === 'waba' || ctx.step === 'templates') {
        return out(`Meta cannot find this ${label}`, 'The number you entered is not a WhatsApp Business Account that this access token can see.', [
          'In Meta → WhatsApp → API Setup the “WhatsApp Business Account ID” is shown right under the Phone number ID. Copy that one.',
          'Make sure the system user / token has your WhatsApp account added as an asset (Business Settings → System users → Add assets).',
        ])
      }
      return out(`Meta cannot find this ${label}`, 'Either the ID is wrong, or the access token is not allowed to see it.', [
        'In Meta → WhatsApp → API Setup copy the “Phone number ID” (digits only — not the phone number, and not the Business Account ID).',
        'If you use a system-user token, make sure your WhatsApp account is added to that system user as an asset with full control.',
        'Make sure the token and the ID belong to the same Meta app.',
      ])
    }
    return out('Meta says one of the values is not valid', msg || 'A parameter was rejected.', ['Check each field above against Meta’s API Setup page.', 'Run “Test connection” again.'])
  }

  // ── permissions ──
  if (p.code === 10 || (p.code >= 200 && p.code <= 299) || p.httpStatus === 403) {
    return out('This token is not allowed to do that', 'The token is valid, but it was not given the WhatsApp permissions (or does not have access to this WhatsApp account).', [
      'Create the token again from a system user and tick both whatsapp_business_messaging and whatsapp_business_management.',
      'Add your WhatsApp Business Account as an asset to that system user with full control.',
    ])
  }

  // ── limits and restrictions ──
  if ([4, 17, 32, 613, 80004, 80007, 130429, 131056].includes(p.code)) {
    return out('Meta is slowing us down (too many requests)', 'Too many requests were made in a short time.', ['Wait a few minutes and test again.', 'Nothing is wrong with your details.'])
  }
  if ([368, 131031].includes(p.code)) {
    return out('This WhatsApp account is restricted by Meta', 'Meta has temporarily blocked or locked the account (often after policy complaints or failed verification).', ['Open Meta Business Suite → Account Quality / Security Center to see the reason.', 'Follow Meta’s steps to appeal or verify, then test again.'])
  }
  if (p.code === 131042) {
    return out('No payment method on your WhatsApp account', 'Meta needs a valid payment method on the WhatsApp Business Account before it will send business messages.', ['In Meta Business Settings → WhatsApp accounts → Payment settings, add a payment method.', 'Then try again.'])
  }
  if (p.code === 131030 || (ctx.step === 'send' && /allowed list|not in allowed/i.test(msg))) {
    return out('That number is not on your test list', 'While your WhatsApp number is in test mode, you can only message numbers you added to Meta’s allowed list.', ['In Meta → WhatsApp → API Setup, under “To”, add this phone number and confirm the code sent to it.', 'Or complete business verification and add your own number to send to anyone.'])
  }
  if (p.code === 133010 || /not registered/i.test(msg)) {
    return out('This phone number is not registered yet', 'The number is added to your account but its registration is not finished.', ['In Meta → WhatsApp → API Setup (or Phone numbers), finish verifying the number with the code sent by SMS or call.', 'Then test again.'])
  }
  if (p.code === 131026) {
    return out('That number is not on WhatsApp', 'Meta could not deliver because the number does not use WhatsApp.', ['Try a number that has WhatsApp installed.'])
  }
  if (p.code === 131058) {
    return out('Meta’s sample template only works on Meta’s test numbers', 'The “hello_world” sample can only be sent from a Public Test Number, not a real business number.', ['Nothing is wrong with your connection. Send a normal message or one of your own approved templates instead.'])
  }
  if (p.code === 131047) {
    return out('That person has not messaged you in the last 24 hours', 'WhatsApp only allows free-form messages to someone who wrote to your number within the last 24 hours. A test text can’t start a conversation.', ['From that phone, send any message to your business number, then press “Send test message” again.', 'To start conversations yourself, use an approved template.'])
  }
  if (p.code === 132001 || p.code === 132000 || p.code === 132012) {
    return out('The test template could not be used', 'The sample “hello_world” template is missing, not approved, or in a different language on this account.', ['In Message templates, check that “hello_world” (English US) exists and is Approved.', 'You can still send messages using your own approved templates.'])
  }
  if (p.code === 1 || p.code === 2 || p.code === 131000 || p.code === 131016 || p.code === 133004 || (p.httpStatus && p.httpStatus >= 500)) {
    return out('Meta had a temporary problem', 'Meta’s servers returned an error that usually clears up by itself.', ['Wait a minute and test again.', 'Check metastatus.com if it continues.'])
  }

  return out('Meta returned an error', msg || 'No details were given.', ['Run “Test connection” again.', 'If it keeps failing, share the technical details below with support.'])
}
