import crypto from 'node:crypto'

/**
 * Verify Meta's webhook signature.
 *
 * Meta signs the RAW request body with the App Secret (HMAC-SHA256) and sends
 * `X-Hub-Signature-256: sha256=<hex>`. Without this check anyone who finds the
 * webhook URL could inject fake customer messages and delivery statuses.
 *
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 *
 * Fails CLOSED: with no secret configured every request is rejected.
 * META_APP_SECRET may hold several comma-separated secrets (one per Meta app);
 * a request is valid if it matches any of them. Every comparison is
 * constant-time. Pattern adapted from ArnasDon/wacrm (MIT).
 *
 * @param {string | Buffer} rawBody exact bytes Meta sent
 * @param {string | undefined} signatureHeader value of x-hub-signature-256
 * @param {string | undefined} appSecretConfig META_APP_SECRET
 * @returns {boolean}
 */
export function verifyMetaSignature(rawBody, signatureHeader, appSecretConfig) {
  const secrets = parseSecrets(appSecretConfig)
  if (secrets.length === 0) return false
  if (rawBody == null) return false
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) return false

  const given = Buffer.from(signatureHeader)
  let ok = false
  for (const secret of secrets) {
    const expected = Buffer.from(
      'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'),
    )
    // timingSafeEqual throws on unequal lengths — a wrong-length header is simply not a match.
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) ok = true
  }
  return ok
}

/** @param {string | undefined} raw */
export function parseSecrets(raw) {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * GET handshake Meta performs when the webhook URL is first saved.
 * Returns the challenge string to echo, or null if the request must be refused.
 *
 * @param {{ 'hub.mode'?: string, 'hub.verify_token'?: string, 'hub.challenge'?: string }} query
 * @param {string | undefined} expectedToken WHATSAPP_VERIFY_TOKEN
 * @returns {string | null}
 */
export function checkVerifyHandshake(query, expectedToken) {
  if (!expectedToken) return null
  if (query['hub.mode'] !== 'subscribe') return null
  const supplied = query['hub.verify_token']
  const challenge = query['hub.challenge']
  if (typeof supplied !== 'string' || typeof challenge !== 'string' || !challenge) return null

  const a = Buffer.from(supplied)
  const b = Buffer.from(expectedToken)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  return challenge
}
