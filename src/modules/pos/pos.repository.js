import { getClient, query } from '../../config/database.js'

const ACTIVE = ['CONFIRMED', 'PREPARING', 'PACKED', 'OUT_FOR_DELIVERY']

/** Run `fn(client)` in one transaction. */
export async function withTransaction(fn) {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

const run = (client) => (client ? client.query.bind(client) : query)

/** Storage for the Store Fulfillment POS. Every read and write is scoped to one shop. */
export class PosRepository {
  // ─── people & access ────────────────────────────────────────────
  async loadAccess(userId, shopId) {
    const { rows } = await query(
      `SELECT u.id, u.name, u.platform_role, ss.role AS shop_role, ss.pos_station
         FROM users u
         LEFT JOIN shop_staff ss ON ss.user_id = u.id AND ss.shop_id = $2 AND ss.is_active AND ss.deleted_at IS NULL
        WHERE u.id = $1 AND u.is_active = true`,
      [userId, shopId],
    )
    return rows[0] ?? null
  }

  async staff(shopId) {
    const { rows } = await query(
      `SELECT u.id, u.name, ss.role, ss.pos_station
         FROM shop_staff ss JOIN users u ON u.id = ss.user_id
        WHERE ss.shop_id = $1 AND ss.is_active AND ss.deleted_at IS NULL AND u.is_active
        ORDER BY u.name`,
      [shopId],
    )
    return rows
  }

  async staffMember(shopId, userId) {
    const { rows } = await query(
      `SELECT u.id, u.name, ss.role, ss.pos_station FROM shop_staff ss JOIN users u ON u.id = ss.user_id
        WHERE ss.shop_id = $1 AND ss.user_id = $2 AND ss.is_active AND ss.deleted_at IS NULL AND u.is_active`,
      [shopId, userId],
    )
    return rows[0] ?? null
  }

  async setStation(shopId, userId, station) {
    const { rowCount } = await query(
      `UPDATE shop_staff SET pos_station = $3, updated_at = NOW() WHERE shop_id = $1 AND user_id = $2 AND is_active AND deleted_at IS NULL`,
      [shopId, userId, station],
    )
    return rowCount > 0
  }

  async names(ids) {
    const out = new Map()
    if (!ids.length) return out
    const { rows } = await query(`SELECT id, name FROM users WHERE id = ANY($1::uuid[])`, [ids])
    for (const r of rows) out.set(r.id, r.name)
    return out
  }

  async shop(shopId) {
    const { rows } = await query(`SELECT id, name, city, pincode FROM shops WHERE id = $1`, [shopId])
    return rows[0] ?? null
  }

  // ─── orders, fulfilment, lines ──────────────────────────────────
  /** The order, only if it belongs to this shop. */
  async order(shopId, orderId, { client, lock = false } = {}) {
    const { rows } = await run(client)(
      `SELECT o.id, o.order_number, o.status, o.shop_id, o.rider_id, o.payment_status, o.payment_method, o.delivery_address, o.delivery_notes,
              o.total_amount, o.created_at, o.updated_at, o.assigned_at, o.delivery_mode, o.scheduled_slot_label, o.scheduled_slot_start
         FROM orders o WHERE o.id = $1 AND o.shop_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
      [orderId, shopId],
    )
    return rows[0] ?? null
  }

  async fulfillment(orderId, client) {
    const { rows } = await run(client)(`SELECT * FROM pos_fulfillments WHERE order_id = $1`, [orderId])
    return rows[0] ?? null
  }

  async lines(orderId, client) {
    const { rows } = await run(client)(`SELECT * FROM pos_lines WHERE order_id = $1 ORDER BY name, id`, [orderId])
    return rows
  }

  async line(orderId, lineId, client, lock = false) {
    const { rows } = await run(client)(`SELECT * FROM pos_lines WHERE order_id = $1 AND id = $2 ${lock ? 'FOR UPDATE' : ''}`, [orderId, lineId])
    return rows[0] ?? null
  }

  /** Snapshot the order's items into a pick list. Safe to call twice (existing lines are kept). */
  async createLines(client, orderId, shopId) {
    await client.query(
      `INSERT INTO pos_lines (order_id, order_item_id, shop_id, product_id, name, unit, image_url, barcode, sku, required_qty)
       SELECT oi.order_id, oi.id, $2, oi.product_id, oi.name, COALESCE(oi.unit, p.net_quantity), p.thumbnail_url, p.barcode, p.sku, oi.quantity
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = $1
       ON CONFLICT (order_item_id) DO NOTHING`,
      [orderId, shopId],
    )
  }

  /** Create the fulfilment record if there is none; assign a picker/packer without starting the work. */
  async ensureFulfillment(client, orderId, shopId) {
    await client.query(`INSERT INTO pos_fulfillments (order_id, shop_id) VALUES ($1,$2) ON CONFLICT (order_id) DO NOTHING`, [orderId, shopId])
    return this.fulfillment(orderId, client)
  }

  async setPerson(client, orderId, role, userId) {
    const col = role === 'PICKER' ? 'picker_id' : 'packer_id'
    await client.query(`UPDATE pos_fulfillments SET ${col} = $2, updated_at = NOW() WHERE order_id = $1`, [orderId, userId])
  }

  async startPick(client, orderId, userId) {
    await client.query(
      `UPDATE pos_fulfillments SET stage = 'PICKING', picker_id = COALESCE(picker_id, $2), pick_started_at = COALESCE(pick_started_at, NOW()), updated_at = NOW() WHERE order_id = $1`,
      [orderId, userId],
    )
  }

  async finishPick(client, orderId) {
    await client.query(`UPDATE pos_fulfillments SET stage = 'PACKING', pick_finished_at = NOW(), updated_at = NOW() WHERE order_id = $1`, [orderId])
  }

  async startPack(client, orderId, userId) {
    await client.query(
      `UPDATE pos_fulfillments SET packer_id = COALESCE(packer_id, $2), pack_started_at = COALESCE(pack_started_at, NOW()), updated_at = NOW() WHERE order_id = $1`,
      [orderId, userId],
    )
  }

  async finishPack(client, orderId, packageCount) {
    await client.query(`UPDATE pos_fulfillments SET stage = 'DONE', pack_finished_at = NOW(), package_count = $2, updated_at = NOW() WHERE order_id = $1`, [orderId, packageCount])
  }

  async addPicked(client, lineId, by = 1) {
    const { rows } = await client.query(
      `UPDATE pos_lines SET picked_qty = picked_qty + $2, status = CASE WHEN picked_qty + $2 >= required_qty THEN 'PICKED' ELSE status END, updated_at = NOW()
        WHERE id = $1 AND status = 'PENDING' AND picked_qty + $2 <= required_qty RETURNING *`,
      [lineId, by],
    )
    return rows[0] ?? null
  }

  async addPacked(client, lineId, target, by = 1) {
    const { rows } = await client.query(
      `UPDATE pos_lines SET packed_qty = packed_qty + $2, updated_at = NOW() WHERE id = $1 AND packed_qty + $2 <= $3 RETURNING *`,
      [lineId, by, target],
    )
    return rows[0] ?? null
  }

  async markMissing(client, lineId, { note, userId }) {
    const { rows } = await client.query(
      `UPDATE pos_lines SET status = 'MISSING', missing_note = $2, missing_by = $3, missing_at = NOW(), updated_at = NOW() WHERE id = $1 AND status IN ('PENDING','PICKED') RETURNING *`,
      [lineId, note, userId],
    )
    return rows[0] ?? null
  }

  async decide(client, lineId, { decision, note, userId }) {
    const { rows } = await client.query(
      `UPDATE pos_lines SET status = 'RESOLVED', decision = $2, decision_note = $3, decided_by = $4, decided_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'MISSING' RETURNING *`,
      [lineId, decision, note, userId],
    )
    return rows[0] ?? null
  }

  async logScan(client, { shopId, orderId, lineId, stage, code, result, userId }) {
    const { rows } = await run(client)(
      `INSERT INTO pos_scans (shop_id, order_id, line_id, stage, code, result, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [shopId, orderId, lineId ?? null, stage, code ? String(code).slice(0, 120) : null, result, userId],
    )
    return rows[0].id
  }

  async logEvent(client, { shopId, orderId, actorId, kind, detail = {} }) {
    await run(client)(`INSERT INTO pos_events (shop_id, order_id, actor_id, kind, detail) VALUES ($1,$2,$3,$4,$5::jsonb)`, [shopId, orderId ?? null, actorId ?? null, kind, JSON.stringify(detail)])
  }

  // ─── the live board ─────────────────────────────────────────────
  async boardOrders(shopId) {
    const { rows } = await query(
      `SELECT o.id, o.order_number, o.status, o.created_at, o.updated_at, o.rider_id, o.delivery_address, o.delivery_mode, o.scheduled_slot_label, o.scheduled_slot_start,
              o.payment_status,
              (SELECT MIN(h.changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'CONFIRMED') AS confirmed_at,
              (SELECT COALESCE(SUM(oi.quantity),0)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_units,
              (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_lines,
              f.stage, f.picker_id, f.packer_id, f.pick_started_at, f.pick_finished_at, f.pack_started_at, f.pack_finished_at, f.package_count,
              pu.name AS picker_name, ku.name AS packer_name,
              da.id AS assignment_id, da.status AS assignment_status, da.assigned_at, da.picked_up_at, ru.name AS rider_name,
              (SELECT t.status FROM order_pickup_tokens t WHERE t.order_id = o.id AND t.delivery_assignment_id = da.id ORDER BY t.issued_at DESC LIMIT 1) AS token_status,
              (SELECT COUNT(*)::int FROM pos_lines l WHERE l.order_id = o.id AND l.status = 'MISSING') AS missing_lines,
              (SELECT COUNT(*)::int FROM pos_lines l WHERE l.order_id = o.id AND l.status IN ('PICKED','RESOLVED')) AS settled_lines,
              (SELECT COUNT(*)::int FROM pos_lines l WHERE l.order_id = o.id) AS pos_lines,
              (SELECT COUNT(*)::int FROM pos_print_jobs j WHERE j.order_id = o.id AND j.status = 'FAILED') AS failed_prints
         FROM orders o
         LEFT JOIN pos_fulfillments f ON f.order_id = o.id
         LEFT JOIN users pu ON pu.id = f.picker_id
         LEFT JOIN users ku ON ku.id = f.packer_id
         LEFT JOIN LATERAL (SELECT * FROM delivery_assignments d WHERE d.order_id = o.id AND d.status <> 'CANCELLED' ORDER BY d.created_at DESC LIMIT 1) da ON TRUE
         LEFT JOIN users ru ON ru.id = da.rider_id
        WHERE o.shop_id = $1 AND o.status = ANY($2::order_status[])
        ORDER BY o.created_at`,
      [shopId, ACTIVE],
    )
    return rows
  }

  async deliveredSince(shopId, since) {
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM orders WHERE shop_id = $1 AND status = 'DELIVERED' AND delivered_at >= $2`, [shopId, since])
    return rows[0].n
  }

  // ─── riders ─────────────────────────────────────────────────────
  /** Approved riders this store may use (its own, or unassigned to any store) with what they are doing right now. */
  async riders(shopId) {
    const { rows } = await query(
      `SELECT u.id, u.name, rp.is_online, rp.vehicle_type, rp.max_active_orders, rp.shop_id AS home_shop_id,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('orderId', o.id, 'orderNumber', o.order_number, 'status', da.status, 'shopId', o.shop_id,
                              'token', (SELECT t.status FROM order_pickup_tokens t WHERE t.delivery_assignment_id = da.id ORDER BY t.issued_at DESC LIMIT 1))
                              ORDER BY da.created_at)
                          FROM delivery_assignments da JOIN orders o ON o.id = da.order_id
                         WHERE da.rider_id = u.id AND da.status IN ('ASSIGNED','ACCEPTED','PICKED_UP','IN_TRANSIT')), '[]'::jsonb) AS active
         FROM rider_profiles rp JOIN users u ON u.id = rp.user_id
        WHERE rp.is_approved AND u.is_active AND (rp.shop_id = $1 OR rp.shop_id IS NULL)
        ORDER BY u.name`,
      [shopId],
    )
    return rows
  }

  async rider(shopId, riderId) {
    const { rows } = await query(
      `SELECT u.id, u.name, rp.is_online FROM rider_profiles rp JOIN users u ON u.id = rp.user_id
        WHERE rp.user_id = $2 AND rp.is_approved AND u.is_active AND (rp.shop_id = $1 OR rp.shop_id IS NULL)`,
      [shopId, riderId],
    )
    return rows[0] ?? null
  }

  async currentAssignment(orderId, client) {
    const { rows } = await run(client)(
      `SELECT da.*, u.name AS rider_name,
              (SELECT t.id FROM order_pickup_tokens t WHERE t.delivery_assignment_id = da.id ORDER BY t.issued_at DESC LIMIT 1) AS token_id,
              (SELECT t.status FROM order_pickup_tokens t WHERE t.delivery_assignment_id = da.id ORDER BY t.issued_at DESC LIMIT 1) AS token_status
         FROM delivery_assignments da JOIN users u ON u.id = da.rider_id
        WHERE da.order_id = $1 AND da.status <> 'CANCELLED' ORDER BY da.created_at DESC LIMIT 1`,
      [orderId],
    )
    return rows[0] ?? null
  }

  /** The live pickup token of the current assignment, for printing the QR. */
  async activePickupToken(orderId) {
    const { rows } = await query(
      `SELECT t.token, t.version FROM order_pickup_tokens t JOIN delivery_assignments da ON da.id = t.delivery_assignment_id
        WHERE t.order_id = $1 AND t.status = 'ACTIVE' AND da.status <> 'CANCELLED' ORDER BY t.issued_at DESC LIMIT 1`,
      [orderId],
    )
    return rows[0] ?? null
  }

  async handover(assignmentId) {
    const { rows } = await query(
      `SELECT h.*, u.name AS staff_name FROM pos_handovers h LEFT JOIN users u ON u.id = h.staff_id WHERE h.assignment_id = $1`,
      [assignmentId],
    )
    return rows[0] ?? null
  }

  async recordHandover(client, { orderId, shopId, assignmentId, riderId, staffId, tokenId, scanResult }) {
    const { rows } = await client.query(
      `INSERT INTO pos_handovers (order_id, shop_id, assignment_id, rider_id, staff_id, token_id, scan_result) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (assignment_id) DO NOTHING RETURNING id`,
      [orderId, shopId, assignmentId, riderId, staffId, tokenId, scanResult],
    )
    return rows[0]?.id ?? null
  }

  // ─── printing ───────────────────────────────────────────────────
  async printers(shopId) {
    const { rows } = await query(`SELECT * FROM pos_printers WHERE shop_id = $1 AND is_active ORDER BY is_default DESC, name`, [shopId])
    return rows
  }

  async printer(shopId, printerId) {
    const { rows } = await query(`SELECT * FROM pos_printers WHERE id = $1 AND shop_id = $2 AND is_active`, [printerId, shopId])
    return rows[0] ?? null
  }

  async defaultPrinter(shopId) {
    const { rows } = await query(`SELECT * FROM pos_printers WHERE shop_id = $1 AND is_active AND is_default LIMIT 1`, [shopId])
    return rows[0] ?? null
  }

  async addPrinter(shopId, { name, paperMm, isDefault }) {
    return withTransaction(async (client) => {
      const count = (await client.query(`SELECT COUNT(*)::int AS n FROM pos_printers WHERE shop_id = $1 AND is_active`, [shopId])).rows[0].n
      const makeDefault = isDefault || count === 0
      if (makeDefault) await client.query(`UPDATE pos_printers SET is_default = FALSE WHERE shop_id = $1 AND is_default`, [shopId])
      const { rows } = await client.query(`INSERT INTO pos_printers (shop_id, name, paper_mm, is_default) VALUES ($1,$2,$3,$4) RETURNING *`, [shopId, name, paperMm, makeDefault])
      return rows[0]
    })
  }

  async updatePrinter(shopId, printerId, { name, paperMm, isDefault }) {
    return withTransaction(async (client) => {
      if (isDefault) await client.query(`UPDATE pos_printers SET is_default = FALSE WHERE shop_id = $1 AND is_default AND id <> $2`, [shopId, printerId])
      const { rows } = await client.query(
        `UPDATE pos_printers SET name = COALESCE($3, name), paper_mm = COALESCE($4, paper_mm), is_default = COALESCE($5, is_default)
          WHERE id = $2 AND shop_id = $1 AND is_active RETURNING *`,
        [shopId, printerId, name ?? null, paperMm ?? null, isDefault ?? null],
      )
      return rows[0] ?? null
    })
  }

  /** Switching a printer off; queued jobs for it go back to "any printer". */
  async removePrinter(shopId, printerId) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(`UPDATE pos_printers SET is_active = FALSE, is_default = FALSE WHERE id = $2 AND shop_id = $1 AND is_active RETURNING id`, [shopId, printerId])
      if (!rows[0]) return false
      await client.query(`UPDATE pos_print_jobs SET printer_id = NULL WHERE printer_id = $1 AND status IN ('QUEUED','FAILED')`, [printerId])
      const next = await client.query(`SELECT id FROM pos_printers WHERE shop_id = $1 AND is_active ORDER BY created_at LIMIT 1`, [shopId])
      if (next.rows[0] && !(await client.query(`SELECT 1 FROM pos_printers WHERE shop_id = $1 AND is_active AND is_default`, [shopId])).rowCount) {
        await client.query(`UPDATE pos_printers SET is_default = TRUE WHERE id = $1`, [next.rows[0].id])
      }
      return true
    })
  }

  async heartbeat(shopId, printerId) {
    const { rowCount } = await query(`UPDATE pos_printers SET last_seen_at = NOW() WHERE id = $1 AND shop_id = $2 AND is_active`, [printerId, shopId])
    return rowCount > 0
  }

  async enqueue(client, { shopId, orderId, printerId, kind, packageNo = null, packageTotal = null, createdBy, reprintOf = null }) {
    const { rows } = await run(client)(
      `INSERT INTO pos_print_jobs (shop_id, order_id, printer_id, kind, package_no, package_total, created_by, reprint_of) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [shopId, orderId, printerId, kind, packageNo, packageTotal, createdBy, reprintOf],
    )
    return rows[0]
  }

  /** A job a station took but never confirmed is a failure, not a success — and not stuck forever. */
  async expireStuckJobs(shopId, seconds) {
    const { rows } = await query(
      `UPDATE pos_print_jobs SET status = 'FAILED', last_error = 'The print station did not confirm in time', updated_at = NOW()
        WHERE shop_id = $1 AND status = 'PRINTING' AND claimed_at < NOW() - make_interval(secs => $2) RETURNING id, order_id`,
      [shopId, seconds],
    )
    return rows
  }

  async jobs(shopId, { status, printerId, orderId, limit = 50 } = {}) {
    const { rows } = await query(
      `SELECT j.*, o.order_number, p.name AS printer_name
         FROM pos_print_jobs j LEFT JOIN orders o ON o.id = j.order_id LEFT JOIN pos_printers p ON p.id = j.printer_id
        WHERE j.shop_id = $1 AND ($2::text IS NULL OR j.status = $2) AND ($3::uuid IS NULL OR j.printer_id = $3 OR j.printer_id IS NULL) AND ($4::uuid IS NULL OR j.order_id = $4)
        ORDER BY j.created_at DESC LIMIT $5`,
      [shopId, status ?? null, printerId ?? null, orderId ?? null, limit],
    )
    return rows
  }

  async job(shopId, jobId) {
    const { rows } = await query(
      `SELECT j.*, o.order_number FROM pos_print_jobs j LEFT JOIN orders o ON o.id = j.order_id WHERE j.id = $1 AND j.shop_id = $2`,
      [jobId, shopId],
    )
    return rows[0] ?? null
  }

  /** Atomic: only one station gets a queued job. */
  async claimJob(shopId, jobId, userId) {
    const { rows } = await query(
      `UPDATE pos_print_jobs SET status = 'PRINTING', attempts = attempts + 1, claimed_by = $3, claimed_at = NOW(), last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND shop_id = $2 AND status = 'QUEUED' RETURNING *`,
      [jobId, shopId, userId],
    )
    return rows[0] ?? null
  }

  async finishJob(shopId, jobId, { ok, error }) {
    const { rows } = await query(
      `UPDATE pos_print_jobs SET status = $3::text, printed_at = CASE WHEN $3::text = 'PRINTED' THEN NOW() ELSE printed_at END, last_error = $4, updated_at = NOW()
        WHERE id = $1 AND shop_id = $2 AND status = 'PRINTING' RETURNING *`,
      [jobId, shopId, ok ? 'PRINTED' : 'FAILED', ok ? null : (error ?? 'Printing failed').slice(0, 300)],
    )
    return rows[0] ?? null
  }

  async requeue(shopId, jobId) {
    const { rows } = await query(`UPDATE pos_print_jobs SET status = 'QUEUED', last_error = NULL, updated_at = NOW() WHERE id = $1 AND shop_id = $2 AND status = 'FAILED' RETURNING *`, [jobId, shopId])
    return rows[0] ?? null
  }

  /** A rider change makes earlier pickup labels worthless: they must not print. */
  async cancelOpenLabels(client, orderId, reason) {
    const { rowCount } = await client.query(
      `UPDATE pos_print_jobs SET status = 'CANCELLED', last_error = $2, updated_at = NOW() WHERE order_id = $1 AND kind = 'LABEL' AND status IN ('QUEUED','FAILED')`,
      [orderId, reason],
    )
    return rowCount
  }

  // ─── documents ──────────────────────────────────────────────────
  async invoiceData(shopId, orderId) {
    const [order, items, shop] = await Promise.all([
      query(
        `SELECT o.order_number, o.created_at, o.subtotal, o.discount_amount, o.delivery_fee, o.platform_fee, o.handling_fee, o.late_night_fee, o.tip_amount, o.tax_amount, o.total_amount,
                o.coupon_code, o.savings_total, o.wallet_amount_used, o.fee_breakdown, o.quick_delivery_surcharge_amount, o.buyer_gstin, o.items,
                o.payment_method, o.payment_status, o.delivery_address, o.delivery_notes, o.scheduled_slot_label
           FROM orders o WHERE o.id = $1 AND o.shop_id = $2`,
        [orderId, shopId],
      ),
      query(`SELECT name, quantity, unit, price, total FROM order_items WHERE order_id = $1 ORDER BY name`, [orderId]),
      query(`SELECT name, address_line1, city, pincode, phone FROM shops WHERE id = $1`, [shopId]),
    ])
    return { order: order.rows[0] ?? null, items: items.rows, shop: shop.rows[0] ?? null }
  }

  // ─── attention (derived live) ───────────────────────────────────
  async attentionSources(shopId, { printerQueuedMin, now }) {
    const nowAt = now
    const [missing, wrong, delays, printFailed, printerOffline, noRider, qr, payment, cancelled, unreleased, resolutions] = await Promise.all([
      query(
        `SELECT l.id AS ref, l.order_id, o.order_number, l.name, l.required_qty - l.picked_qty AS short, l.missing_note, l.missing_at AS since
           FROM pos_lines l JOIN orders o ON o.id = l.order_id WHERE l.shop_id = $1 AND l.status = 'MISSING' AND o.status IN ('CONFIRMED','PREPARING')`,
        [shopId],
      ),
      query(
        `SELECT s.order_id, o.order_number, s.stage, COUNT(*)::int AS n, MIN(s.created_at) AS since
           FROM pos_scans s JOIN orders o ON o.id = s.order_id
          WHERE s.shop_id = $1 AND s.result IN ('WRONG_ITEM','OVER_QTY','NOT_NEEDED') AND s.created_at > $2::timestamptz - interval '30 minutes' AND o.status IN ('CONFIRMED','PREPARING')
          GROUP BY s.order_id, o.order_number, s.stage`,
        [shopId, nowAt],
      ),
      query(
        `SELECT o.id AS order_id, o.order_number,
                CASE WHEN o.status = 'CONFIRMED' THEN 'NEW' WHEN f.stage = 'PACKING' THEN 'PACKING' ELSE 'PICKING' END AS stage,
                CASE WHEN o.status = 'CONFIRMED' THEN COALESCE((SELECT MIN(h.changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'CONFIRMED'), o.created_at)
                     WHEN f.stage = 'PACKING' THEN COALESCE(f.pack_started_at, f.pick_finished_at)
                     ELSE COALESCE(f.pick_started_at, o.updated_at) END AS since
           FROM orders o LEFT JOIN pos_fulfillments f ON f.order_id = o.id
          WHERE o.shop_id = $1 AND o.status IN ('CONFIRMED','PREPARING')`,
        [shopId],
      ),
      query(
        `SELECT j.id AS ref, j.order_id, o.order_number, j.kind, j.last_error, j.updated_at AS since
           FROM pos_print_jobs j LEFT JOIN orders o ON o.id = j.order_id WHERE j.shop_id = $1 AND j.status = 'FAILED' AND j.created_at > $2::timestamptz - interval '1 day'`,
        [shopId, nowAt],
      ),
      query(
        `SELECT j.id AS ref, j.order_id, o.order_number, j.created_at AS since, p.name AS printer_name, p.last_seen_at
           FROM pos_print_jobs j LEFT JOIN orders o ON o.id = j.order_id LEFT JOIN pos_printers p ON p.id = COALESCE(j.printer_id, (SELECT d.id FROM pos_printers d WHERE d.shop_id = j.shop_id AND d.is_default AND d.is_active LIMIT 1))
          WHERE j.shop_id = $1 AND j.status = 'QUEUED' AND j.created_at < $3::timestamptz - make_interval(mins => $2)`,
        [shopId, printerQueuedMin, nowAt],
      ),
      query(
        `SELECT o.id AS order_id, o.order_number, COALESCE(f.pack_finished_at, o.updated_at) AS since
           FROM orders o LEFT JOIN pos_fulfillments f ON f.order_id = o.id
          WHERE o.shop_id = $1 AND o.status = 'PACKED' AND NOT EXISTS (SELECT 1 FROM delivery_assignments d WHERE d.order_id = o.id AND d.status <> 'CANCELLED')`,
        [shopId],
      ),
      query(
        `SELECT q.id AS ref, q.order_id, o.order_number, q.failure_reason, q.scanned_at AS since
           FROM qr_scan_logs q JOIN orders o ON o.id = q.order_id
          WHERE o.shop_id = $1 AND q.result = 'REJECTED' AND q.scanned_at > $2::timestamptz - interval '1 hour' AND o.status IN ('PACKED','OUT_FOR_DELIVERY')`,
        [shopId, nowAt],
      ),
      query(
        `SELECT o.id AS order_id, o.order_number, o.payment_status, o.updated_at AS since FROM orders o
          WHERE o.shop_id = $1 AND o.status IN ('CONFIRMED','PREPARING','PACKED') AND o.payment_status = 'FAILED'`,
        [shopId],
      ),
      query(
        `SELECT o.id AS order_id, o.order_number, o.updated_at AS since, f.stage FROM orders o JOIN pos_fulfillments f ON f.order_id = o.id
          WHERE o.shop_id = $1 AND o.status = 'CANCELLED' AND f.stage <> 'DONE' AND f.pick_started_at IS NOT NULL AND o.updated_at > $2::timestamptz - interval '2 hours'`,
        [shopId, nowAt],
      ),
      query(
        `SELECT o.id AS order_id, o.order_number, da.id AS ref, da.picked_up_at AS since FROM orders o JOIN delivery_assignments da ON da.order_id = o.id
          WHERE o.shop_id = $1 AND da.status IN ('PICKED_UP','IN_TRANSIT','DELIVERED') AND da.picked_up_at > $2::timestamptz - interval '1 day'
            AND NOT EXISTS (SELECT 1 FROM pos_handovers h WHERE h.assignment_id = da.id)`,
        [shopId, nowAt],
      ),
      query(`SELECT order_id, kind, ref FROM pos_attention_resolutions WHERE shop_id = $1`, [shopId]),
    ])
    return { missing: missing.rows, wrong: wrong.rows, delays: delays.rows, printFailed: printFailed.rows, printerOffline: printerOffline.rows, noRider: noRider.rows, qr: qr.rows, payment: payment.rows, cancelled: cancelled.rows, unreleased: unreleased.rows, resolutions: resolutions.rows }
  }

  async resolveAttention(client, { shopId, orderId, kind, ref, note, userId }) {
    const { rows } = await run(client)(
      `INSERT INTO pos_attention_resolutions (shop_id, order_id, kind, ref, note, resolved_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (order_id, kind, ref) DO NOTHING RETURNING id`,
      [shopId, orderId, kind, ref ?? '', note ?? null, userId],
    )
    return rows[0]?.id ?? null
  }

  // ─── timeline & performance ─────────────────────────────────────
  async timeline(shopId, orderId) {
    const [events, history, scans] = await Promise.all([
      query(`SELECT e.kind, e.detail, e.created_at AS at, u.name AS actor FROM pos_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.order_id = $1 AND e.shop_id = $2`, [orderId, shopId]),
      query(`SELECT h.from_status, h.to_status, h.note, h.changed_at AS at, u.name AS actor FROM order_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.order_id = $1`, [orderId]),
      query(`SELECT q.result, q.failure_reason, q.scanned_at AS at, u.name AS actor FROM qr_scan_logs q LEFT JOIN users u ON u.id = q.rider_id WHERE q.order_id = $1`, [orderId]),
    ])
    return { events: events.rows, history: history.rows, qr: scans.rows }
  }

  async performance(shopId, start, end) {
    const p = [shopId, start, end]
    const [picks, packs, scans, missing, riderWait, reassigned, handovers] = await Promise.all([
      query(
        `SELECT f.picker_id AS user_id, u.name, COUNT(*)::int AS orders, AVG(EXTRACT(EPOCH FROM (f.pick_finished_at - f.pick_started_at)) / 60)::float8 AS avg_minutes,
                COALESCE(array_agg(EXTRACT(EPOCH FROM (f.pick_finished_at - f.pick_started_at)) / 60), '{}') AS minutes
           FROM pos_fulfillments f LEFT JOIN users u ON u.id = f.picker_id
          WHERE f.shop_id = $1 AND f.pick_finished_at >= $2 AND f.pick_finished_at < $3 AND f.pick_started_at IS NOT NULL GROUP BY f.picker_id, u.name`,
        p,
      ),
      query(
        `SELECT f.packer_id AS user_id, u.name, COUNT(*)::int AS orders, AVG(EXTRACT(EPOCH FROM (f.pack_finished_at - f.pack_started_at)) / 60)::float8 AS avg_minutes,
                COALESCE(array_agg(EXTRACT(EPOCH FROM (f.pack_finished_at - f.pack_started_at)) / 60), '{}') AS minutes
           FROM pos_fulfillments f LEFT JOIN users u ON u.id = f.packer_id
          WHERE f.shop_id = $1 AND f.pack_finished_at >= $2 AND f.pack_finished_at < $3 AND f.pack_started_at IS NOT NULL GROUP BY f.packer_id, u.name`,
        p,
      ),
      query(
        `SELECT s.user_id, u.name,
                COUNT(*) FILTER (WHERE s.result IN ('OK'))::int AS ok, COUNT(*) FILTER (WHERE s.result = 'MANUAL')::int AS manual,
                COUNT(*) FILTER (WHERE s.result IN ('WRONG_ITEM','OVER_QTY','NOT_NEEDED'))::int AS mistakes
           FROM pos_scans s LEFT JOIN users u ON u.id = s.user_id WHERE s.shop_id = $1 AND s.created_at >= $2 AND s.created_at < $3 GROUP BY s.user_id, u.name`,
        p,
      ),
      query(
        `SELECT l.missing_by AS user_id, u.name, COUNT(*)::int AS n FROM pos_lines l LEFT JOIN users u ON u.id = l.missing_by
          WHERE l.shop_id = $1 AND l.missing_at >= $2 AND l.missing_at < $3 GROUP BY l.missing_by, u.name`,
        p,
      ),
      query(
        `SELECT (EXTRACT(EPOCH FROM (da.picked_up_at - f.pack_finished_at)) / 60)::float8 AS minutes
           FROM pos_fulfillments f JOIN delivery_assignments da ON da.order_id = f.order_id AND da.status <> 'CANCELLED'
          WHERE f.shop_id = $1 AND f.pack_finished_at >= $2 AND f.pack_finished_at < $3 AND da.picked_up_at IS NOT NULL`,
        p,
      ),
      query(
        `SELECT COUNT(*)::int AS n FROM delivery_assignments da JOIN orders o ON o.id = da.order_id
          WHERE o.shop_id = $1 AND da.status = 'CANCELLED' AND da.cancel_reason LIKE 'Reassigned%' AND da.cancelled_at >= $2 AND da.cancelled_at < $3`,
        p,
      ),
      query(
        `SELECT h.staff_id AS user_id, u.name, COUNT(*)::int AS n FROM pos_handovers h LEFT JOIN users u ON u.id = h.staff_id
          WHERE h.shop_id = $1 AND h.created_at >= $2 AND h.created_at < $3 GROUP BY h.staff_id, u.name`,
        p,
      ),
    ])
    return { picks: picks.rows, packs: packs.rows, scans: scans.rows, missing: missing.rows, riderWait: riderWait.rows.map((r) => r.minutes), reassigned: reassigned.rows[0].n, handovers: handovers.rows }
  }
}
