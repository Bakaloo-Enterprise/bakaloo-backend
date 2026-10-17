const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }

export const listOrdersSchema = {
  tags: ['Admin Orders'],
  summary: 'List all orders with filters',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', default: 1 },
      limit: { type: 'integer', default: 20, maximum: 100 },
      status: { type: 'string' },
      paymentMethod: { type: 'string' },
      search: { type: 'string' },
      startDate: { type: 'string', format: 'date-time' },
      endDate: { type: 'string', format: 'date-time' },
      deliveryType: { type: 'string', enum: ['express', 'scheduled', 'standard'] },
      needsPaymentReview: { type: 'boolean' },
      recoveredFromFailed: { type: 'boolean' },
      paymentStatus: { type: 'string' },
      riderId: { type: 'string', format: 'uuid' },
      minAmount: { type: 'number' },
      maxAmount: { type: 'number' },
      area: { type: 'string' },
      isB2B: { type: 'boolean' },
    },
  },
}

export const statsByStatusSchema = { tags: ['Admin Orders'], summary: 'Order counts by status (tab badges)' }

export const orderDetailSchema = {
  tags: ['Admin Orders'],
  summary: 'Full order detail with items, timeline, payment, delivery',
  params: uuidParam,
}

export const orderNotesListSchema = {
  tags: ['Admin Orders'],
  summary: 'List all internal notes for an order (chronological, oldest first)',
  params: uuidParam,
}

export const addOrderNoteSchema = {
  tags: ['Admin Orders'],
  summary: 'Add a free-text internal note to an order',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['body'],
    properties: {
      body: { type: 'string', minLength: 1, maxLength: 2000 },
    },
  },
}

export const updateStatusSchema = {
  tags: ['Admin Orders'],
  summary: 'Update order status with transition validation',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['CONFIRMED', 'PREPARING', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'REFUNDED'] },
      note: { type: 'string', maxLength: 500 },
    },
  },
}

export const rescheduleOrderSchema = {
  tags: ['Admin Orders'],
  summary: 'Change an order\'s scheduled delivery slot',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['scheduledSlotStart', 'scheduledSlotEnd', 'scheduledSlotLabel'],
    properties: {
      scheduledSlotStart: { type: 'string', format: 'date-time' },
      scheduledSlotEnd: { type: 'string', format: 'date-time' },
      scheduledSlotLabel: { type: 'string', maxLength: 120 },
      reason: { type: 'string', maxLength: 500 },
    },
  },
}

export const assignRiderSchema = {
  tags: ['Admin Orders'],
  summary: 'Assign rider to order',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['riderId'],
    properties: { riderId: { type: 'string', format: 'uuid' } },
  },
}

export const bulkAssignSchema = {
  tags: ['Admin Orders'],
  summary: 'Bulk assign riders to orders',
  body: {
    type: 'object',
    required: ['assignments'],
    properties: {
      assignments: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          required: ['orderId', 'riderId'],
          properties: {
            orderId: { type: 'string', format: 'uuid' },
            riderId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
  },
}

export const manualOrderSchema = {
  tags: ['Admin Orders'],
  summary: 'Create manual order on behalf of customer',
  body: {
    type: 'object',
    required: ['userId', 'items', 'deliveryAddress'],
    properties: {
      userId: { type: 'string', format: 'uuid' },
      items: {
        type: 'array', minItems: 1,
        items: {
          type: 'object',
          required: ['productId', 'quantity'],
          properties: {
            productId: { type: 'string', format: 'uuid' },
            quantity: { type: 'integer', minimum: 1 },
            // B2B only: the price agreed with the customer for one unit.
            unitPrice: { type: 'number', minimum: 0, maximum: 99999999 },
          },
        },
      },
      // B2C = a home customer (COD / manual payment). B2B = a business buying on credit: it becomes an approved
      // B2B credit order, so it shows in B2B Orders and Collections and is paid by recorded payments.
      orderType: { type: 'string', enum: ['B2C', 'B2B'], default: 'B2C' },
      dueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      advance: { type: 'object', required: ['amount', 'method'], properties: { amount: { type: 'number', minimum: 0.01 }, method: { type: 'string', enum: ['CASH', 'UPI'] } } },
      paymentMethod: { type: 'string', enum: ['COD', 'MANUAL'], default: 'MANUAL' },
      // The store that delivers the order. Optional only when one store is the obvious choice.
      shopId: { type: 'string', format: 'uuid' },
      // MANUAL only: true = the money is already in hand. Otherwise the order stays unpaid until someone marks it paid.
      paymentReceived: { type: 'boolean', default: false },
      deliveryAddress: { type: 'object' },
      couponCode: { type: 'string' },
    },
  },
}

export const customerLookupSchema = { tags: ['Admin Orders'], summary: 'Find customers for a manual order', querystring: { type: 'object', properties: { search: { type: 'string', maxLength: 60 } } } }

export const staffCustomerSchema = {
  tags: ['Admin Orders'],
  summary: 'Add a customer who is not on the platform yet',
  body: { type: 'object', required: ['name', 'phone'], properties: { name: { type: 'string', maxLength: 100 }, phone: { type: 'string', maxLength: 20 }, kind: { type: 'string', enum: ['HOME', 'BUSINESS'], default: 'HOME' }, businessName: { type: 'string', maxLength: 160 }, gstin: { type: 'string', maxLength: 20 } } },
}

export const markManualPaidSchema = {
  tags: ['Admin Orders'],
  summary: 'Say the money for a manual order has been received',
  params: uuidParam,
  body: { type: 'object', properties: { note: { type: 'string', maxLength: 200 } } },
}

export const invoiceSchema = { tags: ['Admin Orders'], summary: 'Download PDF invoice', params: uuidParam }
export const packingSlipSchema = { tags: ['Admin Orders'], summary: 'Download PDF packing slip', params: uuidParam }
export const gstInvoiceSchema = { tags: ['Admin Orders'], summary: 'Download A4 GST tax invoice', params: uuidParam }

export const exportSchema = {
  tags: ['Admin Orders'],
  summary: 'Export orders to CSV',
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string' },
      startDate: { type: 'string', format: 'date-time' },
      endDate: { type: 'string', format: 'date-time' },
    },
  },
}

export const refundOrderSchema = {
  tags: ['Admin Orders'],
  summary: 'Refund an order (credits wallet or initiates payment refund)',
  params: uuidParam,
  body: {
    type: 'object',
    properties: {
      // No `amount` field — the refund amount is never admin-editable, it's
      // always exactly what the customer paid (see refundOrder in the
      // service). Accepting an amount here would let an admin refund more
      // (or less) than was ever collected.
      reason: { type: 'string', maxLength: 500 },
      refundTo: { type: 'string', enum: ['wallet', 'original', 'none'], default: 'wallet' },
    },
  },
}

export const reconcilePaymentSchema = {
  tags: ['Admin Orders'],
  summary: "Re-check an order's payment directly against Razorpay (manual reconciliation)",
  params: uuidParam,
}

export const razorpayDetailsSchema = {
  tags: ['Admin Orders'],
  summary: "Full payment detail fetched live from Razorpay's own record",
  params: uuidParam,
}

export const bulkReconcilePaymentsSchema = {
  tags: ['Admin Orders'],
  summary: 'Bulk re-check a batch of orders directly against Razorpay (historical audit tool)',
  body: {
    type: 'object',
    required: ['orderIds'],
    properties: {
      orderIds: { type: 'array', maxItems: 50, items: { type: 'string', format: 'uuid' } },
    },
  },
}

export const cancelOrderSchema = {
  tags: ['Admin Orders'],
  summary: 'Cancel an order with optional reason and refund',
  params: uuidParam,
  body: {
    type: 'object',
    properties: {
      reason: { type: 'string', maxLength: 500 },
      refundTo: { type: 'string', enum: ['wallet', 'original', 'none'], default: 'wallet' },
    },
  },
}

export const bulkStatusSchema = {
  tags: ['Admin Orders'],
  summary: 'Bulk update status for multiple orders',
  body: {
    type: 'object',
    required: ['orderIds', 'status'],
    properties: {
      orderIds: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 50 },
      status: { type: 'string', enum: ['CONFIRMED', 'PREPARING', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'] },
    },
  },
}

// ── B2B "Place Order" ────────────────────────────────────────────────

export const listB2BOrdersSchema = {
  tags: ['Admin Orders'],
  summary: 'List B2B "Place Order" credit orders',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', default: 1 },
      limit: { type: 'integer', default: 20, maximum: 100 },
      status: { type: 'string', enum: ['PENDING', 'APPROVED'] },
      // The B2B Collections page's filter — approved orders with money
      // still owed (total_amount > b2b_amount_settled).
      hasPendingCollection: { type: 'boolean' },
    },
  },
}

export const b2bOrderDetailSchema = {
  tags: ['Admin Orders'],
  summary: 'B2B credit order details, including settlement history',
  params: uuidParam,
}

export const approveB2BOrderSchema = {
  tags: ['Admin Orders'],
  summary: 'Approve a pending B2B credit order — deducts stock and confirms it',
  params: uuidParam,
}

export const recordB2BSettlementSchema = {
  tags: ['Admin Orders'],
  summary: 'Record a manual payment-collection entry against a B2B credit order',
  params: uuidParam,
  body: {
    type: 'object',
    required: ['method', 'amount'],
    properties: {
      method: { type: 'string', enum: ['CASH', 'UPI', 'RAZORPAY', 'OTHER'] },
      amount: { type: 'number', exclusiveMinimum: 0 },
      note: { type: 'string', maxLength: 500 },
    },
  },
}

export const setB2BPaymentDueDateSchema = {
  tags: ['Admin Orders'],
  summary: 'Set (or clear) the date a B2B customer promised to pay by',
  params: uuidParam,
  body: {
    type: 'object',
    properties: {
      dueDate: { type: ['string', 'null'], format: 'date' },
    },
  },
}

