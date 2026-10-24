import { describe, expect, it } from 'vitest'
import { csvCell, likePattern, maskPhone, toCsv } from '../../src/modules/erp/explorer.rules.js'

describe('search pattern', () => {
  it('wraps text and makes % and _ ordinary characters', () => {
    expect(likePattern('rice')).toBe('%rice%')
    expect(likePattern('100%_off\\')).toBe('%100\\%\\_off\\\\%')
    expect(likePattern('   ')).toBeNull()
    expect(likePattern(null)).toBeNull()
    expect(likePattern('x'.repeat(100))).toBe(`%${'x'.repeat(60)}%`)
  })
})

describe('phone masking', () => {
  it('keeps the first two and last four digits', () => {
    expect(maskPhone('9876543210')).toBe('98••••3210')
    expect(maskPhone('+91 98765 43210')).toBe('91••••3210')
    expect(maskPhone('123')).toBe('••••')
    expect(maskPhone(null)).toBe('')
  })
})

describe('CSV', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(12.5)).toBe('12.5')
  })
  it('defuses spreadsheet formulas typed into text fields', () => {
    for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '=HYPERLINK("http://x","y")']) expect(csvCell(evil).replace(/^"/, '')).toMatch(/^'/)
    expect(csvCell(-5)).toBe('-5') // a real negative number is not text
  })
  it('writes a header, rows, and a BOM for Excel', () => {
    const out = toCsv([{ key: 'n', label: 'Name' }, { key: 'v', label: 'Value' }], [{ n: 'Rice', v: 10 }, { n: '=bad', v: -1 }])
    expect(out).toBe("﻿Name,Value\r\nRice,10\r\n'=bad,-1\r\n")
  })
})
