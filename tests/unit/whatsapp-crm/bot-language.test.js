import { describe, expect, it } from 'vitest'
import { detectLanguage, editDistance, localizeHours, matchArea, matchProduct, pickText, describeLastOrderLocalized } from '../../../src/modules/whatsapp-crm/bot-language.js'
import { ruleMatches, renderTemplate } from '../../../src/modules/whatsapp-crm/bot.js'

const AREAS = [
  { id: 'mv', name: 'Mota Varachha', name_gu: 'મોટા વરાછા', aliases: ['motavarachha', 'mota varacha', 'મોટા varacha'], is_serviceable: true },
  { id: 'ut', name: 'Utran', name_gu: 'ઉતરાણ', aliases: ['uttran', 'ઉત્રાણ'], is_serviceable: true },
  { id: 'am', name: 'Amroli', name_gu: 'અમરોલી', aliases: [], is_serviceable: false },
  { id: 'pal', name: 'Pal', name_gu: 'પાલ', aliases: [], is_serviceable: false },
  { id: 'nv', name: 'Nana Varachha', name_gu: 'નાના વરાછા', aliases: [], is_serviceable: false },
]
const PRODUCTS = [
  { alias: 'libu', search_term: 'lemon' }, { alias: 'લીંબુ', search_term: 'lemon' }, { alias: 'dungli', search_term: 'onion' },
  { alias: 'ડુંગળી', search_term: 'onion' }, { alias: 'tameta', search_term: 'tomato' }, { alias: 'dudh', search_term: 'milk' }, { alias: 'dudhi', search_term: 'gourd' },
]

describe('detectLanguage — real customer lines', () => {
  it.each([
    ['ડુંગળી મોટી સાઈઝ લાલ કેસરી પતી વાળી', 'gu', true],
    ['મોટા વરાછા', 'gu', true],
    ['Tamaro Area kyo chhe ?', 'gl', true],
    ['Libu no su bhav 6', 'gl', true],
    ['Ketla KG joi chhe ?', 'gl', true],
    ['Where are you serviceable?', 'en', true],
    ['How can I order ?', 'en', true],
    ['What is price of different vegetables?', 'en', true],
  ])('%s -> %s', (t, lang, confident) => expect(detectLanguage(t)).toEqual({ lang, confident }))

  it('short or empty-signal messages keep the previous language', () => {
    expect(detectLanguage('Hi')).toEqual({ lang: 'en', confident: false })
    expect(detectLanguage('Ok', 'gu')).toEqual({ lang: 'gu', confident: false })
    expect(detectLanguage('Amroli', 'gl')).toEqual({ lang: 'gl', confident: false })
  })
})

describe('editDistance', () => {
  it('counts single edits and stops early', () => {
    expect(editDistance('utran', 'uttran')).toBe(1)
    expect(editDistance('abc', 'xyz', 1)).toBeGreaterThan(1)
  })
})

describe('matchArea — what customers actually typed', () => {
  const hit = (t) => matchArea(t, AREAS)?.area.id ?? null
  it.each([
    ['Mota Varachha', 'mv'], ['motavarachha', 'mv'], ['Mota Varacha', 'mv'], ['મોટા વરાછા', 'mv'], ['રામ ચોક મોટા varacha', 'mv'],
    ['Utran', 'ut'], ['uttran', 'ut'], ['ઉતરાણ', 'ut'], ['ઉત્રાણ', 'ut'],
    ['Amroli', 'am'], ['amroli surat', 'am'], ['Pal surat', 'pal'],
  ])('%s -> %s', (t, id) => expect(hit(t)).toBe(id))

  it('does not guess', () => {
    expect(hit('Yogi chowk')).toBeNull()
    expect(hit('Sarthana jakatnaka')).toBeNull() // not in this test list
    expect(hit('How can I order ?')).toBeNull()
    expect(hit('Where are you serviceable?')).toBeNull()
    expect(hit('Hi')).toBeNull()
    expect(hit('palak')).toBeNull() // spinach, not Pal
    expect(hit('')).toBeNull()
  })
  it('Nana Varachha is NOT Mota Varachha', () => {
    expect(hit('nana varachha')).toBe('nv')
    expect(hit('varachha')).toBeNull()
  })
  it('a long sentence is not an answer to "which area"', () => {
    expect(hit('I was in Amroli yesterday and my friend told me about you but I live somewhere else entirely')).toBeNull()
  })
})

describe('matchProduct', () => {
  it.each([
    ['Libu no su bhav 6', 'lemon'], ['Liquid ni su priec', null], ['લીંબુ છે?', 'lemon'], ['સૂકી ડુંગળી મહારાષ્ટ ની', 'onion'], ['tamata', 'tomato'], ['dudhi', 'gourd'], ['dudh', 'milk'],
    ['Vegetables ni price please', null],
  ])('%s -> %s', (t, term) => expect(matchProduct(t, PRODUCTS)).toBe(term))
})

describe('new rule types', () => {
  const rule = (match_type) => ({ is_active: true, when_hours: 'ANY', keywords: [], exact_keywords: [], match_type })
  const ctx = (o) => ({ isOpen: true, pincode: null, area: null, awaitingArea: false, product: null, ...o })
  it('AREA_YES / AREA_NO', () => {
    expect(ruleMatches(rule('AREA_YES'), 'Utran', ctx({ area: AREAS[1] }))).toBe(true)
    expect(ruleMatches(rule('AREA_YES'), 'Amroli', ctx({ area: AREAS[2] }))).toBe(false)
    expect(ruleMatches(rule('AREA_NO'), 'Amroli', ctx({ area: AREAS[2] }))).toBe(true)
    expect(ruleMatches(rule('AREA_NO'), 'Utran', ctx({ area: AREAS[1] }))).toBe(false)
  })
  it('AREA_ASKED only when we asked, no area matched and the answer is short', () => {
    expect(ruleMatches(rule('AREA_ASKED'), 'Yogi chowk', ctx({ awaitingArea: true }))).toBe(true)
    expect(ruleMatches(rule('AREA_ASKED'), 'Yogi chowk', ctx({ awaitingArea: false }))).toBe(false)
    expect(ruleMatches(rule('AREA_ASKED'), 'Utran', ctx({ awaitingArea: true, area: AREAS[1] }))).toBe(false)
    expect(ruleMatches(rule('AREA_ASKED'), 'one two three four five six seven', ctx({ awaitingArea: true }))).toBe(false)
  })
  it('PRODUCT', () => {
    expect(ruleMatches(rule('PRODUCT'), 'libu', ctx({ product: 'lemon' }))).toBe(true)
    expect(ruleMatches(rule('PRODUCT'), 'hello', ctx())).toBe(false)
  })
})

describe('wording', () => {
  it('pickText falls back to English when a translation is missing', () => {
    expect(pickText('Hello', 'નમસ્તે', null, 'gu')).toBe('નમસ્તે')
    expect(pickText('Hello', 'નમસ્તે', null, 'gl')).toBe('Hello')
    expect(pickText('Hello', '  ', 'Namaste', 'gu')).toBe('Hello')
  })
  it('order sentence in every language, and an honest "none found"', () => {
    const o = { order_number: 'BK1', status: 'OUT_FOR_DELIVERY' }
    expect(describeLastOrderLocalized(o, 'en')).toBe('Your latest order BK1 is out for delivery.')
    expect(describeLastOrderLocalized(o, 'gu')).toContain('BK1')
    expect(describeLastOrderLocalized(o, 'gl')).toContain('delivery mate nikli')
    expect(describeLastOrderLocalized(null, 'gu')).toContain('ઓર્ડર')
  })
  it('opening hours keep the times and swap the words', () => {
    expect(localizeHours('from 9:00 AM to 10:00 PM today', 'gu')).toBe('આજે 9:00 AM થી 10:00 PM સુધી')
    expect(localizeHours('from 9:00 AM to 10:00 PM tomorrow', 'gl')).toBe('aavtikale 9:00 AM thi 10:00 PM sudhi')
    expect(localizeHours('from 9:00 AM to 10:00 PM on Monday', 'gl')).toContain('somvare')
    expect(localizeHours('during our regular working hours', 'en')).toBe('during our regular working hours')
  })
  it('an unknown name leaves no stray space before the comma', () => {
    expect(renderTemplate('નમસ્તે {{customer_name}}, આવો', { customer_name: '' })).toBe('નમસ્તે, આવો')
  })
})
