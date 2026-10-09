import { PosError } from './errors.js'
import { withTransaction } from './pos.repository.js'
import {
  ATTENTION_KINDS, boardLane, canRetry, canTakeRole, isEmptyPackage, isResolved, laneSince, LANES, matchScan, mergeTimeline, median, minutesBetween,
  packBlockers, packTarget, parsePosRange, pickBlockers, posAbilities, printerOnline, remaining, sortAttention, STATIONS, THRESHOLD_MINUTES,
  PRINT_STUCK_SECONDS, MAX_PRINT_ATTEMPTS,
} from './pos.rules.js'
import { buildOrderBill } from '../../utils/orderBill.js'
import { renderInvoice, renderLabel, renderTest, deliveryArea } from './pos.print.js'

const LANE_LABEL = Object.fromEntries(LANES.map((l) => [l.id, l.label]))

/**
 * Store Fulfillment POS (Phase 11): pick → scan → pack → verify → print → rider → QR handover.
 *
 * It does not replace the order system, it drives it:
 *   - order status moves (CONFIRMED → PREPARING → PACKED) go through the existing ShopOrdersService
 *   - a rider is assigned through FinalizeAssignmentService (the only writer that mints pickup tokens)
 *   - the rider's QR scan stays on the rider side; the store records the handover next to it
 * Every action is shop-scoped, checked against the person's role + station, and written to the audit trail.
 */
export class PosService {
  /**
   * @param {{ repo: import('./pos.repository.js').PosRepository, shopOrders: { transition: Function },
   *           finalize: { finalize: Function }, emit: (shopId: string, payload: object) => void, logger: object, now?: () => Date }} deps
   */
  constructor({ repo, shopOrders, finalize, emit, logger, now = () => new Date() }) {
    Object.assign(this, { repo, shopOrders, finalize, emit, logger, now })
  }

  // ─── access ─────────────────────────────────────────────────────
  /** @returns {Promise<{ userId: string, shopId: string, name: string, abilities: object, station: string|null, shopRole: string|null }>} */
  async access(userId, shopId, need) {
    const who = await this.repo.loadAccess(userId, shopId)
    if (!who) throw new PosError('Not signed in as an active user.', 403, 'FORBIDDEN')
    const abilities = posAbilities({ hqRole: who.platform_role, shopRole: who.shop_role, station: who.pos_station })
    const ctx = { userId, shopId, name: who.name, abilities, station: who.pos_station ?? null, shopRole: who.shop_role ?? null, hqRole: who.platform_role ?? null }
    if (need) {
      const needs = Array.isArray(need) ? need : [need]
      if (!needs.some((n) => abilities[n])) throw new PosError('Your role does not allow this.', 403, 'FORBIDDEN')
    }
    return ctx
  }

  async me(userId, shopId) {
    const c = await this.access(userId, shopId)
    return { userId, shopId, name: c.name, shopRole: c.shopRole, station: c.station, isHq: Boolean(c.hqRole), abilities: c.abilities }
  }

  // ─── the live board ─────────────────────────────────────────────
  async board(userId, shopId) {
    await this.access(userId, shopId, 'view')
    const now = this.now()
    await this.repo.expireStuckJobs(shopId, PRINT_STUCK_SECONDS)
    const [rows, delivered, printers, jobs] = await Promise.all([
      this.repo.boardOrders(shopId),
      this.repo.deliveredSince(shopId, new Date(now.getTime() - 24 * 3_600_000)),
      this.repo.printers(shopId),
      this.repo.jobs(shopId, { limit: 200 }),
    ])

    const lanes = LANES.map((l) => ({ ...l, orders: [] }))
    for (const r of rows) {
      const lane = boardLane({ orderStatus: r.status, stage: r.stage, assignmentStatus: r.assignment_status, hasRider: Boolean(r.assignment_id) })
      if (!lane) continue
      const since = laneSince(lane, {
        createdAt: r.created_at, confirmedAt: r.confirmed_at, pickStartedAt: r.pick_started_at, pickFinishedAt: r.pick_finished_at, packStartedAt: r.pack_started_at,
        packFinishedAt: r.pack_finished_at, assignedAt: r.assigned_at, pickedUpAt: r.picked_up_at, updatedAt: r.updated_at,
      })
      const minutes = minutesBetween(since, now)
      const limit = { NEW: THRESHOLD_MINUTES.NEW, PICKING: THRESHOLD_MINUTES.PICKING, PACKING: THRESHOLD_MINUTES.PACKING, READY: THRESHOLD_MINUTES.NO_RIDER }[lane]
      lanes.find((l) => l.id === lane).orders.push({
        id: r.id,
        orderNumber: r.order_number,
        lane,
        since,
        waitingMinutes: minutes,
        late: limit != null && minutes != null && minutes >= limit,
        items: { lines: r.item_lines, units: r.item_units },
        picker: r.picker_id ? { id: r.picker_id, name: r.picker_name } : null,
        packer: r.packer_id ? { id: r.packer_id, name: r.packer_name } : null,
        rider: r.assignment_id ? { name: r.rider_name, assignment: r.assignment_status, pickup: r.token_status } : null,
        area: deliveryArea(r.delivery_address),
        slot: r.delivery_mode === 'SCHEDULED' ? r.scheduled_slot_label : null,
        packages: r.package_count ?? 1,
        progress: r.pos_lines > 0 ? { done: r.settled_lines, total: r.pos_lines } : null,
        flags: { missing: r.missing_lines > 0, printFailed: r.failed_prints > 0, paymentFailed: r.payment_status === 'FAILED' },
      })
    }
    for (const l of lanes) l.orders.sort((a, b) => (b.waitingMinutes ?? 0) - (a.waitingMinutes ?? 0))

    const queued = jobs.filter((j) => j.status === 'QUEUED' || j.status === 'PRINTING').length
    const failed = jobs.filter((j) => j.status === 'FAILED').length
    return {
      lanes,
      deliveredLast24h: delivered,
      printing: { printers: printers.length, online: printers.filter((p) => printerOnline(p.last_seen_at, now)).length, queued, failed },
      totals: { active: lanes.reduce((n, l) => n + l.orders.length, 0), late: lanes.reduce((n, l) => n + l.orders.filter((o) => o.late).length, 0) },
    }
  }

  // ─── one order ──────────────────────────────────────────────────
  async detail(userId, shopId, orderId) {
    const ctx = await this.access(userId, shopId, 'view')
    const order = await this.mustOrder(shopId, orderId)
    const [f, lines, assignment, jobs] = await Promise.all([
      this.repo.fulfillment(orderId),
      this.repo.lines(orderId),
      this.repo.currentAssignment(orderId),
      this.repo.jobs(shopId, { orderId, limit: 20 }),
    ])
    const handover = assignment ? await this.repo.handover(assignment.id) : null
    const names = await this.peopleNames([f?.picker_id, f?.packer_id])
    // Money only — same itemised bill as the printed slip; no customer details (agreement §12).
    const billData = await this.repo.invoiceData(shopId, orderId)
    const bill = billData.order ? buildOrderBill({ ...billData.order, items: billData.items }) : null
    const lane = boardLane({ orderStatus: order.status, stage: f?.stage, assignmentStatus: assignment?.status, hasRider: Boolean(assignment) })
    const mine = (id) => !id || id === userId || ctx.abilities.manage

    return {
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      lane,
      laneLabel: lane ? LANE_LABEL[lane] : null,
      paymentStatus: order.payment_status,
      area: deliveryArea(order.delivery_address),
      notes: order.delivery_notes ?? null,
      slot: order.delivery_mode === 'SCHEDULED' ? order.scheduled_slot_label : null,
      createdAt: order.created_at,
      fulfillment: f && {
        stage: f.stage,
        picker: f.picker_id ? { id: f.picker_id, name: names.get(f.picker_id) } : null,
        packer: f.packer_id ? { id: f.packer_id, name: names.get(f.packer_id) } : null,
        pickStartedAt: f.pick_started_at, pickFinishedAt: f.pick_finished_at, packStartedAt: f.pack_started_at, packFinishedAt: f.pack_finished_at, packages: f.package_count,
      },
      lines: lines.map((l) => ({
        id: l.id, name: l.name, unit: l.unit, imageUrl: l.image_url, barcode: l.barcode, sku: l.sku, required: l.required_qty, picked: l.picked_qty, packed: l.packed_qty,
        packTarget: packTarget(l), status: l.status, missingNote: l.missing_note, decision: l.decision, decisionNote: l.decision_note,
      })),
      blockers: { pick: pickBlockers(lines), pack: packBlockers(lines) },
      rider: assignment && { name: assignment.rider_name, id: assignment.rider_id, assignment: assignment.status, pickup: assignment.token_status, assignedAt: assignment.assigned_at, pickedUpAt: assignment.picked_up_at },
      handover: handover && { by: handover.staff_name, at: handover.created_at, scan: handover.scan_result },
      printJobs: jobs.map(publicJob),
      bill,
      can: this.canDo(ctx, order, f, lines, assignment, mine),
    }
  }

  /** What the screen may offer right now — the same checks the actions enforce, so buttons and rules never disagree. */
  canDo(ctx, order, f, lines, assignment, mine) {
    const a = ctx.abilities
    const s = order.status
    const picking = s === 'PREPARING' && f?.stage === 'PICKING' && f.pick_started_at
    const packing = s === 'PREPARING' && f?.stage === 'PACKING'
    return {
      assignPeople: a.manage && ['CONFIRMED', 'PREPARING'].includes(s),
      startPick: a.pick && (s === 'CONFIRMED' || (s === 'PREPARING' && !f?.pick_started_at)) && mine(f?.picker_id) && order.payment_status !== 'FAILED',
      pick: a.pick && Boolean(picking) && mine(f?.picker_id),
      finishPick: a.pick && Boolean(picking) && mine(f?.picker_id) && pickBlockers(lines).length === 0,
      decideMissing: a.manage && ['CONFIRMED', 'PREPARING'].includes(s),
      startPack: a.pack && packing && !f?.pack_started_at && mine(f?.packer_id),
      pack: a.pack && packing && Boolean(f?.pack_started_at) && mine(f?.packer_id),
      finishPack: a.pack && packing && Boolean(f?.pack_started_at) && mine(f?.packer_id) && packBlockers(lines).length === 0 && !isEmptyPackage(lines),
      assignRider: a.manage && s === 'PACKED',
      handover: a.handover && assignment != null && ['PACKED', 'OUT_FOR_DELIVERY'].includes(s),
      reprint: a.reprint || a.manage,
    }
  }

  // ─── people ─────────────────────────────────────────────────────
  async assignPerson(userId, shopId, orderId, { role, userId: target }) {
    await this.access(userId, shopId, 'manage')
    const order = await this.activeOrder(shopId, orderId, ['CONFIRMED', 'PREPARING'])
    const staff = await this.repo.staffMember(shopId, target)
    if (!staff) throw new PosError('That person is not on this store’s team.', 404, 'STAFF_NOT_FOUND')
    if (!canTakeRole(staff, role)) throw new PosError(`${staff.name} is not set up as a ${role.toLowerCase()}.`, 409, 'WRONG_STATION')
    await withTransaction(async (client) => {
      const f = await this.repo.ensureFulfillment(client, orderId, shopId)
      if (role === 'PICKER' && f.pick_finished_at) throw new PosError('Picking is already finished.', 409, 'STAGE_PASSED')
      if (role === 'PACKER' && f.pack_finished_at) throw new PosError('Packing is already finished.', 409, 'STAGE_PASSED')
      await this.repo.setPerson(client, orderId, role, target)
      await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: role === 'PICKER' ? 'PICK_ASSIGNED' : 'PACK_ASSIGNED', detail: { userId: target, name: staff.name } })
    })
    this.notify(shopId, orderId, 'assigned')
    return this.detail(userId, shopId, order.id)
  }

  async staff(userId, shopId) {
    await this.access(userId, shopId, 'manage')
    return this.repo.staff(shopId)
  }

  async setStation(userId, shopId, targetId, station) {
    await this.access(userId, shopId, 'manage')
    if (station !== null && !STATIONS.includes(station)) throw new PosError('Station must be PICKER, PACKER or none.', 400, 'VALIDATION')
    const target = await this.repo.staffMember(shopId, targetId)
    if (!target) throw new PosError('That person is not on this store’s team.', 404, 'STAFF_NOT_FOUND')
    if (target.role !== 'SHOP_STAFF') throw new PosError('Stations are for staff members; managers and admins can do every job.', 409, 'NOT_STAFF')
    await this.repo.setStation(shopId, targetId, station)
    return this.repo.staff(shopId)
  }

  // ─── picking ────────────────────────────────────────────────────
  async startPick(userId, shopId, orderId) {
    const ctx = await this.access(userId, shopId, 'pick')
    let order = await this.mustOrder(shopId, orderId)
    if (!['CONFIRMED', 'PREPARING'].includes(order.status)) throw this.notActive(order)
    if (order.payment_status === 'FAILED') throw new PosError('Payment failed for this order — it should not be prepared.', 409, 'PAYMENT_PROBLEM')
    const existing = await this.repo.fulfillment(orderId)
    this.assertOwner(ctx, existing?.picker_id, 'picking')
    if (existing?.pick_started_at) return this.detail(userId, shopId, orderId) // already started: idempotent

    // The order's own status is the authority, so it moves first; the POS record follows and can be retried.
    if (order.status === 'CONFIRMED') await this.shopOrders.transition(shopId, orderId, 'PREPARING', this.actor(ctx))
    const count = await withTransaction(async (client) => {
      await this.repo.ensureFulfillment(client, orderId, shopId)
      await this.repo.createLines(client, orderId, shopId)
      await this.repo.startPick(client, orderId, userId)
      const n = (await this.repo.lines(orderId, client)).length
      await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: 'PICK_STARTED', detail: { lines: n } })
      return n
    })
    if (count === 0) this.logger.warn({ orderId }, 'POS: order has no items to pick')
    this.notify(shopId, orderId, 'pick_started')
    return this.detail(userId, shopId, orderId)
  }

  /**
   * A scan (barcode scanners type like a keyboard). A wrong scan is refused with a clear message and counted —
   * never silently accepted.
   */
  async scan(userId, shopId, orderId, { stage, code }) {
    const ctx = await this.access(userId, shopId, stage === 'PICK' ? 'pick' : 'pack')
    await this.workable(ctx, orderId, stage)
    const lines = await this.repo.lines(orderId)
    const { result, line } = matchScan(lines, code, stage)

    if (result !== 'OK') {
      await withTransaction(async (client) => {
        await this.repo.logScan(client, { shopId, orderId, lineId: line?.id, stage, code, result, userId })
        await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: 'SCAN_REJECTED', detail: { code: String(code).slice(0, 40), result, stage, name: line?.name } })
      })
      this.notify(shopId, orderId, 'scan_rejected')
      throw new PosError(SCAN_MESSAGE[result](line), 409, result, { line: line && { id: line.id, name: line.name } })
    }

    const updated = await withTransaction(async (client) => {
      const row = stage === 'PICK' ? await this.repo.addPicked(client, line.id, 1) : await this.repo.addPacked(client, line.id, packTarget(line), 1)
      if (!row) return null // lost a race with another scan of the last unit
      await this.repo.logScan(client, { shopId, orderId, lineId: line.id, stage, code, result: 'OK', userId })
      await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: 'ITEM_SCANNED', detail: { name: line.name, stage, qty: stage === 'PICK' ? row.picked_qty : row.packed_qty } })
      return row
    })
    if (!updated) throw new PosError('That item was just completed.', 409, 'OVER_QTY', { line: { id: line.id, name: line.name } })
    this.notify(shopId, orderId, 'scanned')
    return { ok: true, line: { id: updated.id, name: updated.name, required: updated.required_qty, picked: updated.picked_qty, packed: updated.packed_qty, status: updated.status } }
  }

  /** Confirm by hand — for items without a barcode. Logged as MANUAL so it shows up in the performance numbers. */
  async confirmLine(userId, shopId, orderId, lineId, { stage, qty = 1 }) {
    const ctx = await this.access(userId, shopId, stage === 'PICK' ? 'pick' : 'pack')
    await this.workable(ctx, orderId, stage)
    const line = await this.repo.line(orderId, lineId)
    if (!line) throw new PosError('Item not found on this order.', 404, 'LINE_NOT_FOUND')
    const need = remaining(line, stage)
    if (need <= 0) throw new PosError('That item is already complete.', 409, 'OVER_QTY')
    const by = Math.min(Math.max(1, Math.floor(qty)), need)
    const row = await withTransaction(async (client) => {
      const r = stage === 'PICK' ? await this.repo.addPicked(client, lineId, by) : await this.repo.addPacked(client, lineId, packTarget(line), by)
      if (!r) return null
      await this.repo.logScan(client, { shopId, orderId, lineId, stage, code: null, result: 'MANUAL', userId })
      await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: 'ITEM_CONFIRMED', detail: { name: line.name, stage, qty: by } })
      return r
    })
    if (!row) throw new PosError('That item just changed — refresh and try again.', 409, 'CONFLICT')
    this.notify(shopId, orderId, 'confirmed')
    return { ok: true, line: { id: row.id, name: row.name, required: row.required_qty, picked: row.picked_qty, packed: row.packed_qty, status: row.status } }
  }

  /** The picker reports it; a manager decides what happens next (agreement §11). */
  async reportMissing(userId, shopId, orderId, lineId, { note }) {
    const ctx = await this.access(userId, shopId, 'pick')
    await this.workable(ctx, orderId, 'PICK')
    const text = String(note ?? '').trim().slice(0, 300)
    const line = await this.repo.line(orderId, lineId)
    if (!line) throw new PosError('Item not found on this order.', 404, 'LINE_NOT_FOUND')
    const row = await withTransaction(async (client) => {
      const r = await this.repo.markMissing(client, lineId, { note: text || null, userId })
      if (!r) return null
      await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: 'ITEM_MISSING', detail: { name: line.name, short: r.required_qty - r.picked_qty, note: text } })
      return r
    })
    if (!row) throw new PosError('That item is already reported or finished.', 409, 'CONFLICT')
    this.notify(shopId, orderId, 'missing')
    return this.detail(userId, shopId, orderId)
  }

  async decideMissing(userId, shopId, orderId, lineId, { decision, note }) {
    await this.access(userId, shopId, 'manage')
    await this.activeOrder(shopId, orderId, ['CONFIRMED', 'PREPARING'])
    const line = await this.repo.line(orderId, lineId)
    if (!line) throw new PosError('Item not found on this order.', 404, 'LINE_NOT_FOUND')
    const text = String(note ?? '').trim().slice(0, 300)
    if (decision === 'REPLACE' && !text) throw new PosError('Say what replaces it (e.g. the product and size).', 400, 'VALIDATION', { note: 'Required for a replacement' })
    const row = await withTransaction(async (client) => {
      const r = await this.repo.decide(client, lineId, { decision, note: text || null, userId })
      if (!r) return null
      await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: 'MISSING_DECIDED', detail: { name: line.name, decision, note: text } })
      return r
    })
    if (!row) throw new PosError('That item is not waiting for a decision.', 409, 'CONFLICT')
    this.notify(shopId, orderId, 'decided')
    return this.detail(userId, shopId, orderId)
  }

  async finishPick(userId, shopId, orderId) {
    const ctx = await this.access(userId, shopId, 'pick')
    await this.workable(ctx, orderId, 'PICK')
    const lines = await this.repo.lines(orderId)
    const blockers = pickBlockers(lines)
    if (blockers.length) throw new PosError(`${blockers.length} item${blockers.length === 1 ? ' is' : 's are'} not finished yet.`, 409, 'PICK_INCOMPLETE', { blockers })
    await withTransaction(async (client) => {
      await this.repo.finishPick(client, orderId)
      await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: 'PICK_FINISHED', detail: { verified: lines.filter((l) => l.status === 'PICKED').length } })
    })
    this.notify(shopId, orderId, 'pick_finished')
    return this.detail(userId, shopId, orderId)
  }

  // ─── packing ────────────────────────────────────────────────────
  async startPack(userId, shopId, orderId) {
    const ctx = await this.access(userId, shopId, 'pack')
    const order = await this.mustOrder(shopId, orderId)
    if (order.status !== 'PREPARING') throw this.notActive(order)
    const f = await this.repo.fulfillment(orderId)
    if (f?.stage !== 'PACKING') throw new PosError('Picking is not finished yet.', 409, 'WRONG_STAGE')
    this.assertOwner(ctx, f.packer_id, 'packing')
    if (f.pack_started_at) return this.detail(userId, shopId, orderId)
    await withTransaction(async (client) => {
      await this.repo.startPack(client, orderId, userId)
      await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: 'PACK_STARTED' })
    })
    this.notify(shopId, orderId, 'pack_started')
    return this.detail(userId, shopId, orderId)
  }

  /**
   * Final store-side check. Needs every line verified; moves the order to PACKED and queues the invoice for the
   * store printer. (Pickup labels print when a rider is assigned — the QR belongs to one rider.)
   */
  async finishPack(userId, shopId, orderId, { packageCount = 1 } = {}) {
    const ctx = await this.access(userId, shopId, 'pack')
    const order = await this.mustOrder(shopId, orderId)
    if (!['PREPARING', 'PACKED'].includes(order.status)) throw this.notActive(order)
    const f = await this.repo.fulfillment(orderId)
    if (f?.stage === 'DONE') return this.detail(userId, shopId, orderId) // idempotent
    if (f?.stage !== 'PACKING' || !f.pack_started_at) throw new PosError('Start packing first.', 409, 'WRONG_STAGE')
    this.assertOwner(ctx, f.packer_id, 'packing')
    const lines = await this.repo.lines(orderId)
    const blockers = packBlockers(lines)
    if (blockers.length) throw new PosError(`${blockers.length} item${blockers.length === 1 ? ' is' : 's are'} not verified yet.`, 409, 'PACK_INCOMPLETE', { blockers })
    if (isEmptyPackage(lines)) throw new PosError('Every item was removed — there is nothing to pack. Ask a manager to cancel or refund the order.', 409, 'NOTHING_TO_PACK')
    const packages = Math.min(20, Math.max(1, Math.floor(Number(packageCount) || 1)))

    if (order.status === 'PREPARING') await this.shopOrders.transition(shopId, orderId, 'PACKED', this.actor(ctx))
    const printer = await this.repo.defaultPrinter(shopId)
    await withTransaction(async (client) => {
      await this.repo.finishPack(client, orderId, packages)
      await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: 'PACK_FINISHED', detail: { packages } })
      const job = await this.repo.enqueue(client, { shopId, orderId, printerId: printer?.id ?? null, kind: 'INVOICE', createdBy: userId })
      await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: 'PRINT_QUEUED', detail: { kind: 'INVOICE', jobId: job.id } })
    })
    this.notify(shopId, orderId, 'packed')
    this.notify(shopId, orderId, 'print')
    return this.detail(userId, shopId, orderId)
  }

  // ─── rider & handover ───────────────────────────────────────────
  async riders(userId, shopId) {
    await this.access(userId, shopId, 'view')
    const rows = await this.repo.riders(shopId)
    return rows.map((r) => ({ id: r.id, name: r.name, vehicle: r.vehicle_type, ...riderState(r, shopId) }))
  }

  /** Assign (or re-assign) the rider for a packed order. The previous rider's QR stops working at once. */
  async assignRider(userId, shopId, orderId, riderId) {
    await this.access(userId, shopId, 'manage')
    const order = await this.mustOrder(shopId, orderId)
    if (order.status !== 'PACKED') throw new PosError(order.status === 'OUT_FOR_DELIVERY' ? 'The order has already left the store.' : 'The order must be packed before a rider is assigned.', 409, 'WRONG_STAGE')
    const rider = await this.repo.rider(shopId, riderId)
    if (!rider) throw new PosError('That rider is not available to this store.', 404, 'RIDER_NOT_FOUND')
    const before = await this.repo.currentAssignment(orderId)
    if (before?.picked_up_at) throw new PosError('The rider has already collected this order.', 409, 'ALREADY_PICKED_UP')

    const res = await this.finalize.finalize(orderId, { riderId, method: 'MANUAL', reason: 'Assigned from the store POS', triggeredBy: userId })
    if (!res?.success) throw new PosError(RIDER_FAIL[res?.reason] ?? 'The rider could not be assigned.', 409, res?.reason ?? 'ASSIGN_FAILED')
    if (res.unchanged) return this.detail(userId, shopId, orderId)

    const f = await this.repo.fulfillment(orderId)
    const printer = await this.repo.defaultPrinter(shopId)
    const packages = f?.package_count ?? 1
    await withTransaction(async (client) => {
      const cancelled = await this.repo.cancelOpenLabels(client, orderId, 'Rider changed — this label’s QR is no longer valid')
      await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: 'RIDER_ASSIGNED', detail: { riderId, riderName: rider.name, previousRiderName: before?.rider_name ?? null, labelsCancelled: cancelled } })
      for (let n = 1; n <= packages; n++) {
        const job = await this.repo.enqueue(client, { shopId, orderId, printerId: printer?.id ?? null, kind: 'LABEL', packageNo: n, packageTotal: packages, createdBy: userId })
        await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: 'PRINT_QUEUED', detail: { kind: 'LABEL', jobId: job.id, packageNo: n } })
      }
    })
    this.notify(shopId, orderId, 'rider')
    this.notify(shopId, orderId, 'print')
    return this.detail(userId, shopId, orderId)
  }

  /**
   * The store releases the package. The rider must already have scanned the pickup QR — a handover without a
   * verified scan would defeat the point. Recorded once per assignment.
   */
  async handover(userId, shopId, orderId) {
    await this.access(userId, shopId, 'handover')
    const order = await this.mustOrder(shopId, orderId)
    if (!['PACKED', 'OUT_FOR_DELIVERY'].includes(order.status)) throw this.notActive(order)
    const a = await this.repo.currentAssignment(orderId)
    if (!a) throw new PosError('No rider is assigned to this order.', 409, 'NO_RIDER')
    const existing = await this.repo.handover(a.id)
    if (existing) return this.detail(userId, shopId, orderId) // already released: idempotent
    if (!['VERIFIED', 'CONSUMED'].includes(a.token_status)) {
      throw new PosError(a.token_status === 'ACTIVE' ? `${a.rider_name} has not scanned the package QR yet.` : 'The pickup QR is no longer valid — assign the rider again.', 409, a.token_status === 'ACTIVE' ? 'NOT_SCANNED' : 'NO_VALID_PICKUP')
    }
    await withTransaction(async (client) => {
      const id = await this.repo.recordHandover(client, { orderId, shopId, assignmentId: a.id, riderId: a.rider_id, staffId: userId, tokenId: a.token_id, scanResult: a.token_status })
      if (id) await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: 'HANDOVER', detail: { riderId: a.rider_id, riderName: a.rider_name, scan: a.token_status } })
    })
    this.notify(shopId, orderId, 'handover')
    return this.detail(userId, shopId, orderId)
  }

  // ─── printers & the print queue ─────────────────────────────────
  async printers(userId, shopId) {
    await this.access(userId, shopId, ['view'])
    const now = this.now()
    return (await this.repo.printers(shopId)).map((p) => ({ id: p.id, name: p.name, paperMm: p.paper_mm, isDefault: p.is_default, lastSeenAt: p.last_seen_at, online: printerOnline(p.last_seen_at, now) }))
  }

  async addPrinter(userId, shopId, input) {
    await this.access(userId, shopId, 'manage')
    try {
      await this.repo.addPrinter(shopId, { name: input.name.trim(), paperMm: input.paperMm ?? 80, isDefault: Boolean(input.isDefault) })
    } catch (err) {
      if (err.code === '23505') throw new PosError('A printer with that name already exists.', 409, 'DUPLICATE_PRINTER', { name: 'Already used' })
      throw err
    }
    return this.printers(userId, shopId)
  }

  async updatePrinter(userId, shopId, printerId, input) {
    await this.access(userId, shopId, 'manage')
    let row
    try {
      row = await this.repo.updatePrinter(shopId, printerId, { name: input.name?.trim(), paperMm: input.paperMm, isDefault: input.isDefault })
    } catch (err) {
      if (err.code === '23505') throw new PosError('A printer with that name already exists.', 409, 'DUPLICATE_PRINTER', { name: 'Already used' })
      throw err
    }
    if (!row) throw new PosError('Printer not found.', 404, 'PRINTER_NOT_FOUND')
    return this.printers(userId, shopId)
  }

  async removePrinter(userId, shopId, printerId) {
    await this.access(userId, shopId, 'manage')
    if (!(await this.repo.removePrinter(shopId, printerId))) throw new PosError('Printer not found.', 404, 'PRINTER_NOT_FOUND')
    return this.printers(userId, shopId)
  }

  /** A print station (a browser tab at the printer) says "I'm here". Silence = offline. */
  async heartbeat(userId, shopId, printerId) {
    await this.access(userId, shopId, ['pack', 'reprint', 'manage'])
    if (!(await this.repo.heartbeat(shopId, printerId))) throw new PosError('Printer not found.', 404, 'PRINTER_NOT_FOUND')
    return { ok: true }
  }

  async testPrint(userId, shopId, printerId) {
    await this.access(userId, shopId, 'manage')
    const p = await this.repo.printer(shopId, printerId)
    if (!p) throw new PosError('Printer not found.', 404, 'PRINTER_NOT_FOUND')
    await this.repo.enqueue(null, { shopId, orderId: null, printerId: p.id, kind: 'TEST', createdBy: userId })
    this.notify(shopId, null, 'print')
    return { ok: true }
  }

  async jobs(userId, shopId, q = {}) {
    await this.access(userId, shopId, 'view')
    await this.repo.expireStuckJobs(shopId, PRINT_STUCK_SECONDS)
    return (await this.repo.jobs(shopId, { status: q.status, printerId: q.printerId, limit: q.limit ?? 50 })).map(publicJob)
  }

  /** A station takes a queued job. Only one station can. */
  async claimJob(userId, shopId, jobId) {
    await this.access(userId, shopId, ['pack', 'reprint', 'manage'])
    const job = await this.repo.claimJob(shopId, jobId, userId)
    if (!job) throw new PosError('That job was already taken or is no longer waiting.', 409, 'JOB_TAKEN')
    return publicJob(job)
  }

  /** The document for a job the caller holds — rendered fresh (a label always shows the CURRENT rider's QR). */
  async document(userId, shopId, jobId) {
    await this.access(userId, shopId, ['pack', 'reprint', 'manage'])
    const job = await this.repo.job(shopId, jobId)
    if (!job) throw new PosError('Print job not found.', 404, 'JOB_NOT_FOUND')
    const printer = job.printer_id ? await this.repo.printer(shopId, job.printer_id) : await this.repo.defaultPrinter(shopId)
    const paperMm = printer?.paper_mm ?? 80
    const shop = await this.repo.shop(shopId)
    if (job.kind === 'TEST') return { kind: 'TEST', paperMm, html: renderTest({ shopName: shop?.name, printerName: printer?.name, paperMm }) }
    const { order, items, shop: shopRow } = await this.repo.invoiceData(shopId, job.order_id)
    if (!order) throw new PosError('The order for this print job no longer exists.', 404, 'ORDER_NOT_FOUND')
    if (job.kind === 'INVOICE') return { kind: 'INVOICE', paperMm, html: renderInvoice({ shop: shopRow, order, items, paperMm }) }
    const [token, assignment] = await Promise.all([this.repo.activePickupToken(job.order_id), this.repo.currentAssignment(job.order_id)])
    return { kind: 'LABEL', paperMm, html: await renderLabel({ shop: shopRow, order, packageNo: job.package_no, packageTotal: job.package_total, riderName: assignment?.rider_name, token, paperMm }) }
  }

  /** The station reports what really happened. Only then is a job PRINTED or FAILED. */
  async reportJob(userId, shopId, jobId, { ok, error }) {
    await this.access(userId, shopId, ['pack', 'reprint', 'manage'])
    const job = await this.repo.finishJob(shopId, jobId, { ok, error })
    if (!job) throw new PosError('That job is not being printed.', 409, 'NOT_PRINTING')
    await this.repo.logEvent(null, { shopId, orderId: job.order_id, actorId: userId, kind: ok ? 'PRINT_DONE' : 'PRINT_FAILED', detail: { kind: job.kind, jobId, error: job.last_error } })
    this.notify(shopId, job.order_id, 'print')
    return publicJob(job)
  }

  /** Controlled retry of a failed print (a bounded number of times). */
  async retryJob(userId, shopId, jobId) {
    await this.access(userId, shopId, ['reprint', 'manage'])
    const job = await this.repo.job(shopId, jobId)
    if (!job) throw new PosError('Print job not found.', 404, 'JOB_NOT_FOUND')
    if (job.status !== 'FAILED') throw new PosError('Only a failed print can be retried.', 409, 'NOT_FAILED')
    if (!canRetry(job)) throw new PosError(`This print failed ${MAX_PRINT_ATTEMPTS} times. Check the printer, then reprint it.`, 409, 'TOO_MANY_ATTEMPTS')
    const row = await this.repo.requeue(shopId, jobId)
    if (!row) throw new PosError('That job just changed — refresh.', 409, 'CONFLICT')
    await this.repo.logEvent(null, { shopId, orderId: job.order_id, actorId: userId, kind: 'PRINT_RETRY', detail: { kind: job.kind, jobId } })
    this.notify(shopId, job.order_id, 'print')
    return publicJob(row)
  }

  /** A fresh copy (for a reprint after a successful print, or after the attempts ran out). */
  async reprint(userId, shopId, jobId) {
    await this.access(userId, shopId, ['reprint', 'manage'])
    const job = await this.repo.job(shopId, jobId)
    if (!job) throw new PosError('Print job not found.', 404, 'JOB_NOT_FOUND')
    if (['QUEUED', 'PRINTING'].includes(job.status)) throw new PosError('That job is still waiting to print.', 409, 'STILL_QUEUED')
    if (job.kind === 'LABEL') {
      const t = await this.repo.activePickupToken(job.order_id)
      if (!t) throw new PosError('There is no valid pickup QR to print — assign a rider first.', 409, 'NO_VALID_PICKUP')
    }
    const printer = job.printer_id ? await this.repo.printer(shopId, job.printer_id) : null
    const copy = await this.repo.enqueue(null, { shopId, orderId: job.order_id, printerId: printer?.id ?? (await this.repo.defaultPrinter(shopId))?.id ?? null, kind: job.kind, packageNo: job.package_no, packageTotal: job.package_total, createdBy: userId, reprintOf: job.id })
    await this.repo.logEvent(null, { shopId, orderId: job.order_id, actorId: userId, kind: 'PRINT_QUEUED', detail: { kind: job.kind, jobId: copy.id, reprint: true } })
    this.notify(shopId, job.order_id, 'print')
    return publicJob(copy)
  }

  // ─── needs attention ────────────────────────────────────────────
  async attention(userId, shopId) {
    await this.access(userId, shopId, 'view')
    const now = this.now()
    await this.repo.expireStuckJobs(shopId, PRINT_STUCK_SECONDS)
    const s = await this.repo.attentionSources(shopId, { printerQueuedMin: THRESHOLD_MINUTES.PRINTER_QUEUED, now })
    const resolved = new Set(s.resolutions.map((r) => `${r.order_id}|${r.kind}|${r.ref ?? ''}`))
    const items = []
    const add = (kind, row, ref, text, extra = {}) => items.push({ kind, ...ATTENTION_KINDS[kind], orderId: row.order_id ?? null, orderNumber: row.order_number ?? null, ref: ref ?? '', since: row.since, minutes: minutesBetween(row.since, now), text, resolvable: Boolean(row.order_id), ...extra })

    for (const r of s.missing) add('MISSING_ITEM', r, r.ref, `${r.name}: ${r.short} missing${r.missing_note ? ` — ${r.missing_note}` : ''}`, { lineId: r.ref })
    for (const r of s.wrong) add('WRONG_SCAN', r, r.stage, `${r.n} wrong scan${r.n === 1 ? '' : 's'} while ${r.stage === 'PICK' ? 'picking' : 'packing'}`)
    for (const r of s.delays) {
      const limit = THRESHOLD_MINUTES[r.stage]
      const m = minutesBetween(r.since, now)
      if (m != null && m >= limit) add('DELAY', r, r.stage, `Waiting ${m} min in ${LANE_LABEL[r.stage]} (usually under ${limit})`)
    }
    for (const r of s.printFailed) add('PRINT_FAILED', r, r.ref, `${r.kind === 'LABEL' ? 'Label' : r.kind === 'TEST' ? 'Test page' : 'Invoice'} did not print${r.last_error ? `: ${r.last_error}` : ''}`, { jobId: r.ref })
    const offline = new Map()
    for (const r of s.printerOffline) {
      if (printerOnline(r.last_seen_at, now)) continue
      const key = r.printer_name ?? 'none'
      if (!offline.has(key)) offline.set(key, { row: r, n: 0 })
      offline.get(key).n++
    }
    for (const [name, { row, n }] of offline) items.push({ kind: 'PRINTER_OFFLINE', ...ATTENTION_KINDS.PRINTER_OFFLINE, orderId: null, orderNumber: null, ref: name, since: row.since, minutes: minutesBetween(row.since, now), resolvable: false, text: name === 'none' ? `${n} print${n === 1 ? '' : 's'} waiting but no printer is set up` : `${name} is offline — ${n} print${n === 1 ? '' : 's'} waiting` })
    for (const r of s.noRider) { const m = minutesBetween(r.since, now); if (m >= THRESHOLD_MINUTES.NO_RIDER) add('NO_RIDER', r, '', `Packed ${m} min ago, no rider assigned`) }
    for (const r of s.qr) add('QR_REJECTED', r, r.ref, `Pickup QR rejected${r.failure_reason ? `: ${String(r.failure_reason).toLowerCase().replace(/_/g, ' ')}` : ''}`)
    for (const r of s.payment) add('PAYMENT_PROBLEM', r, '', 'Payment failed — do not hand this order over')
    for (const r of s.cancelled) add('CANCELLED_IN_PROGRESS', r, '', 'Cancelled while being prepared — stop work and set the items aside')
    for (const r of s.unreleased) add('UNRELEASED_PICKUP', r, r.ref, 'The rider collected this without a store handover record')

    const open = items.filter((i) => !isResolved(i, resolved))
    return { items: sortAttention(open), counts: { total: open.length, high: open.filter((i) => i.severity === 'HIGH').length } }
  }

  async resolveAttention(userId, shopId, { orderId, kind, ref, note }) {
    await this.access(userId, shopId, 'manage')
    if (!ATTENTION_KINDS[kind]) throw new PosError('Unknown kind of item.', 400, 'VALIDATION', { kind: 'Unknown' })
    await this.mustOrder(shopId, orderId)
    await withTransaction(async (client) => {
      const id = await this.repo.resolveAttention(client, { shopId, orderId, kind, ref, note: String(note ?? '').trim().slice(0, 300) || null, userId })
      if (id) await this.repo.logEvent(client, { shopId, orderId, actorId: userId, kind: 'ATTENTION_RESOLVED', detail: { kind, label: ATTENTION_KINDS[kind].label, note: String(note ?? '').trim().slice(0, 300) } })
    })
    this.notify(shopId, orderId, 'attention')
    return this.attention(userId, shopId)
  }

  // ─── audit & performance ────────────────────────────────────────
  async timeline(userId, shopId, orderId) {
    await this.access(userId, shopId, 'view')
    await this.mustOrder(shopId, orderId)
    return mergeTimeline(await this.repo.timeline(shopId, orderId))
  }

  async performance(userId, shopId, q = {}) {
    await this.access(userId, shopId, 'manage')
    const r = parsePosRange(q, this.now())
    const d = await this.repo.performance(shopId, r.start, r.end)
    const people = new Map()
    const row = (id, name) => {
      const k = id ?? 'unknown'
      if (!people.has(k)) people.set(k, { userId: id, name: name ?? 'Unknown', picked: null, packed: null, scans: { ok: 0, manual: 0, mistakes: 0 }, missingReports: 0, handovers: 0 })
      return people.get(k)
    }
    const round = (n) => (n == null ? null : Math.round(n * 10) / 10)
    for (const x of d.picks) row(x.user_id, x.name).picked = { orders: x.orders, avgMinutes: round(x.avg_minutes), medianMinutes: round(median(x.minutes)) }
    for (const x of d.packs) row(x.user_id, x.name).packed = { orders: x.orders, avgMinutes: round(x.avg_minutes), medianMinutes: round(median(x.minutes)) }
    for (const x of d.scans) Object.assign(row(x.user_id, x.name).scans, { ok: x.ok, manual: x.manual, mistakes: x.mistakes })
    for (const x of d.missing) row(x.user_id, x.name).missingReports = x.n
    for (const x of d.handovers) row(x.user_id, x.name).handovers = x.n
    const list = [...people.values()].map((p) => ({ ...p, scans: { ...p.scans, mistakeRate: p.scans.ok + p.scans.mistakes ? round((p.scans.mistakes / (p.scans.ok + p.scans.mistakes)) * 100) : null } }))
    const sum = (arr, f) => arr.reduce((n, x) => n + (f(x) ?? 0), 0)
    const waits = d.riderWait.filter((x) => x != null && x >= 0)
    return {
      range: { from: r.from, to: r.to, days: r.days },
      totals: {
        pickedOrders: sum(d.picks, (x) => x.orders),
        packedOrders: sum(d.packs, (x) => x.orders),
        avgPickMinutes: round(d.picks.length ? sum(d.picks, (x) => x.avg_minutes * x.orders) / sum(d.picks, (x) => x.orders) : null),
        avgPackMinutes: round(d.packs.length ? sum(d.packs, (x) => x.avg_minutes * x.orders) / sum(d.packs, (x) => x.orders) : null),
        scanMistakes: sum(d.scans, (x) => x.mistakes),
        manualConfirms: sum(d.scans, (x) => x.manual),
        missingReports: sum(d.missing, (x) => x.n),
        handovers: sum(d.handovers, (x) => x.n),
        riderWaitMedianMinutes: round(median(waits)),
        riderWaitSamples: waits.length,
        reassignments: d.reassigned,
      },
      people: list.sort((a, b) => ((b.picked?.orders ?? 0) + (b.packed?.orders ?? 0)) - ((a.picked?.orders ?? 0) + (a.packed?.orders ?? 0))),
    }
  }

  // ─── helpers ────────────────────────────────────────────────────
  actor(ctx) {
    return { id: ctx.userId, platform_role: ctx.hqRole ?? undefined, shopRole: ctx.shopRole ?? undefined, role: 'ADMIN' }
  }

  notify(shopId, orderId, kind) {
    try {
      this.emit(shopId, { orderId, kind })
    } catch (err) {
      this.logger.warn({ err: err.message }, 'POS realtime emit failed')
    }
  }

  async mustOrder(shopId, orderId) {
    const o = await this.repo.order(shopId, orderId)
    if (!o) throw new PosError('Order not found.', 404, 'ORDER_NOT_FOUND') // other shops' orders do not exist here
    return o
  }

  async activeOrder(shopId, orderId, statuses) {
    const o = await this.mustOrder(shopId, orderId)
    if (!statuses.includes(o.status)) throw this.notActive(o)
    return o
  }

  notActive(order) {
    const text = order.status === 'CANCELLED' ? 'This order was cancelled.' : order.status === 'DELIVERED' ? 'This order was already delivered.' : `This order is ${order.status.toLowerCase().replace(/_/g, ' ')} — that step is not available.`
    return new PosError(text, 409, order.status === 'CANCELLED' ? 'ORDER_CANCELLED' : 'ORDER_NOT_ACTIVE')
  }

  /** Someone else's job stays theirs, unless a manager steps in. */
  assertOwner(ctx, ownerId, verb) {
    if (ownerId && ownerId !== ctx.userId && !ctx.abilities.manage) throw new PosError(`This order is assigned to someone else for ${verb}.`, 409, 'OWNED_BY_OTHER')
  }

  /** The order must be in the right stage, owned by the caller (or a manager). */
  async workable(ctx, orderId, stage) {
    const order = await this.mustOrder(ctx.shopId, orderId)
    if (order.status !== 'PREPARING') throw this.notActive(order)
    const f = await this.repo.fulfillment(orderId)
    if (stage === 'PICK') {
      if (!f || f.stage !== 'PICKING' || !f.pick_started_at) throw new PosError('Start picking first.', 409, 'WRONG_STAGE')
      this.assertOwner(ctx, f.picker_id, 'picking')
    } else {
      if (!f || f.stage !== 'PACKING' || !f.pack_started_at) throw new PosError(f?.stage === 'PACKING' ? 'Start packing first.' : 'Picking is not finished yet.', 409, 'WRONG_STAGE')
      this.assertOwner(ctx, f.packer_id, 'packing')
    }
    return { order, f }
  }

  async peopleNames(ids) {
    return this.repo.names(ids.filter(Boolean))
  }
}

const SCAN_MESSAGE = {
  WRONG_ITEM: () => 'That item is not on this order. Put it back.',
  OVER_QTY: (l) => `${l?.name ?? 'That item'} is already complete. Do not take more.`,
  NOT_NEEDED: (l) => `${l?.name ?? 'That item'} is not needed — it was reported missing or removed.`,
}

const RIDER_FAIL = {
  ORDER_NOT_FOUND: 'Order not found.',
  ORDER_NOT_ACTIVE: 'This order can no longer be assigned.',
  MANUAL_ASSIGNMENT_PROTECTED: 'A rider was already chosen by hand for this order.',
}

function publicJob(j) {
  return {
    id: j.id, kind: j.kind, status: j.status, orderId: j.order_id, orderNumber: j.order_number ?? null, printerId: j.printer_id, printerName: j.printer_name ?? null,
    packageNo: j.package_no, packageTotal: j.package_total, attempts: j.attempts, error: j.last_error, createdAt: j.created_at, printedAt: j.printed_at, reprintOf: j.reprint_of,
    canRetry: canRetry(j),
  }
}

/**
 * What a rider is doing right now, from their open assignments (the furthest-along one wins):
 * Offline · Available · Assigned · Coming to store · At store · Picked up · On delivery.
 */
export function riderState(r, shopId) {
  const active = Array.isArray(r.active) ? r.active : []
  const rank = { ASSIGNED: 1, ACCEPTED: 2, PICKED_UP: 4, IN_TRANSIT: 5 }
  let best = null
  for (const a of active) {
    let key = rank[a.status] ?? 0
    if (a.status === 'ACCEPTED' && a.token === 'VERIFIED') key = 3
    if (!best || key > best.key) best = { key, a }
  }
  const state = !best ? (r.is_online ? 'AVAILABLE' : 'OFFLINE') : ['', 'ASSIGNED', 'COMING_TO_STORE', 'AT_STORE', 'PICKED_UP', 'ON_DELIVERY'][best.key] ?? 'ASSIGNED'
  return {
    state,
    online: Boolean(r.is_online),
    activeOrders: active.length,
    maxActiveOrders: r.max_active_orders ?? null,
    forThisStore: active.filter((a) => a.shopId === shopId).length,
    orders: active.map((a) => ({ orderId: a.orderId, orderNumber: a.orderNumber, status: a.status, pickup: a.token, thisStore: a.shopId === shopId })),
  }
}
