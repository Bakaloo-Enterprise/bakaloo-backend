// NOTE: the app runs AJV with removeAdditional:'all' — fields not declared here are dropped.
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }

export const dayCloseSchema = { querystring: { type: 'object', properties: { date, shopId: uuid } } }
export const wastageSchema = { querystring: { type: 'object', properties: { period: { type: 'string', enum: ['today', '7d', '30d', 'custom'] }, from: date, to: date, shopId: uuid } } }
export const forecastSchema = { querystring: { type: 'object', properties: { shopId: uuid, horizon: { type: 'integer', minimum: 1, maximum: 14 }, cover: { type: 'integer', minimum: 1, maximum: 7 } } } }
export const targetsSchema = {
  params: { type: 'object', required: ['id'], properties: { id: uuid } },
  body: { type: 'object', properties: { marginPct: { type: ['number', 'null'], minimum: 0, maximum: 89 }, wastagePct: { type: ['number', 'null'], minimum: 0, maximum: 100 } } },
}

const month = { type: 'string', pattern: '^\\d{4}-\\d{2}$' }
const EXPENSE_CATEGORIES = ['RENT', 'SALARY', 'ELECTRICITY', 'INTERNET', 'TAXES', 'TRANSPORT', 'PACKING', 'RIDER_PAY', 'MARKETING', 'GATEWAY_FEES', 'MAINTENANCE', 'OTHER']
const CASH_KINDS = ['OPENING_BALANCE', 'OWNER_CAPITAL', 'OWNER_DRAWING', 'OTHER_INCOME', 'BANK_DEPOSIT', 'BANK_WITHDRAWAL']

export const monthSchema = { querystring: { type: 'object', properties: { month } } }
export const expensesListSchema = { querystring: { type: 'object', properties: { from: date, to: date, category: { type: 'string', enum: EXPENSE_CATEGORIES }, shopId: uuid, includeVoided: { type: 'boolean' } } } }
export const cashListSchema = { querystring: { type: 'object', properties: { from: date, to: date, includeVoided: { type: 'boolean' } } } }
export const expenseCreateSchema = {
  body: {
    type: 'object',
    required: ['spentOn', 'category', 'amount', 'paidVia'],
    properties: { spentOn: date, category: { type: 'string', enum: EXPENSE_CATEGORIES }, amount: { type: 'number', exclusiveMinimum: 0, maximum: 100000000 }, paidVia: { type: 'string', enum: ['CASH', 'UPI', 'BANK'] }, shopId: uuid, party: { type: 'string', maxLength: 120 }, note: { type: 'string', maxLength: 300 } },
  },
}
export const cashCreateSchema = {
  body: {
    type: 'object',
    required: ['entryOn', 'kind', 'amount'],
    properties: { entryOn: date, kind: { type: 'string', enum: CASH_KINDS }, account: { type: 'string', enum: ['CASH', 'BANK'] }, amount: { type: 'number', exclusiveMinimum: 0, maximum: 100000000 }, note: { type: 'string', maxLength: 300 } },
  },
}
export const voidSchema = { params: { type: 'object', required: ['id'], properties: { id: uuid } }, body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 300 } } } }

const kind = { type: 'string', enum: ['orders', 'lines', 'movements', 'purchases', 'refunds', 'expenses'] }
const explorerQuery = { period: { type: 'string', enum: ['today', '7d', '30d', 'custom'] }, from: date, to: date, shopId: uuid, q: { type: 'string', maxLength: 60 } }
export const explorerListSchema = { params: { type: 'object', required: ['kind'], properties: { kind } }, querystring: { type: 'object', properties: { ...explorerQuery, limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0, maximum: 1000000 } } } }
export const explorerExportSchema = { params: { type: 'object', required: ['kind'], properties: { kind } }, querystring: { type: 'object', properties: explorerQuery } }

export const shelfSchema = { querystring: { type: 'object', required: ['shopId'], properties: { shopId: uuid } } }
export const logWastageSchema = {
  body: {
    type: 'object',
    required: ['shopId', 'productId', 'quantity', 'reason'],
    properties: { shopId: uuid, productId: uuid, quantity: { type: 'integer', minimum: 1, maximum: 100000 }, reason: { type: 'string', maxLength: 40 }, note: { type: 'string', maxLength: 200 } },
  },
}
