import { success, error } from '../../../utils/apiResponse.js'

export class AdminOrdersController {
  constructor(service) {
    this.service = service
  }

  async findAll(request, reply) {
    const data = await this.service.findAll(request.query)
    return reply.send(success(data, 'Orders fetched'))
  }

  async getStatsByStatus(request, reply) {
    const data = await this.service.getStatsByStatus()
    return reply.send(success(data, 'Order stats by status'))
  }

  async findById(request, reply) {
    try {
      const data = await this.service.findById(request.params.id)
      return reply.send(success(data, 'Order details'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async getOrderNotes(request, reply) {
    try {
      const data = await this.service.getOrderNotes(request.params.id)
      return reply.send(success(data, 'Order notes'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async addOrderNote(request, reply) {
    try {
      const data = await this.service.addOrderNote(request.params.id, request.user.id, request.body.body, request.ip)
      return reply.code(201).send(success(data, 'Note added'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async updateStatus(request, reply) {
    try {
      const { status, note } = request.body
      const data = await this.service.updateStatus(request.params.id, status, request.user.id, note, request.ip)
      return reply.send(success(data, 'Order status updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async rescheduleDelivery(request, reply) {
    try {
      const { scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel, reason } = request.body
      const data = await this.service.rescheduleDelivery(
        request.params.id,
        { scheduledSlotStart, scheduledSlotEnd, scheduledSlotLabel, reason },
        request.user.id,
        request.ip
      )
      return reply.send(success(data, 'Delivery rescheduled'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async assignRider(request, reply) {
    try {
      const { riderId } = request.body
      const data = await this.service.assignRider(request.params.id, riderId, request.user.id, request.ip)
      return reply.send(success(data, 'Rider assigned'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async bulkAssign(request, reply) {
    try {
      const data = await this.service.bulkAssign(request.body.assignments, request.user.id, request.ip)
      return reply.send(success(data, 'Bulk assignment done'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async createManualOrder(request, reply) {
    try {
      const data = await this.service.createManualOrder(request.body, request.user.id, request.ip)
      return reply.code(201).send(success(data, 'Manual order created'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code))
    }
  }

  async customerLookup(request, reply) {
    try {
      return reply.send(success(await this.service.customerLookup(request.query.search), 'Customers fetched'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code))
    }
  }

  async createCustomerByStaff(request, reply) {
    try {
      const data = await this.service.createCustomerByStaff(request.body, request.user.id, request.ip)
      return reply.code(data.existing ? 200 : 201).send(success(data, data.existing ? 'This number already has an account' : 'Customer added'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code))
    }
  }

  async markManualOrderPaid(request, reply) {
    try {
      const data = await this.service.markManualOrderPaid(request.params.id, request.body || {}, request.user.id, request.ip)
      return reply.send(success(data, 'Marked as paid'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message, err.code))
    }
  }

  async getInvoice(request, reply) {
    try {
      const buffer = await this.service.getInvoice(request.params.id)
      return reply.type('application/pdf').header('Content-Disposition', `attachment; filename=invoice-${request.params.id}.pdf`).send(buffer)
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async getPackingSlip(request, reply) {
    try {
      const buffer = await this.service.getPackingSlip(request.params.id)
      return reply.type('application/pdf').header('Content-Disposition', `attachment; filename=packing-slip-${request.params.id}.pdf`).send(buffer)
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async getGstInvoice(request, reply) {
    try {
      const buffer = await this.service.getGstInvoice(request.params.id)
      return reply.type('application/pdf').header('Content-Disposition', `attachment; filename=tax-invoice-${request.params.id}.pdf`).send(buffer)
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async exportCSV(request, reply) {
    try {
      const buffer = await this.service.exportCSV(request.query)
      return reply.type('text/csv').header('Content-Disposition', 'attachment; filename=orders-export.csv').send(buffer)
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async refundOrder(request, reply) {
    try {
      const data = await this.service.refundOrder(
        request.params.id,
        request.body || {},
        request.user.id,
        request.ip
      )
      return reply.send(success(data, 'Order refunded'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async reconcilePayment(request, reply) {
    try {
      const data = await this.service.reconcilePayment(
        request.params.id,
        request.user.id,
        request.ip
      )
      return reply.send(success(data, 'Payment re-checked against Razorpay'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async bulkReconcilePayments(request, reply) {
    try {
      const data = await this.service.bulkReconcilePayments(request.body.orderIds, request.user.id, request.ip)
      return reply.send(success(data, 'Bulk re-check complete'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async getRazorpayDetails(request, reply) {
    try {
      const data = await this.service.getRazorpayDetails(request.params.id)
      return reply.send(success(data, 'Razorpay payment details fetched'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async cancelOrder(request, reply) {
    try {
      const data = await this.service.cancelOrder(
        request.params.id,
        request.body || {},
        request.user.id,
        request.ip
      )
      return reply.send(success(data, 'Order cancelled'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async bulkUpdateStatus(request, reply) {
    try {
      const { orderIds, status } = request.body
      const data = await this.service.bulkUpdateStatus(orderIds, status, request.user.id, request.ip)
      return reply.send(success(data, 'Bulk status update done'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  // ── B2B "Place Order" ──────────────────────────────────────────────

  async findAllB2B(request, reply) {
    try {
      const data = await this.service.findAllB2B(request.query)
      return reply.send(success(data, 'B2B orders fetched'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async findB2BById(request, reply) {
    try {
      const data = await this.service.findB2BById(request.params.id)
      return reply.send(success(data, 'B2B order details'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async approveB2BOrder(request, reply) {
    try {
      const data = await this.service.approveB2BOrder(request.params.id, request.user.id, request.ip)
      return reply.send(success(data, 'Order approved'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async recordB2BSettlement(request, reply) {
    try {
      const data = await this.service.recordB2BSettlement(
        request.params.id,
        request.body,
        request.user.id,
        request.ip
      )
      return reply.send(success(data, 'Settlement recorded'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }

  async setB2BPaymentDueDate(request, reply) {
    try {
      const data = await this.service.setB2BPaymentDueDate(
        request.params.id,
        request.body.dueDate,
        request.user.id,
        request.ip
      )
      return reply.send(success(data, 'Payment due date updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message))
    }
  }
}
