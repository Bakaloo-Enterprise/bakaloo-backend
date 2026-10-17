import { query } from '../../config/database.js'

/** Read-only queries for the month-end report. Every figure is computed live from the same tables the screens use. */
export class MonthlyRepository {
  async purchases(from, to) {
    const { rows } = await query(
      `SELECT e.id, e.entry_no, to_char(e.procured_on, 'YYYY-MM-DD') AS date, v.name AS vendor, p.name AS product, e.expected_qty, e.received_qty, e.damaged_qty, e.owed_qty,
              e.unit_price, e.purchase_total AS total, e.status, e.invoice_ref,
              (SELECT COUNT(*) FROM procurement_documents d WHERE d.entry_id = e.id AND d.kind = 'INVOICE')::int AS invoices
         FROM procurement_entries e JOIN vendors v ON v.id = e.vendor_id JOIN products p ON p.id = e.product_id
        WHERE e.status <> 'CANCELLED' AND e.procured_on >= $1::date AND e.procured_on <= $2::date ORDER BY e.procured_on, e.entry_no`, [from, to])
    return rows
  }

  /** Received purchases up to a date; credit for goods sent back counted only up to `instant`. */
  async billsAsOf(date, instant) {
    const { rows } = await query(
      `SELECT e.id, e.entry_no, e.vendor_id, to_char(e.procured_on, 'YYYY-MM-DD') AS procured_on, e.purchase_total AS total,
              COALESCE((SELECT SUM(a.quantity * a.unit_cost) FROM procurement_adjustments a WHERE a.entry_id = e.id AND a.kind = 'VENDOR_RETURN' AND a.created_at < $2), 0)::numeric(14,2) AS credit
         FROM procurement_entries e WHERE e.status = 'ACTIVE' AND e.procured_on <= $1::date ORDER BY e.procured_on, e.entry_no`, [date, instant])
    return rows
  }
  async paidAsOf(date) {
    const { rows } = await query(`SELECT vendor_id, SUM(amount)::numeric(14,2) AS total FROM vendor_payments WHERE voided_at IS NULL AND paid_on <= $1::date GROUP BY vendor_id`, [date])
    return rows
  }
  async creditsInWindow(start, end) {
    const { rows } = await query(
      `SELECT e.vendor_id, SUM(a.quantity * a.unit_cost)::numeric(14,2) AS total FROM procurement_adjustments a JOIN procurement_entries e ON e.id = a.entry_id
        WHERE a.kind = 'VENDOR_RETURN' AND e.status = 'ACTIVE' AND a.created_at >= $1 AND a.created_at < $2 GROUP BY e.vendor_id`, [start, end])
    return rows
  }
  async vendors() {
    const { rows } = await query(`SELECT id, name, credit_days, payment_terms FROM vendors ORDER BY LOWER(name)`)
    return rows
  }
  async payments(from, to) {
    const { rows } = await query(
      `SELECT y.id, to_char(y.paid_on, 'YYYY-MM-DD') AS date, v.name AS vendor, y.amount, y.method, y.reference, y.note, u.name AS by, y.voided_at IS NOT NULL AS voided, y.void_reason
         FROM vendor_payments y JOIN vendors v ON v.id = y.vendor_id LEFT JOIN users u ON u.id = y.created_by
        WHERE y.paid_on >= $1::date AND y.paid_on <= $2::date ORDER BY y.paid_on, y.created_at`, [from, to])
    return rows
  }

  /** Stock taken out of a purchase for a reason (returns, wastage, damage, B2B supply). */
  async adjustments(start, end) {
    const { rows } = await query(
      `SELECT a.created_at, a.kind, a.quantity, a.unit_cost, a.reason, e.entry_no, v.name AS vendor, p.name AS product, s.name AS shop, u.name AS by
         FROM procurement_adjustments a JOIN procurement_entries e ON e.id = a.entry_id JOIN vendors v ON v.id = e.vendor_id JOIN products p ON p.id = e.product_id
         LEFT JOIN shops s ON s.id = a.shop_id LEFT JOIN users u ON u.id = a.created_by
        WHERE a.created_at >= $1 AND a.created_at < $2 ORDER BY a.created_at`, [start, end])
    return rows
  }
  /** Bad goods counted at the door and thrown away. */
  async doorDamage(start, end) {
    const { rows } = await query(
      `SELECT e.received_at AS created_at, e.entry_no, v.name AS vendor, p.name AS product, e.damaged_qty AS quantity, e.unit_price AS unit_cost
         FROM procurement_entries e JOIN vendors v ON v.id = e.vendor_id JOIN products p ON p.id = e.product_id
        WHERE e.status = 'ACTIVE' AND e.damaged_qty > 0 AND e.received_at >= $1 AND e.received_at < $2 ORDER BY e.received_at`, [start, end])
    return rows
  }

  /** Money collected from B2B customers: the recorded settlements (NOT orders.payment_status, which is PAID for credit orders at checkout). */
  async collections(start, end) {
    const { rows } = await query(
      `SELECT s.created_at, o.order_number, COALESCE(b.company_name, cu.staff_business_name, cu.name, cu.phone) AS customer, s.method, s.amount, s.note, ru.name AS by
         FROM order_b2b_settlements s JOIN orders o ON o.id = s.order_id JOIN users cu ON cu.id = o.user_id
         LEFT JOIN business_accounts b ON b.user_id = o.user_id LEFT JOIN users ru ON ru.id = s.recorded_by
        WHERE s.created_at >= $1 AND s.created_at < $2 ORDER BY s.created_at`, [start, end])
    return rows
  }
  async b2bSales(start, end) {
    const { rows } = await query(
      `SELECT o.b2b_approved_at AS approved_at, o.order_number, COALESCE(b.company_name, cu.staff_business_name, cu.name, cu.phone) AS customer, o.total_amount AS total,
              COALESCE((SELECT SUM(amount) FROM order_b2b_settlements x WHERE x.order_id = o.id AND x.created_at < $2), 0)::numeric(14,2) AS settled_by_end, o.status::text AS status
         FROM orders o JOIN users cu ON cu.id = o.user_id LEFT JOIN business_accounts b ON b.user_id = o.user_id
        WHERE o.b2b_approval_status = 'APPROVED' AND o.b2b_approved_at >= $1 AND o.b2b_approved_at < $2 AND o.status::text <> 'CANCELLED' ORDER BY o.b2b_approved_at`, [start, end])
    return rows
  }
  /** Every approved B2B bill still unpaid at month end, with its due date. */
  async receivablesAt(end) {
    const { rows } = await query(
      `SELECT o.order_number, COALESCE(b.company_name, cu.staff_business_name, cu.name, cu.phone) AS customer, to_char(o.b2b_approved_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS billed_on,
              to_char(o.b2b_payment_due_date, 'YYYY-MM-DD') AS due_on, o.total_amount AS total,
              COALESCE((SELECT SUM(amount) FROM order_b2b_settlements x WHERE x.order_id = o.id AND x.created_at < $1), 0)::numeric(14,2) AS settled
         FROM orders o JOIN users cu ON cu.id = o.user_id LEFT JOIN business_accounts b ON b.user_id = o.user_id
        WHERE o.b2b_approval_status = 'APPROVED' AND o.b2b_approved_at < $1 AND o.status::text <> 'CANCELLED' ORDER BY o.b2b_approved_at`, [end])
    return rows
  }

  /** Cash taken at the door for delivered COD orders (what the customer handed over, wallet part excluded). */
  async codCash(start, end) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(m.total_amount - m.wallet_part), 0)::numeric(14,2) AS total
         FROM order_money m JOIN orders o ON o.id = m.order_id
        WHERE m.payment_method = 'COD' AND m.payment_status = 'PAID' AND m.status = 'DELIVERED' AND o.delivered_at >= $1 AND o.delivered_at < $2`, [start, end])
    return rows[0]
  }
  /** Online money the gateway captured in the window. Refunds are not netted off here. */
  async gatewayCaptured(start, end) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::numeric(14,2) AS total FROM payments WHERE status = 'PAID' AND updated_at >= $1 AND updated_at < $2`, [start, end])
    return rows[0]
  }
  /** Manual orders (phone / WhatsApp) the admin has not yet marked as paid. */
  async manualUnpaid(end) {
    const { rows } = await query(
      `SELECT o.order_number, COALESCE(u.name, u.phone) AS customer, to_char(o.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS on, o.total_amount AS total
         FROM orders o JOIN users u ON u.id = o.user_id
        WHERE o.payment_method = 'MANUAL' AND o.payment_status = 'PENDING' AND o.status::text <> 'CANCELLED' AND o.created_at < $1 ORDER BY o.created_at`, [end])
    return rows
  }
}
