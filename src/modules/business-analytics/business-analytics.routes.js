import { BusinessError } from '../../utils/business-error.js'
import { BIZ_PERM, requireBusiness, sendBusinessError } from '../../utils/business-access.js'
import { success } from '../../utils/apiResponse.js'
import { ProcurementRepository } from '../procurement/procurement.repository.js'
import { ProcurementService } from '../procurement/procurement.service.js'
import { BusinessAnalyticsRepository } from './business-analytics.repository.js'
import { BusinessAnalyticsService } from './business-analytics.service.js'
import * as S from './business-analytics.schema.js'

/** Business Analytics — /api/v1/admin/business-analytics. Authenticated admin + analytics.business (HQ always passes). */
export default async function businessAnalyticsRoutes(fastify) {
  const service = new BusinessAnalyticsService({ repo: new BusinessAnalyticsRepository(), procurement: new ProcurementService({ repo: new ProcurementRepository() }) })
  fastify.addHook('onRequest', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })
  const route = (url, schema, message, fn) =>
    fastify.get(url, { schema, preValidation: requireBusiness(BIZ_PERM.ANALYTICS_BUSINESS), config: { requiredPermission: BIZ_PERM.ANALYTICS_BUSINESS } }, async (request, reply) => {
      try {
        return success(await fn(request.query), message)
      } catch (err) {
        return sendBusinessError(reply, err, BusinessError)
      }
    })
  route('/overview', S.baseSchema, 'Overview fetched', (q) => service.overview(q))
  route('/products', S.productsSchema, 'Products fetched', (q) => service.products(q))
  route('/customers', S.customersSchema, 'Customers fetched', (q) => service.customers(q))
  route('/stores', S.baseSchema, 'Stores fetched', (q) => service.stores(q))
  route('/channels', S.baseSchema, 'B2B and B2C fetched', (q) => service.channels(q))
  route('/vendors', S.vendorsSchema, 'Vendors fetched', (q) => service.vendors(q))
  route('/reconciliation', S.reconciliationSchema, 'Reconciliation fetched', (q) => service.reconciliation(q))
}
