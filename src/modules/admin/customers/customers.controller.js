import { AdminCustomersService } from './customers.service.js'
import { success, error } from '../../../utils/apiResponse.js'

const svc = new AdminCustomersService()

export class AdminCustomersController {
  async list(request, reply) {
    const { page, limit, search, status, segment, sortBy, sortOrder } = request.query
    const data = await svc.list({ page, limit, search, status, segment, sortBy, sortOrder })
    return success(data, 'Customers fetched')
  }

  async getDetail(request, reply) {
    const customer = await svc.getDetail(request.params.id)
    if (!customer) return error('Customer not found', 404)
    return success(customer, 'Customer detail fetched')
  }

  async getOrders(request, reply) {
    const { page, limit } = request.query
    const data = await svc.getOrders(request.params.id, { page, limit })
    return success(data, 'Customer orders fetched')
  }

  async getAddresses(request, reply) {
    const data = await svc.getAddresses(request.params.id)
    return success(data, 'Customer addresses fetched')
  }

  async getLTV(request, reply) {
    const data = await svc.getLTV()
    return success(data, 'Customer LTV report fetched')
  }

  async getChurned(request, reply) {
    const { days } = request.query
    const data = await svc.getChurned(days)
    return success(data, 'Churned customers fetched')
  }

  async getVIP(request, reply) {
    const { minOrders } = request.query
    const data = await svc.getVIP(minOrders)
    return success(data, 'VIP customers fetched')
  }

  async creditWallet(request, reply) {
    const { amount, description } = request.body
    const result = await svc.creditWallet(request.params.id, amount, description, request.user.id, request.ip)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'CREDIT_FAILED'))
    }
    return success({ wallet_balance: result.wallet.balance }, 'Wallet credited')
  }

  async debitWallet(request, reply) {
    const { amount, description } = request.body
    const result = await svc.debitWallet(request.params.id, amount, description, request.user.id, request.ip)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'DEBIT_FAILED'))
    }
    return success({ wallet_balance: result.wallet.balance }, 'Wallet debited')
  }

  async sendNotification(request, reply) {
    const { title, body } = request.body
    await svc.sendPersonalNotification(request.params.id, title, body, request.server, { id: request.user.id })
    return success(null, 'Notification sent')
  }

  async getNotifications(request) {
    const { personal = true, limit = 50 } = request.query
    return success(await svc.notificationHistory(request.params.id, { personal, limit }), 'Notifications fetched')
  }

  async toggleBlock(request, reply) {
    const { blocked } = request.body
    const user = await svc.toggleBlock(request.params.id, blocked, request.user.id, request.ip)
    if (!user) return error('Customer not found', 404)
    return success(user, blocked ? 'Customer blocked' : 'Customer unblocked')
  }

  async exportCustomers(request, reply) {
    const { buffer, filename } = await svc.exportCustomers()
    reply.header('Content-Type', 'text/csv')
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    return reply.send(buffer)
  }
}
