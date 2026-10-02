import { describe, expect, it } from 'vitest'
import { describeHours, describeLastOrder, extractPincode, findMatchingRule, friendlyName, normalize, renderTemplate, ruleMatches } from '../../../src/modules/whatsapp-crm/bot.js'

const OPEN = { isOpen: true, pincode: null }
const CLOSED = { isOpen: false, pincode: null }
const r = (o) => ({ is_active: true, when_hours: 'ANY', exact_keywords: [], keywords: [], ...o })

describe('normalize', () => {
  it.each([
    ['Hi!!  👋', 'hi'],
    ['  WHERE is   my ORDER?? ', 'where is my order'],
    ['Good-Morning,', 'good morning'],
    ['नमस्ते!', 'नमस्ते'],
    ['নমস্কার', 'নমস্কার'],
    ['ＨＥＬＬＯ', 'hello'], // full-width -> NFKC
    ['', ''],
    [null, ''],
  ])('%j -> %j', (i, o) => expect(normalize(i)).toBe(o))
})

describe('extractPincode', () => {
  it.each([
    ['my pin is 700091 thanks', '700091'],
    ['700091', '700091'],
    ['deliver to 700 091', null],
    ['call 9876543210', null], // phone number is not a pincode
    ['order 1234567', null], // 7 digits
    ['012345', null], // PINs never start with 0
    ['pin:700091.', '700091'],
  ])('%j -> %j', (i, o) => expect(extractPincode(i)).toBe(o))
})

describe('ruleMatches', () => {
  it('CONTAINS matches whole words/phrases only', () => {
    const rule = r({ match_type: 'CONTAINS', keywords: ['where is my order', 'track'] })
    expect(ruleMatches(rule, 'Hi, where is my order?', OPEN)).toBe(true)
    expect(ruleMatches(rule, 'can I TRACK it', OPEN)).toBe(true)
    expect(ruleMatches(rule, 'trackpad please', OPEN)).toBe(false) // substring of a word
    expect(ruleMatches(rule, 'where my is order', OPEN)).toBe(false) // order matters inside a phrase
  })
  it('EXACT matches only the whole message', () => {
    const rule = r({ match_type: 'EXACT', keywords: ['hi', 'hello'] })
    expect(ruleMatches(rule, 'Hi!', OPEN)).toBe(true)
    expect(ruleMatches(rule, 'hi, where is my order', OPEN)).toBe(false)
  })
  it('STARTS_WITH', () => {
    const rule = r({ match_type: 'STARTS_WITH', keywords: ['refund'] })
    expect(ruleMatches(rule, 'Refund please', OPEN)).toBe(true)
    expect(ruleMatches(rule, 'refunded', OPEN)).toBe(false)
    expect(ruleMatches(rule, 'I want a refund', OPEN)).toBe(false)
  })
  it('menu digits only fire when the WHOLE message is the digit', () => {
    const rule = r({ match_type: 'CONTAINS', keywords: ['order status'], exact_keywords: ['2'] })
    expect(ruleMatches(rule, '2', OPEN)).toBe(true)
    expect(ruleMatches(rule, ' 2 ', OPEN)).toBe(true)
    expect(ruleMatches(rule, '2 kg onions please', OPEN)).toBe(false)
    expect(ruleMatches(rule, 'send 5 kg rice', OPEN)).toBe(false)
    expect(ruleMatches(rule, 'what is my order status', OPEN)).toBe(true)
  })
  it('PINCODE rule needs a pincode in context', () => {
    const rule = r({ match_type: 'PINCODE' })
    expect(ruleMatches(rule, '700091', { isOpen: true, pincode: '700091' })).toBe(true)
    expect(ruleMatches(rule, 'hello', OPEN)).toBe(false)
  })
  it('opening-hours condition', () => {
    const open = r({ match_type: 'EXACT', keywords: ['hi'], when_hours: 'OPEN' })
    const closed = r({ match_type: 'EXACT', keywords: ['hi'], when_hours: 'CLOSED' })
    expect(ruleMatches(open, 'hi', OPEN)).toBe(true)
    expect(ruleMatches(open, 'hi', CLOSED)).toBe(false)
    expect(ruleMatches(closed, 'hi', CLOSED)).toBe(true)
    expect(ruleMatches(closed, 'hi', OPEN)).toBe(false)
  })
  it('works for Hindi and Bengali keywords', () => {
    expect(ruleMatches(r({ match_type: 'EXACT', keywords: ['नमस्ते'] }), 'नमस्ते!', OPEN)).toBe(true)
    expect(ruleMatches(r({ match_type: 'CONTAINS', keywords: ['অর্ডার'] }), 'আমার অর্ডার কোথায়', OPEN)).toBe(true)
  })
  it('empty / emoji-only messages and empty keywords never match', () => {
    expect(ruleMatches(r({ match_type: 'CONTAINS', keywords: ['hi'] }), '👍', OPEN)).toBe(false)
    expect(ruleMatches(r({ match_type: 'CONTAINS', keywords: [''] }), 'anything', OPEN)).toBe(false)
    expect(ruleMatches(r({ match_type: 'STARTS_WITH', keywords: [''] }), 'anything', OPEN)).toBe(false)
  })
})

describe('findMatchingRule', () => {
  const rules = [
    r({ id: 'person', match_type: 'CONTAINS', keywords: ['agent'] }),
    r({ id: 'order', match_type: 'CONTAINS', keywords: ['my order'] }),
    r({ id: 'greet', match_type: 'EXACT', keywords: ['hi'] }),
    r({ id: 'off', match_type: 'CONTAINS', keywords: ['offers'], is_active: false }),
  ]
  it('first match in order wins', () => {
    expect(findMatchingRule(rules, 'talk to an agent about my order', OPEN).id).toBe('person')
    expect(findMatchingRule(rules, 'hi where is my order', OPEN).id).toBe('order') // not the bare greeting
    expect(findMatchingRule(rules, 'hi', OPEN).id).toBe('greet')
  })
  it('skips inactive rules and returns null when nothing matches', () => {
    expect(findMatchingRule(rules, 'any offers', OPEN)).toBeNull()
    expect(findMatchingRule(rules, 'qwerty', OPEN)).toBeNull()
  })
})

describe('renderTemplate / friendlyName / describeLastOrder', () => {
  it('fills variables, blanks unknown ones, trims, caps length', () => {
    expect(renderTemplate('Hi {{customer_name}}, {{ last_order }} {{nope}}', { customer_name: 'Rahul', last_order: 'Done.' })).toBe('Hi Rahul, Done.')
    expect(renderTemplate('x'.repeat(5000), {}).length).toBe(4096)
  })
  it('does not re-expand variables inside values (no injection)', () => {
    expect(renderTemplate('{{customer_name}}', { customer_name: '{{last_order}}', last_order: 'SECRET' })).toBe('{{last_order}}')
  })
  it('friendlyName uses the first usable name, never a phone number', () => {
    expect(friendlyName('Rahul Das', 'x')).toBe('Rahul')
    expect(friendlyName(null, '9876543210', 'Priya S.')).toBe('Priya')
    expect(friendlyName('+919876543210', '')).toBe('there')
  })
  it('describes the latest order or says none was found', () => {
    expect(describeLastOrder({ order_number: 'BK10482', status: 'OUT_FOR_DELIVERY' })).toBe('Your latest order BK10482 is out for delivery.')
    expect(describeLastOrder({ order_number: 'BK1', status: 'WEIRD_NEW' })).toBe('Your latest order BK1 is weird new.')
    expect(describeLastOrder(null)).toMatch(/could not find/)
  })
})

describe('describeHours (IST)', () => {
  const week = Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((d) => [d, { open: '09:00', close: '22:00' }]))
  // 2026-10-02 is a Friday. IST = UTC+5:30.
  const at = (h, m) => new Date(Date.UTC(2026, 9, 2, 0, 0) + ((h * 60 + m) - 330) * 60000)

  it('before opening or during the day -> today', () => {
    expect(describeHours(week, at(7, 0))).toBe('from 9:00 AM to 10:00 PM today')
    expect(describeHours(week, at(15, 30))).toBe('from 9:00 AM to 10:00 PM today')
  })
  it('after closing -> tomorrow', () => {
    expect(describeHours(week, at(22, 30))).toBe('from 9:00 AM to 10:00 PM tomorrow')
  })
  it('skips closed days and names the weekday', () => {
    const w = { ...week, saturday: { closed: true }, sunday: { closed: true } }
    expect(describeHours(w, at(23, 0))).toBe('from 9:00 AM to 10:00 PM on Monday')
  })
  it('uses 12-hour wording incl. noon/midnight edge cases', () => {
    expect(describeHours({ ...week, friday: { open: '00:00', close: '12:30' } }, at(1, 0))).toBe('from 12:00 AM to 12:30 PM today')
  })
  it('falls back politely when there is no usable schedule', () => {
    for (const bad of [null, {}, { friday: { open: 'x', close: 'y' } }]) expect(describeHours(bad, at(10, 0))).toBe('during our regular working hours')
  })
})
