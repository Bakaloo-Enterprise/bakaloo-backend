const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

export const listCustomersSchema = {
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      search: { type: 'string' },
      status: { type: 'string', enum: ['active', 'blocked'] },
      segment: { type: 'string', enum: ['vip', 'churned'] },
      sortBy: { type: 'string', enum: ['created_at', 'name', 'orders', 'spent'], default: 'created_at' },
      sortOrder: { type: 'string', enum: ['ASC', 'DESC'], default: 'DESC' },
    },
  },
}

export const customerIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
}

export const customerOrdersSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
  },
}

export const churnedSchema = {
  querystring: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, default: 30 },
    },
  },
}

export const vipSchema = {
  querystring: {
    type: 'object',
    properties: {
      minOrders: { type: 'integer', minimum: 1, default: 10 },
    },
  },
}

export const creditWalletSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    required: ['amount'],
    properties: {
      amount: { type: 'number', minimum: 1, maximum: 50000 },
      description: { type: 'string', maxLength: 255, default: 'Admin credit' },
    },
  },
}

export const debitWalletSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    required: ['amount'],
    properties: {
      amount: { type: 'number', minimum: 1, maximum: 50000 },
      description: { type: 'string', maxLength: 255, default: 'Amount deducted by company' },
    },
  },
}

export const sendNotificationSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    required: ['title', 'body'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', minLength: 1, maxLength: 1000 },
    },
  },
}

export const toggleBlockSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: uuidPattern } },
  },
  body: {
    type: 'object',
    required: ['blocked'],
    properties: { blocked: { type: 'boolean' } },
  },
}

export const customerNotificationsSchema = {
  params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuidPattern } } },
  querystring: { type: 'object', properties: { personal: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
}
