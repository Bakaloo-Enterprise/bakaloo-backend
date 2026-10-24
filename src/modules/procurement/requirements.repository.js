import { query } from '../../config/database.js'

const REQ_SELECT = `
  r.id, r.req_no, r.customer_name, r.customer_phone, r.business_account_id, r.wa_conversation_id, r.source, r.status,
  to_char(r.delivery_date, 'YYYY-MM-DD') AS delivery_date, r.payment_terms, r.note, r.created_at, u.name AS created_by_name,
  b.company_name AS business_name, r.order_id, ord.order_number`
const REQ_FROM = `
  FROM b2b_requirements r
  LEFT JOIN users u ON u.id = r.created_by
  LEFT JOIN business_accounts b ON b.id = r.business_account_id
  LEFT JOIN orders ord ON ord.id = r.order_id`

export class RequirementsRepository {
  async list({ status, source, search, limit = 30, offset = 0 }) {
    const where = ['TRUE']
    const p = []
    if (status) { p.push(status); where.push(`r.status = $${p.length}`) }
    if (source) { p.push(source); where.push(`r.source = $${p.length}`) }
    if (search) { p.push(`%${search}%`); where.push(`(r.customer_name ILIKE $${p.length} OR r.customer_phone ILIKE $${p.length} OR r.req_no::text = trim(both '%' from $${p.length}))`) }
    const total = (await query(`SELECT COUNT(*)::int AS n ${REQ_FROM} WHERE ${where.join(' AND ')}`, p)).rows[0].n
    p.push(limit, offset)
    const { rows } = await query(
      `SELECT ${REQ_SELECT} ${REQ_FROM} WHERE ${where.join(' AND ')}
        ORDER BY CASE r.status WHEN 'CONFIRMED' THEN 0 WHEN 'INQUIRY' THEN 1 ELSE 2 END, r.delivery_date NULLS LAST, r.created_at DESC
        LIMIT $${p.length - 1} OFFSET $${p.length}`, p)
    return { rows, total }
  }

  async byId(id, client) {
    const { rows } = await (client ?? { query }).query(`SELECT ${REQ_SELECT} ${REQ_FROM} WHERE r.id = $1`, [id])
    return rows[0] ?? null
  }

  async itemsFor(ids) {
    if (ids.length === 0) return []
    const { rows } = await query(
      `SELECT i.requirement_id, i.product_id, i.quantity, i.unit_price, p.name AS product_name, p.net_quantity AS unit, p.thumbnail_url AS image_url
         FROM b2b_requirement_items i JOIN products p ON p.id = i.product_id WHERE i.requirement_id = ANY($1::uuid[]) ORDER BY p.name`, [ids])
    return rows
  }

  async events(id) {
    const { rows } = await query(
      `SELECT v.kind, v.detail, v.created_at, u.name AS actor_name FROM b2b_requirement_events v LEFT JOIN users u ON u.id = v.actor_id
        WHERE v.requirement_id = $1 ORDER BY v.created_at, v.id`, [id])
    return rows
  }

  async lock(client, id) {
    const { rows } = await client.query(`SELECT id, status FROM b2b_requirements WHERE id = $1 FOR UPDATE`, [id])
    return rows[0] ?? null
  }

  async insert(client, d, actorId) {
    const { rows } = await client.query(
      `INSERT INTO b2b_requirements (customer_name, customer_phone, business_account_id, wa_conversation_id, source, status, delivery_date, payment_terms, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [d.customerName, d.customerPhone, d.businessAccountId ?? null, d.waConversationId ?? null, d.source, d.status, d.deliveryDate, d.paymentTerms, d.note, actorId])
    const id = rows[0].id
    for (const it of d.items) {
      await client.query(`INSERT INTO b2b_requirement_items (requirement_id, product_id, quantity, unit_price) VALUES ($1,$2,$3,$4)`, [id, it.productId, it.quantity, it.unitPrice])
    }
    return id
  }

  async setStatus(client, id, status) {
    await client.query(`UPDATE b2b_requirements SET status = $2, updated_at = NOW() WHERE id = $1`, [id, status])
  }

  async logEvent(client, id, actorId, kind, detail = {}) {
    await client.query(`INSERT INTO b2b_requirement_events (requirement_id, actor_id, kind, detail) VALUES ($1,$2,$3,$4)`, [id, actorId, kind, JSON.stringify(detail)])
  }

  async productsExist(ids) {
    const { rows } = await query(`SELECT id FROM products WHERE id = ANY($1::uuid[])`, [ids])
    return new Set(rows.map((r) => r.id))
  }

  async businessAccount(id) {
    const { rows } = await query(
      `SELECT b.id, b.company_name, b.status, u.name AS contact_name, u.phone FROM business_accounts b JOIN users u ON u.id = b.user_id WHERE b.id = $1`, [id])
    return rows[0] ?? null
  }

  /** Approved business accounts matching a name or phone — the "customer" picker. */
  async customers(search) {
    const { rows } = await query(
      `SELECT b.id, b.company_name, u.name AS contact_name, u.phone
         FROM business_accounts b JOIN users u ON u.id = b.user_id
        WHERE b.status = 'APPROVED' AND ($1 = '' OR b.company_name ILIKE $2 OR u.name ILIKE $2 OR u.phone ILIKE $2)
        ORDER BY b.company_name LIMIT 8`, [search, `%${search}%`])
    return rows
  }

  /** Name/phone of a CRM chat, so "Create requirement" from the inbox starts filled in. */
  async conversation(id) {
    const { rows } = await query(
      `SELECT c.id, COALESCE(k.profile_name, '') AS profile_name, k.phone, k.wa_id, k.user_id,
              (SELECT ba.id FROM business_accounts ba WHERE ba.user_id = k.user_id AND ba.status = 'APPROVED') AS business_account_id,
              (SELECT ba.company_name FROM business_accounts ba WHERE ba.user_id = k.user_id AND ba.status = 'APPROVED') AS company_name
         FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id WHERE c.id = $1`, [id])
    return rows[0] ?? null
  }

  /** One row per product that anyone needs; see requirements.rules.js planFor() for how the columns combine. */
  async planRows() {
    const { rows } = await query(
      `WITH conf AS (
         SELECT i.product_id, SUM(i.quantity)::int AS q, MIN(r.delivery_date) AS first_due
           FROM b2b_requirement_items i JOIN b2b_requirements r ON r.id = i.requirement_id WHERE r.status = 'CONFIRMED' GROUP BY 1),
       inq AS (
         SELECT i.product_id, SUM(i.quantity)::int AS q
           FROM b2b_requirement_items i JOIN b2b_requirements r ON r.id = i.requirement_id WHERE r.status = 'INQUIRY' GROUP BY 1),
       app AS (
         SELECT oi.product_id, SUM(oi.quantity)::int AS q
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.b2b_approval_status = 'PENDING' AND o.status::text <> 'CANCELLED' AND oi.product_id IS NOT NULL GROUP BY 1),
       st AS (
         SELECT sp.product_id, SUM(sp.stock_quantity)::int AS stock, SUM(GREATEST(0, sp.low_stock_threshold - sp.stock_quantity))::int AS low
           FROM shop_products sp JOIN shops s ON s.id = sp.shop_id AND s.is_active
          WHERE sp.deleted_at IS NULL AND sp.is_available IS NOT FALSE GROUP BY 1),
       ce AS (
         SELECT e.product_id, SUM(e.received_qty - e.damaged_qty - COALESCE(al.qty, 0) - COALESCE(ca.qty, 0))::int AS q
           FROM procurement_entries e
           LEFT JOIN LATERAL (SELECT SUM(quantity) AS qty FROM procurement_allocations WHERE entry_id = e.id AND status = 'APPLIED') al ON TRUE
           LEFT JOIN LATERAL (SELECT SUM(quantity) AS qty FROM procurement_adjustments WHERE entry_id = e.id AND shop_id IS NULL) ca ON TRUE
          WHERE e.status = 'ACTIVE' GROUP BY 1),
       inc AS (
         SELECT e.product_id, SUM(CASE WHEN e.status = 'ORDERED' THEN e.expected_qty ELSE e.owed_qty END)::int AS q
           FROM procurement_entries e WHERE e.status = 'ORDERED' OR (e.status = 'ACTIVE' AND e.owed_qty > 0) GROUP BY 1),
       lastbuy AS (
         SELECT DISTINCT ON (e.product_id) e.product_id, e.unit_price, v.name AS vendor_name, v.id AS vendor_id
           FROM procurement_entries e JOIN vendors v ON v.id = e.vendor_id AND v.is_active WHERE e.status = 'ACTIVE' ORDER BY e.product_id, e.procured_on DESC, e.created_at DESC),
       -- the suppliers we usually buy each product from (most recent first, at most 4), each with the price of the latest purchase
       vend AS (
         SELECT product_id, jsonb_agg(jsonb_build_object('vendorId', vendor_id, 'name', name, 'price', price, 'on', last_on, 'times', n) ORDER BY last_on DESC) AS list
           FROM (SELECT x.*, ROW_NUMBER() OVER (PARTITION BY x.product_id ORDER BY x.last_on DESC, x.n DESC) AS rn
                   FROM (SELECT e.product_id, e.vendor_id, v.name, (ARRAY_AGG(e.unit_price ORDER BY e.procured_on DESC, e.created_at DESC))[1] AS price,
                                to_char(MAX(e.procured_on), 'YYYY-MM-DD') AS last_on, COUNT(*)::int AS n
                           FROM procurement_entries e JOIN vendors v ON v.id = e.vendor_id AND v.is_active
                          WHERE e.status IN ('ACTIVE', 'ORDERED') GROUP BY e.product_id, e.vendor_id, v.name) x) r
          WHERE rn <= 4 GROUP BY product_id)
       SELECT p.id AS product_id, p.name, p.net_quantity AS unit, p.thumbnail_url AS image_url,
              COALESCE(conf.q, 0) AS confirmed, COALESCE(inq.q, 0) AS inquiry, COALESCE(app.q, 0) AS app_orders,
              COALESCE(st.low, 0) AS shop_low, COALESCE(st.stock, 0) AS store_stock, GREATEST(COALESCE(ce.q, 0), 0) AS central_stock, COALESCE(inc.q, 0) AS incoming,
              to_char(conf.first_due, 'YYYY-MM-DD') AS first_due, lastbuy.unit_price AS last_price, lastbuy.vendor_name AS last_vendor, lastbuy.vendor_id AS last_vendor_id,
              COALESCE(vend.list, '[]'::jsonb) AS vendors
         FROM products p
         LEFT JOIN conf ON conf.product_id = p.id LEFT JOIN inq ON inq.product_id = p.id LEFT JOIN app ON app.product_id = p.id
         LEFT JOIN st ON st.product_id = p.id LEFT JOIN ce ON ce.product_id = p.id LEFT JOIN inc ON inc.product_id = p.id LEFT JOIN lastbuy ON lastbuy.product_id = p.id LEFT JOIN vend ON vend.product_id = p.id
        WHERE COALESCE(conf.q, 0) + COALESCE(inq.q, 0) + COALESCE(app.q, 0) + COALESCE(st.low, 0) > 0
        ORDER BY p.name LIMIT 500`)
    return rows
  }
}
