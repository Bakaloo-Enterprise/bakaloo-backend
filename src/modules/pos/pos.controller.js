import { success, error } from '../../utils/apiResponse.js'
import { PosError } from './errors.js'

/** Domain errors, and the existing order service's typed errors (they carry statusCode + code), become API errors. */
function fail(reply, err) {
  if (err instanceof PosError) {
    const body = error(err.message, err.code)
    return reply.code(err.statusCode).send(err.details !== undefined ? { ...body, details: err.details } : body)
  }
  if (err?.statusCode && err.statusCode < 500 && err.code) return reply.code(err.statusCode).send(error(err.message, err.code))
  throw err
}

/** @param {() => import('./pos.service.js').PosService} getService */
export function createPosController(getService) {
  const run = (message, fn) =>
    async function handler(request, reply) {
      try {
        // HQ staff pass the shop-scope check without a store (they may look at several); the POS always works on ONE.
        if (!request.shopId) throw new PosError('Choose a store first — the POS works on one store at a time.', 400, 'SHOP_SCOPE_REQUIRED')
        return success(await fn(getService(), request, request.user.id, request.shopId), message)
      } catch (err) {
        return fail(reply, err)
      }
    }
  return {
    me: run('POS access', (s, _r, u, shop) => s.me(u, shop)),
    board: run('Board fetched', (s, _r, u, shop) => s.board(u, shop)),
    detail: run('Order fetched', (s, r, u, shop) => s.detail(u, shop, r.params.id)),
    timeline: run('Timeline fetched', (s, r, u, shop) => s.timeline(u, shop, r.params.id)),
    assignPerson: run('Assigned', (s, r, u, shop) => s.assignPerson(u, shop, r.params.id, r.body)),
    startPick: run('Picking started', (s, r, u, shop) => s.startPick(u, shop, r.params.id)),
    scan: run('Scan checked', (s, r, u, shop) => s.scan(u, shop, r.params.id, r.body)),
    confirmLine: run('Item confirmed', (s, r, u, shop) => s.confirmLine(u, shop, r.params.id, r.params.lineId, r.body)),
    missing: run('Reported missing', (s, r, u, shop) => s.reportMissing(u, shop, r.params.id, r.params.lineId, r.body ?? {})),
    decision: run('Decision recorded', (s, r, u, shop) => s.decideMissing(u, shop, r.params.id, r.params.lineId, r.body)),
    finishPick: run('Picking finished', (s, r, u, shop) => s.finishPick(u, shop, r.params.id)),
    startPack: run('Packing started', (s, r, u, shop) => s.startPack(u, shop, r.params.id)),
    finishPack: run('Packing finished', (s, r, u, shop) => s.finishPack(u, shop, r.params.id, r.body ?? {})),
    assignRider: run('Rider assigned', (s, r, u, shop) => s.assignRider(u, shop, r.params.id, r.body.riderId)),
    handover: run('Handover recorded', (s, r, u, shop) => s.handover(u, shop, r.params.id)),
    riders: run('Riders fetched', (s, _r, u, shop) => s.riders(u, shop)),
    staff: run('Team fetched', (s, _r, u, shop) => s.staff(u, shop)),
    setStation: run('Station saved', (s, r, u, shop) => s.setStation(u, shop, r.params.userId, r.body.station)),
    printers: run('Printers fetched', (s, _r, u, shop) => s.printers(u, shop)),
    addPrinter: run('Printer added', (s, r, u, shop) => s.addPrinter(u, shop, r.body)),
    updatePrinter: run('Printer updated', (s, r, u, shop) => s.updatePrinter(u, shop, r.params.id, r.body ?? {})),
    removePrinter: run('Printer removed', (s, r, u, shop) => s.removePrinter(u, shop, r.params.id)),
    heartbeat: run('OK', (s, r, u, shop) => s.heartbeat(u, shop, r.params.id)),
    testPrint: run('Test page queued', (s, r, u, shop) => s.testPrint(u, shop, r.params.id)),
    jobs: run('Print jobs fetched', (s, r, u, shop) => s.jobs(u, shop, r.query)),
    claimJob: run('Job taken', (s, r, u, shop) => s.claimJob(u, shop, r.params.id)),
    document: run('Document ready', (s, r, u, shop) => s.document(u, shop, r.params.id)),
    reportJob: run('Result recorded', (s, r, u, shop) => s.reportJob(u, shop, r.params.id, r.body)),
    retryJob: run('Print retried', (s, r, u, shop) => s.retryJob(u, shop, r.params.id)),
    reprint: run('Reprint queued', (s, r, u, shop) => s.reprint(u, shop, r.params.id)),
    attention: run('Attention queue fetched', (s, _r, u, shop) => s.attention(u, shop)),
    resolveAttention: run('Resolved', (s, r, u, shop) => s.resolveAttention(u, shop, r.body)),
    performance: run('Performance fetched', (s, r, u, shop) => s.performance(u, shop, r.query)),
  }
}
