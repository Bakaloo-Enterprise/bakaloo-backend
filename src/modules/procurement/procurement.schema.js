// NOTE: the app runs AJV with removeAdditional:'all' — fields not declared here are dropped.
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } }
const period = { period: { type: 'string', enum: ['today', '7d', '30d', 'custom'] }, from: date, to: date }

export const idSchema = { params: idParams }
export const listVendorsSchema = { querystring: { type: 'object', properties: { includeInactive: { type: 'boolean' } } } }
export const createVendorSchema = { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2, maxLength: 120 }, phone: { type: 'string', maxLength: 20 }, notes: { type: 'string', maxLength: 300 } } } }
export const updateVendorSchema = { params: idParams, body: { type: 'object', properties: { name: { type: 'string', minLength: 2, maxLength: 120 }, phone: { type: 'string', maxLength: 20 }, notes: { type: 'string', maxLength: 300 }, isActive: { type: 'boolean' } } } }

export const listEntriesSchema = {
  querystring: {
    type: 'object',
    properties: {
      from: date, to: date, vendorId: uuid, productId: uuid, shopId: uuid, status: { type: 'string', enum: ['ACTIVE', 'CANCELLED'] },
      purpose: { type: 'string', enum: ['RETAIL', 'B2B_RESERVED'] }, search: { type: 'string', maxLength: 80 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 },
    },
  },
}
export const createEntrySchema = {
  body: {
    type: 'object',
    required: ['productId', 'unitPrice'],
    properties: {
      productId: uuid, vendorId: uuid, vendorName: { type: 'string', maxLength: 120 }, unit: { type: 'string', maxLength: 40 },
      expectedQty: { type: 'integer', minimum: 1, maximum: 10_000_000 }, receivedQty: { type: 'integer', minimum: 1, maximum: 10_000_000 }, damagedQty: { type: 'integer', minimum: 0, maximum: 10_000_000 },
      unitPrice: { type: 'number', minimum: 0, maximum: 99_999_999.99 }, purchaseTotal: { type: 'number', minimum: 0, maximum: 99_999_999.99 }, procuredOn: date,
      invoiceRef: { type: 'string', maxLength: 80 }, receivingNote: { type: 'string', maxLength: 300 }, destinationShopId: uuid,
      purpose: { type: 'string', enum: ['RETAIL', 'B2B_RESERVED'] }, businessAccountId: uuid, reservationNote: { type: 'string', maxLength: 300 },
    },
  },
}
export const allocateSchema = {
  params: idParams,
  body: {
    type: 'object',
    required: ['allocations'],
    properties: {
      allocations: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['shopId', 'quantity'], properties: { shopId: uuid, quantity: { type: 'integer', minimum: 1, maximum: 10_000_000 } } } },
      note: { type: 'string', maxLength: 300 }, updateCostPrice: { type: 'boolean' },
    },
  },
}
export const adjustSchema = {
  params: idParams,
  body: {
    type: 'object',
    required: ['kind', 'quantity', 'reason'],
    properties: {
      kind: { type: 'string', enum: ['VENDOR_RETURN', 'DAMAGE', 'WASTAGE', 'AUTHORIZED_ADJUSTMENT', 'B2B_SUPPLY'] },
      quantity: { type: 'integer', minimum: 1, maximum: 10_000_000 }, shopId: uuid, reason: { type: 'string', minLength: 1, maxLength: 300 },
    },
  },
}
export const reserveSchema = { params: idParams, body: { type: 'object', properties: { businessAccountId: uuid, note: { type: 'string', maxLength: 300 } } } }
export const vendorReportSchema = { querystring: { type: 'object', properties: { ...period, vendorId: uuid } } }
export const reconciliationSchema = { querystring: { type: 'object', properties: { ...period, productId: uuid, vendorId: uuid } } }
