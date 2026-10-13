/**
 * Wallet JSON schemas for request/response validation
 */

const walletResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    balance: { type: 'number' },
    // balance = permanentBalance (never expires) + expiringBalance
    permanentBalance: { type: 'number' },
    expiringBalance: { type: 'number' },
    nextExpiry: {
      type: ['object', 'null'],
      properties: {
        amount: { type: 'number' },
        expiresAt: { type: 'string' },
      },
    },
    createdAt: { type: 'string' },
  },
}

const transactionResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    walletId: { type: 'string', format: 'uuid' },
    userId: { type: ['string', 'null'], format: 'uuid' },
    type: { type: 'string', enum: ['CREDIT', 'DEBIT'] },
    amount: { type: 'number' },
    description: { type: 'string' },
    referenceId: { type: ['string', 'null'] },
    balanceAfter: { type: ['number', 'null'] },
    status: { type: 'string', enum: ['PENDING', 'COMPLETED', 'FAILED'] },
    // Set on expiring credits; null for ordinary money.
    expiresAt: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
  },
}

const topUpOrderResponseSchema = {
  type: 'object',
  properties: {
    razorpayOrderId: { type: 'string' },
    amount: { type: 'number' },
    currency: { type: 'string' },
    keyId: { type: 'string' },
  },
}

export const getWalletSchema = {
  tags: ['Wallet'],
  summary: 'Get wallet balance',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: walletResponseSchema,
      },
    },
  },
}

export const getTransactionsSchema = {
  tags: ['Wallet'],
  summary: 'Get wallet transaction history',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      type: { type: 'string', enum: ['CREDIT', 'DEBIT'] },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: transactionResponseSchema },
        pagination: { type: 'object' },
      },
    },
  },
}

export const addMoneySchema = {
  tags: ['Wallet', 'Admin'],
  summary: 'Admin/internal: add money to wallet directly',
  body: {
    type: 'object',
    required: ['amount'],
    properties: {
      amount: { type: 'number', minimum: 1, maximum: 50000 },
      description: { type: 'string', maxLength: 255 },
      referenceId: { type: 'string', maxLength: 100 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            wallet: walletResponseSchema,
            transaction: transactionResponseSchema,
          },
        },
      },
    },
  },
}

export const createTopUpSchema = {
  tags: ['Wallet'],
  summary: 'Create a Razorpay order for wallet top-up',
  body: {
    type: 'object',
    required: ['amount'],
    properties: {
      amount: { type: 'number', minimum: 10, maximum: 10000 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: topUpOrderResponseSchema,
      },
    },
  },
}

export const verifyTopUpSchema = {
  tags: ['Wallet'],
  summary: 'Verify top-up payment and credit wallet',
  body: {
    type: 'object',
    required: ['paymentId', 'orderId', 'signature'],
    properties: {
      paymentId: { type: 'string' },
      orderId: { type: 'string' },
      signature: { type: 'string' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            wallet: walletResponseSchema,
            transaction: transactionResponseSchema,
          },
        },
      },
    },
  },
}

export const payFromWalletSchema = {
  tags: ['Wallet'],
  summary: 'Pay for an order from wallet',
  body: {
    type: 'object',
    required: ['orderId'],
    properties: {
      orderId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            wallet: walletResponseSchema,
            transaction: transactionResponseSchema,
          },
        },
      },
    },
  },
}

export const searchRecipientSchema = {
  tags: ['Wallet'],
  summary: 'Search users by phone number prefix (recipient picker)',
  querystring: {
    type: 'object',
    required: ['q'],
    properties: {
      // 6-10 digit prefix of an Indian mobile number. The 6-digit floor
      // keeps result sets small/relevant and resists casual scraping —
      // shorter prefixes alone already span huge cohorts of users.
      q: { type: 'string', pattern: '^[6-9]\\d{5,9}$' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              phone: { type: 'string' },
            },
          },
        },
      },
    },
  },
}

export const transferSchema = {
  tags: ['Wallet'],
  summary: 'Transfer money to another user by phone',
  body: {
    type: 'object',
    required: ['phone', 'amount'],
    properties: {
      phone: { type: 'string', pattern: '^[6-9]\\d{9}$' },
      amount: { type: 'number', minimum: 1, maximum: 10000 },
      description: { type: 'string', maxLength: 255 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            wallet: walletResponseSchema,
            transaction: transactionResponseSchema,
          },
        },
      },
    },
  },
}

// ─── Admin Schemas ─────────────────────────────────────

export const adminCreditSchema = {
  tags: ['Wallet', 'Admin'],
  summary: 'Admin: credit a user wallet',
  params: {
    type: 'object',
    required: ['userId'],
    properties: {
      userId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['amount'],
    properties: {
      amount: { type: 'number', minimum: 1 },
      description: { type: 'string', maxLength: 255 },
      referenceId: { type: 'string', maxLength: 100 },
      // true = promotional credit that expires (Settings → Wallet → Expiry);
      // false/omitted = plain money that never expires.
      isBonus: { type: 'boolean', default: false },
      expiryDays: { type: 'integer', minimum: 1, maximum: 3650 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            wallet: walletResponseSchema,
            transaction: transactionResponseSchema,
          },
        },
      },
    },
  },
}

export const adminDebitSchema = {
  tags: ['Wallet', 'Admin'],
  summary: 'Admin: debit a user wallet',
  params: {
    type: 'object',
    required: ['userId'],
    properties: {
      userId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['amount'],
    properties: {
      amount: { type: 'number', minimum: 1 },
      description: { type: 'string', maxLength: 255, default: 'Amount deducted by company' },
      referenceId: { type: 'string', maxLength: 100 },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            wallet: walletResponseSchema,
            transaction: transactionResponseSchema,
          },
        },
      },
    },
  },
}
