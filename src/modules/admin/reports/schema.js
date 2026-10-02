/**
 * Zod-style JSON Schema definitions for HQ report endpoints.
 * Validates query parameters: from, to, shop_ids, page, limit.
 *
 * @module modules/admin/reports/schema
 */

const datePattern = '^\\d{4}-\\d{2}-\\d{2}$'

const paginationQuerystring = {
  type: 'object',
  properties: {
    from: { type: 'string', pattern: datePattern, description: 'Start date (YYYY-MM-DD)' },
    to: { type: 'string', pattern: datePattern, description: 'End date (YYYY-MM-DD)' },
    shop_ids: { type: 'string', description: 'Comma-separated shop UUIDs' },
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
}

const reportResponseSchema = {
  200: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: { type: 'array', items: { type: 'object', additionalProperties: true } },
      meta: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
        },
      },
    },
  },
}

export const gmvSchema = {
  tags: ['Admin Reports'],
  summary: 'GMV report [reports.global_view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const ordersSchema = {
  tags: ['Admin Reports'],
  summary: 'Orders report [reports.global_view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const revenueSchema = {
  tags: ['Admin Reports'],
  summary: 'Revenue report [reports.global_view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const refundsSchema = {
  tags: ['Admin Reports'],
  summary: 'Refunds report [reports.global_view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const shopPerformanceSchema = {
  tags: ['Admin Reports'],
  summary: 'Shop performance report [reports.global_view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const topShopsSchema = {
  tags: ['Admin Reports'],
  summary: 'Top shops report [reports.global_view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const topProductsSchema = {
  tags: ['Admin Reports'],
  summary: 'Top products report [reports.global_view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const lowStockSchema = {
  tags: ['Admin Reports'],
  summary: 'Low stock report [reports.global_view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const riderPerformanceSchema = {
  tags: ['Admin Reports'],
  summary: 'Rider performance report [reports.global_view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const couponUsageSchema = {
  tags: ['Admin Reports'],
  summary: 'Coupon usage report [reports.global_view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const payoutsSchema = {
  tags: ['Admin Reports'],
  summary: 'Payouts report [reports.global_view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const customerAcquisitionSchema = {
  tags: ['Admin Reports'],
  summary: 'Customer acquisition report [reports.global_view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const exportSchema = {
  tags: ['Admin Reports'],
  summary: 'Export report as CSV [reports.global_view]',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: {
      ...paginationQuerystring.properties,
      report: {
        type: 'string',
        enum: [
          'gmv', 'orders', 'revenue', 'refunds', 'shop-performance',
          'top-shops', 'top-products', 'low-stock', 'rider-performance',
          'coupon-usage', 'payouts', 'customer-acquisition',
        ],
        description: 'Report type to export',
      },
    },
    required: ['report'],
  },
}
