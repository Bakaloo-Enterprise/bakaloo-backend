// NOTE: the app runs AJV with removeAdditional:'all' — fields not declared here are dropped.
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const base = { period: { type: 'string', enum: ['today', '7d', '30d', 'custom'] }, from: date, to: date, shopId: uuid, channel: { type: 'string', enum: ['ALL', 'B2B', 'B2C'] } }

export const baseSchema = { querystring: { type: 'object', properties: base } }
export const productsSchema = { querystring: { type: 'object', properties: { ...base, sort: { type: 'string', enum: ['revenue', 'units', 'trending'] }, limit: { type: 'integer', minimum: 1, maximum: 50 } } } }
export const customersSchema = { querystring: { type: 'object', properties: { ...base, limit: { type: 'integer', minimum: 1, maximum: 50 } } } }
export const vendorsSchema = { querystring: { type: 'object', properties: { period: base.period, from: date, to: date, vendorId: uuid } } }
export const reconciliationSchema = { querystring: { type: 'object', properties: { period: base.period, from: date, to: date, productId: uuid, vendorId: uuid } } }
