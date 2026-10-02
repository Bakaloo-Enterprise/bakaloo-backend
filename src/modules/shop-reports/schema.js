/**
 * JSON Schema definitions for shop-scoped report endpoints.
 * Validates query parameters: from, to, page, limit.
 *
 * @module modules/shop-reports/schema
 */

const datePattern = '^\\d{4}-\\d{2}-\\d{2}$'

const paginationQuerystring = {
  type: 'object',
  properties: {
    from: { type: 'string', pattern: datePattern, description: 'Start date (YYYY-MM-DD)' },
    to: { type: 'string', pattern: datePattern, description: 'End date (YYYY-MM-DD)' },
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
  tags: ['Shop Reports'],
  summary: 'Shop GMV report [shop_reports.view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const ordersSchema = {
  tags: ['Shop Reports'],
  summary: 'Shop orders report [shop_reports.view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const revenueSchema = {
  tags: ['Shop Reports'],
  summary: 'Shop revenue report [shop_reports.view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const refundsSchema = {
  tags: ['Shop Reports'],
  summary: 'Shop refunds report [shop_reports.view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const topProductsSchema = {
  tags: ['Shop Reports'],
  summary: 'Shop top products report [shop_reports.view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const lowStockSchema = {
  tags: ['Shop Reports'],
  summary: 'Shop low stock report [shop_reports.view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const staffActivitySchema = {
  tags: ['Shop Reports'],
  summary: 'Shop staff activity report [shop_reports.view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const riderPerformanceSchema = {
  tags: ['Shop Reports'],
  summary: 'Shop rider performance report [shop_reports.view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const couponUsageSchema = {
  tags: ['Shop Reports'],
  summary: 'Shop coupon usage report [shop_reports.view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const settlementSchema = {
  tags: ['Shop Reports'],
  summary: 'Shop settlement report [shop_reports.view]',
  security: [{ bearerAuth: [] }],
  querystring: paginationQuerystring,
  response: reportResponseSchema,
}

export const exportSchema = {
  tags: ['Shop Reports'],
  summary: 'Export shop report as CSV [shop_reports.view]',
  security: [{ bearerAuth: [] }],
  querystring: {
    type: 'object',
    properties: {
      ...paginationQuerystring.properties,
      report: {
        type: 'string',
        enum: [
          'gmv', 'orders', 'revenue', 'refunds', 'top-products',
          'low-stock', 'staff-activity', 'rider-performance',
          'coupon-usage', 'settlement',
        ],
        description: 'Report type to export',
      },
    },
    required: ['report'],
  },
}
