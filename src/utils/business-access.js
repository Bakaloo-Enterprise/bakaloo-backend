import { error } from './apiResponse.js'
import { loadCrmAccess } from '../modules/whatsapp-crm/access.js'

/**
 * Permissions for the Phase 12 business modules (free-form strings in roles.permissions, migration 151).
 * HQ SUPER_ADMIN / ADMIN always pass.
 */
export const BIZ_PERM = Object.freeze({
  PROCUREMENT_VIEW: 'procurement.view',
  PROCUREMENT_MANAGE: 'procurement.manage',
  CATALOG_BULK: 'catalog.bulk',
  ANALYTICS_BUSINESS: 'analytics.business',
})

/** preHandler factory. Runs after authenticate + requireAdmin. */
export function requireBusiness(permission) {
  return async function businessGuard(request, reply) {
    const access = await loadCrmAccess(request.user.id)
    request.biz = access
    if (!access.has(permission)) return reply.code(403).send(error(`Forbidden — requires '${permission}' permission`, 'PERMISSION_DENIED'))
  }
}

/** Send a BusinessError as JSON; anything else is rethrown for the global handler. */
export function sendBusinessError(reply, err, BusinessErrorClass) {
  if (err instanceof BusinessErrorClass) {
    const body = error(err.message, err.code)
    return reply.code(err.statusCode).send(err.details !== undefined ? { ...body, details: err.details } : body)
  }
  throw err
}
