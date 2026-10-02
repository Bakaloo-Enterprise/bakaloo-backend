import { describe, expect, it } from 'vitest'
import {
  boardLane, canRetry, canTakeRole, isEmptyPackage, isResolved, laneSince, LANES, matchScan, median, minutesBetween, normalizeCode, packBlockers,
  packTarget, parsePosRange, pickBlockers, posAbilities, printerOnline, remaining, sortAttention, MAX_PRINT_ATTEMPTS,
} from '../../../src/modules/pos/pos.rules.js'

const line = (o = {}) => ({ id: 'l1', name: 'Rice 5kg', barcode: '8901234567890', sku: 'RICE5', required_qty: 2, picked_qty: 0, packed_qty: 0, status: 'PENDING', decision: null, ...o })

describe('posAbilities — who may do what', () => {
  it('managers and admins can do everything, HQ operators too', () => {
    for (const w of [{ shopRole: 'SHOP_ADMIN' }, { shopRole: 'SHOP_MANAGER' }, { hqRole: 'SUPER_ADMIN' }, { hqRole: 'HQ_MANAGER' }, { hqRole: 'HQ_SUPPORT' }]) {
      expect(posAbilities(w)).toEqual({ view: true, pick: true, pack: true, handover: true, reprint: true, manage: true })
    }
  })
  it('a picker can only pick; a packer packs, hands over and reprints; neither manages', () => {
    expect(posAbilities({ shopRole: 'SHOP_STAFF', station: 'PICKER' })).toEqual({ view: true, pick: true, pack: false, handover: false, reprint: false, manage: false })
    expect(posAbilities({ shopRole: 'SHOP_STAFF', station: 'PACKER' })).toEqual({ view: true, pick: false, pack: true, handover: true, reprint: true, manage: false })
  })
  it('an all-round staff member (no station) picks and packs but never manages', () => {
    expect(posAbilities({ shopRole: 'SHOP_STAFF' })).toEqual({ view: true, pick: true, pack: true, handover: true, reprint: true, manage: false })
  })
  it('viewers and finance can only look; unknown roles get nothing', () => {
    expect(posAbilities({ shopRole: 'SHOP_VIEWER' })).toEqual({ view: true, pick: false, pack: false, handover: false, reprint: false, manage: false })
    expect(posAbilities({ hqRole: 'HQ_FINANCE' }).manage).toBe(false)
    expect(posAbilities({ hqRole: 'HQ_FINANCE' }).view).toBe(true)
    expect(Object.values(posAbilities({ shopRole: 'CUSTOMER' })).some(Boolean)).toBe(false)
    expect(Object.values(posAbilities({})).some(Boolean)).toBe(false)
  })
  it('a station on a manager does not reduce them', () => {
    expect(posAbilities({ shopRole: 'SHOP_MANAGER', station: 'PICKER' }).manage).toBe(true)
  })
  it('who can be given a job', () => {
    expect(canTakeRole({ role: 'SHOP_STAFF', pos_station: 'PICKER' }, 'PICKER')).toBe(true)
    expect(canTakeRole({ role: 'SHOP_STAFF', pos_station: 'PICKER' }, 'PACKER')).toBe(false)
    expect(canTakeRole({ role: 'SHOP_STAFF', pos_station: null }, 'PACKER')).toBe(true)
    expect(canTakeRole({ role: 'SHOP_VIEWER' }, 'PICKER')).toBe(false)
    expect(canTakeRole({ role: 'SHOP_MANAGER' }, 'PACKER')).toBe(true)
  })
})

describe('boardLane — where an order is', () => {
  it('walks an order through every lane', () => {
    expect(boardLane({ orderStatus: 'CONFIRMED' })).toBe('NEW')
    expect(boardLane({ orderStatus: 'PREPARING', stage: 'PICKING' })).toBe('PICKING')
    expect(boardLane({ orderStatus: 'PREPARING', stage: 'PACKING' })).toBe('PACKING')
    expect(boardLane({ orderStatus: 'PACKED', hasRider: false })).toBe('READY')
    expect(boardLane({ orderStatus: 'PACKED', hasRider: true })).toBe('WAITING_RIDER')
    expect(boardLane({ orderStatus: 'OUT_FOR_DELIVERY', assignmentStatus: 'PICKED_UP' })).toBe('PICKED_UP')
    expect(boardLane({ orderStatus: 'OUT_FOR_DELIVERY', assignmentStatus: 'IN_TRANSIT' })).toBe('OUT_FOR_DELIVERY')
  })
  it('an order moved on elsewhere (PREPARING, no POS record) still shows up, never lost', () => {
    expect(boardLane({ orderStatus: 'PREPARING' })).toBe('PICKING')
  })
  it('orders that are not active in the store are not on the board', () => {
    for (const s of ['PENDING', 'DELIVERED', 'CANCELLED', 'REFUNDED', 'WHATEVER']) expect(boardLane({ orderStatus: s })).toBeNull()
  })
  it('lanes are in working order', () => {
    expect(LANES.map((l) => l.id)).toEqual(['NEW', 'PICKING', 'PACKING', 'READY', 'WAITING_RIDER', 'PICKED_UP', 'OUT_FOR_DELIVERY'])
  })
  it('waiting time starts when the order entered its lane', () => {
    const t = { createdAt: 'c', confirmedAt: 'conf', pickStartedAt: 'ps', pickFinishedAt: 'pf', packStartedAt: 'ks', packFinishedAt: 'kf', assignedAt: 'as', pickedUpAt: 'pu', updatedAt: 'u' }
    expect([laneSince('NEW', t), laneSince('PICKING', t), laneSince('PACKING', t), laneSince('READY', t), laneSince('WAITING_RIDER', t), laneSince('PICKED_UP', t)]).toEqual(['conf', 'ps', 'ks', 'kf', 'as', 'pu'])
    expect(laneSince('PACKING', { pickFinishedAt: 'pf' })).toBe('pf')
    expect(laneSince('NEW', { createdAt: 'c' })).toBe('c')
    expect(laneSince('NOPE', t)).toBeNull()
  })
  it('minutesBetween never goes negative and tolerates no start', () => {
    expect(minutesBetween('2026-10-02T10:00:00Z', '2026-10-02T10:07:59Z')).toBe(7)
    expect(minutesBetween('2026-10-02T10:10:00Z', '2026-10-02T10:00:00Z')).toBe(0)
    expect(minutesBetween(null, new Date())).toBeNull()
  })
})

describe('scanning', () => {
  it('normalises what a scanner types', () => {
    expect(normalizeCode(' 8901 234\r\n')).toBe('8901234')
    expect(normalizeCode('rice5')).toBe('RICE5')
    expect(normalizeCode(null)).toBe('')
  })
  it('a correct scan matches by barcode or SKU, whatever the case', () => {
    expect(matchScan([line()], '8901234567890', 'PICK')).toMatchObject({ result: 'OK', line: { id: 'l1' } })
    expect(matchScan([line()], 'rice5', 'PICK').result).toBe('OK')
  })
  it('a code that is not on the order is a WRONG_ITEM — never silently accepted', () => {
    expect(matchScan([line()], '0000', 'PICK')).toEqual({ result: 'WRONG_ITEM', line: null })
    expect(matchScan([line()], '', 'PICK').result).toBe('WRONG_ITEM')
    expect(matchScan([], 'x', 'PICK').result).toBe('WRONG_ITEM')
  })
  it('too many scans of one item are refused, not counted', () => {
    expect(matchScan([line({ picked_qty: 2, status: 'PICKED' })], 'RICE5', 'PICK').result).toBe('OVER_QTY')
  })
  it('a line that is missing or removed is not needed', () => {
    expect(matchScan([line({ status: 'MISSING' })], 'RICE5', 'PICK').result).toBe('NOT_NEEDED')
    expect(matchScan([line({ status: 'RESOLVED', decision: 'REMOVE', picked_qty: 0 })], 'RICE5', 'PACK').result).toBe('NOT_NEEDED')
  })
  it('the same product on two lines fills the first that still needs units', () => {
    const a = line({ id: 'a', picked_qty: 2, status: 'PICKED' }), b = line({ id: 'b' })
    expect(matchScan([a, b], 'RICE5', 'PICK').line.id).toBe('b')
  })
  it('packing verifies against what was picked, not what was ordered', () => {
    const l = line({ status: 'PICKED', picked_qty: 1, packed_qty: 0 }) // ordered 2, picked 1
    expect(remaining(l, 'PACK')).toBe(1)
    expect(matchScan([l], 'RICE5', 'PACK').result).toBe('OK')
    expect(matchScan([{ ...l, packed_qty: 1 }], 'RICE5', 'PACK').result).toBe('OVER_QTY')
  })
  it('remaining units', () => {
    expect(remaining(line(), 'PICK')).toBe(2)
    expect(remaining(line({ picked_qty: 1 }), 'PICK')).toBe(1)
    expect(remaining(line({ status: 'MISSING' }), 'PICK')).toBe(0)
    expect(remaining(line(), 'PACK')).toBe(0) // not picked yet → nothing to pack
  })
})

describe('what must be packed (manager decisions settle missing items)', () => {
  it('a fully picked line packs what was picked', () => expect(packTarget(line({ status: 'PICKED', picked_qty: 2 }))).toBe(2))
  it('REMOVE and REFUND pack only what was picked; REPLACE packs the full approved quantity', () => {
    expect(packTarget(line({ status: 'RESOLVED', decision: 'REMOVE', picked_qty: 1 }))).toBe(1)
    expect(packTarget(line({ status: 'RESOLVED', decision: 'REFUND', picked_qty: 0 }))).toBe(0)
    expect(packTarget(line({ status: 'RESOLVED', decision: 'REPLACE', picked_qty: 0 }))).toBe(2)
  })
  it('an undecided line has no target yet', () => {
    expect(packTarget(line())).toBeNull()
    expect(packTarget(line({ status: 'MISSING' }))).toBeNull()
  })
})

describe('what blocks finishing', () => {
  it('picking: anything not collected, and anything missing that nobody has decided', () => {
    const lines = [line({ id: 'a', status: 'PICKED', picked_qty: 2 }), line({ id: 'b', picked_qty: 1 }), line({ id: 'c', status: 'MISSING' }), line({ id: 'd', status: 'RESOLVED', decision: 'REMOVE' })]
    expect(pickBlockers(lines).map((b) => [b.lineId, b.reason])).toEqual([['b', 'NOT_PICKED'], ['c', 'MISSING_UNDECIDED']])
    expect(pickBlockers([lines[0], lines[3]])).toEqual([])
  })
  it('packing: everything to pack must be verified into the package', () => {
    const ok = line({ id: 'a', status: 'PICKED', picked_qty: 2, packed_qty: 2 })
    const half = line({ id: 'b', status: 'PICKED', picked_qty: 2, packed_qty: 1 })
    const open = line({ id: 'c' })
    expect(packBlockers([ok, half, open]).map((b) => [b.lineId, b.reason, b.needed])).toEqual([['b', 'NOT_VERIFIED', 1], ['c', 'UNSETTLED', 2]])
    expect(packBlockers([ok])).toEqual([])
  })
  it('a removed line needs no packing; an order with nothing left to pack is flagged', () => {
    const removed = line({ status: 'RESOLVED', decision: 'REFUND', picked_qty: 0 })
    expect(packBlockers([removed])).toEqual([])
    expect(isEmptyPackage([removed])).toBe(true)
    expect(isEmptyPackage([removed, line({ id: 'x', status: 'PICKED', picked_qty: 1 })])).toBe(false)
  })
})

describe('printing', () => {
  const now = new Date('2026-10-02T10:00:00Z')
  it('a station that reported in the last 90 seconds is online', () => {
    expect(printerOnline('2026-10-02T09:58:45Z', now)).toBe(true)
    expect(printerOnline('2026-10-02T09:58:29Z', now)).toBe(false)
    expect(printerOnline(null, now)).toBe(false)
  })
  it('a failed job may be retried a bounded number of times; a printed one is only reprinted', () => {
    expect(canRetry({ status: 'FAILED', attempts: 1 })).toBe(true)
    expect(canRetry({ status: 'FAILED', attempts: MAX_PRINT_ATTEMPTS })).toBe(false)
    expect(canRetry({ status: 'PRINTED', attempts: 1 })).toBe(false)
    expect(canRetry({ status: 'QUEUED', attempts: 0 })).toBe(false)
  })
})

describe('attention', () => {
  it('most urgent first, then the one waiting longest', () => {
    const items = [
      { kind: 'DELAY', severity: 'MEDIUM', since: '2026-10-02T09:00:00Z' },
      { kind: 'NO_RIDER', severity: 'HIGH', since: '2026-10-02T09:50:00Z' },
      { kind: 'MISSING_ITEM', severity: 'HIGH', since: '2026-10-02T09:10:00Z' },
    ]
    expect(sortAttention(items).map((i) => i.kind)).toEqual(['MISSING_ITEM', 'NO_RIDER', 'DELAY'])
    expect(items[0].kind).toBe('DELAY') // input untouched
  })
  it('resolved items are recognised by order + kind + reference', () => {
    const res = new Set(['o1|DELAY|PICKING'])
    expect(isResolved({ orderId: 'o1', kind: 'DELAY', ref: 'PICKING' }, res)).toBe(true)
    expect(isResolved({ orderId: 'o1', kind: 'DELAY', ref: 'PACKING' }, res)).toBe(false)
    expect(isResolved({ orderId: 'o2', kind: 'DELAY', ref: 'PICKING' }, res)).toBe(false)
  })
})

describe('reporting helpers', () => {
  it('median', () => {
    expect(median([5, 20, 30])).toBe(20)
    expect(median([5, 20])).toBe(12.5)
    expect(median([])).toBeNull()
    expect(median([NaN, 4])).toBe(4)
  })
  it('parsePosRange: last 7 days by default, India days, max 92', () => {
    const now = new Date('2026-10-02T10:00:00Z')
    expect(parsePosRange({}, now)).toMatchObject({ from: '2026-09-26', to: '2026-10-02', days: 7 })
    expect(parsePosRange({ from: '2026-10-02', to: '2026-10-02' }, now).days).toBe(1)
    expect(() => parsePosRange({ from: '2026-10-05', to: '2026-10-01' }, now)).toThrow(/must not be after/)
    expect(() => parsePosRange({ from: '2026-01-01', to: '2026-10-01' }, now)).toThrow(/at most 92/)
    expect(() => parsePosRange({ from: 'x' }, now)).toThrow(/From/)
    expect(parsePosRange({ from: '2026-07-03', to: '2026-10-02' }, now).days).toBe(92)
  })
})
