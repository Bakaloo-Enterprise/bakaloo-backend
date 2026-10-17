import { addFlows, buildProfit, orderMovements, replayStock, round2 } from './valuation.rules.js'

const LOSS_KINDS = new Set(['DAMAGE', 'WASTAGE', 'AUTHORIZED_ADJUSTMENT'])

/** Stock value, cost of goods sold and profit for one month, measured from the stock ledger and the purchase records. */
export class ValuationService {
  constructor({ repo }) {
    Object.assign(this, { repo })
  }

  /**
   * @param {{start: Date, end: Date, month: string}} w   the month window
   * @param {string|null} previousMonth  the month before, when it has been closed (its closing stock is this month's opening)
   */
  async compute(w, previousMonth = null) {
    const [shelves, moves, snap, whStart, whEnd, whOut, supplyRows] = await Promise.all([
      this.repo.shelves(w.start, w.end), this.repo.movements(w.start, w.end), previousMonth ? this.repo.snapshot(previousMonth) : [],
      this.repo.warehouseAsOf(w.start), this.repo.warehouseAsOf(w.end), this.repo.warehouseOut(w.start, w.end), this.repo.directSupplies(w.start, w.end),
    ])
    const snapBy = new Map(snap.map((s) => [s.shop_product_id, s]))
    const movesBy = new Map()
    for (const m of moves) {
      const list = movesBy.get(m.shop_product_id) ?? []
      list.push({ type: m.type, delta: m.delta, before: m.before, at: new Date(m.at).toISOString(), price: m.line_price === null ? null : Number(m.line_price), channel: m.channel ?? undefined, entryPrice: m.entry_price === null ? null : Number(m.entry_price) })
      movesBy.set(m.shop_product_id, list)
    }

    // ── shelves ──
    const results = []
    const checks = { ledgerMismatch: [], gaps: [], noCost: [], openingDiffers: [], estimatedOpening: { shelves: 0, value: 0 } }
    let openingValue = 0
    let closingValue = 0
    for (const s of shelves) {
      const raw = movesBy.get(s.id) ?? []
      if (s.qty_start === 0 && s.qty_end === 0 && raw.length === 0) continue
      const carried = snapBy.get(s.id)
      const fallback = s.cost_price === null ? null : Number(s.cost_price)
      const avg0 = carried ? carried.avg_cost : null
      const events = orderMovements(raw, s.qty_start)
      const r = replayStock({ qty: s.qty_start, avg: avg0, fallback, events })
      const label = `${s.product_name} @ ${s.shop_name}`
      const unitOpen = avg0 ?? fallback ?? 0
      const open = s.qty_start * unitOpen
      openingValue += open
      closingValue += r.value
      if (!carried && s.qty_start > 0) { checks.estimatedOpening.shelves += 1; checks.estimatedOpening.value += open }
      if (carried && carried.qty !== s.qty_start) checks.openingDiffers.push({ ref: label, detail: `closed month said ${carried.qty}, ledger says ${s.qty_start}` })
      if (r.qty !== s.qty_end) checks.ledgerMismatch.push({ ref: label, detail: `ledger replay ends at ${r.qty}, stock now says ${s.qty_end}` })
      if (r.flows.gapUnits !== 0) checks.gaps.push({ ref: label, detail: `${r.flows.gapUnits > 0 ? '+' : ''}${r.flows.gapUnits} units changed with no ledger record` })
      if (r.flows.unknownCostUnits > 0) checks.noCost.push({ ref: label, detail: `${r.flows.unknownCostUnits} units with no known cost` })
      results.push({ shelf: s, r, open })
    }
    const flows = addFlows(results.map((x) => x.r.flows))

    const byProduct = new Map()
    const byShop = new Map()
    for (const { shelf: s, r, open } of results) {
      const f = r.flows
      const p = byProduct.get(s.product_id) ?? { productId: s.product_id, name: s.product_name, units: 0, sales: 0, cogs: 0, loss: 0, stockQty: 0, stockValue: 0 }
      p.units += f.soldUnits; p.sales += f.sales; p.cogs += f.cogs; p.loss += f.lossDamaged + f.lossAdjust; p.stockQty += r.qty; p.stockValue += r.value
      byProduct.set(s.product_id, p)
      const h = byShop.get(s.shop_id) ?? { shopId: s.shop_id, name: s.shop_name, openingValue: 0, closingValue: 0, sales: 0, cogs: 0, loss: 0 }
      h.openingValue += open; h.closingValue += r.value; h.sales += f.sales; h.cogs += f.cogs; h.loss += f.lossDamaged + f.lossAdjust
      byShop.set(s.shop_id, h)
    }
    const margin = (sales, cost) => (sales > 0 ? round2(((sales - cost) / sales) * 100) : null)
    const products = [...byProduct.values()].map((p) => ({ ...p, sales: round2(p.sales), cogs: round2(p.cogs), gross: round2(p.sales - p.cogs), marginPct: margin(p.sales, p.cogs), loss: round2(p.loss), stockValue: round2(p.stockValue) })).sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name))
    const shops = [...byShop.values()].map((h) => ({ ...h, openingValue: round2(h.openingValue), closingValue: round2(h.closingValue), sales: round2(h.sales), cogs: round2(h.cogs), gross: round2(h.sales - h.cogs), marginPct: margin(h.sales, h.cogs), loss: round2(h.loss) })).sort((a, b) => a.name.localeCompare(b.name))

    // ── warehouse (bought, not yet on a shelf), each purchase at its own price ──
    const endBy = new Map(whEnd.map((e) => [e.id, e]))
    const startBy = new Map(whStart.map((e) => [e.id, e]))
    const units = (e) => (e ? Math.max(0, e.received - e.damaged - e.sent - e.adj) : 0)
    let whOpen = 0, whClose = 0, goodsIn = 0, doorLoss = 0, sentValue = 0, sentUnits = 0
    const warehouseRows = []
    for (const id of new Set([...endBy.keys(), ...startBy.keys()])) {
      const a = startBy.get(id)
      const b = endBy.get(id)
      const price = (b ?? a).price
      whOpen += units(a) * price
      whClose += units(b) * price
      goodsIn += ((b?.received ?? 0) - (a?.received ?? 0)) * price
      doorLoss += ((b?.damaged ?? 0) - (a?.damaged ?? 0)) * price
      const dSent = (b?.sent ?? 0) - (a?.sent ?? 0)
      sentValue += dSent * price
      sentUnits += dSent
      if (units(b) > 0) warehouseRows.push({ entryNo: Number(b.entry_no), product: b.product, vendor: b.vendor, units: units(b), price, value: round2(units(b) * price) })
    }
    const out = (kinds) => whOut.filter((o) => kinds(o.kind)).reduce((n, o) => n + o.value, 0)
    const outUnits = (kinds) => whOut.filter((o) => kinds(o.kind)).reduce((n, o) => n + o.units, 0)
    const warehouse = {
      openingValue: whOpen, closingValue: whClose, goodsInValue: goodsIn, sentValue, sentUnits,
      lossValue: out((k) => LOSS_KINDS.has(k)) + doorLoss, doorLoss, returnedValue: out((k) => k === 'VENDOR_RETURN'),
    }

    // ── goods delivered straight from the hold to a B2B request ──
    const priced = supplyRows.filter((x) => x.sell !== null)
    const suppliedUnits = outUnits((k) => k === 'B2B_SUPPLY')
    const pricedUnits = priced.reduce((n, x) => n + x.quantity, 0)
    const supplies = { cost: out((k) => k === 'B2B_SUPPLY'), revenue: priced.reduce((n, x) => n + x.quantity * x.sell, 0), unpricedUnits: Math.max(0, suppliedUnits - pricedUnits), units: suppliedUnits }

    const { profit, rollForward } = buildProfit({ stores: { flows, openingValue, closingValue }, warehouse, supplies })

    // ── does goods sent from the warehouse equal goods received on shelves? ──
    const shelfIn = moves.filter((m) => m.type === 'PROCUREMENT_RECEIPT').reduce((n, m) => n + m.delta, 0) + moves.filter((m) => m.type === 'PROCUREMENT_REVERSAL').reduce((n, m) => n + m.delta, 0)
    checks.transfer = { shelfUnits: shelfIn, warehouseUnits: sentUnits, ok: shelfIn === sentUnits }
    checks.unpricedSupplyUnits = supplies.unpricedUnits
    checks.estimatedOpening.value = round2(checks.estimatedOpening.value)

    return {
      profit, rollForward, checks,
      stock: {
        openingValue: round2(openingValue), closingValue: round2(closingValue), warehouseOpening: round2(whOpen), warehouseClosing: round2(whClose),
        totalOpening: round2(openingValue + whOpen), totalClosing: round2(closingValue + whClose), basis: previousMonth ? 'CLOSED_MONTH' : 'ESTIMATED',
      },
      byProduct: [...products, ...(supplies.units > 0 ? [{ productId: null, name: 'Direct B2B supplies (from the warehouse hold)', units: supplies.units, sales: round2(supplies.revenue), cogs: round2(supplies.cost), gross: round2(supplies.revenue - supplies.cost), marginPct: margin(supplies.revenue, supplies.cost), loss: 0, stockQty: 0, stockValue: 0 }] : [])],
      byShop: shops, warehouseRows,
      closingSnapshot: results.filter((x) => x.r.qty > 0).map((x) => ({ shopProductId: x.shelf.id, qty: x.r.qty, avgCost: round2(x.r.unitCost * 10000) / 10000 })),
    }
  }
}
