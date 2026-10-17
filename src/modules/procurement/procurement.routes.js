import { BusinessError } from '../../utils/business-error.js'
import { BIZ_PERM, requireBusiness, sendBusinessError } from '../../utils/business-access.js'
import { success } from '../../utils/apiResponse.js'
import { loadCrmAccess } from '../whatsapp-crm/access.js'
import { ProcurementRepository } from './procurement.repository.js'
import { ProcurementService } from './procurement.service.js'
import { SuppliersService } from './suppliers.service.js'
import { error } from '../../utils/apiResponse.js'
import { DistributionRepository } from './distribution.repository.js'
import { DistributionService } from './distribution.service.js'
import { PeriodsRepository } from './periods.repository.js'
import { PeriodsService } from './periods.service.js'
import { ValuationRepository } from './valuation.repository.js'
import { ValuationService } from './valuation.service.js'
import { MonthlyRepository } from './monthly.repository.js'
import { MonthlyService } from './monthly.service.js'
import { RequirementsRepository } from './requirements.repository.js'
import { RequirementsService } from './requirements.service.js'
import * as S from './procurement.schema.js'

/**
 * Procurement — mounted at /api/v1/admin/procurement. Authenticated admin + procurement.* permission
 * (HQ SUPER_ADMIN / ADMIN always pass). Authentication runs in onRequest so an unauthenticated call is a 401
 * before any validation error.
 */
export default async function procurementRoutes(fastify) {
  const procRepo = new ProcurementRepository()
  const service = new ProcurementService({ repo: procRepo })
  const distribution = new DistributionService({ repo: new DistributionRepository(), procurement: service, procRepo })
  const suppliers = new SuppliersService({ repo: new ProcurementRepository(), procurement: service })
  const periodsRepo = new PeriodsRepository()
  const monthly = new MonthlyService({ repo: new MonthlyRepository(), valuation: new ValuationService({ repo: new ValuationRepository() }), periods: periodsRepo })
  const periods = new PeriodsService({ repo: periodsRepo, monthly })
  service.periods = periods
  suppliers.periods = periods
  const reqs = new RequirementsService({ repo: new RequirementsRepository(), distribution })
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

  route('get', '/vendors', VIEW, S.listVendorsSchema, 'Vendors fetched', (r) => service.vendors(r.query, r.biz.has(MANAGE)))
  route('post', '/vendors', MANAGE, S.createVendorSchema, 'Vendor added', (r) => service.createVendor(r.body, r.user.id))
  route('patch', '/vendors/:id', MANAGE, S.updateVendorSchema, 'Vendor updated', (r) => service.updateVendor(r.params.id, r.body))

  route('get', '/entries', VIEW, S.listEntriesSchema, 'Purchases fetched', (r) => service.list(r.query))
  route('post', '/entries', MANAGE, S.createEntrySchema, 'Purchase recorded', (r) => service.createEntry(r.body, actor(r)))
  route('get', '/entries/:id', VIEW, S.idSchema, 'Purchase fetched', (r) => service.detail(r.params.id))
  route('post', '/entries/:id/receive', MANAGE, S.receiveSchema, 'Goods received', (r) => service.receive(r.params.id, r.body, actor(r)))
  route('post', '/entries/:id/arrived', MANAGE, S.arriveSchema, 'Delivery added', (r) => service.arrive(r.params.id, r.body.quantity, actor(r)))
  route('post', '/entries/:id/allocations', MANAGE, S.allocateSchema, 'Stock sent to stores', (r) => service.allocate(r.params.id, r.body, actor(r)))
  route('post', '/entries/:id/adjustments', MANAGE, S.adjustSchema, 'Adjustment recorded', (r) => service.adjust(r.params.id, r.body, actor(r)))
  route('post', '/entries/:id/reserve', MANAGE, S.reserveSchema, 'Stock reserved for B2B', (r) => service.reserve(r.params.id, r.body, actor(r)))
  route('post', '/entries/:id/release', MANAGE, S.idSchema, 'Reservation released', (r) => service.release(r.params.id, actor(r)))
  route('post', '/entries/:id/cancel', MANAGE, S.idSchema, 'Purchase cancelled', (r) => service.cancel(r.params.id, actor(r)))
  route('post', '/allocations/:id/reverse', MANAGE, S.idSchema, 'Allocation reversed', (r) => service.reverseAllocation(r.params.id, actor(r)))

  route('get', '/reports/vendors', VIEW, S.vendorReportSchema, 'Vendor report fetched', (r) => service.vendorReport(r.query))
  route('get', '/reports/reconciliation', VIEW, S.reconciliationSchema, 'Reconciliation fetched', (r) => service.reconciliation(r.query))

  // Month-end report: a screen preview and the Excel workbook, both built from the same data.
  route('get', '/reports/monthly', VIEW, S.monthlySchema, 'Month report fetched', async (r) => {
    const d = await monthly.build(r.query.month)
    return { ...monthly.previewOf(d), closing: await periods.status(r.query.month, d.closed ? null : d), history: (await periods.history()).slice(0, 6) }
  })
  route('post', '/reports/monthly/close', MANAGE, S.closeMonthSchema, 'Month closed', (r) => periods.close(r.body.month, r.body, actor(r)))
  route('post', '/reports/monthly/reopen', MANAGE, S.reopenMonthSchema, 'Month reopened', (r) => periods.reopen(r.body.month, r.body, actor(r)))
  fastify.get('/reports/monthly/download', { schema: S.monthlySchema, preValidation: requireBusiness(VIEW), config: { requiredPermission: VIEW } }, async (request, reply) => {
    try {
      const file = await monthly.workbook(request.query.month)
      return reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="bakaloo-month-end-${request.query.month}.xlsx"`).header('Cache-Control', 'private, no-store').send(file)
    } catch (err) {
      return sendBusinessError(reply, err, BusinessError)
    }
  })

  // Smart distribution: suggestion, then one confirmed plan (customer holds + store stock together).
  route('get', '/entries/:id/distribution', VIEW, S.idSchema, 'Plan suggested', (r) => distribution.preview(r.params.id))
  route('post', '/entries/:id/distribute', MANAGE, S.distributeSchema, 'Stock distributed', (r) => distribution.distribute(r.params.id, r.body, actor(r)))
  route('post', '/reservations/:id/release', MANAGE, S.idSchema, 'Hold released', (r) => distribution.releaseReservation(r.params.id, actor(r)))

  // B2B requirements (WhatsApp / call / walk-in requests) and the purchase plan built from them.
  route('get', '/plan', VIEW, {}, 'Purchase plan fetched', () => reqs.plan())
  route('get', '/requirements', VIEW, S.listRequirementsSchema, 'Requirements fetched', (r) => reqs.list(r.query))
  route('post', '/requirements', MANAGE, S.createRequirementSchema, 'Requirement saved', (r) => reqs.create(r.body, r.user.id))
  route('get', '/requirements/customers', VIEW, S.customersSchema, 'Customers fetched', (r) => reqs.customers(r.query.search))
  route('get', '/requirements/prefill', VIEW, S.prefillSchema, 'Chat details fetched', (r) => reqs.prefill(r.query.conversationId))
  route('get', '/requirements/:id', VIEW, S.idSchema, 'Requirement fetched', (r) => reqs.detail(r.params.id))
  route('post', '/requirements/:id/status', MANAGE, S.requirementStatusSchema, 'Requirement updated', (r) => reqs.setStatus(r.params.id, r.body.status, r.user.id))

  // Supplier money: what we owe, payments, and the supplier's papers.
  route('get', '/payables', VIEW, {}, 'Payables fetched', () => suppliers.payables())
  route('get', '/vendors/:id/ledger', VIEW, S.idSchema, 'Supplier account fetched', (r) => suppliers.ledger(r.params.id, r.biz.has(MANAGE)))
  route('post', '/vendors/:id/payments', MANAGE, S.paySchema, 'Payment saved', (r) => suppliers.pay(r.params.id, r.body, actor(r)))
  route('post', '/payments/:id/void', MANAGE, S.voidPaymentSchema, 'Payment cancelled', (r) => suppliers.voidPayment(r.params.id, r.body.reason, actor(r)))
  route('delete', '/documents/:id', MANAGE, S.idSchema, 'File removed', (r) => suppliers.removeDocument(r.params.id, actor(r)))

  /** multipart: one PDF / JPG / PNG per request. Kept privately in the database. */
  fastify.post('/entries/:id/documents', { schema: S.docUploadSchema, preValidation: requireBusiness(MANAGE), config: { requiredPermission: MANAGE } }, async (request, reply) => {
    const file = await request.file()
    if (!file) return reply.code(400).send(error('No file uploaded', 'BAD_REQUEST'))
    try {
      const buffer = await file.toBuffer()
      return success(await suppliers.addDocument(request.params.id, { kind: request.query.kind, buffer, filename: file.filename, mime: file.mimetype }, actor(request)), 'File saved')
    } catch (err) {
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(400).send(error('That file is bigger than 5 MB.', 'FILE_TOO_LARGE'))
      return sendBusinessError(reply, err, BusinessError)
    }
  })
  fastify.get('/documents/:id/file', { schema: S.idSchema, preValidation: requireBusiness(VIEW), config: { requiredPermission: VIEW } }, async (request, reply) => {
    try {
      const d = await suppliers.file(request.params.id)
      return reply.header('Content-Type', d.mime_type).header('Content-Disposition', `inline; filename="${encodeURIComponent(d.file_name)}"`).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').send(d.data)
    } catch (err) {
      return sendBusinessError(reply, err, BusinessError)
    }
  })
}
