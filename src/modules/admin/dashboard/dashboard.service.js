export class DashboardService {
  constructor(repository) {
    this.repository = repository
  }

  async getStats(period = 'week', shopId = null) {
    return this.repository.getStats(period, shopId)
  }

  async getOverview(period = 'week', shopId = null) {
    return this.repository.overview.overview({ period, shopId })
  }

  async getKpis(shopId = null) {
    return this.repository.getKpis(shopId)
  }

  async getRevenueChart(days, shopId = null) {
    return this.repository.getRevenueChart(days, shopId)
  }

  async getOrdersByHour(shopId = null) {
    return this.repository.getOrdersByHour(shopId)
  }

  async getTopProducts(limit, shopId = null) {
    return this.repository.getTopProducts(limit, shopId)
  }

  async getLowStockAlerts(threshold, shopId = null) {
    return this.repository.getLowStockAlerts(threshold, shopId)
  }

  async getPendingActions(shopId = null) {
    return this.repository.getPendingActions(shopId)
  }

  async getLiveStats(shopId = null) {
    return this.repository.getLiveStats(shopId)
  }

  async getCategoryRevenue(shopId = null) {
    return this.repository.getCategoryRevenue(shopId)
  }
}
