import { BusinessError } from '../../utils/business-error.js'

/**
 * Repacking bulk stock into pack sizes — pure functions, no I/O.
 * Stock stays whole units: a repack uses WHOLE units of the bulk purchase, and the packs it makes cannot weigh more than that.
 * What is left over (trimming, spillage) is recorded as a loss — never hidden.
 */

const UNIT_WORDS = { kg: ['G', 1000], kgs: ['G', 1000], g: ['G', 1], gm: ['G', 1], gms: ['G', 1], gram: ['G', 1], grams: ['G', 1], l: ['ML', 1000], ltr: ['ML', 1000], litre: ['ML', 1000], liter: ['ML', 1000], ml: ['ML', 1] }

/** "500 g" → {size:500, unit:'G'}, "1.5 kg" → {size:1500, unit:'G'}, "250ml" → {size:250, unit:'ML'}. Anything else (e.g. "2 x 500 g", "Pack of 6") → null. */
export function parseNetQuantity(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(kgs|kg|gms|gm|grams|gram|g|ml|ltr|litre|liter|l)\s*$/i.exec(String(text ?? ''))
  if (!m) return null
  const [unit, factor] = UNIT_WORDS[m[2].toLowerCase()]
  const size = Math.round(Number(m[1]) * factor)
  return size > 0 ? { size, unit } : null
}

/** "1500 g" → "1.5 kg", "500 g" → "500 g", "250 ml" → "250 ml", "2000 ml" → "2 L". */
export function formatAmount(size, unit) {
  const big = size >= 1000
  const n = big ? size / 1000 : size
  const num = Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000)
  return `${num} ${unit === 'G' ? (big ? 'kg' : 'g') : (big ? 'L' : 'ml')}`
}

/** Validate a product's pack size. */
export function checkPackSize({ size, unit }) {
  if (!Number.isInteger(size) || size < 1 || size > 100_000_000) throw new BusinessError('Pack size must be a whole number of grams or millilitres.', 400, 'VALIDATION', { size: 'Invalid' })
  if (!['G', 'ML'].includes(unit)) throw new BusinessError('Choose grams (g / kg) or millilitres (ml / L).', 400, 'VALIDATION', { unit: 'Invalid' })
  return { size, unit }
}

/**
 * Work out a repack.
 * @param {{ unitSize:number, unit:string, price:number, available:number }} entry  one unit of the bulk purchase = `unitSize` g/ml, bought at `price`
 * @param {{ unitsUsed:number, lines:Array<{shopId:string, productId:string, packs:number, packSize:number, packUnit:string}> }} input
 * @returns {{ unitsUsed, gramsUsed, gramsPacked, gramsLost, lossPct, lossValue, lines: Array<{..., unitCost:number}> }}
 */
export function planRepack(entry, { unitsUsed, lines }) {
  if (!entry.unitSize) throw new BusinessError('Say how big one unit of this purchase is first (for example 1 kg).', 409, 'NO_PACK_SIZE')
  if (!Array.isArray(lines) || lines.length === 0) throw new BusinessError('Choose which packs to make.', 400, 'VALIDATION', { lines: 'Empty' })
  if (!Number.isInteger(unitsUsed) || unitsUsed < 1) throw new BusinessError('Units used must be a whole number of at least 1.', 400, 'VALIDATION', { unitsUsed: 'Invalid' })
  if (unitsUsed > entry.available) throw new BusinessError(`You are using ${unitsUsed} but only ${Math.max(0, entry.available)} is free.`, 409, 'OVER_ALLOCATION', { requested: unitsUsed, available: entry.available })
  const seen = new Set()
  let packed = 0
  const out = lines.map((l, i) => {
    if (!l.packSize) throw new BusinessError(`Line ${i + 1}: that pack has no size set.`, 409, 'NO_PACK_SIZE')
    if (l.packUnit !== entry.unit) throw new BusinessError(`Line ${i + 1}: ${l.packUnit === 'G' ? 'a weight' : 'a volume'} pack cannot be made from ${entry.unit === 'G' ? 'a weight' : 'a volume'} purchase.`, 400, 'UNIT_MISMATCH')
    if (!Number.isInteger(l.packs) || l.packs < 1) throw new BusinessError(`Line ${i + 1}: packs must be a whole number of at least 1.`, 400, 'VALIDATION', { packs: 'Invalid' })
    const key = `${l.shopId}:${l.productId}`
    if (seen.has(key)) throw new BusinessError('The same pack for the same store appears twice. Combine them.', 400, 'DUPLICATE_LINE')
    seen.add(key)
    packed += l.packs * l.packSize
    return { ...l, unitCost: Math.round((entry.price / entry.unitSize) * l.packSize * 10000) / 10000 }
  })
  const used = unitsUsed * entry.unitSize
  if (packed > used) {
    const need = Math.ceil(packed / entry.unitSize)
    throw new BusinessError(`Those packs weigh ${packed} but ${unitsUsed} unit${unitsUsed === 1 ? '' : 's'} hold only ${used}. Use at least ${need} unit${need === 1 ? '' : 's'}.`, 409, 'NOT_ENOUGH_BULK', { packed, used, need })
  }
  const lost = used - packed
  return { unitsUsed, gramsUsed: used, gramsPacked: packed, gramsLost: lost, lossPct: used > 0 ? Math.round((lost / used) * 1000) / 10 : 0, lossValue: Math.round(((entry.price / entry.unitSize) * lost) * 100) / 100, lines: out }
}

/** The fewest whole units that can hold the packs. */
export const unitsNeeded = (packedGrams, unitSize) => (unitSize > 0 ? Math.ceil(packedGrams / unitSize) : 0)
