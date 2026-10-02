import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { buildRows, classifyKnown, isUsable, mapColumns, readSheet } from '../../../src/modules/whatsapp-crm/prospect-import.js'

const csv = (s) => Buffer.from(s, 'utf8')

describe('readSheet', () => {
  it('reads CSV with a BOM and odd spacing', async () => {
    const rows = await readSheet(csv('﻿Name, Business Name ,Phone\nRavi,Ravi Stores,98765 43210\n'), 'p.csv')
    expect(rows).toEqual([{ Name: 'Ravi', 'Business Name': 'Ravi Stores', Phone: '98765 43210' }])
  })
  it('reads xlsx, keeping a phone typed as a number intact', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('s')
    ws.addRow(['Mobile', 'Shop'])
    ws.addRow([919876543210, 'Kiran Kirana'])
    ws.addRow([])
    const buf = Buffer.from(await wb.xlsx.writeBuffer())
    expect(await readSheet(buf, 'p.xlsx')).toEqual([{ Mobile: '919876543210', Shop: 'Kiran Kirana' }])
  })
  it('refuses other file types', async () => {
    await expect(readSheet(csv('x'), 'p.pdf')).rejects.toThrow(/csv or .xlsx/)
  })
})

describe('mapColumns', () => {
  it('recognises common header spellings', () => {
    expect(mapColumns([{ 'Contact Person': 'a', 'Mobile Number': '1', 'Shop Name': 's' }])).toMatchObject({ phone: 'Mobile Number', name: 'Contact Person', business: 'Shop Name' })
  })
  it('reports no phone column', () => {
    expect(mapColumns([{ Email: 'a@b.c' }]).phone).toBeNull()
  })
})

describe('buildRows', () => {
  const recs = [
    { Name: 'A', Phone: '9876543210' },
    { Name: 'B', Phone: '+91 98765 43210' }, // same number
    { Name: 'C', Phone: '12345' },
    { Name: 'D', Phone: '' },
    { Name: 'E', Phone: '+14155550123' }, // international with "+"
    { Name: 'F', Phone: '4155550123' }, // ambiguous without "+"
  ]
  it('marks invalid and repeated numbers, keeping the first of a repeat', () => {
    const { rows } = buildRows(recs)
    expect(rows.map((r) => [r.rowNumber, r.status, r.waId])).toEqual([
      [2, 'PENDING', '919876543210'], [3, 'DUPLICATE', '919876543210'], [4, 'INVALID', null], [5, 'INVALID', null], [6, 'PENDING', '14155550123'], [7, 'INVALID', null],
    ])
  })
})

describe('classifyKnown / isUsable', () => {
  const row = { status: 'PENDING', waId: '919876543210' }
  it('never lets anything override an opt-out or suppression', () => {
    expect(classifyKnown(row, { suppressed: true, isCustomer: true })).toBe('SUPPRESSED')
    expect(classifyKnown(row, { consent: 'OPTED_OUT', isCustomer: true, hasContact: true })).toBe('OPTED_OUT')
  })
  it('distinguishes customer / contact / new', () => {
    expect(classifyKnown(row, { isCustomer: true, hasContact: true })).toBe('EXISTING_CUSTOMER')
    expect(classifyKnown(row, { hasContact: true })).toBe('EXISTING_CONTACT')
    expect(classifyKnown(row, {})).toBe('NEW')
  })
  it('keeps invalid and duplicate as they are', () => {
    expect(classifyKnown({ status: 'INVALID' }, { hasContact: true })).toBe('INVALID')
    expect(classifyKnown({ status: 'DUPLICATE' }, {})).toBe('DUPLICATE')
  })
  it('existing customers are usable only when included', () => {
    expect(isUsable('NEW', false)).toBe(true)
    expect(isUsable('EXISTING_CUSTOMER', false)).toBe(false)
    expect(isUsable('EXISTING_CUSTOMER', true)).toBe(true)
    for (const s of ['INVALID', 'DUPLICATE', 'OPTED_OUT', 'SUPPRESSED']) expect(isUsable(s, true)).toBe(false)
  })
})
