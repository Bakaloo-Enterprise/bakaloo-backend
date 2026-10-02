import crypto from 'node:crypto'
import { env } from '../config/env.js'

// Same HMAC-SHA256-over-a-joined-string pattern already used for Razorpay
// payment/webhook signature verification (payments.service.js, wallet
// wallet.service.js) — reused here rather than introducing a second
// signing convention. Falls back to JWT_ACCESS_SECRET so this works out of
// the box without a new required env var; set QR_SIGNING_SECRET separately
// if you want QR tokens to survive a JWT-secret rotation independently.
const SIGNING_SECRET = env.QR_SIGNING_SECRET || env.JWT_ACCESS_SECRET

export const QR_TOKEN_VERSION = 1

/**
 * Random 8-byte (64-bit) token, base64url-encoded (~11 chars).
 *
 * Kept intentionally short so the printed QR stays at the lowest possible
 * QR version (small module grid, big blocky squares — the thing that
 * actually makes a code print and scan reliably). Token length is not
 * what makes this credential safe: it is single-use (consumed on pickup
 * confirmation), time-limited (24h TTL), revoked on cancel/reassign, and
 * every scan — success or failure — is logged with rider/IP context
 * behind an authenticated, rider-scoped endpoint. 64 bits of entropy is
 * already far beyond what a rate-limited, logged guessing attack could
 * reach before being noticed and shut down.
 */
export function generatePickupToken() {
  return crypto.randomBytes(8).toString('base64url')
}

/**
 * Truncated HMAC-SHA256 (4 bytes / 32 bits of the 32-byte digest,
 * base64url-encoded to ~6 chars). This is deliberately short — it is a
 * fast, offline "does this look like a code we issued" check that lets
 * verifyScan reject garbage input before touching the database, not the
 * system's actual security boundary. The real authorization is the
 * DB-backed token lookup below it (exact value match, ACTIVE status,
 * rider ownership, single-use consumption) — none of which get any
 * weaker from a shorter signature, since a forged (token, sig) pair that
 * doesn't exist in `order_pickup_tokens` is rejected by that lookup
 * regardless of whether its signature happens to verify.
 */
function truncatedHmac(input) {
  const full = crypto.createHmac('sha256', SIGNING_SECRET).update(input).digest()
  return full.subarray(0, 4).toString('base64url')
}

/**
 * Signs {token, version} so a scanned QR payload can be verified without a
 * DB round-trip for a first-pass tamper check (the DB lookup still happens
 * separately, to check revocation/expiry/consumption state).
 *
 * Neither `orderId` nor `assignmentId` is part of the signed payload, or
 * the QR at all — verifyScan looks the token up by exact value against
 * `order_pickup_tokens` and reads `order_id`/`delivery_assignment_id`
 * straight from that row. Trusting client-supplied id fields added no
 * security (the DB row already scopes everything) and cost the QR a full
 * UUID's worth of characters for nothing.
 */
export function signPickupPayload({ token, version = QR_TOKEN_VERSION }) {
  return truncatedHmac(`${token}|${version}`)
}

export function verifyPickupSignature({ token, version = QR_TOKEN_VERSION, signature }) {
  const expected = signPickupPayload({ token, version })
  const provided = String(signature || '')
  if (expected.length !== provided.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
}

/**
 * The exact string printed in a pickup QR: `version.token.signature` (no field contains a '.', so a plain
 * split is unambiguous). The invoice and the store POS's package label both print this; the rider app parses it
 * back into { v, token, sig } for POST /pickup-tokens/verify.
 */
export function buildPickupQrPayload({ token, version = QR_TOKEN_VERSION }) {
  return `${version}.${token}.${signPickupPayload({ token, version })}`
}
