import { describe, expect, it } from 'vitest'
import { describeChanges, diffRow, mapHeaders, parseCell, productKey } from '../../../src/modules/catalog-bulk/catalog-bulk.rules.js'

const cur = (o = {}) => ({ price: 50, sale_price: null, wholesale_price: null, cost_price: 30, stock_quantity: 4, is_available: true, max_order_qty: 50, low_stock_threshold: 5, productPrice: 50, ...o })

describe('mapHeaders', () => {
  it('matches common spellings, ignoring case, spaces and punctuation', () => {
    const { map, unknown } = mapHeaders(['SKU', 'Branch Code', 'Stock Qty', 'Retail Price', 'Sale-Price', 'Purchase Price', 'Availability', 'Notes'])
    expect(map).toMatchObject({ sku: 'SKU', branch_code: 'Branch Code', stock: 'Stock Qty', price: 'Retail Price', sale_price: 'Sale-Price', cost_price: 'Purchase Price', available: 'Availability' })
    expect(unknown).toEqual(['Notes'])
  })
  it('explains what is missing in plain words', () => {
    expect(() => mapHeaders(['Branch Code', 'Stock'])).toThrow(/SKU, Barcode or Product ID/)
    expect(() => mapHeaders(['SKU', 'Stock'])).toThrow(/Branch Code/)
    expect(() => mapHeaders(['SKU', 'Branch Code'])).toThrow(/no column to change/)
  })
})

describe('parseCell', () => {
  it('blank = no change; dash / clear empties a price only', () => {
    expect(parseCell('price', '')).toEqual({})
    expect(parseCell('sale_price', '-')).toEqual({ value: null })
    expect(parseCell('cost_price', 'Clear')).toEqual({ value: null })
    expect(parseCell('stock', '-').error).toMatch(/cannot be cleared/)
  })
  it('reads money with symbols and commas', () => {
    expect(parseCell('price', '₹1,250.505')).toEqual({ value: 1250.51 })
    expect(parseCell('price', 'Rs. 40')).toEqual({ value: 40 })
  })
  it.each([['price', '0'], ['price', 'abc'], ['price', '-5'], ['price', '100000000'], ['stock', '-1'], ['stock', '2.5'], ['max_order_qty', '0'], ['max_order_qty', '10001'], ['available', 'maybe']])('rejects %s = %s', (f, v) => {
    expect(parseCell(f, v).error).toBeTruthy()
  })
  it('allows a zero cost but not a zero price', () => {
    expect(parseCell('cost_price', '0')).toEqual({ value: 0 })
    expect(parseCell('price', '0').error).toBeTruthy()
  })
  it('reads yes/no variants', () => {
    for (const v of ['Yes', 'TRUE', '1', 'Y', 'available']) expect(parseCell('available', v)).toEqual({ value: true })
    for (const v of ['No', 'false', '0', 'inactive']) expect(parseCell('available', v)).toEqual({ value: false })
  })
})

describe('diffRow', () => {
  it('lists only what actually changes', () => {
    const { errors, changes } = diffRow(cur(), { stock: '10', price: '50', sale_price: '45', available: 'yes' })
    expect(errors).toEqual([])
    expect(changes).toEqual({ stock: { from: 4, to: 10 }, sale_price: { from: null, to: 45 } })
  })
  it('a row identical to the store is unchanged (no changes, no errors)', () => {
    expect(diffRow(cur(), { stock: '4', price: '50.00' })).toEqual({ errors: [], changes: {} })
  })
  it('sale price must stay below the retail price — new or inherited', () => {
    expect(diffRow(cur(), { sale_price: '50' }).errors[0]).toMatch(/lower than the retail/)
    expect(diffRow(cur({ price: null, productPrice: 40 }), { sale_price: '41' }).errors[0]).toMatch(/lower than/)
    expect(diffRow(cur({ sale_price: 45 }), { price: '44' }).errors[0]).toMatch(/lower than/)
    expect(diffRow(cur({ sale_price: 45 }), { price: '60' }).errors).toEqual([])
  })
  it('clearing a sale price is a change to null', () => {
    expect(diffRow(cur({ sale_price: 45 }), { sale_price: '-' }).changes).toEqual({ sale_price: { from: 45, to: null } })
  })
  it('cannot switch on a product with no stock', () => {
    expect(diffRow(cur({ stock_quantity: 0, is_available: false }), { available: 'yes' }).errors[0]).toMatch(/0 stock/)
    expect(diffRow(cur({ stock_quantity: 0, is_available: false }), { available: 'yes', stock: '5' }).errors).toEqual([])
  })
  it('collects every bad cell, and reports no changes when anything is wrong', () => {
    const r = diffRow(cur(), { stock: 'x', price: '-1', cost_price: '12' })
    expect(r.errors).toHaveLength(2)
    expect(r.changes).toEqual({})
  })
  it('describes a change set in words', () => {
    expect(describeChanges({ stock: { from: 4, to: 10 }, sale_price: { from: null, to: 35 }, available: { from: true, to: false } })).toBe('Stock 4 → 10, Sale price — → 35, Available yes → no')
  })
})

describe('productKey', () => {
  it('prefers id, then SKU, then barcode', () => {
    expect(productKey({ product_id: 'x', sku: 'y' })).toEqual({ by: 'id', value: 'x' })
    expect(productKey({ sku: ' S1 ', barcode: 'b' })).toEqual({ by: 'sku', value: 'S1' })
    expect(productKey({ barcode: 'b' })).toEqual({ by: 'barcode', value: 'b' })
    expect(productKey({})).toBeNull()
  })
})
