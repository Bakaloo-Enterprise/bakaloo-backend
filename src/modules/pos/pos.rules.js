import { PosError } from './errors.js'
import { istDate, istDayStart } from '../whatsapp-crm/analytics.js'

/**
 * Pure rules for the Store Fulfillment POS (Phase 11). No database, no clock of its own — everything here is
 * unit-tested directly; the repository and service only apply these decisions.
 */

// ─── Who may do what ────────────────────────────────────────────────

/** HQ roles that may operate a store's POS (HQ_FINANCE can only look). */
const HQ_OPERATORS = new Set(['SUPER_ADMIN', 'ADMIN', 'HQ_MANAGER', 'HQ_SUPPORT'])
export const STATIONS = Object.freeze(['PICKER', 'PACKER'])

const NONE = Object.freeze({ view: false, pick: false, pack: false, handover: false, reprint: false, manage: false })

/**
 * @param {{ hqRole?: string|null, shopRole?: string|null, station?: string|null }} who
 *   hqRole = users.platform_role; shopRole/station come from the person's shop_staff row for THIS shop.
 * @returns {{ view: boolean, pick: boolean, pack: boolean, handover: boolean, reprint: boolean, manage: boolean }}
 *
 * manage = decide on missing items, assign people and riders, resolve attention, set up printers, see performance.
 * A Picker can only pick; a Packer packs, hands over and reprints; an all-round staff member (no station) does
 * all three; a Viewer only looks.
 */
export function posAbilities({ hqRole = null, shopRole = null, station = null } = {}) {
  if (hqRole) {
    return HQ_OPERATORS.has(hqRole)
      ? { view: true, pick: true, pack: true, handover: true, reprint: true, manage: true }
      : { ...NONE, view: true }
  }
  switch (shopRole) {
    case 'SHOP_ADMIN':
    case 'SHOP_MANAGER':
      return { view: true, pick: true, pack: true, handover: true, reprint: true, manage: true }
    case 'SHOP_STAFF':
      if (station === 'PICKER') return { ...NONE, view: true, pick: true }
      if (station === 'PACKER') return { ...NONE, view: true, pack: true, handover: true, reprint: true }
      return { ...NONE, view: true, pick: true, pack: true, handover: true, reprint: true }
    case 'SHOP_VIEWER':
      return { ...NONE, view: true }
    default:
      return { ...NONE }
  }
}

/** Can this staff member be given the picker / packer job? */
export function canTakeRole(staff, jobRole) {
  const a = posAbilities({ shopRole: staff.role, station: staff.pos_station })
  return jobRole === 'PICKER' ? a.pick : a.pack
}

// ─── Where an order is (the live board) ─────────────────────────────

export const LANES = Object.freeze([
  { id: 'NEW', label: 'New' },
  { id: 'PICKING', label: 'Picking' },
  { id: 'PACKING', label: 'Packing' },
  { id: 'READY', label: 'Ready' },
  { id: 'WAITING_RIDER', label: 'Waiting for rider' },
  { id: 'PICKED_UP', label: 'Picked up' },
  { id: 'OUT_FOR_DELIVERY', label: 'Out for delivery' },
])

/**
 * Which lane an ACTIVE order is in, or null when it is not on the board (pending payment, delivered, cancelled…).
 *
 *   CONFIRMED                                  → New
 *   PREPARING, picking                         → Picking        (a started pick list)
 *   PREPARING, packing                         → Packing
 *   PACKED, no rider                           → Ready          (needs a rider)
 *   PACKED, rider assigned                     → Waiting for rider
 *   OUT_FOR_DELIVERY, assignment PICKED_UP     → Picked up      (just left the store)
 *   OUT_FOR_DELIVERY, anything later           → Out for delivery
 *
 * PREPARING with no POS record (someone moved it on the old orders screen) shows as Picking so it is never lost.
 */
export function boardLane({ orderStatus, stage = null, assignmentStatus = null, hasRider = false }) {
  switch (orderStatus) {
    case 'CONFIRMED':
      return 'NEW'
    case 'PREPARING':
      return stage === 'PACKING' ? 'PACKING' : 'PICKING'
    case 'PACKED':
      return hasRider ? 'WAITING_RIDER' : 'READY'
    case 'OUT_FOR_DELIVERY':
      return assignmentStatus === 'PICKED_UP' ? 'PICKED_UP' : 'OUT_FOR_DELIVERY'
    default:
      return null
  }
}

/** Whole minutes between two instants (never negative). */
export function minutesBetween(from, to) {
  if (!from) return null
  return Math.max(0, Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 60_000))
}

/** When the order entered its current lane — the start of its "waiting time". */
export function laneSince(lane, t) {
  switch (lane) {
    case 'NEW': return t.confirmedAt ?? t.createdAt
    case 'PICKING': return t.pickStartedAt ?? t.confirmedAt ?? t.createdAt
    case 'PACKING': return t.packStartedAt ?? t.pickFinishedAt
    case 'READY': return t.packFinishedAt ?? t.updatedAt
    case 'WAITING_RIDER': return t.assignedAt ?? t.packFinishedAt
    case 'PICKED_UP': return t.pickedUpAt
    case 'OUT_FOR_DELIVERY': return t.pickedUpAt ?? t.updatedAt
    default: return null
  }
}

// ─── Scanning ───────────────────────────────────────────────────────

/** Scanners type the code like a keyboard; strip control characters and spaces, compare case-insensitively. */
export function normalizeCode(raw) {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f\s]/g, '').toUpperCase()
}

/** Units still to collect (PICK) or confirm (PACK) on a line. */
export function remaining(line, stage) {
  if (stage === 'PICK') return line.status === 'PENDING' ? Math.max(0, line.required_qty - line.picked_qty) : 0
  const target = packTarget(line)
  return target == null ? 0 : Math.max(0, target - line.packed_qty)
}

/**
 * How many units must be packed for this line, or null while it is still unsettled (not picked / missing and
 * undecided). A manager's decision settles a missing item: REMOVE and REFUND mean "pack what was picked",
 * REPLACE means "an approved replacement stands in for the full quantity".
 */
export function packTarget(line) {
  if (line.status === 'PICKED') return line.picked_qty
  if (line.status === 'RESOLVED') return line.decision === 'REPLACE' ? line.required_qty : line.picked_qty
  return null
}

/**
 * Match a scanned code to a line of THIS order. A scan is never silently accepted:
 *   OK          matched a line that still needs units
 *   OVER_QTY    matched, but every unit is already collected / confirmed
 *   NOT_NEEDED  matched a line that is missing or removed
 *   WRONG_ITEM  not on this order at all
 * @returns {{ result: 'OK'|'OVER_QTY'|'NOT_NEEDED'|'WRONG_ITEM', line: object|null }}
 */
export function matchScan(lines, code, stage) {
  const c = normalizeCode(code)
  if (!c) return { result: 'WRONG_ITEM', line: null }
  const hits = lines.filter((l) => normalizeCode(l.barcode) === c || normalizeCode(l.sku) === c)
  if (!hits.length) return { result: 'WRONG_ITEM', line: null }
  const open = hits.find((l) => remaining(l, stage) > 0)
  if (open) return { result: 'OK', line: open }
  const active = hits.find((l) => (stage === 'PICK' ? l.status !== 'MISSING' : packTarget(l) !== 0 && packTarget(l) != null))
  if (active) return { result: 'OVER_QTY', line: active }
  return { result: 'NOT_NEEDED', line: hits[0] }
}

/** Lines that stop the picker finishing: not yet collected, or reported missing and not yet decided. */
export function pickBlockers(lines) {
  return lines
    .filter((l) => l.status === 'PENDING' || l.status === 'MISSING')
    .map((l) => ({ lineId: l.id, name: l.name, reason: l.status === 'MISSING' ? 'MISSING_UNDECIDED' : 'NOT_PICKED', needed: l.required_qty - l.picked_qty }))
}

/** Lines that stop the packer finishing: something picked (or approved) but not yet verified into the package. */
export function packBlockers(lines) {
  const out = []
  for (const l of lines) {
    const target = packTarget(l)
    if (target == null) out.push({ lineId: l.id, name: l.name, reason: 'UNSETTLED', needed: l.required_qty })
    else if (l.packed_qty < target) out.push({ lineId: l.id, name: l.name, reason: 'NOT_VERIFIED', needed: target - l.packed_qty })
  }
  return out
}

/** Nothing to pack at all (every line removed) — completing would send an empty package. */
export function isEmptyPackage(lines) {
  return lines.every((l) => packTarget(l) === 0)
}

// ─── Printing ───────────────────────────────────────────────────────

export const PRINTER_ONLINE_SECONDS = 90
export const PRINT_STUCK_SECONDS = 120
export const MAX_PRINT_ATTEMPTS = 5

/** A print station reports in regularly; silence means the printer cannot be relied on. */
export function printerOnline(lastSeenAt, now = new Date()) {
  if (!lastSeenAt) return false
  return now.getTime() - new Date(lastSeenAt).getTime() <= PRINTER_ONLINE_SECONDS * 1000
}

/** May this finished job be tried again? Failed ones yes (a bounded number of times); others are reprints. */
export function canRetry(job) {
  return job.status === 'FAILED' && job.attempts < MAX_PRINT_ATTEMPTS
}

// ─── Needs attention ────────────────────────────────────────────────

export const THRESHOLD_MINUTES = Object.freeze({ NEW: 5, PICKING: 20, PACKING: 15, NO_RIDER: 5, PRINTER_QUEUED: 2 })

export const ATTENTION_KINDS = Object.freeze({
  MISSING_ITEM: { label: 'Item missing', severity: 'HIGH' },
  WRONG_SCAN: { label: 'Wrong item scanned', severity: 'MEDIUM' },
  DELAY: { label: 'Order is waiting too long', severity: 'MEDIUM' },
  PRINT_FAILED: { label: 'Printing failed', severity: 'HIGH' },
  PRINTER_OFFLINE: { label: 'Printer offline', severity: 'HIGH' },
  NO_RIDER: { label: 'No rider assigned', severity: 'HIGH' },
  QR_REJECTED: { label: 'Rider’s pickup QR was rejected', severity: 'HIGH' },
  PAYMENT_PROBLEM: { label: 'Payment problem', severity: 'HIGH' },
  CANCELLED_IN_PROGRESS: { label: 'Order cancelled while being prepared', severity: 'HIGH' },
  UNRELEASED_PICKUP: { label: 'Picked up without a store handover record', severity: 'MEDIUM' },
})

const SEVERITY_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 }

/** Most urgent first, then longest waiting. */
export function sortAttention(items) {
  return [...items].sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) || (new Date(a.since).getTime() - new Date(b.since).getTime()))
}

/** Is a derived item already dealt with? */
export function isResolved(item, resolutions) {
  return resolutions.has(`${item.orderId}|${item.kind}|${item.ref ?? ''}`)
}

// ─── Reporting ──────────────────────────────────────────────────────

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/** India-day range, from–to inclusive, at most 92 days (operational reporting, not history). */
export function parsePosRange({ from, to } = {}, now = new Date()) {
  const today = istDate(now)
  const toYmd = to ?? today
  const toStart = istDayStart(toYmd)
  if (!toStart) throw new PosError('“To” must be a date like 2026-10-31.', 400, 'VALIDATION', { to: 'Invalid date' })
  const fromYmd = from ?? istDate(new Date(toStart.getTime() - 6 * 86_400_000 + 5.5 * 3_600_000))
  const start = istDayStart(fromYmd)
  if (!start) throw new PosError('“From” must be a date like 2026-10-01.', 400, 'VALIDATION', { from: 'Invalid date' })
  if (start.getTime() > toStart.getTime()) throw new PosError('“From” must not be after “To”.', 400, 'VALIDATION', { from: 'After the end date' })
  const days = Math.round((toStart.getTime() - start.getTime()) / 86_400_000) + 1
  if (days > 92) throw new PosError('Pick at most 92 days at a time.', 400, 'RANGE_TOO_LONG')
  return { from: fromYmd, to: toYmd, start, end: new Date(toStart.getTime() + 86_400_000), days }
}

export const EVENT_KINDS = Object.freeze([
  'PICK_ASSIGNED', 'PACK_ASSIGNED', 'PICK_STARTED', 'ITEM_SCANNED', 'ITEM_CONFIRMED', 'SCAN_REJECTED', 'ITEM_MISSING', 'MISSING_DECIDED',
  'PICK_FINISHED', 'PACK_STARTED', 'PACK_FINISHED', 'PRINT_QUEUED', 'PRINT_DONE', 'PRINT_FAILED', 'PRINT_RETRY', 'RIDER_ASSIGNED',
  'HANDOVER', 'ATTENTION_RESOLVED',
])

// ─── Audit timeline ─────────────────────────────────────────────────

const STATUS_TEXT = { PENDING: 'pending', CONFIRMED: 'confirmed', PREPARING: 'being prepared', PACKED: 'packed', OUT_FOR_DELIVERY: 'out for delivery', DELIVERED: 'delivered', CANCELLED: 'cancelled', REFUNDED: 'refunded' }

/** One plain-language sentence per POS event ("Rahul assigned as picker"). */
export function describeEvent(kind, detail = {}, actor = null) {
  const who = actor ?? 'Someone'
  switch (kind) {
    case 'PICK_ASSIGNED': return `${detail.name ?? 'Someone'} assigned as picker${actor ? ` by ${actor}` : ''}`
    case 'PACK_ASSIGNED': return `${detail.name ?? 'Someone'} assigned as packer${actor ? ` by ${actor}` : ''}`
    case 'PICK_STARTED': return `${who} started picking (${detail.lines ?? '?'} items)`
    case 'ITEM_SCANNED': return `${who} scanned ${detail.name ?? 'an item'} (${detail.stage === 'PACK' ? 'packing' : 'picking'})`
    case 'ITEM_CONFIRMED': return `${who} confirmed ${detail.name ?? 'an item'} by hand (${detail.stage === 'PACK' ? 'packing' : 'picking'})`
    case 'SCAN_REJECTED': return `${who} scanned a wrong item${detail.code ? ` (${detail.code})` : ''} — ${String(detail.result ?? '').toLowerCase().replace(/_/g, ' ')}`
    case 'ITEM_MISSING': return `${who} reported ${detail.name ?? 'an item'} missing${detail.note ? `: ${detail.note}` : ''}`
    case 'MISSING_DECIDED': return `${who} decided: ${String(detail.decision ?? '').toLowerCase()} ${detail.name ?? 'item'}${detail.note ? ` — ${detail.note}` : ''}`
    case 'PICK_FINISHED': return `${who} finished picking — ${detail.verified ?? '?'} items verified`
    case 'PACK_STARTED': return `${who} started packing`
    case 'PACK_FINISHED': return `${who} completed packing (${detail.packages ?? 1} package${detail.packages === 1 ? '' : 's'})`
    case 'PRINT_QUEUED': return `${detail.kind === 'LABEL' ? 'Label' : 'Invoice'} print queued${detail.reprint ? ' (reprint)' : ''}`
    case 'PRINT_DONE': return `${detail.kind === 'LABEL' ? 'Label' : 'Invoice'} printed`
    case 'PRINT_FAILED': return `${detail.kind === 'LABEL' ? 'Label' : 'Invoice'} print failed${detail.error ? `: ${detail.error}` : ''}`
    case 'PRINT_RETRY': return `${who} retried a ${detail.kind === 'LABEL' ? 'label' : 'invoice'} print`
    case 'RIDER_ASSIGNED': return `${detail.riderName ?? 'A rider'} assigned${detail.previousRiderName ? ` (replacing ${detail.previousRiderName})` : ''}${actor ? ` by ${actor}` : ''}`
    case 'HANDOVER': return `${who} handed the package to ${detail.riderName ?? 'the rider'} (pickup QR ${String(detail.scan ?? '').toLowerCase()})`
    case 'ATTENTION_RESOLVED': return `${who} resolved: ${detail.label ?? detail.kind}${detail.note ? ` — ${detail.note}` : ''}`
    default: return String(kind)
  }
}

/**
 * One chronological list from the three places the truth lives: what the POS did, how the order's status
 * changed, and what the rider's QR scans said. Oldest first.
 */
export function mergeTimeline({ events, history, qr }) {
  const items = [
    ...events.map((e) => ({ at: e.at, source: 'POS', kind: e.kind, actor: e.actor ?? null, text: describeEvent(e.kind, e.detail, e.actor) })),
    ...history.map((h) => ({
      at: h.at, source: 'ORDER', kind: 'STATUS', actor: h.actor ?? null,
      text: `Order ${h.from_status ? `${STATUS_TEXT[h.from_status] ?? h.from_status} → ` : ''}${STATUS_TEXT[h.to_status] ?? h.to_status}${h.actor ? ` by ${h.actor}` : ''}`,
    })),
    ...qr.map((q) => ({
      at: q.at, source: 'RIDER', kind: q.result === 'SUCCESS' ? 'QR_OK' : 'QR_REJECTED', actor: q.actor ?? null,
      text: q.result === 'SUCCESS' ? `${q.actor ?? 'Rider'} scanned the pickup QR — verified` : `${q.actor ?? 'Rider'}’s pickup QR scan was rejected${q.failure_reason ? ` (${String(q.failure_reason).toLowerCase().replace(/_/g, ' ')})` : ''}`,
    })),
  ]
  return items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
}
