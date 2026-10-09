/**
 * Bot v2 helpers — pure functions, no I/O, no AI. See migration 156.
 *
 *  - detectLanguage : Gujarati script / Roman Gujarati / English
 *  - matchArea      : which delivery area (if any) a short message names, spelling-tolerant
 *  - matchProduct   : which product word (if any) a message names
 *  - localized wording for order status, opening hours and PIN results
 */
import { normalize } from './bot.js'

/** Languages the bot can answer in. gu = Gujarati script, gl = Gujarati written in English letters. */
export const LANGS = Object.freeze(['en', 'gu', 'gl'])

// Words that appear in Roman-Gujarati but not in ordinary English. Deliberately conservative.
const ROMAN_GUJARATI_WORDS = new Set([
  'tamaro', 'tamari', 'tamne', 'tame', 'tamara', 'kyo', 'kyan', 'kya', 'chhe', 'chho', 'che', 'shu', 'su', 'bhav', 'bhaav', 'bhaw',
  'joiye', 'joie', 'joiyo', 'ketla', 'ketlu', 'kem', 'kyare', 'nathi', 'mare', 'maru', 'mari', 'amne', 'amari', 'amaro', 'ame', 'aapo',
  'aapjo', 'karo', 'kari', 'karvu', 'thase', 'hase', 'mane', 'moklo', 'mokalo', 'jano', 'janavo', 'batavo', 'kimat', 'kinmat', 'ghare',
  'ni', 'nu', 'no', 'ma', 'pase', 'bajuma', 'vishe', 'etle', 'pan', 'ane', 'hu', 'hun', 'tamara', 'chalu', 'bandh', 'aavse', 'avse',
])
// "ni/nu/no/ma/pan/ane/hu/pase/che/kya" are common but ambiguous alone; they only count together with another marker.
const WEAK = new Set(['ni', 'nu', 'no', 'ma', 'pan', 'ane', 'hu', 'hun', 'che', 'kya', 'pase', 'ame', 'su', 'kem', 'mane', 'kari', 'karo'])

const GUJARATI_SCRIPT = /[઀-૿]/u

/**
 * @param {string} text
 * @param {string|null} [previous] the language we last settled on for this customer
 * @returns {{ lang: 'en'|'gu'|'gl', confident: boolean }}
 *   `confident:false` means "too little to tell" (e.g. "Hi", "Ok"), so the caller keeps `previous`.
 */
export function detectLanguage(text, previous = null) {
  const raw = String(text ?? '')
  if (GUJARATI_SCRIPT.test(raw)) return { lang: 'gu', confident: true }

  const tokens = normalize(raw).split(' ').filter(Boolean)
  const strong = tokens.filter((t) => ROMAN_GUJARATI_WORDS.has(t) && !WEAK.has(t)).length
  const weak = tokens.filter((t) => WEAK.has(t)).length
  if (strong >= 1 || weak >= 3) return { lang: 'gl', confident: true }

  const letters = tokens.join('').length
  if (letters >= 12 && tokens.length >= 3) return { lang: 'en', confident: true }
  return { lang: LANGS.includes(previous) ? previous : 'en', confident: false }
}

// ─── Fuzzy matching ─────────────────────────────────────────────────

function squash(text) {
  return normalize(text).replace(/ /g, '')
}

/** Levenshtein distance, early exit above `max`. */
export function editDistance(a, b, max = 2) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      rowMin = Math.min(rowMin, cur[j])
    }
    if (rowMin > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

/** Every run of 1–4 consecutive words, written together without spaces ("mota varachha" -> "motavarachha"). */
function windows(tokens, maxRun = 4) {
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    let s = ''
    for (let j = i; j < Math.min(tokens.length, i + maxRun); j++) {
      s += tokens[j]
      out.push(s)
    }
  }
  return out
}

/** Spelling tolerance by length: short names must match exactly, long ones may be 1–2 letters off. */
function tolerance(len) {
  if (len < 6) return 0
  return len >= 10 ? 2 : 1
}

/**
 * Which delivery area does this message name?
 * Only short messages are considered (a long sentence mentioning a place is not an answer to "your area?").
 * @param {string} text
 * @param {{ id: string, name: string, name_gu?: string, aliases: string[], is_serviceable: boolean }[]} areas
 * @returns {{ area: object, exact: boolean }|null}
 */
export function matchArea(text, areas) {
  const tokens = normalize(text).split(' ').filter(Boolean)
  if (tokens.length === 0 || tokens.length > 8) return null
  const cands = windows(tokens)
  let best = null
  for (const area of areas) {
    for (const alias of [area.name, area.name_gu, ...(area.aliases ?? [])]) {
      const a = squash(alias ?? '')
      if (!a) continue
      for (const c of cands) {
        const tol = Math.min(tolerance(a.length), tolerance(c.length))
        const d = c === a ? 0 : editDistance(a, c, tol)
        if (d > tol) continue
        const score = (d === 0 ? 100 : 50) + a.length
        if (!best || score > best.score) best = { area, exact: d === 0, score }
      }
    }
  }
  return best ? { area: best.area, exact: best.exact } : null
}

/**
 * Which known product word does this message contain?
 * @param {string} text
 * @param {{ alias: string, search_term: string }[]} aliases
 * @returns {string|null} the English search term for the catalog
 */
export function matchProduct(text, aliases) {
  const tokens = normalize(text).split(' ').filter(Boolean)
  if (tokens.length === 0 || tokens.length > 12) return null
  const cands = windows(tokens, 3)
  let best = null
  for (const row of aliases) {
    const a = squash(row.alias)
    if (!a) continue
    for (const c of cands) {
      const tol = Math.min(tolerance(a.length), tolerance(c.length))
      const d = c === a ? 0 : editDistance(a, c, tol)
      if (d > tol) continue
      const score = (d === 0 ? 100 : 50) + a.length
      if (!best || score > best.score) best = { term: row.search_term, score }
    }
  }
  return best?.term ?? null
}

// ─── Wording ────────────────────────────────────────────────────────

/** Pick the reply for the customer's language, falling back to English if that rule has no translation yet. */
export function pickText(en, gu, gl, lang) {
  if (lang === 'gu' && gu?.trim()) return gu
  if (lang === 'gl' && gl?.trim()) return gl
  return en
}

const ORDER_STATUS = Object.freeze({
  PENDING: ['waiting for payment confirmation', 'પેમેન્ટ કન્ફર્મેશનની રાહ જોવાઈ રહી છે', 'payment confirmation ni rah joi rahya chhiye'],
  CONFIRMED: ['confirmed', 'કન્ફર્મ થઈ ગયો છે', 'confirm thai gayo chhe'],
  PREPARING: ['being prepared', 'તૈયાર થઈ રહ્યો છે', 'taiyar thai rahyo chhe'],
  PACKED: ['packed and waiting for a delivery partner', 'પેક થઈ ગયો છે અને ડિલિવરી પાર્ટનરની રાહ જોવાઈ રહી છે', 'pack thai gayo chhe ane delivery partner ni rah joi rahya chhiye'],
  OUT_FOR_DELIVERY: ['out for delivery', 'ડિલિવરી માટે નીકળી ગયો છે', 'delivery mate nikli gayo chhe'],
  DELIVERED: ['delivered', 'ડિલિવર થઈ ગયો છે', 'deliver thai gayo chhe'],
  CANCELLED: ['cancelled', 'કેન્સલ થયો છે', 'cancel thayo chhe'],
  REFUNDED: ['refunded', 'રિફંડ થઈ ગયું છે', 'refund thai gayu chhe'],
})
const IDX = { en: 0, gu: 1, gl: 2 }

/** One sentence about the customer's latest order, or an honest "can't find one". */
export function describeLastOrderLocalized(order, lang = 'en') {
  const i = IDX[lang] ?? 0
  if (!order) {
    return [
      'I could not find a recent order on this number.',
      'આ નંબર પર મને કોઈ તાજેતરનો ઓર્ડર મળ્યો નથી.',
      'Aa number par mane koi taajo order malyo nathi.',
    ][i]
  }
  const raw = ORDER_STATUS[order.status]?.[i] ?? String(order.status ?? '').toLowerCase().replace(/_/g, ' ')
  return [`Your latest order ${order.order_number} is ${raw}.`, `તમારો તાજેતરનો ઓર્ડર ${order.order_number} ${raw}.`, `Tamaro taajo order ${order.order_number} ${raw}.`][i]
}

/** PIN-code answer in the customer's language. */
export function pincodeResult(listed, pincode, lang = 'en') {
  const i = IDX[lang] ?? 0
  if (listed) {
    return [`Good news! We deliver to ${pincode}.`, `ખુશખબર! અમે ${pincode} માં ડિલિવરી કરીએ છીએ.`, `Khushkhabar! Ame ${pincode} ma delivery karie chhie.`][i]
  }
  return [
    `I could not confirm delivery to ${pincode} automatically. A team member will check and reply here shortly.`,
    `${pincode} માં ડિલિવરી થાય છે કે નહીં તે હું આપમેળે ચકાસી શક્યો નથી. અમારી ટીમ તપાસીને અહીં જવાબ આપશે.`,
    `${pincode} ma delivery thay chhe ke nahi te hu automatically check na kari shakyo. Amari team check kari ne ahi jawab aapshe.`,
  ][i]
}

const DAY_GU = ['રવિવારે', 'સોમવારે', 'મંગળવારે', 'બુધવારે', 'ગુરુવારે', 'શુક્રવારે', 'શનિવારે']
const DAY_GL = ['ravivare', 'somvare', 'mangalvare', 'budhvare', 'guruvare', 'shukravare', 'shanivare']

/**
 * Localised version of bot.js describeHours: swaps the surrounding words only.
 * @param {string} englishPhrase output of describeHours(), e.g. "from 9:00 AM to 10:00 PM today"
 */
export function localizeHours(englishPhrase, lang = 'en') {
  if (lang === 'en') return englishPhrase
  const m = /^from (.+) to (.+) (today|tomorrow|on ([A-Za-z]+))$/.exec(englishPhrase)
  if (!m) {
    return lang === 'gu' ? 'અમારા કામકાજના સમય દરમિયાન' : 'amara kaamkaaj na samay darmiyan'
  }
  const [, open, close, whenWord, dayName] = m
  const dayIdx = dayName ? ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(dayName.toLowerCase()) : -1
  if (lang === 'gu') {
    const when = whenWord === 'today' ? 'આજે' : whenWord === 'tomorrow' ? 'આવતીકાલે' : DAY_GU[dayIdx] ?? ''
    return `${when} ${open} થી ${close} સુધી`
  }
  const when = whenWord === 'today' ? 'aaje' : whenWord === 'tomorrow' ? 'aavtikale' : DAY_GL[dayIdx] ?? ''
  return `${when} ${open} thi ${close} sudhi`
}
