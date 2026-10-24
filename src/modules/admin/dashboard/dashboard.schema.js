export const getStatsSchema = {
  tags: ['Admin Dashboard'],
  summary: 'Enhanced dashboard stats with comparison + sparklines',
  querystring: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'week', 'month', 'year'], default: 'week' },
    },
  },
}

export const getKpisSchema = {
  tags: ['Admin Dashboard'],
  summary: 'Flat KPI summary for the HQ Dashboard page top strip',
}

export const getRevenueChartSchema = {
  tags: ['Admin Dashboard'],
  summary: 'Revenue chart data (daily breakdown)',
  querystring: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 90, default: 7 },
    },
  },
}

export const getOrdersByHourSchema = {
  tags: ['Admin Dashboard'],
  summary: 'Order distribution by hour (last 30 days)',
}

export const getTopProductsSchema = {
  tags: ['Admin Dashboard'],
  summary: 'Top selling products by revenue',
  querystring: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
  },
}

export const getLowStockSchema = {
  tags: ['Admin Dashboard'],
  summary: 'Products with low stock alerts',
  querystring: {
    type: 'object',
    properties: {
      threshold: { type: 'integer', minimum: 1, default: 10 },
    },
  },
}

export const getPendingActionsSchema = {
  tags: ['Admin Dashboard'],
  summary: 'Count of items needing admin attention',
}

export const getLiveStatsSchema = {
  tags: ['Admin Dashboard'],
  summary: 'Real-time dashboard stats (today + riders)',
}

export const getCategoryRevenueSchema = {
  tags: ['Admin Dashboard'],
  summary: 'Revenue breakdown by category (for donut chart)',
}

export const getOverviewSchema = {
  tags: ['Admin Dashboard'],
  summary: 'Accurate overview: net revenue, orders that stood, refunds, cancellations, daily series, hours, top products, categories, channels, live counts',
  querystring: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'week', 'month', 'year'], default: 'week' },
    },
  },
}
