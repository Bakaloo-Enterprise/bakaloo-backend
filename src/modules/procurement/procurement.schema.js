// NOTE: the app runs AJV with removeAdditional:'all' — fields not declared here are dropped.
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } }
const period = { period: { type: 'string', enum: ['today', '7d', '30d', 'custom'] }, from: date, to: date }

export const idSchema = { params: idParams }
export const listVendorsSchema = { querystring: { type: 'object', properties: { includeInactive: { type: 'boolean' } } } }
export const createVendorSchema = { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2, maxLength: 120 }, phone: { type: 'string', maxLength: 20 }, notes: { type: 'string', maxLength: 300 }, tradeName: { type: 'string', maxLength: 160 }, gstin: { type: 'string', maxLength: 20 }, address: { type: 'string', maxLength: 300 }, contactPerson: { type: 'string', maxLength: 120 }, paymentTerms: { type: 'string', enum: ['CASH', 'UPI', 'BANK', 'CREDIT'] }, creditDays: { type: 'integer', minimum: 0, maximum: 365 }, upiId: { type: 'string', maxLength: 80 }, bankName: { type: 'string', maxLength: 80 }, bankAccountNo: { type: 'string', maxLength: 30 }, bankIfsc: { type: 'string', maxLength: 11 } } } }
export const updateVendorSchema = { params: idParams, body: { type: 'object', properties: { name: { type: 'string', minLength: 2, maxLength: 120 }, phone: { type: 'string', maxLength: 20 }, notes: { type: 'string', maxLength: 300 }, isActive: { type: 'boolean' }, tradeName: { type: 'string', maxLength: 160 }, gstin: { type: 'string', maxLength: 20 }, address: { type: 'string', maxLength: 300 }, contactPerson: { type: 'string', maxLength: 120 }, paymentTerms: { type: 'string', enum: ['CASH', 'UPI', 'BANK', 'CREDIT'] }, creditDays: { type: 'integer', minimum: 0, maximum: 365 }, upiId: { type: 'string', maxLength: 80 }, bankName: { type: 'string', maxLength: 80 }, bankAccountNo: { type: 'string', maxLength: 30 }, bankIfsc: { type: 'string', maxLength: 11 } } } }

export const listEntriesSchema = {
  querystring: {
    type: 'object',
    properties: {
      from: date, to: date, vendorId: uuid, productId: uuid, shopId: uuid, status: { type: 'string', enum: ['ORDERED', 'ACTIVE', 'CANCELLED'] },
      owed: { type: 'boolean' },
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
      purpose: { type: 'string', enum: ['RETAIL', 'B2B_RESERVED'] }, businessAccountId: uuid, reservationNote: { type: 'string', maxLength: 300 }, ordered: { type: 'boolean' },
    },
  },
}
export const receiveSchema = {
  params: idParams,
  body: {
    type: 'object',
    required: ['receivedQty'],
    properties: {
      receivedQty: { type: 'integer', minimum: 1, maximum: 10_000_000 }, rejectedQty: { type: 'integer', minimum: 0, maximum: 10_000_000 },
      outcome: { type: 'string', enum: ['WASTAGE', 'RETURN', 'REPLACEMENT'] }, restComing: { type: 'boolean' }, note: { type: 'string', maxLength: 300 },
    },
  },
}
export const arriveSchema = { params: idParams, body: { type: 'object', required: ['quantity'], properties: { quantity: { type: 'integer', minimum: 1, maximum: 10_000_000 } } } }
export const allocateSchema = {
  params: idParams,
  body: {
    type: 'object',
    required: ['allocations'],
    properties: {
      allocations: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['shopId', 'quantity'], properties: { shopId: uuid, quantity: { type: 'integer', minimum: 1, maximum: 10_000_000 } } } },
      note: { type: 'string', maxLength: 300 }, updateCostPrice: { type: 'boolean' }, inTransit: { type: 'boolean' },
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

const reqStatus = { type: 'string', enum: ['INQUIRY', 'CONFIRMED', 'DELIVERED', 'CANCELLED'] }
export const listRequirementsSchema = { querystring: { type: 'object', properties: { status: reqStatus, source: { type: 'string', enum: ['WHATSAPP_META', 'WHATSAPP_PERSONAL', 'PHONE_CALL', 'WALK_IN', 'OTHER'] }, search: { type: 'string', maxLength: 80 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } } } }
export const createRequirementSchema = {
  body: {
    type: 'object',
    required: ['customerName', 'source', 'items'],
    properties: {
      customerName: { type: 'string', maxLength: 120 }, customerPhone: { type: 'string', maxLength: 20 }, businessAccountId: uuid, waConversationId: uuid,
      source: { type: 'string', enum: ['WHATSAPP_META', 'WHATSAPP_PERSONAL', 'PHONE_CALL', 'WALK_IN', 'OTHER'] },
      paymentTerms: { type: 'string', enum: ['COD', 'UPI', 'ADVANCE_PAID', 'CREDIT', 'PARTIAL'] }, deliveryDate: date, note: { type: 'string', maxLength: 500 }, confirmed: { type: 'boolean' },
      items: { type: 'array', minItems: 1, maxItems: 60, items: { type: 'object', required: ['productId', 'quantity'], properties: { productId: uuid, quantity: { type: 'integer', minimum: 1, maximum: 10_000_000 }, unitPrice: { type: 'number', minimum: 0, maximum: 99_999_999.99 } } } },
    },
  },
}
export const requirementStatusSchema = { params: idParams, body: { type: 'object', required: ['status'], properties: { status: reqStatus } } }
export const customersSchema = { querystring: { type: 'object', properties: { search: { type: 'string', maxLength: 60 } } } }
export const prefillSchema = { querystring: { type: 'object', required: ['conversationId'], properties: { conversationId: uuid } } }

export const paySchema = { params: idParams, body: { type: 'object', required: ['amount', 'method'], properties: { amount: { type: 'number', minimum: 0.01, maximum: 99_999_999.99 }, method: { type: 'string', enum: ['CASH', 'UPI', 'BANK'] }, paidOn: date, reference: { type: 'string', maxLength: 80 }, note: { type: 'string', maxLength: 300 } } } }
export const voidPaymentSchema = { params: idParams, body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 200 } } } }
export const docUploadSchema = { params: idParams, querystring: { type: 'object', properties: { kind: { type: 'string', enum: ['INVOICE', 'DELIVERY_SLIP', 'CREDIT_NOTE'] } } } }

export const distributeSchema = {
  params: idParams,
  body: {
    type: 'object',
    properties: {
      reservations: { type: 'array', maxItems: 100, items: { type: 'object', required: ['requirementId', 'quantity'], properties: { requirementId: uuid, quantity: { type: 'integer', minimum: 1, maximum: 10_000_000 } } } },
      allocations: { type: 'array', maxItems: 100, items: { type: 'object', required: ['shopId', 'quantity'], properties: { shopId: uuid, quantity: { type: 'integer', minimum: 1, maximum: 10_000_000 } } } },
      note: { type: 'string', maxLength: 300 }, inTransit: { type: 'boolean' },
    },
  },
}

export const monthlySchema = { querystring: { type: 'object', required: ['month'], properties: { month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } } } }

const monthStr = { type: 'string', pattern: '^\\d{4}-\\d{2}$' }
export const closeMonthSchema = { body: { type: 'object', required: ['month'], properties: { month: monthStr, note: { type: 'string', maxLength: 300 } } } }
export const reopenMonthSchema = { body: { type: 'object', required: ['month', 'reason'], properties: { month: monthStr, reason: { type: 'string', minLength: 1, maxLength: 300 } } } }

export const repackSchema = {
  params: idParams,
  body: {
    type: 'object',
    required: ['unitsUsed', 'lines'],
    properties: {
      unitsUsed: { type: 'integer', minimum: 1, maximum: 10_000_000 }, note: { type: 'string', maxLength: 300 },
      lines: { type: 'array', minItems: 1, maxItems: 60, items: { type: 'object', required: ['shopId', 'productId', 'packs'], properties: { shopId: uuid, productId: uuid, packs: { type: 'integer', minimum: 1, maximum: 10_000_000 } } } },
    },
  },
}
export const packSizeSchema = { params: idParams, body: { type: 'object', required: ['size', 'unit'], properties: { size: { type: 'integer', minimum: 1, maximum: 100000000 }, unit: { type: 'string', enum: ['G', 'ML'] } } } }

export const receiveTransferSchema = { params: idParams, body: { type: 'object', required: ['receivedQty'], properties: { receivedQty: { type: 'integer', minimum: 1, maximum: 10000000 }, note: { type: 'string', maxLength: 200 } } } }
