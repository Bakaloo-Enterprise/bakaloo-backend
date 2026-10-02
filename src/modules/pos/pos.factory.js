import { logger } from '../../config/logger.js'
import { getSocketEmitter } from '../../plugins/socket-emitter.js'
import { FinalizeAssignmentService } from '../rider-assignment/finalize-assignment.service.js'
import { ShopOrdersRepository } from '../shop-orders/repository.js'
import { ShopOrdersService } from '../shop-orders/service.js'
import { PosRepository } from './pos.repository.js'
import { PosService } from './pos.service.js'

/** Realtime: tell the store's dashboards (and HQ viewing it) something changed. Content-free — screens refetch. */
export function emitPosEvent(shopId, payload) {
  try {
    getSocketEmitter().to(`shop:${shopId}`).to('hq:global').emit('pos:update', { shopId, ...payload })
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not emit POS realtime event')
  }
}

/** Wires the POS to the existing order and rider-assignment services (so their rules and side effects stay in force). */
export function createPosService(fastify) {
  return new PosService({
    repo: new PosRepository(),
    shopOrders: new ShopOrdersService(new ShopOrdersRepository(), { fastify }),
    finalize: new FinalizeAssignmentService(fastify),
    emit: emitPosEvent,
    logger,
  })
}
