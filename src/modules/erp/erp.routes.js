import { BusinessError } from '../../utils/business-error.js'
import { BIZ_PERM, requireBusiness, sendBusinessError } from '../../utils/business-access.js'
import { error, success } from '../../utils/apiResponse.js'
import { OpsRepository } from './ops.repository.js'
import { OpsService } from './ops.service.js'
import { ExplorerRepository } from './explorer.repository.js'
import { ExplorerService } from './explorer.service.js'
import { emit } from '../../utils/audit-log.js'
import { FounderService } from './founder.service.js'
import { OverviewRepository } from '../admin/dashboard/overview.repository.js'
import { OverviewService } from '../admin/dashboard/overview.service.js'
import { BusinessAnalyticsRepository } from '../business-analytics/business-analytics.repository.js'
import { BusinessAnalyticsService } from '../business-analytics/business-analytics.service.js'
import { ProcurementRepository } from '../procurement/procurement.repository.js'
import { ProcurementService } from '../procurement/procurement.service.js'
import { AccountingRepository } from './accounting.repository.js'
import { AccountingService } from './accounting.service.js'
import { MonthlyRepository } from '../procurement/monthly.repository.js'
import { MonthlyService } from '../procurement/monthly.service.js'
import { PeriodsRepository } from '../procurement/periods.repository.js'
import { PeriodsService } from '../procurement/periods.service.js'
import { ValuationRepository } from '../procurement/valuation.repository.js'
import { ValuationService } from '../procurement/valuation.service.js'
import * as S from './erp.schema.js'

/**
 * Operations ERP — /api/v1/admin/erp. Authenticated admin + a feature lock ('erp') + a permission per route:
 * reading uses analytics.business (HQ always passes), changing a target uses procurement.manage.
 */
export default async function erpRoutes(fastify) {
  const ops = new OpsService({ repo: new OpsRepository() })
  const explorer = new ExplorerService({ repo: new ExplorerRepository() })
  const periodsRepo = new PeriodsRepository()
  const monthlyRepo = new MonthlyRepository()
  const monthly = new MonthlyService({ repo: monthlyRepo, valuation: new ValuationService({ repo: new ValuationRepository() }), periods: periodsRepo })
  const accounting = new AccountingService({ repo: new AccountingRepository(), monthly, monthlyRepo, periods: new PeriodsService({ repo: periodsRepo, monthly }) })
  fastify.addHook('onRequest', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })
  // A store-level user (a token that carries a shopId) sees only their own store, and never the whole-business screens.
  const HQ_ONLY = (reply) => reply.code(403).send(error('This screen covers the whole business. Ask the owner or a head-office user.', 'HQ_ONLY'))
  const OTHER_STORE = (reply) => reply.code(403).send(error('You can only work with your own store.', 'CROSS_SHOP_ACCESS_DENIED'))
  const ownShop = (request) => request.user?.shopId ?? null
  const wrap = (fn) => async (request, reply) => {
    try {
      return await fn(request, reply)
    } catch (err) {
      return sendBusinessError(reply, err, BusinessError)
    }
  }
  /** `companyWide`: money for the whole business — closed to store-level users. Otherwise a store-level user is pinned to their store. */
  const read = (url, schema, message, fn, { companyWide = false } = {}) =>
    fastify.get(url, { schema, preValidation: requireBusiness(BIZ_PERM.ANALYTICS_BUSINESS), config: { requiredPermission: BIZ_PERM.ANALYTICS_BUSINESS } }, wrap(async (request, reply) => {
      const shop = ownShop(request)
      if (shop && companyWide) return HQ_ONLY(reply)
      return success(await fn(shop ? { ...request.query, shopId: shop } : request.query), message)
    }))

  read('/ops/day-close', S.dayCloseSchema, 'Day close fetched', (q) => ops.dayClose(q))
  read('/ops/wastage', S.wastageSchema, 'Wastage fetched', (q) => ops.wastage(q))
  read('/ops/forecast', S.forecastSchema, 'Forecast fetched', (q) => ops.forecast(q))
  read('/ops/shelf', S.shelfSchema, 'Shelf fetched', (q) => ops.shelf(q.shopId))
  fastify.post('/ops/wastage', { schema: S.logWastageSchema, preValidation: requireBusiness(BIZ_PERM.PROCUREMENT_MANAGE), config: { requiredPermission: BIZ_PERM.PROCUREMENT_MANAGE } },
    wrap(async (request, reply) => {
      if (ownShop(request) && request.body.shopId !== ownShop(request)) return OTHER_STORE(reply)
      reply.code(201)
      return success(await ops.logWastage(request.body, { userId: request.user.id }), 'Wastage recorded')
    }))
  fastify.patch('/ops/products/:id/targets', { schema: S.targetsSchema, preValidation: requireBusiness(BIZ_PERM.PROCUREMENT_MANAGE), config: { requiredPermission: BIZ_PERM.PROCUREMENT_MANAGE } },
    wrap(async (request, reply) => (ownShop(request) ? HQ_ONLY(reply) : success(await ops.setTargets(request.params.id, request.body ?? {}), 'Targets saved')))) // product targets are catalogue-wide

  const founder = new FounderService({
    accounting, monthly, repo: new OpsRepository(), overview: new OverviewService({ repo: new OverviewRepository() }),
    analytics: new BusinessAnalyticsService({ repo: new BusinessAnalyticsRepository(), procurement: new ProcurementService({ repo: new ProcurementRepository() }) }),
  })
  read('/founder', S.monthSchema, 'Founder view fetched', (q) => founder.build(q), { companyWide: true })

  // ── accounting: reading needs analytics.business, writing needs procurement.manage (money handling) ──
  read('/accounting/summary', S.monthSchema, 'Accounting summary fetched', (q) => accounting.summary(q), { companyWide: true })
  read('/accounting/journal', S.monthSchema, 'Money log fetched', (q) => accounting.journal(q), { companyWide: true })
  read('/accounting/expenses', S.expensesListSchema, 'Expenses fetched', (q) => accounting.listExpenses(q), { companyWide: true })
  read('/accounting/cash-entries', S.cashListSchema, 'Cash book fetched', (q) => accounting.listCash(q), { companyWide: true })
  const write = (url, schema, message, fn, status = 200) =>
    fastify.post(url, { schema, preValidation: requireBusiness(BIZ_PERM.PROCUREMENT_MANAGE), config: { requiredPermission: BIZ_PERM.PROCUREMENT_MANAGE } },
      wrap(async (request, reply) => {
        if (ownShop(request)) return HQ_ONLY(reply) // recording business money is for head office
        reply.code(status)
        return success(await fn(request), message)
      }))
  write('/accounting/expenses', S.expenseCreateSchema, 'Expense saved', (r) => accounting.createExpense(r.body, { userId: r.user.id }), 201)
  write('/accounting/expenses/:id/void', S.voidSchema, 'Expense cancelled', (r) => accounting.voidExpense(r.params.id, r.body.reason, { userId: r.user.id }))
  write('/accounting/cash-entries', S.cashCreateSchema, 'Entry saved', (r) => accounting.createCash(r.body, { userId: r.user.id }), 201)
  write('/accounting/cash-entries/:id/void', S.voidSchema, 'Entry cancelled', (r) => accounting.voidCash(r.params.id, r.body.reason, { userId: r.user.id }))

  // ── data explorer: the raw records behind every screen (customer phones are masked) ──
  const readPerm = { preValidation: requireBusiness(BIZ_PERM.ANALYTICS_BUSINESS), config: { requiredPermission: BIZ_PERM.ANALYTICS_BUSINESS } }
  fastify.get('/explorer/kinds', readPerm, async () => success(explorer.kinds(), 'Record types'))
  const pinned = (request) => (ownShop(request) ? { ...request.query, shopId: ownShop(request) } : request.query)
  fastify.get('/explorer/:kind', { schema: S.explorerListSchema, ...readPerm }, wrap(async (request) => {
    // the company-wide expense book is not a store's to read
    if (ownShop(request) && request.params.kind === 'expenses') throw new BusinessError('Expenses cover the whole business.', 403, 'HQ_ONLY')
    return success(await explorer.list(request.params.kind, pinned(request)), 'Records fetched')
  }))
  fastify.get('/explorer/:kind/export', { schema: S.explorerExportSchema, ...readPerm }, wrap(async (request, reply) => {
    if (ownShop(request) && request.params.kind === 'expenses') throw new BusinessError('Expenses cover the whole business.', 403, 'HQ_ONLY')
    const out = await explorer.exportCsv(request.params.kind, pinned(request))
    emit('erp.explorer.export', { actor_user_id: request.user.id, actor_role: 'ADMIN', target_type: 'erp_explorer', target_id: null, after: { kind: request.params.kind, filters: request.query, rows: out.total } })
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${out.filename}"`).header('X-Export-Truncated', String(out.truncated)).header('Cache-Control', 'no-store').send(out.csv)
  }))
}
