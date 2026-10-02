import { query } from '../../config/database.js'
import { error } from '../../utils/apiResponse.js'

/**
 * Feature locks (migration 154).
 *
 * A locked feature is usable only by a Developer Super Admin (users.is_developer) or by someone the developer
 * granted individually. Once the developer flips `released`, everyone who already holds the feature's normal
 * permission can use it. This sits IN FRONT of the existing permission checks — it never widens access.
 */

/** URL prefix -> feature key. Everything not listed here is never gated. */
export const FEATURE_PREFIXES = Object.freeze([
  ['/api/v1/admin/crm', 'whatsapp_crm'],
  ['/api/v1/admin/chat', 'team_chat'],
  ['/api/v1/admin/procurement', 'procurement'],
  ['/api/v1/admin/catalog-bulk', 'catalog_bulk'],
  ['/api/v1/admin/business-analytics', 'business_analytics'],
  ['/api/v1/pos', 'store_pos'],
])

export function featureForUrl(url) {
  const path = String(url || '').split('?')[0]
  for (const [prefix, key] of FEATURE_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return key
  }
  return null
}

/** Is this user a (still active) Developer Super Admin? */
export async function isDeveloper(userId) {
  const { rows } = await query(`SELECT 1 FROM users WHERE id = $1 AND is_developer = true AND is_active = true`, [userId])
  return rows.length > 0
}

/** Can this user use the feature right now? */
export async function canUseFeature(userId, key) {
  const { rows } = await query(
    `SELECT u.is_developer, f.released,
            EXISTS (SELECT 1 FROM feature_grants g WHERE g.feature_key = f.key AND g.user_id = u.id) AS granted
       FROM users u, feature_flags f
      WHERE u.id = $1 AND u.is_active = true AND f.key = $2`,
    [userId, key],
  )
  const row = rows[0]
  if (!row) return false // unknown user or unknown feature → closed
  return row.is_developer === true || row.released === true || row.granted === true
}

/** Everything the dashboard needs to draw locks: one entry per feature + whether the caller is a developer. */
export async function loadFeatureAccess(userId) {
  const [{ rows: flags }, { rows: me }, { rows: grants }] = await Promise.all([
    query(`SELECT key, label, description, released FROM feature_flags ORDER BY label`),
    query(`SELECT is_developer FROM users WHERE id = $1 AND is_active = true`, [userId]),
    query(`SELECT feature_key FROM feature_grants WHERE user_id = $1`, [userId]),
  ])
  const dev = me[0]?.is_developer === true
  const granted = new Set(grants.map((g) => g.feature_key))
  return {
    isDeveloper: dev,
    features: Object.fromEntries(
      flags.map((f) => [f.key, { label: f.label, released: f.released, canAccess: dev || f.released || granted.has(f.key) }]),
    ),
  }
}

/**
 * Global onRequest hook. Installed once on the root app (before the module routes) so it covers every locked prefix
 * without touching those modules, and runs BEFORE their own auth / permission / validation so a locked feature answers
 * FEATURE_LOCKED consistently. It authenticates the caller itself (same live checks as the routes), so an
 * unauthenticated caller still gets a plain 401, never a lock message.
 */
export function installFeatureGate(app) {
  app.addHook('onRequest', async (request, reply) => {
    const key = featureForUrl(request.raw.url)
    if (!key) return
    if (!request.user) {
      await app.authenticate(request, reply)
      if (reply.sent) return reply
    }
    if (!(await canUseFeature(request.user.id, key))) {
      return reply
        .code(403)
        .send(error('This feature is still in development and is not available yet.', 'FEATURE_LOCKED'))
    }
  })
}
