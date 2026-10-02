import { AdminCustomersController } from './customers.controller.js'
import {
  listCustomersSchema, customerIdSchema, customerOrdersSchema,
  churnedSchema, vipSchema, creditWalletSchema, debitWalletSchema, sendNotificationSchema,
  toggleBlockSchema, customerNotificationsSchema,
} from './customers.schema.js'

const ctrl = new AdminCustomersController()

export default async function adminCustomerRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: listCustomersSchema }, ctrl.list)
  fastify.get('/ltv', ctrl.getLTV)
  fastify.get('/churned', { schema: churnedSchema }, ctrl.getChurned)
  fastify.get('/vip', { schema: vipSchema }, ctrl.getVIP)
  fastify.get('/export', ctrl.exportCustomers)
  fastify.get('/:id', { schema: customerIdSchema }, ctrl.getDetail)
  fastify.get('/:id/orders', { schema: customerOrdersSchema }, ctrl.getOrders)
  fastify.get('/:id/addresses', { schema: customerIdSchema }, ctrl.getAddresses)
  fastify.post('/:id/credit-wallet', { schema: creditWalletSchema }, ctrl.creditWallet)
  fastify.post('/:id/debit-wallet', { schema: debitWalletSchema }, ctrl.debitWallet)
  fastify.get('/:id/notifications', { schema: customerNotificationsSchema }, ctrl.getNotifications)
  fastify.post('/:id/notify', { schema: sendNotificationSchema }, ctrl.sendNotification)
  fastify.put('/:id/block', { schema: toggleBlockSchema }, ctrl.toggleBlock)
}
