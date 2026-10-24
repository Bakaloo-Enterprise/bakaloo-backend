import { success } from '../../../utils/apiResponse.js'

export class DashboardController {
  constructor(service) {
    this.service = service
  }

  async getStats(request, reply) {
    const { period = 'week' } = request.query
    const data = await this.service.getStats(period, request.shopId)
    return reply.send(success(data, 'Dashboard stats fetched'))
  }

  async getOverview(request, reply) {
    const { period = 'week' } = request.query
    const data = await this.service.getOverview(period, request.shopId)
    return reply.send(success(data, 'Overview fetched'))
  }

  async getKpis(request, reply) {
    const data = await this.service.getKpis(request.shopId)
    return reply.send(success(data, 'Dashboard KPIs fetched'))
  }

  async getRevenueChart(request, reply) {
    const { days = 7 } = request.query
    const data = await this.service.getRevenueChart(days, request.shopId)
    return reply.send(success(data, 'Revenue chart data'))
  }

  async getOrdersByHour(request, reply) {
    const data = await this.service.getOrdersByHour(request.shopId)
    return reply.send(success(data, 'Orders by hour'))
  }

  async getTopProducts(request, reply) {
    const { limit = 10 } = request.query
    const data = await this.service.getTopProducts(limit, request.shopId)
    return reply.send(success(data, 'Top products'))
  }

  async getLowStockAlerts(request, reply) {
    const { threshold = 10 } = request.query
    const data = await this.service.getLowStockAlerts(threshold, request.shopId)
    return reply.send(success(data, 'Low stock alerts'))
  }

  async getPendingActions(request, reply) {
    const data = await this.service.getPendingActions(request.shopId)
    return reply.send(success(data, 'Pending actions'))
  }

  async getLiveStats(request, reply) {
    const data = await this.service.getLiveStats(request.shopId)
    return reply.send(success(data, 'Live stats'))
  }

  async getCategoryRevenue(request, reply) {
    const data = await this.service.getCategoryRevenue(request.shopId)
    return reply.send(success(data, 'Category revenue breakdown'))
  }
}
