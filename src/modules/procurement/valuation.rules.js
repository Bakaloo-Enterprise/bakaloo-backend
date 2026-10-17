/**
 * Stock valuation, cost of goods sold and profit — pure functions, no I/O.
 *
 * Method: MOVING AVERAGE COST, replayed from the audited stock ledger (stock_movements).
 *   - goods received from a purchase come in at that purchase's price and re-average the stock already held
 *   - goods sold, wasted, damaged or written off leave at the average cost at that moment
 *   - returns / cancellations put goods back at the current average (and take the sale back with them)
 * Sales and cost of goods sold come from the SAME ledger events, so they always cover the same goods and a margin is a
 * real margin (not "this month's sales against last month's purchases").
 *
 * Money is rounded to the paisa only when reported; the running average keeps full precision.
 */

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

const emptyFlows = () => ({
  receiptsValue: 0, otherInValue: 0, cogs: 0, sales: 0, soldUnits: 0, lossDamaged: 0, lossAdjust: 0, reversalOut: 0,
  gapUnits: 0, gapValue: 0, unknownCostUnits: 0,
  byChannel: { B2B: { sales: 0, cogs: 0, units: 0 }, B2C: { sales: 0, cogs: 0, units: 0 } },
})

/** Put movements that share a timestamp (one transaction) into the order that makes the quantities chain up. */
export function orderMovements(events, startQty) {
  const sorted = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const out = []
  let qty = startQty
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j < sorted.length && sorted[j].at === sorted[i].at) j++
    const group = sorted.slice(i, j)
    while (group.length) {
      let k = group.findIndex((e) => e.before === qty)
      if (k < 0) k = 0
      const [e] = group.splice(k, 1)
      out.push(e)
      qty = e.before + e.delta
    }
    i = j
  }
  return out
}

/**
 * Replay one shop product through a month.
 * @param {{qty:number, avg:number|null, fallback:number|null, events:Array<{type,delta,before,price?:number|null,channel?:'B2B'|'B2C',entryPrice?:number|null}>}} input
 *   avg = the average cost carried in (from a closed month); fallback = the last known purchase price, used when nothing better exists
 */
export function replayStock({ qty = 0, avg = null, fallback = null, events = [] }) {
  const f = emptyFlows()
  let cost = avg
  let have = qty
  const known = () => cost ?? fallback
  const out = (units) => { const c = known(); if (c === null || c === undefined) { f.unknownCostUnits += units; return 0 } return c }

  for (const e of events) {
    // The ledger says what the stock WAS before this movement. If it differs from what we carried, something changed
    // stock without being recorded: keep the books moving, but count it so a person can look.
    if (e.before !== undefined && e.before !== have) {
      const gap = e.before - have
      f.gapUnits += gap
      f.gapValue += gap * (known() ?? 0)
      have = e.before
    }
    const d = e.delta
    const units = Math.abs(d)
    const line = e.price !== null && e.price !== undefined ? Number(e.price) : null
    const ch = e.channel === 'B2B' ? 'B2B' : 'B2C'
    if (d > 0) {
      if (e.type === 'PROCUREMENT_RECEIPT') {
        const c = e.entryPrice ?? known() ?? 0
        if (e.entryPrice === null || e.entryPrice === undefined) { if (known() === null || known() === undefined) f.unknownCostUnits += units }
        cost = have + d > 0 ? ((have * (known() ?? c)) + d * c) / (have + d) : c
        f.receiptsValue += d * c
      } else if ((e.type === 'CANCELLATION_RESTORE' || e.type === 'RETURN_STOCK') && line !== null) {
        const c = out(units)
        f.cogs -= d * c; f.sales -= d * line; f.soldUnits -= d
        f.byChannel[ch].cogs -= d * c; f.byChannel[ch].sales -= d * line; f.byChannel[ch].units -= d
      } else {
        // found / returned without a sale to take back / manual top-up / bulk upload
        const c = known() ?? 0
        if (known() === null || known() === undefined) f.unknownCostUnits += units
        f.otherInValue += d * c
      }
    } else if (d < 0) {
      const c = out(units)
      if (e.type === 'ORDER_DEDUCTION') {
        f.cogs += units * c; f.soldUnits += units
        f.byChannel[ch].cogs += units * c; f.byChannel[ch].units += units
        if (line !== null) { f.sales += units * line; f.byChannel[ch].sales += units * line }
      } else if (e.type === 'DAMAGED_STOCK') f.lossDamaged += units * c
      else if (e.type === 'PROCUREMENT_REVERSAL') f.reversalOut += units * c
      else f.lossAdjust += units * c
    }
    have += d
  }
  const unit = known() ?? 0
  return { qty: have, avg: cost, unitCost: unit, value: have * unit, flows: f }
}

/** Sum replay flows of many shop products (and round once). */
export function addFlows(list) {
  const t = emptyFlows()
  for (const f of list) {
    for (const k of ['receiptsValue', 'otherInValue', 'cogs', 'sales', 'soldUnits', 'lossDamaged', 'lossAdjust', 'reversalOut', 'gapUnits', 'gapValue', 'unknownCostUnits']) t[k] += f[k]
    for (const c of ['B2B', 'B2C']) for (const k of ['sales', 'cogs', 'units']) t.byChannel[c][k] += f.byChannel[c][k]
  }
  return t
}

/**
 * Profit and the stock roll-forward, from the pieces the service measures. Everything is rounded here, once.
 *   stores    = flows summed over all shop products (+ opening / closing value of the shelves)
 *   warehouse = bought stock not yet sent to a store, valued at each purchase's own price
 *   supplies  = goods delivered straight from the warehouse hold to a B2B request (B2B_SUPPLY)
 */
export function buildProfit({ stores, warehouse, supplies }) {
  const f = stores.flows
  const cogs = f.cogs + supplies.cost
  const sales = f.sales + supplies.revenue
  const loss = f.lossDamaged + f.lossAdjust + warehouse.lossValue
  const gross = sales - cogs
  const channel = {
    B2B: { sales: f.byChannel.B2B.sales + supplies.revenue, cogs: f.byChannel.B2B.cogs + supplies.cost },
    B2C: { sales: f.byChannel.B2C.sales, cogs: f.byChannel.B2C.cogs },
  }
  for (const c of Object.values(channel)) { c.gross = c.sales - c.cogs; c.marginPct = c.sales > 0 ? round2((c.gross / c.sales) * 100) : null }
  const profit = {
    sales: round2(sales), cogs: round2(cogs), gross: round2(gross), marginPct: sales > 0 ? round2((gross / sales) * 100) : null,
    loss: round2(loss), afterLoss: round2(gross - loss), unpricedSupplyUnits: supplies.unpricedUnits,
    channel: Object.fromEntries(Object.entries(channel).map(([k, v]) => [k, { sales: round2(v.sales), cogs: round2(v.cogs), gross: round2(v.gross), marginPct: v.marginPct }])),
  }
  // Roll-forward: opening + in − out = closing, with the cost difference on goods moved between warehouse and shelves shown, not hidden.
  const moved = (f.receiptsValue - f.reversalOut) - warehouse.sentValue
  const lines = {
    opening: round2(stores.openingValue + warehouse.openingValue),
    goodsReceived: round2(warehouse.goodsInValue),
    otherAdded: round2(f.otherInValue),
    costOfGoodsSold: round2(-cogs),
    wastageAndLoss: round2(-loss),
    sentBackToSuppliers: round2(-warehouse.returnedValue),
    movedBetweenWarehouseAndShelves: round2(moved),
    unexplained: round2(f.gapValue),
  }
  const expectedClosing = Object.values(lines).reduce((n, v) => n + v, 0)
  const closing = stores.closingValue + warehouse.closingValue
  return { profit, rollForward: { ...lines, closing: round2(closing), expectedClosing: round2(expectedClosing), difference: round2(closing - expectedClosing) } }
}
