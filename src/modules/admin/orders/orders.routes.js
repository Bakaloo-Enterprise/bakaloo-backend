import { AdminOrdersRepository } from './orders.repository.js'
import { AdminOrdersService } from './orders.service.js'
import { AdminOrdersController } from './orders.controller.js'
import {
  listOrdersSchema, statsByStatusSchema, orderDetailSchema,
  updateStatusSchema, assignRiderSchema, bulkAssignSchema,
  manualOrderSchema, markManualPaidSchema, customerLookupSchema, staffCustomerSchema, invoiceSchema, packingSlipSchema, gstInvoiceSchema, exportSchema,
  refundOrderSchema, cancelOrderSchema, bulkStatusSchema,
  rescheduleOrderSchema, orderNotesListSchema, addOrderNoteSchema,
  reconcilePaymentSchema, razorpayDetailsSchema, bulkReconcilePaymentsSchema,
  listB2BOrdersSchema, b2bOrderDetailSchema, approveB2BOrderSchema, recordB2BSettlementSchema,
  setB2BPaymentDueDateSchema,
} from './orders.schema.js'

/**
 * Admin orders routes
 * Prefix: /api/v1/admin/orders
 */
export default async function adminOrdersRoutes(fastify) {
  const repo = new AdminOrdersRepository()
  const service = new AdminOrdersService(repo, fastify)
  const ctrl = new AdminOrdersController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', { schema: listOrdersSchema, preHandler: adminAuth }, ctrl.findAll.bind(ctrl))
  fastify.get('/stats-by-status', { schema: statsByStatusSchema, preHandler: adminAuth }, ctrl.getStatsByStatus.bind(ctrl))
  fastify.get('/export', { schema: exportSchema, preHandler: adminAuth }, ctrl.exportCSV.bind(ctrl))
  fastify.get('/customers/lookup', { schema: customerLookupSchema, preHandler: adminAuth }, ctrl.customerLookup.bind(ctrl))
  fastify.post('/customers', { schema: staffCustomerSchema, preHandler: adminAuth }, ctrl.createCustomerByStaff.bind(ctrl))
  fastify.post('/manual', { schema: manualOrderSchema, preHandler: adminAuth }, ctrl.createManualOrder.bind(ctrl))
  fastify.post('/:id/payment-received', { schema: markManualPaidSchema, preHandler: adminAuth }, ctrl.markManualOrderPaid.bind(ctrl))
  fastify.post('/bulk-assign', { schema: bulkAssignSchema, preHandler: adminAuth }, ctrl.bulkAssign.bind(ctrl))
  fastify.get('/:id', { schema: orderDetailSchema, preHandler: adminAuth }, ctrl.findById.bind(ctrl))
  fastify.get('/:id/notes', { schema: orderNotesListSchema, preHandler: adminAuth }, ctrl.getOrderNotes.bind(ctrl))
  fastify.post('/:id/notes', { schema: addOrderNoteSchema, preHandler: adminAuth }, ctrl.addOrderNote.bind(ctrl))
  fastify.put('/:id/status', { schema: updateStatusSchema, preHandler: adminAuth }, ctrl.updateStatus.bind(ctrl))
  fastify.put('/:id/reschedule', { schema: rescheduleOrderSchema, preHandler: adminAuth }, ctrl.rescheduleDelivery.bind(ctrl))
  fastify.put('/:id/assign-rider', { schema: assignRiderSchema, preHandler: adminAuth }, ctrl.assignRider.bind(ctrl))
  fastify.get('/:id/invoice', { schema: invoiceSchema, preHandler: adminAuth }, ctrl.getInvoice.bind(ctrl))
  fastify.get('/:id/packing-slip', { schema: packingSlipSchema, preHandler: adminAuth }, ctrl.getPackingSlip.bind(ctrl))
  fastify.get('/:id/tax-invoice', { schema: gstInvoiceSchema, preHandler: adminAuth }, ctrl.getGstInvoice.bind(ctrl))
  fastify.post('/:id/refund', { schema: refundOrderSchema, preHandler: adminAuth }, ctrl.refundOrder.bind(ctrl))
  fastify.post('/:id/reconcile-payment', { schema: reconcilePaymentSchema, preHandler: adminAuth }, ctrl.reconcilePayment.bind(ctrl))
  fastify.get('/:id/razorpay-details', { schema: razorpayDetailsSchema, preHandler: adminAuth }, ctrl.getRazorpayDetails.bind(ctrl))
  fastify.post('/bulk-reconcile-payment', { schema: bulkReconcilePaymentsSchema, preHandler: adminAuth }, ctrl.bulkReconcilePayments.bind(ctrl))
  fastify.post('/:id/cancel', { schema: cancelOrderSchema, preHandler: adminAuth }, ctrl.cancelOrder.bind(ctrl))
  fastify.post('/bulk-status', { schema: bulkStatusSchema, preHandler: adminAuth }, ctrl.bulkUpdateStatus.bind(ctrl))

  // B2B "Place Order" — registered as literal "/b2b..." segments, which
  // Fastify's router always matches ahead of the ":id" param routes above
  // regardless of registration order (static segments take precedence).
  fastify.get('/b2b', { schema: listB2BOrdersSchema, preHandler: adminAuth }, ctrl.findAllB2B.bind(ctrl))
  fastify.get('/b2b/:id', { schema: b2bOrderDetailSchema, preHandler: adminAuth }, ctrl.findB2BById.bind(ctrl))
  fastify.post('/b2b/:id/approve', { schema: approveB2BOrderSchema, preHandler: adminAuth }, ctrl.approveB2BOrder.bind(ctrl))
  fastify.post('/b2b/:id/settlements', { schema: recordB2BSettlementSchema, preHandler: adminAuth }, ctrl.recordB2BSettlement.bind(ctrl))
  fastify.put('/b2b/:id/due-date', { schema: setB2BPaymentDueDateSchema, preHandler: adminAuth }, ctrl.setB2BPaymentDueDate.bind(ctrl))
}
