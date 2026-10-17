import { query } from '../../config/database.js'

/** Closed months and what was frozen when they were closed. */
export class PeriodsRepository {
  async get(month) {
    const { rows } = await query(`SELECT p.month, p.closed_at, p.note, p.snapshot, u.name AS closed_by_name FROM accounting_periods p LEFT JOIN users u ON u.id = p.closed_by WHERE p.month = $1`, [month])
    return rows[0] ?? null
  }
  async closedMonths() {
    const { rows } = await query(`SELECT month FROM accounting_periods ORDER BY month`)
    return rows.map((r) => r.month)
  }
  async isClosed(month) {
    const { rows } = await query(`SELECT 1 FROM accounting_periods WHERE month = $1`, [month])
    return rows.length > 0
  }
  async history(limit = 20) {
    const { rows } = await query(
      `SELECT l.month, l.action, l.note, l.created_at, u.name AS actor_name FROM accounting_period_log l LEFT JOIN users u ON u.id = l.actor_id ORDER BY l.created_at DESC, l.id DESC LIMIT ${Number(limit)}`)
    return rows
  }
  async insert(client, { month, actorId, note, snapshot, stockRows }) {
    await client.query(`INSERT INTO accounting_periods (month, closed_by, note, snapshot) VALUES ($1,$2,$3,$4)`, [month, actorId, note ?? null, JSON.stringify(snapshot)])
    for (const r of stockRows) {
      await client.query(`INSERT INTO period_stock_snapshots (month, shop_product_id, qty, avg_cost) VALUES ($1,$2,$3,$4)`, [month, r.shopProductId, r.qty, r.avgCost])
    }
  }
  async remove(client, month) {
    await client.query(`DELETE FROM accounting_periods WHERE month = $1`, [month])
  }
  async log(client, { month, action, actorId, note, totals }) {
    await client.query(`INSERT INTO accounting_period_log (month, action, actor_id, note, totals) VALUES ($1,$2,$3,$4,$5)`, [month, action, actorId, note ?? null, totals ? JSON.stringify(totals) : null])
  }
  async lock(client, month) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`period:${month}`])
  }
}
