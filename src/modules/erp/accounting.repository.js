import { query } from '../../config/database.js'

const many = async (sql, params) => (await query(sql, params)).rows

/** Expenses and the owner's cash book, plus the two money-in sources that have no home elsewhere (gateway capture and refunds). */
export class AccountingRepository {
  expenses({ from, to, category = null, shopId = null, includeVoided = false, limit = 500 }) {
    return many(
      `SELECT e.id, to_char(e.spent_on, 'YYYY-MM-DD') AS spent_on, e.category, e.kind, e.amount, e.paid_via, e.shop_id, s.name AS shop, e.party, e.note, e.created_at, cu.name AS created_by_name,
              e.voided_at, e.void_reason, vu.name AS voided_by_name
         FROM erp_expenses e LEFT JOIN shops s ON s.id = e.shop_id LEFT JOIN users cu ON cu.id = e.created_by LEFT JOIN users vu ON vu.id = e.voided_by
        WHERE e.spent_on >= $1::date AND e.spent_on <= $2::date AND ($3::text IS NULL OR e.category = $3) AND ($4::uuid IS NULL OR e.shop_id = $4) AND ($5::boolean OR e.voided_at IS NULL)
        ORDER BY e.spent_on DESC, e.created_at DESC LIMIT ${Number(limit)}`, [from, to, category, shopId, includeVoided])
  }
  async insertExpense(client, x) {
    const { rows } = await client.query(
      `INSERT INTO erp_expenses (spent_on, category, kind, amount, paid_via, shop_id, party, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [x.spentOn, x.category, x.kind, x.amount, x.paidVia, x.shopId, x.party, x.note, x.actorId])
    return rows[0].id
  }
  async lockExpense(client, id) {
    const { rows } = await client.query(`SELECT id, to_char(spent_on, 'YYYY-MM-DD') AS spent_on, amount, category, voided_at FROM erp_expenses WHERE id = $1 FOR UPDATE`, [id])
    return rows[0] ?? null
  }
  voidExpense(client, id, actorId, reason) {
    return client.query(`UPDATE erp_expenses SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL`, [id, actorId, reason])
  }

  cashEntries({ from, to, includeVoided = false, limit = 500 }) {
    return many(
      `SELECT c.id, to_char(c.entry_on, 'YYYY-MM-DD') AS entry_on, c.kind, c.account, c.amount, c.note, c.created_at, cu.name AS created_by_name, c.voided_at, c.void_reason, vu.name AS voided_by_name
         FROM erp_cash_entries c LEFT JOIN users cu ON cu.id = c.created_by LEFT JOIN users vu ON vu.id = c.voided_by
        WHERE c.entry_on >= $1::date AND c.entry_on <= $2::date AND ($3::boolean OR c.voided_at IS NULL) ORDER BY c.entry_on DESC, c.created_at DESC LIMIT ${Number(limit)}`, [from, to, includeVoided])
  }
  async insertCash(client, x) {
    const { rows } = await client.query(`INSERT INTO erp_cash_entries (entry_on, kind, account, amount, note, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [x.entryOn, x.kind, x.account, x.amount, x.note, x.actorId])
    return rows[0].id
  }
  async lockCash(client, id) {
    const { rows } = await client.query(`SELECT id, to_char(entry_on, 'YYYY-MM-DD') AS entry_on, kind, amount, voided_at FROM erp_cash_entries WHERE id = $1 FOR UPDATE`, [id])
    return rows[0] ?? null
  }
  voidCash(client, id, actorId, reason) {
    return client.query(`UPDATE erp_cash_entries SET voided_at = NOW(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL`, [id, actorId, reason])
  }
  /** The latest opening balance for a box on or before a day (the starting point balances are counted from). */
  async opening(account, asOf) {
    const rows = await many(
      `SELECT to_char(entry_on, 'YYYY-MM-DD') AS on, amount FROM erp_cash_entries WHERE kind = 'OPENING_BALANCE' AND account = $1 AND voided_at IS NULL AND entry_on <= $2::date
        ORDER BY entry_on DESC, created_at DESC LIMIT 1`, [account, asOf])
    return rows[0] ?? null
  }

  /** Online money the gateway took, by the day the customer paid. Status REFUNDED = it was paid first. */
  async gatewayIn(start, end) {
    return (await many(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::numeric(14,2) AS total FROM payments WHERE status IN ('PAID','REFUNDED') AND created_at >= $1 AND created_at < $2`, [start, end]))[0]
  }
  /** Money sent back through the gateway, by the day it was refunded. */
  async gatewayOut(start, end) {
    return (await many(`SELECT COUNT(*)::int AS n, COALESCE(SUM(refund_amount), 0)::numeric(14,2) AS total FROM payments WHERE refund_amount > 0 AND updated_at >= $1 AND updated_at < $2`, [start, end]))[0]
  }
  codByDay(start, end) {
    return many(
      `SELECT to_char(o.delivered_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n, COALESCE(SUM(m.total_amount - m.wallet_part), 0)::numeric(14,2) AS total
         FROM order_money m JOIN orders o ON o.id = m.order_id
        WHERE m.payment_method = 'COD' AND m.payment_status = 'PAID' AND m.status = 'DELIVERED' AND o.delivered_at >= $1 AND o.delivered_at < $2 GROUP BY 1 ORDER BY 1`, [start, end])
  }
  gatewayInByDay(start, end) {
    return many(`SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::numeric(14,2) AS total FROM payments WHERE status IN ('PAID','REFUNDED') AND created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 1`, [start, end])
  }
  gatewayOutByDay(start, end) {
    return many(`SELECT to_char(updated_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n, COALESCE(SUM(refund_amount), 0)::numeric(14,2) AS total FROM payments WHERE refund_amount > 0 AND updated_at >= $1 AND updated_at < $2 GROUP BY 1 ORDER BY 1`, [start, end])
  }
}
