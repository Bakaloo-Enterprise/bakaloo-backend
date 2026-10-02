import { query } from '../../config/database.js'
import { success, error } from '../../utils/apiResponse.js'
import { logAdminActivity } from '../../utils/activityLogger.js'
import { isDeveloper, loadFeatureAccess } from './feature-access.js'

const UUID = { type: 'string', format: 'uuid' }
const keyParams = { type: 'object', required: ['key'], properties: { key: { type: 'string', maxLength: 40 } } }

/**
 * Mounted at /api/v1/admin.
 *   GET  /features                          any signed-in dashboard user: which features are locked for me
 *   *    /developer/...                     Developer Super Admin only: release features, grant people, manage developers
 */
export default async function featuresRoutes(fastify) {
  fastify.get('/features', { preHandler: [fastify.authenticate] }, async (request) =>
    success(await loadFeatureAccess(request.user.id)),
  )

  fastify.register(async function developerRoutes(dev) {
    dev.addHook('preHandler', async (request, reply) => {
      await dev.authenticate(request, reply)
      if (reply.sent) return reply
      if (!(await isDeveloper(request.user.id))) {
        return reply.code(403).send(error('Developer Super Admin access required.', 'DEVELOPER_ONLY'))
      }
    })

    // Everything the developer page shows in one call.
    dev.get('/overview', async () => {
      const [{ rows: features }, { rows: grants }, { rows: developers }] = await Promise.all([
        query(`SELECT key, label, description, released, released_at FROM feature_flags ORDER BY label`),
        query(
          `SELECT g.feature_key, g.user_id, u.name AS full_name, u.email
             FROM feature_grants g JOIN users u ON u.id = g.user_id ORDER BY u.name NULLS LAST`,
        ),
        query(`SELECT id, name AS full_name, email, platform_role FROM users WHERE is_developer = true AND is_active = true ORDER BY name NULLS LAST`),
      ])
      return success({
        features: features.map((f) => ({
          ...f,
          grants: grants.filter((g) => g.feature_key === f.key).map((g) => ({ userId: g.user_id, fullName: g.full_name, email: g.email })),
        })),
        developers,
      })
    })

    // People who can be granted access / made a developer: active dashboard (HQ) users.
    dev.get('/users', async (request) => {
      const search = String(request.query?.search || '').trim()
      const { rows } = await query(
        `SELECT id, name AS full_name, email, platform_role, is_developer
           FROM users
          WHERE is_active = true AND platform_role IS NOT NULL
            AND ($1 = '' OR name ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%')
          ORDER BY name NULLS LAST LIMIT 50`,
        [search],
      )
      return success(rows)
    })

    // Release to everyone / lock again.
    dev.put('/features/:key', {
      schema: { params: keyParams, body: { type: 'object', required: ['released'], additionalProperties: false, properties: { released: { type: 'boolean' } } } },
    }, async (request, reply) => {
      const { rows } = await query(
        `UPDATE feature_flags
            SET released = $2, released_at = CASE WHEN $2 THEN NOW() ELSE NULL END, updated_by = $3, updated_at = NOW()
          WHERE key = $1 RETURNING key, label, released`,
        [request.params.key, request.body.released, request.user.id],
      )
      if (!rows[0]) return reply.code(404).send(error('Unknown feature.', 'NOT_FOUND'))
      logAdminActivity(request.user.id, `${rows[0].released ? 'Released' : 'Locked'} feature: ${rows[0].label}`, 'feature', null, null, { key: rows[0].key, released: rows[0].released })
      return success(rows[0])
    })

    // Early access for one person.
    dev.put('/features/:key/grants/:userId', {
      schema: { params: { type: 'object', required: ['key', 'userId'], properties: { key: { type: 'string', maxLength: 40 }, userId: UUID } } },
    }, async (request, reply) => {
      const { rows: target } = await query(`SELECT id FROM users WHERE id = $1 AND is_active = true AND platform_role IS NOT NULL`, [request.params.userId])
      if (!target[0]) return reply.code(404).send(error('User not found.', 'NOT_FOUND'))
      const { rowCount } = await query(
        `INSERT INTO feature_grants (feature_key, user_id, granted_by) SELECT key, $2, $3 FROM feature_flags WHERE key = $1 ON CONFLICT DO NOTHING`,
        [request.params.key, request.params.userId, request.user.id],
      )
      logAdminActivity(request.user.id, `Granted feature access: ${request.params.key}`, 'feature', request.params.userId, null, { key: request.params.key })
      return success({ granted: true, new: rowCount === 1 })
    })

    dev.delete('/features/:key/grants/:userId', {
      schema: { params: { type: 'object', required: ['key', 'userId'], properties: { key: { type: 'string', maxLength: 40 }, userId: UUID } } },
    }, async (request) => {
      await query(`DELETE FROM feature_grants WHERE feature_key = $1 AND user_id = $2`, [request.params.key, request.params.userId])
      logAdminActivity(request.user.id, `Revoked feature access: ${request.params.key}`, 'feature', request.params.userId, null, { key: request.params.key })
      return success({ revoked: true })
    })

    // Make / remove a Developer Super Admin. Target must already be an HQ Super Admin or Admin.
    dev.put('/users/:userId/developer', {
      schema: { params: { type: 'object', required: ['userId'], properties: { userId: UUID } }, body: { type: 'object', required: ['isDeveloper'], additionalProperties: false, properties: { isDeveloper: { type: 'boolean' } } } },
    }, async (request, reply) => {
      const { userId } = request.params
      const makeDev = request.body.isDeveloper
      if (!makeDev) {
        if (userId === request.user.id) return reply.code(400).send(error('You cannot remove your own developer access.', 'SELF_DEMOTE'))
        const { rows } = await query(`SELECT count(*)::int AS n FROM users WHERE is_developer = true AND is_active = true AND id <> $1`, [userId])
        if (rows[0].n < 1) return reply.code(400).send(error('There must always be at least one Developer Super Admin.', 'LAST_DEVELOPER'))
      }
      const { rows } = await query(
        `UPDATE users SET is_developer = $2
          WHERE id = $1 AND is_active = true AND platform_role IN ('SUPER_ADMIN','ADMIN')
          RETURNING id, name AS full_name, email, is_developer`,
        [userId, makeDev],
      )
      if (!rows[0]) return reply.code(404).send(error('User must be an active Super Admin or Admin.', 'NOT_ELIGIBLE'))
      logAdminActivity(request.user.id, `${makeDev ? 'Made' : 'Removed'} Developer Super Admin`, 'user', userId, null, { isDeveloper: makeDev })
      return success(rows[0])
    })
  }, { prefix: '/developer' })
}
