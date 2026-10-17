import { describe, expect, it } from 'vitest'
import { addFlows, buildProfit, orderMovements, replayStock, round2 } from '../../../src/modules/procurement/valuation.rules.js'

const ev = (type, delta, before, extra = {}) => ({ type, delta, before, at: extra.at ?? '2026-10-05T00:00:00Z', ...extra })

describe('replayStock — moving average cost', () => {
  it('the worked example: buy 10 @30 then 10 @36, sell 5 @50, one order cancelled, 2 damaged', () => {
    const r = replayStock({
      qty: 0, events: [
        ev('PROCUREMENT_RECEIPT', 10, 0, { entryPrice: 30 }), ev('PROCUREMENT_RECEIPT', 10, 10, { entryPrice: 36 }),
        ev('ORDER_DEDUCTION', -5, 20, { price: 50, channel: 'B2C' }), ev('CANCELLATION_RESTORE', 1, 15, { price: 50, channel: 'B2C' }), ev('DAMAGED_STOCK', -2, 16),
      ],
    })
    expect(r.avg).toBe(33)
    expect(r.qty).toBe(14)
    expect(round2(r.value)).toBe(462)
    expect(r.flows).toMatchObject({ receiptsValue: 660, soldUnits: 4 })
    expect(round2(r.flows.cogs)).toBe(132) // 4 × 33
    expect(round2(r.flows.sales)).toBe(200) // 4 × 50
    expect(round2(r.flows.lossDamaged)).toBe(66)
    // opening 0 + received 660 − cogs 132 − loss 66 = closing 462
    expect(round2(0 + 660 - r.flows.cogs - r.flows.lossDamaged)).toBe(round2(r.value))
  })
  it('carries an opening average and re-averages with new purchases', () => {
    const r = replayStock({ qty: 10, avg: 20, events: [ev('PROCUREMENT_RECEIPT', 10, 10, { entryPrice: 40 })] })
    expect(r.avg).toBe(30)
    expect(round2(r.value)).toBe(600)
  })
  it('uses the fallback cost when nothing is carried, and counts units with no cost at all', () => {
    expect(replayStock({ qty: 5, fallback: 12, events: [ev('ORDER_DEDUCTION', -2, 5, { price: 20 })] }).flows.cogs).toBe(24)
    const none = replayStock({ qty: 5, events: [ev('ORDER_DEDUCTION', -2, 5, { price: 20 })] })
    expect(none.flows).toMatchObject({ cogs: 0, unknownCostUnits: 2 })
  })
  it('splits sales and cost by channel', () => {
    const r = replayStock({ qty: 10, avg: 10, events: [ev('ORDER_DEDUCTION', -2, 10, { price: 15, channel: 'B2B' }), ev('ORDER_DEDUCTION', -3, 8, { price: 20, channel: 'B2C' })] })
    expect(r.flows.byChannel).toEqual({ B2B: { sales: 30, cogs: 20, units: 2 }, B2C: { sales: 60, cogs: 30, units: 3 } })
  })
  it('manual top-ups and write-offs are valued at the average, not treated as sales', () => {
    const r = replayStock({ qty: 10, avg: 10, events: [ev('MANUAL_ADJUSTMENT', 5, 10), ev('BULK_UPDATE', -3, 15)] })
    expect(r.flows).toMatchObject({ otherInValue: 50, lossAdjust: 30, sales: 0, cogs: 0 })
    expect(r.qty).toBe(12)
  })
  it('a return with no sale to take back is just stock added', () => {
    expect(replayStock({ qty: 0, avg: 10, events: [ev('RETURN_STOCK', 2, 0)] }).flows.otherInValue).toBe(20)
  })
  it('a hole in the ledger is counted, and the books carry on from what the ledger says', () => {
    const r = replayStock({ qty: 10, avg: 10, events: [ev('ORDER_DEDUCTION', -2, 7, { price: 15 })] }) // 3 units vanished without a record
    expect(r.flows).toMatchObject({ gapUnits: -3, gapValue: -30 })
    expect(r.qty).toBe(5)
  })
  it('goods sent back to the warehouse leave at the average', () => {
    expect(replayStock({ qty: 10, avg: 10, events: [ev('PROCUREMENT_REVERSAL', -4, 10)] }).flows.reversalOut).toBe(40)
  })
})

describe('orderMovements', () => {
  it('orders movements that share a timestamp by their quantity chain', () => {
    const t = '2026-10-05T00:00:00Z'
    const out = orderMovements([ev('ORDER_DEDUCTION', -2, 8, { at: t }), ev('ORDER_DEDUCTION', -3, 11, { at: t }), ev('PROCUREMENT_RECEIPT', 5, 6, { at: t })], 11)
    expect(out.map((e) => e.before)).toEqual([11, 8, 6])
  })
  it('keeps different timestamps in time order', () => {
    expect(orderMovements([ev('X', 1, 1, { at: '2026-10-06T00:00:00Z' }), ev('X', 1, 0, { at: '2026-10-05T00:00:00Z' })], 0).map((e) => e.before)).toEqual([0, 1])
  })
})

describe('buildProfit', () => {
  const stores = { flows: addFlows([replayStock({ qty: 0, events: [ev('PROCUREMENT_RECEIPT', 20, 0, { entryPrice: 30 }), ev('ORDER_DEDUCTION', -10, 20, { price: 50, channel: 'B2C' })] }).flows]), openingValue: 0, closingValue: 300 }
  it('profit and an exact roll-forward', () => {
    const warehouse = { openingValue: 0, goodsInValue: 600, sentValue: 600, returnedValue: 0, lossValue: 0, closingValue: 0 }
    const { profit, rollForward } = buildProfit({ stores, warehouse, supplies: { revenue: 0, cost: 0, unpricedUnits: 0 } })
    expect(profit).toMatchObject({ sales: 500, cogs: 300, gross: 200, marginPct: 40, loss: 0, afterLoss: 200 })
    expect(rollForward).toMatchObject({ opening: 0, goodsReceived: 600, costOfGoodsSold: -300, closing: 300, difference: 0 })
  })
  it('direct supplies from the warehouse hold count as sales and cost, and wastage comes off the profit', () => {
    const warehouse = { openingValue: 100, goodsInValue: 600, sentValue: 600, returnedValue: 30, lossValue: 60, closingValue: 10 }
    const { profit, rollForward } = buildProfit({ stores, warehouse, supplies: { revenue: 100, cost: 40, unpricedUnits: 2 } })
    expect(profit).toMatchObject({ sales: 600, cogs: 340, gross: 260, loss: 60, afterLoss: 200, unpricedSupplyUnits: 2 })
    expect(profit.channel.B2B).toMatchObject({ sales: 100, cogs: 40, gross: 60, marginPct: 60 })
    expect(Math.abs(rollForward.difference)).toBeGreaterThanOrEqual(0)
  })
  it('margin is empty (not zero or infinite) when nothing was sold', () => {
    const idle = { flows: addFlows([replayStock({ qty: 3, avg: 5, events: [] }).flows]), openingValue: 15, closingValue: 15 }
    const { profit } = buildProfit({ stores: idle, warehouse: { openingValue: 0, goodsInValue: 0, sentValue: 0, returnedValue: 0, lossValue: 0, closingValue: 0 }, supplies: { revenue: 0, cost: 0, unpricedUnits: 0 } })
    expect(profit.marginPct).toBeNull()
  })
})
