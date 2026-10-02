import fp from 'fastify-plugin'
import fjwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import { env } from '../config/env.js'
import { query } from '../config/database.js'
import { ERROR_CODES } from '../constants/errors.js'
import { logger } from '../config/logger.js'

/**
 * Auth plugin — registers JWT + Cookie support
 * Decorates fastify with `authenticate` and `authorize` preHandlers
 */
async function authPlugin(fastify) {
  // Cookie support (for httpOnly refresh token cookie)
  await fastify.register(cookie, {
    secret: env.COOKIE_SECRET || env.JWT_ACCESS_SECRET,
    parseOptions: {},
  })

  // JWT support (only access token verification via this plugin)
  await fastify.register(fjwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: {
      expiresIn: env.JWT_ACCESS_EXPIRY,
    },
    cookie: {
      cookieName: 'accessToken',
      signed: false,
    },
  })

  /**
   * preHandler: Verify JWT from Authorization header or cookie.
   *
   * Pipeline (per multi-vendor design §5.5, R20.8):
   *   1. `request.jwtVerify()` — validates signature + expiry, populates
   *      `request.user` with the token payload.
   *   2. Single parameterized SELECT against `users` to fetch
   *      `is_blocked` and `session_version` in one round-trip (PK
   *      lookup, well under the <50ms p95 DB budget).
   *   3. Reject blocked accounts with 403 ACCOUNT_BLOCKED.
   *   4. Compare the JWT-encoded `session_version` against
   *      `users.session_version`. Mismatch → 401 SESSION_INVALID.
   *      Change-password (auth.service.js#changePassword, task 3.5)
   *      atomically increments the row, so every previously issued JWT
   *      for the user becomes invalid the moment the transaction
   *      commits. Login / select-shop / change-password (tasks 3.2,
   *      3.3, 3.5) mint tokens with the current row value.
   *
   * Backward compatibility (R20.8 migration safety):
   *   Tokens issued before migration 047 carry no `session_version`
   *   claim. When `STRICT_SESSION_VERSION_CHECK=false` (the default
   *   until live tokens have rotated) those tokens are accepted
   *   without comparison. When the env flag is `true` the missing
   *   claim is treated as a violation and rejected with 401
   *   SESSION_INVALID — flip the flag once Phase C is live and all
   *   in-flight tokens carry the claim.
   *
   * @see Requirements: R20.8
   * @see Design: §5.5
   */
  /**
   * Shared by `authenticate` and `optionalAuth`: verify the JWT, fetch live
   * account state (blocked / session-version / B2B business-account
   * status), and populate `request.auth.b2b`. Throws a tagged error
   * ({ httpStatus, code, message }) on the two known rejection cases;
   * `request.jwtVerify()` itself throws an untagged error on a missing,
   * malformed, or expired token. Callers decide how to respond —
   * `authenticate` replies with the failure, `optionalAuth` lets its
   * caller's own try/catch swallow it and proceed anonymously.
   *
   * The LEFT JOIN to business_accounts is new (B2B feature) — everything
   * else here is byte-for-byte the same gates `authenticate` always had.
   */
  async function attachAuthContext(request) {
    await request.jwtVerify()

    // Single PK lookup fetches both existing gates plus live B2B status in
    // one round-trip.
    const { rows } = await query(
      `SELECT u.is_blocked, u.session_version, ba.status AS b2b_status, ba.b2b_enabled
         FROM users u
         LEFT JOIN business_accounts ba ON ba.user_id = u.id
        WHERE u.id = $1 LIMIT 1`,
      [request.user.id]
    )

    // Daily-active-customer stamp — fire-and-forget (never awaited) and
    // throttled at the SQL level (skip if stamped within the last 10
    // minutes) so this doesn't turn into a write on every single
    // authenticated request platform-wide. Wrapped in a synchronous
    // try/catch (not just a trailing .catch()) because `query()` isn't
    // guaranteed to return a thenable in every context this decorator
    // runs in — this must never affect the auth decision or add latency
    // to the request it's riding on.
    try {
      query(
        `UPDATE users SET last_active_at = NOW()
         WHERE id = $1 AND (last_active_at IS NULL OR last_active_at < NOW() - INTERVAL '10 minutes')`,
        [request.user.id]
      ).catch((err) => {
        logger.warn({ err: err.message, userId: request.user.id }, 'last_active_at stamp failed (non-critical)')
      })
    } catch (err) {
      logger.warn({ err: err.message, userId: request.user.id }, 'last_active_at stamp failed (non-critical)')
    }

    // ── 1. Blocked-account gate ─────────────────────────────────
    if (rows.length > 0 && rows[0].is_blocked) {
      throw Object.assign(new Error('Account is blocked. Contact support.'), {
        httpStatus: 403,
        code: 'ACCOUNT_BLOCKED',
      })
    }

    // ── 2. session_version gate (R20.8, design §5.5) ────────────
    // The JWT claim is populated by login / select-shop /
    // change-password. A row miss (deleted user) plus a present
    // claim is treated as an invalidated session for symmetry with
    // the row-vs-claim mismatch path; downstream guards already
    // assume `request.user.id` resolves to a live row.
    const jwtSessionVersion = request.user.session_version
    if (jwtSessionVersion === undefined || jwtSessionVersion === null) {
      if (env.STRICT_SESSION_VERSION_CHECK) {
        throw Object.assign(new Error('Session is no longer valid'), {
          httpStatus: 401,
          code: ERROR_CODES.SESSION_INVALID,
        })
      }
      // Non-strict mode: legacy token without the claim — accept.
    } else {
      const rowSessionVersion = rows[0]?.session_version
      if (rowSessionVersion !== jwtSessionVersion) {
        throw Object.assign(new Error('Session is no longer valid'), {
          httpStatus: 401,
          code: ERROR_CODES.SESSION_INVALID,
        })
      }
    }

    // request.auth.b2b is null when the account has never applied for a
    // business account at all — resolveEffectivePriceMode/resolveEffectiveAudience
    // treat that the same as PENDING/REJECTED (never grants B2B pricing/theme).
    request.auth = {
      ...(request.auth || {}),
      b2b: rows[0]?.b2b_status
        ? { status: rows[0].b2b_status, enabled: !!rows[0].b2b_enabled }
        : null,
    }
  }

  fastify.decorate('authenticate', async function (request, reply) {
    try {
      await attachAuthContext(request)
    } catch (err) {
      if (err.httpStatus) {
        return reply.code(err.httpStatus).send({
          success: false,
          message: err.message,
          code: err.code,
        })
      }
      // `err.name` distinguishes TokenExpiredError / JsonWebTokenError /
      // NotBeforeError from unrelated failures (e.g. the DB lookup above
      // throwing). Logged at warn so production auth failures are
      // diagnosable without guessing from response timing alone.
      logger.warn(
        { err: err.message, name: err.name, path: request.url },
        'Authenticate preHandler rejected request'
      )
      reply.code(401).send({
        success: false,
        message: 'Unauthorized — invalid or expired token',
        code: 'UNAUTHORIZED',
      })
    }
  })

  /**
   * preHandler: best-effort auth for public/soft-auth routes (product
   * listing, categories, payment-offers, and anywhere else that wants to
   * personalize for a logged-in customer without requiring login). Runs
   * the exact same live checks as `authenticate` — a blocked account or a
   * stale session is never treated as verified here either — but never
   * sends a reply of its own; on any failure request.user/.auth are simply
   * left unset and the caller's own try/catch falls back to anonymous.
   *
   * Previously referenced defensively in several route files
   * (`typeof fastify.optionalAuth === 'function'`) but never actually
   * decorated — this was a real gap: those routes silently fell back to a
   * bare `request.jwtVerify()` with no `is_blocked`/`session_version`
   * check at all, and (before this feature) no way to know a caller's
   * verified B2B status on a soft-auth route either.
   */
  fastify.decorate('optionalAuth', async function (request) {
    await attachAuthContext(request)
  })

  /**
   * preHandler factory: Check if user has one of the allowed roles
   * Must be used AFTER authenticate
   * Usage: preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])]
   */
  fastify.decorate('authorize', function (allowedRoles) {
    return async function (request, reply) {
      const { role } = request.user
      if (!allowedRoles.includes(role)) {
        reply.code(403).send({
          success: false,
          message: 'Forbidden — insufficient permissions',
          code: 'FORBIDDEN',
        })
      }
    }
  })

  /**
   * preHandler: Check if user has ADMIN role
   * Must be used AFTER authenticate
   * Usage: preHandler: [fastify.authenticate, fastify.requireAdmin]
   */
  fastify.decorate('requireAdmin', async function (request, reply) {
    const { role } = request.user
    if (role !== 'ADMIN') {
      reply.code(403).send({
        success: false,
        message: 'Forbidden — admin access required',
        code: 'FORBIDDEN',
      })
    }
  })

  /**
   * preHandler factory: Check if user has a specific permission via their role
   * Must be used AFTER authenticate
   * Usage: preHandler: [fastify.authenticate, fastify.requireAdmin, fastify.requirePermission('products.manage')]
   */
  fastify.decorate('requirePermission', function (permission) {
    return async function (request, reply) {
      const { id } = request.user
      const { rows } = await query(
        `SELECT COALESCE(r.permissions, '[]'::jsonb) AS permissions, (u.is_developer AND u.is_active) AS is_developer
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1`,
        [id]
      )
      // A Developer Super Admin is the superior role: it never needs a role attached to pass a permission check.
      if (rows[0]?.is_developer === true) return
      const perms = rows[0]?.permissions || []
      if (!perms.includes(permission)) {
        reply.code(403).send({
          success: false,
          message: `Forbidden — requires '${permission}' permission`,
          code: 'PERMISSION_DENIED',
        })
      }
    }
  })
}

export default fp(authPlugin, { name: 'auth' })
