import { BusinessError } from '../../utils/business-error.js'
import { BIZ_PERM, requireBusiness, sendBusinessError } from '../../utils/business-access.js'
import { success } from '../../utils/apiResponse.js'
import { loadCrmAccess } from '../whatsapp-crm/access.js'
import { ProcurementRepository } from './procurement.repository.js'
import { ProcurementService } from './procurement.service.js'
import * as S from './procurement.schema.js'

/**
 * Procurement — mounted at /api/v1/admin/procurement. Authenticated admin + procurement.* permission
 * (HQ SUPER_ADMIN / ADMIN always pass). Authentication runs in onRequest so an unauthenticated call is a 401
 * before any validation error.
 */
export default async function procurementRoutes(fastify) {
  const service = new ProcurementService({ repo: new ProcurementRepository() })
  fastify.addHook('onRequest', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })
  fastify.addHook('preHandler', async (request) => {
    request.biz ??= await loadCrmAccess(request.user.id)
  })

  const run = (message, fn) => async (request, reply) => {
    try {
      return success(await fn(request), message)
    } catch (err) {
      return sendBusinessError(reply, err, BusinessError)
    }
  }
  const route = (method, url, perm, schema, message, fn) =>
    fastify[method](url, { schema, preValidation: requireBusiness(perm), config: { requiredPermission: perm } }, run(message, fn))
  const { PROCUREMENT_VIEW: VIEW, PROCUREMENT_MANAGE: MANAGE } = BIZ_PERM
  const actor = (r) => ({ userId: r.user.id })

  // Which Phase 12 screens this person may use (the dashboard hides what they cannot).
  fastify.get('/me', async (request) => success({
    procurementView: request.biz.has(BIZ_PERM.PROCUREMENT_VIEW), procurementManage: request.biz.has(BIZ_PERM.PROCUREMENT_MANAGE),
    catalogBulk: request.biz.has(BIZ_PERM.CATALOG_BULK), analyticsBusiness: request.biz.has(BIZ_PERM.ANALYTICS_BUSINESS),
  }, 'Access fetched'))

  route('get', '/vendors', VIEW, S.listVendorsSchema, 'Vendors fetched', (r) => service.vendors(r.query))
  route('post', '/vendors', MANAGE, S.createVendorSchema, 'Vendor added', (r) => service.createVendor(r.body, r.user.id))
  route('patch', '/vendors/:id', MANAGE, S.updateVendorSchema, 'Vendor updated', (r) => service.updateVendor(r.params.id, r.body))

  route('get', '/entries', VIEW, S.listEntriesSchema, 'Purchases fetched', (r) => service.list(r.query))
  route('post', '/entries', MANAGE, S.createEntrySchema, 'Purchase recorded', (r) => service.createEntry(r.body, actor(r)))
  route('get', '/entries/:id', VIEW, S.idSchema, 'Purchase fetched', (r) => service.detail(r.params.id))
  route('post', '/entries/:id/allocations', MANAGE, S.allocateSchema, 'Stock sent to stores', (r) => service.allocate(r.params.id, r.body, actor(r)))
  route('post', '/entries/:id/adjustments', MANAGE, S.adjustSchema, 'Adjustment recorded', (r) => service.adjust(r.params.id, r.body, actor(r)))
  route('post', '/entries/:id/reserve', MANAGE, S.reserveSchema, 'Stock reserved for B2B', (r) => service.reserve(r.params.id, r.body, actor(r)))
  route('post', '/entries/:id/release', MANAGE, S.idSchema, 'Reservation released', (r) => service.release(r.params.id, actor(r)))
  route('post', '/entries/:id/cancel', MANAGE, S.idSchema, 'Purchase cancelled', (r) => service.cancel(r.params.id, actor(r)))
  route('post', '/allocations/:id/reverse', MANAGE, S.idSchema, 'Allocation reversed', (r) => service.reverseAllocation(r.params.id, actor(r)))

  route('get', '/reports/vendors', VIEW, S.vendorReportSchema, 'Vendor report fetched', (r) => service.vendorReport(r.query))
  route('get', '/reports/reconciliation', VIEW, S.reconciliationSchema, 'Reconciliation fetched', (r) => service.reconciliation(r.query))
}
