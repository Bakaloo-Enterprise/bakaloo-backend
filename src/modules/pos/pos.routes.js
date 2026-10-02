import { requireShopScope } from '../../middlewares/shop-scope.js'
import { requirePermission } from '../../middlewares/permission-check.js'
import { createPosService } from './pos.factory.js'
import { createPosController } from './pos.controller.js'
import * as S from './pos.schema.js'

/**
 * Store Fulfillment POS — mounted at /api/v1/pos.
 *
 * Every route needs a signed-in user who belongs to the store (or HQ acting on it with X-Shop-Id) AND a canonical
 * shop-order permission; the finer rule (Picker vs Packer vs manager) is the POS ability check inside the
 * service. Authentication runs in onRequest so an unauthenticated call is a 401 before any validation error.
 */
export default async function posRoutes(fastify) {
  const service = createPosService(fastify)
  const ctrl = createPosController(() => service)
  const shopScope = requireShopScope({ requireShop: true })

  fastify.addHook('onRequest', async (request, reply) => {
    await fastify.authenticate(request, reply)
  })

  const route = (method, url, perm, schema, handler) =>
    fastify[method](url, { schema, config: { requiredPermission: perm }, preHandler: [shopScope, requirePermission(perm)] }, handler)

  const VIEW = 'shop_orders.view'
  const WORK = 'shop_orders.update_status'
  const RIDER = 'shop_orders.assign_rider'

  route('get', '/me', VIEW, undefined, ctrl.me)
  route('get', '/board', VIEW, undefined, ctrl.board)
  route('get', '/orders/:id', VIEW, S.orderIdSchema, ctrl.detail)
  route('get', '/orders/:id/timeline', VIEW, S.orderIdSchema, ctrl.timeline)
  route('post', '/orders/:id/assign', WORK, S.assignPersonSchema, ctrl.assignPerson)
  route('post', '/orders/:id/start-pick', WORK, S.orderIdSchema, ctrl.startPick)
  route('post', '/orders/:id/scan', WORK, S.scanSchema, ctrl.scan)
  route('post', '/orders/:id/lines/:lineId/confirm', WORK, S.confirmLineSchema, ctrl.confirmLine)
  route('post', '/orders/:id/lines/:lineId/missing', WORK, S.missingSchema, ctrl.missing)
  route('post', '/orders/:id/lines/:lineId/decision', WORK, S.decisionSchema, ctrl.decision)
  route('post', '/orders/:id/finish-pick', WORK, S.orderIdSchema, ctrl.finishPick)
  route('post', '/orders/:id/start-pack', WORK, S.orderIdSchema, ctrl.startPack)
  route('post', '/orders/:id/finish-pack', WORK, S.finishPackSchema, ctrl.finishPack)
  route('post', '/orders/:id/rider', RIDER, S.riderSchema, ctrl.assignRider)
  route('post', '/orders/:id/handover', WORK, S.orderIdSchema, ctrl.handover)

  route('get', '/riders', VIEW, undefined, ctrl.riders)
  route('get', '/staff', VIEW, undefined, ctrl.staff)
  route('patch', '/staff/:userId', WORK, S.staffStationSchema, ctrl.setStation)

  route('get', '/printers', VIEW, undefined, ctrl.printers)
  route('post', '/printers', WORK, S.addPrinterSchema, ctrl.addPrinter)
  route('patch', '/printers/:id', WORK, S.updatePrinterSchema, ctrl.updatePrinter)
  route('delete', '/printers/:id', WORK, S.printerIdSchema, ctrl.removePrinter)
  route('post', '/printers/:id/heartbeat', WORK, S.printerIdSchema, ctrl.heartbeat)
  route('post', '/printers/:id/test', WORK, S.printerIdSchema, ctrl.testPrint)

  route('get', '/print/jobs', VIEW, S.jobsSchema, ctrl.jobs)
  route('post', '/print/jobs/:id/claim', WORK, S.jobIdSchema, ctrl.claimJob)
  route('get', '/print/jobs/:id/document', WORK, S.jobIdSchema, ctrl.document)
  route('post', '/print/jobs/:id/result', WORK, S.jobResultSchema, ctrl.reportJob)
  route('post', '/print/jobs/:id/retry', WORK, S.jobIdSchema, ctrl.retryJob)
  route('post', '/print/jobs/:id/reprint', WORK, S.jobIdSchema, ctrl.reprint)

  route('get', '/attention', VIEW, undefined, ctrl.attention)
  route('post', '/attention/resolve', WORK, S.resolveAttentionSchema, ctrl.resolveAttention)
  route('get', '/performance', VIEW, S.performanceSchema, ctrl.performance)
}
