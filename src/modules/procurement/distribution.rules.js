/**
 * Smart distribution — pure functions, no I/O. Quantities are whole units.
 *
 * Priority (a confirmed customer is never short-changed to fill a shelf):
 *   1. B2B customer requests  → held centrally (reserved), earliest delivery date first
 *   2. App B2B orders waiting for approval → sent to the store that will deliver them (that is where stock is taken)
 *   3. Shelves → bring every store up to its own low-stock line, shared fairly when there is not enough
 *   4. Whatever is left stays in the warehouse
 */

/** Split `amount` over `needs` [{key, need}] in proportion to need, whole units only, never above a need. */
export function shareFairly(amount, needs) {
  const total = needs.reduce((n, x) => n + x.need, 0)
  const out = new Map(needs.map((x) => [x.key, 0]))
  if (amount <= 0 || total <= 0) return out
  if (amount >= total) { for (const x of needs) out.set(x.key, x.need); return out }
  let given = 0
  const rest = needs.map((x) => {
    const exact = (amount * x.need) / total
    const floor = Math.floor(exact)
    out.set(x.key, floor)
    given += floor
    return { key: x.key, frac: exact - floor, need: x.need }
  })
  rest.sort((a, b) => b.frac - a.frac || b.need - a.need)
  for (let i = 0; given < amount && i < rest.length; i = (i + 1) % rest.length) {
    const r = rest[i]
    if (out.get(r.key) < r.need) { out.set(r.key, out.get(r.key) + 1); given++ }
    else if (rest.every((x) => out.get(x.key) >= x.need)) break
  }
  return out
}

/**
 * @param {number} available units free to distribute
 * @param {{requirements: Array<{id,customer,due,open}>, appDemand: Array<{shopId,qty}>, shops: Array<{shopId,name,stock,low}>, onlyShopId?: string|null}} ctx
 *   requirements[].open = units of this product still to reserve for that request
 */
export function suggestDistribution(available, { requirements = [], appDemand = [], shops = [], onlyShopId = null }) {
  let left = Math.max(0, available)
  const reservations = []
  let b2bShort = 0
  for (const r of [...requirements].sort((a, b) => (a.due ?? '9999') < (b.due ?? '9999') ? -1 : (a.due ?? '9999') > (b.due ?? '9999') ? 1 : String(a.id).localeCompare(String(b.id)))) {
    if (r.open <= 0) continue
    const q = Math.min(left, r.open)
    if (q > 0) reservations.push({ requirementId: r.id, customer: r.customer, due: r.due ?? null, wanted: r.open, quantity: q })
    left -= q
    b2bShort += r.open - q
  }

  const eligible = shops.filter((s) => !onlyShopId || s.shopId === onlyShopId)
  const demandBy = new Map(appDemand.map((d) => [d.shopId, d.qty]))
  const lines = new Map(eligible.map((s) => [s.shopId, { shopId: s.shopId, name: s.name, stock: s.stock, low: s.low, appOrders: demandBy.get(s.shopId) ?? 0, b2bQty: 0, retailQty: 0, retailNeed: 0 }]))

  // App B2B orders: stock is only taken when an admin approves, so the store must hold enough by then.
  const appNeeds = [...lines.values()].map((l) => ({ key: l.shopId, need: Math.max(0, l.appOrders - l.stock) })).filter((x) => x.need > 0)
  const appShare = shareFairly(left, appNeeds)
  let appShort = 0
  for (const x of appNeeds) { const g = appShare.get(x.key); lines.get(x.key).b2bQty = g; left -= g; appShort += x.need - g }
  // Orders for stores this purchase cannot reach (a dedicated purchase) are not this purchase's job.

  const shelfNeeds = [...lines.values()].map((l) => {
    const after = Math.max(0, l.stock + l.b2bQty - l.appOrders)
    l.retailNeed = Math.max(0, l.low - after)
    return { key: l.shopId, need: l.retailNeed }
  }).filter((x) => x.need > 0)
  const shelfShare = shareFairly(left, shelfNeeds)
  let retailShort = 0
  for (const x of shelfNeeds) { const g = shelfShare.get(x.key); lines.get(x.key).retailQty = g; left -= g; retailShort += x.need - g }

  const stores = [...lines.values()].map((l) => ({ ...l, total: l.b2bQty + l.retailQty })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
  return { available, reservations, stores, keepCentral: left, shortages: { b2b: b2bShort, appOrders: appShort, shelves: retailShort } }
}

/** Check a confirmed plan against what is free. Throws a BusinessError-like message string via the caller. */
export function planTotals({ reservations = [], allocations = [] }) {
  const reserved = reservations.reduce((n, r) => n + r.quantity, 0)
  const sent = allocations.reduce((n, a) => n + a.quantity, 0)
  return { reserved, sent, total: reserved + sent }
}
