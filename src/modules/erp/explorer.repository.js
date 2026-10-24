import { query } from '../../config/database.js'
import { PLACED, CANCELLED, REFUND_EVENTS_CTE, CH } from '../business-analytics/sales-rules.js'

/**
 * Data Explorer: one definition per kind of record. Every query takes the same four parameters:
 *   $1 start, $2 end (instants, [start, end)), $3 store id or NULL, $4 LIKE pattern or NULL.
 * Nothing user-typed is ever placed in the SQL text — only these parameters.
 */
const shop = (col) => `($3::uuid IS NULL OR ${col} = $3)`

const TREATMENT = `(CASE
  WHEN o.status = 'PENDING' THEN 'Unpaid — not a sale'
  WHEN ${CANCELLED} THEN 'Cancelled — not a sale'
  WHEN rf.is_full THEN 'Refunded in full — not counted'
  WHEN rf.order_id IS NOT NULL THEN 'Sale — part refunded'
  ELSE 'Sale' END)`

export const KINDS = {
  orders: {
    label: 'Orders',
    with: REFUND_EVENTS_CTE,
    from: `orders o JOIN users u ON u.id = o.user_id LEFT JOIN shops s ON s.id = o.shop_id LEFT JOIN refund_events rf ON rf.order_id = o.id`,
    where: `o.created_at >= $1 AND o.created_at < $2 AND ${shop('o.shop_id')} AND ($4::text IS NULL OR o.order_number ILIKE $4 ESCAPE '\\' OR u.name ILIKE $4 ESCAPE '\\' OR u.phone ILIKE $4 ESCAPE '\\')`,
    order: 'o.created_at DESC, o.id',
    select: `o.order_number AS number, o.created_at AS at, s.name AS store, u.name AS customer, u.phone AS phone, ${CH} AS channel, o.status::text AS status, o.payment_method AS method,
             o.payment_status AS paid, o.total_amount::float AS total, COALESCE(rf.amt, 0)::float AS refunded, ${TREATMENT} AS treatment`,
    columns: [['number', 'Order', 'text'], ['at', 'Placed', 'datetime'], ['store', 'Store', 'text'], ['customer', 'Customer', 'text'], ['phone', 'Phone', 'phone'], ['channel', 'Type', 'text'], ['status', 'Status', 'text'], ['method', 'Pays by', 'text'], ['paid', 'Payment', 'text'], ['total', 'Total', 'money'], ['refunded', 'Refunded', 'money'], ['treatment', 'In sales?', 'text']],
  },
  lines: {
    label: 'Order items',
    from: `order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id LEFT JOIN shops s ON s.id = o.shop_id`,
    where: `o.created_at >= $1 AND o.created_at < $2 AND ${shop('o.shop_id')} AND ($4::text IS NULL OR p.name ILIKE $4 ESCAPE '\\' OR o.order_number ILIKE $4 ESCAPE '\\')`,
    order: 'o.created_at DESC, oi.id',
    select: `o.order_number AS number, o.created_at AS at, s.name AS store, p.name AS product, oi.quantity AS qty, oi.price::float AS price, oi.total::float AS total, o.status::text AS status`,
    columns: [['number', 'Order', 'text'], ['at', 'Placed', 'datetime'], ['store', 'Store', 'text'], ['product', 'Product', 'text'], ['qty', 'Qty', 'number'], ['price', 'Price', 'money'], ['total', 'Total', 'money'], ['status', 'Order status', 'text']],
  },
  movements: {
    label: 'Stock movements',
    from: `stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN shops s ON s.id = m.shop_id LEFT JOIN orders o ON o.id = m.order_id`,
    where: `m.created_at >= $1 AND m.created_at < $2 AND ${shop('m.shop_id')} AND ($4::text IS NULL OR p.name ILIKE $4 ESCAPE '\\' OR m.type ILIKE $4 ESCAPE '\\' OR o.order_number ILIKE $4 ESCAPE '\\')`,
    order: 'm.created_at DESC, m.id',
    select: `m.created_at AS at, s.name AS store, p.name AS product, m.type AS type, m.quantity_delta AS change, m.quantity_before AS before, m.quantity_after AS after,
             COALESCE(NULLIF(m.metadata->>'reason', ''), m.reason) AS reason, o.order_number AS number`,
    columns: [['at', 'When', 'datetime'], ['store', 'Store', 'text'], ['product', 'Product', 'text'], ['type', 'What happened', 'text'], ['change', 'Change', 'number'], ['before', 'Before', 'number'], ['after', 'After', 'number'], ['reason', 'Reason', 'text'], ['number', 'Order', 'text']],
  },
  purchases: {
    label: 'Purchases',
    from: `procurement_entries e JOIN vendors v ON v.id = e.vendor_id JOIN products p ON p.id = e.product_id LEFT JOIN shops s ON s.id = e.destination_shop_id`,
    where: `e.procured_on >= ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date AND e.procured_on < ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date AND ${shop('e.destination_shop_id')} AND ($4::text IS NULL OR p.name ILIKE $4 ESCAPE '\\' OR v.name ILIKE $4 ESCAPE '\\' OR e.invoice_ref ILIKE $4 ESCAPE '\\')`,
    order: 'e.procured_on DESC, e.entry_no DESC',
    select: `to_char(e.procured_on, 'YYYY-MM-DD') AS date, v.name AS vendor, p.name AS product, s.name AS store, e.expected_qty AS ordered, e.received_qty AS received, e.damaged_qty AS bad,
             e.unit_price::float AS price, e.purchase_total::float AS total, e.status AS status, e.invoice_ref AS invoice`,
    columns: [['date', 'Date', 'text'], ['vendor', 'Vendor', 'text'], ['product', 'Product', 'text'], ['store', 'Store', 'text'], ['ordered', 'Ordered', 'number'], ['received', 'Received', 'number'], ['bad', 'Bad', 'number'], ['price', 'Price', 'money'], ['total', 'Total', 'money'], ['status', 'Status', 'text'], ['invoice', 'Invoice', 'text']],
  },
  refunds: {
    label: 'Refunds',
    with: REFUND_EVENTS_CTE,
    from: `refund_events rf JOIN orders o ON o.id = rf.order_id JOIN users u ON u.id = o.user_id LEFT JOIN shops s ON s.id = o.shop_id`,
    where: `rf.at >= $1 AND rf.at < $2 AND ${shop('o.shop_id')} AND ($4::text IS NULL OR o.order_number ILIKE $4 ESCAPE '\\' OR u.name ILIKE $4 ESCAPE '\\')`,
    order: 'rf.at DESC, o.id',
    select: `rf.at AS at, o.order_number AS number, s.name AS store, u.name AS customer, o.total_amount::float AS order_total, rf.amt::float AS refunded, rf.is_full AS full,
             (CASE WHEN ${CANCELLED} THEN 'Cancelled order — not counted as a refund' WHEN rf.is_full THEN 'Refunded in full' ELSE 'Part refund' END) AS note`,
    columns: [['at', 'Refunded on', 'datetime'], ['number', 'Order', 'text'], ['store', 'Store', 'text'], ['customer', 'Customer', 'text'], ['order_total', 'Order total', 'money'], ['refunded', 'Refunded', 'money'], ['full', 'Whole order?', 'bool'], ['note', 'How it counts', 'text']],
  },
  expenses: {
    label: 'Expenses',
    from: `erp_expenses e LEFT JOIN shops s ON s.id = e.shop_id`,
    where: `e.spent_on >= ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date AND e.spent_on < ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date AND ${shop('e.shop_id')} AND ($4::text IS NULL OR e.category ILIKE $4 ESCAPE '\\' OR e.party ILIKE $4 ESCAPE '\\' OR e.note ILIKE $4 ESCAPE '\\')`,
    order: 'e.spent_on DESC, e.created_at DESC',
    select: `to_char(e.spent_on, 'YYYY-MM-DD') AS date, e.category AS category, e.kind AS kind, e.amount::float AS amount, e.paid_via AS via, s.name AS store, e.party AS party, e.note AS note,
             (CASE WHEN e.voided_at IS NULL THEN 'Counted' ELSE 'Cancelled: ' || e.void_reason END) AS state`,
    columns: [['date', 'Date', 'text'], ['category', 'Type', 'text'], ['kind', 'Fixed/varies', 'text'], ['amount', 'Amount', 'money'], ['via', 'Paid by', 'text'], ['store', 'Store', 'text'], ['party', 'Paid to', 'text'], ['note', 'Note', 'text'], ['state', 'State', 'text']],
  },
}

export class ExplorerRepository {
  async page(kind, args, { limit, offset }) {
    const k = KINDS[kind]
    const withSql = k.with ? `WITH ${k.with}` : ''
    const [rows, count] = await Promise.all([
      query(`${withSql} SELECT ${k.select} FROM ${k.from} WHERE ${k.where} ORDER BY ${k.order} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, args),
      query(`${withSql} SELECT COUNT(*)::int AS n FROM ${k.from} WHERE ${k.where}`, args),
    ])
    return { rows: rows.rows, total: count.rows[0].n }
  }
}
