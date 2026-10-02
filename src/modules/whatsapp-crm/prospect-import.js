import { parse } from 'csv-parse'
import ExcelJS from 'exceljs'
import { toWaId, waIdToIndianPhone } from './phone.js'

/** Pure + file-reading helpers for prospect sheets (Phase 8). The database is not touched here. */

export const MAX_PROSPECT_ROWS = 5000

const ALIASES = {
  phone: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'number', 'whatsapp', 'whatsappnumber', 'contactnumber', 'contact'],
  name: ['name', 'contactname', 'contactperson', 'owner', 'ownername', 'person', 'fullname'],
  business: ['business', 'businessname', 'company', 'companyname', 'shop', 'shopname', 'store', 'storename', 'firm'],
}

const norm = (h) => String(h ?? '').trim().toLowerCase().replace(/[\s_\-.]/g, '')

function cell(v) {
  if (v == null) return ''
  if (typeof v === 'object') {
    if (v instanceof Date) return ''
    if ('result' in v) return String(v.result ?? '')
    if ('text' in v) return String(v.text ?? '')
    if ('richText' in v) return v.richText.map((r) => r.text).join('')
    return ''
  }
  // a phone typed as a number in Excel arrives as 9.19876543210e11 for large values — print it plainly
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v)
  return String(v)
}

/** @returns {Promise<Array<Record<string,string>>>} one record per data row, keyed by the header text */
export async function readSheet(buffer, filename = '') {
  const ext = String(filename).toLowerCase().split('.').pop()
  if (ext === 'csv') {
    const rows = await new Promise((resolve, reject) => {
      parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }, (err, data) => (err ? reject(err) : resolve(data)))
    })
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)])))
  }
  if (ext !== 'xlsx') throw new Error('Upload a .csv or .xlsx file')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const ws = wb.worksheets[0]
  if (!ws) return []
  const headerValues = ws.getRow(1).values
  const headers = Array.isArray(headerValues) ? headerValues.slice(1).map((h) => cell(h).trim()) : []
  const out = []
  ws.eachRow((row, n) => {
    if (n === 1) return
    const values = Array.isArray(row.values) ? row.values.slice(1) : []
    const rec = {}
    headers.forEach((h, i) => { rec[h] = cell(values[i]).trim() })
    if (Object.values(rec).some(Boolean)) out.push(rec)
  })
  return out
}

/** Which header is the phone / name / business column? */
export function mapColumns(records) {
  const headers = Object.keys(records[0] ?? {})
  const find = (kind) => headers.find((h) => ALIASES[kind].includes(norm(h))) ?? null
  return { phone: find('phone'), name: find('name'), business: find('business'), headers }
}

const clip = (s, n) => String(s ?? '').trim().slice(0, n) || null

/**
 * Turn sheet records into rows with a number we can use. Matching against our database happens later;
 * here: bad numbers are INVALID, a repeat of an earlier number in the same file is DUPLICATE.
 *
 * @returns {{ rows: Array<{ rowNumber: number, name: string|null, business: string|null, phoneRaw: string|null, waId: string|null, status: 'PENDING'|'INVALID'|'DUPLICATE' }>, columns: object }}
 */
export function buildRows(records) {
  const columns = mapColumns(records)
  const seen = new Set()
  const rows = records.map((rec, i) => {
    const phoneRaw = clip(rec[columns.phone], 40)
    const waId = toWaId(phoneRaw)
    let status = 'PENDING'
    if (!waId) status = 'INVALID'
    else if (seen.has(waId)) status = 'DUPLICATE'
    else seen.add(waId)
    return { rowNumber: i + 2, name: clip(columns.name ? rec[columns.name] : null, 120), business: clip(columns.business ? rec[columns.business] : null, 160), phoneRaw, waId: waId ?? null, status }
  })
  return { rows, columns }
}

/**
 * Final status of a row given what the database already knows about its number.
 * Order matters: a person who opted out or is suppressed is never contacted, whatever else is true.
 *
 * @param {{ status: string, waId: string|null }} row
 * @param {{ suppressed?: boolean, consent?: string, hasContact?: boolean, isCustomer?: boolean }} known
 */
export function classifyKnown(row, known) {
  if (row.status !== 'PENDING') return row.status
  if (known.suppressed) return 'SUPPRESSED'
  if (known.consent === 'OPTED_OUT') return 'OPTED_OUT'
  if (known.isCustomer) return 'EXISTING_CUSTOMER'
  if (known.hasContact) return 'EXISTING_CONTACT'
  return 'NEW'
}

export const ROW_STATUS_TEXT = Object.freeze({
  NEW: 'New prospect',
  EXISTING_CONTACT: 'Already in WhatsApp CRM',
  EXISTING_CUSTOMER: 'Already a Bakaloo customer',
  INVALID: 'Not a valid phone number',
  DUPLICATE: 'Repeated in this file',
  OPTED_OUT: 'Opted out earlier — never contacted',
  SUPPRESSED: 'On the do-not-contact list',
})

/** Which statuses become reachable when the import is confirmed. */
export function isUsable(status, includeExisting) {
  return status === 'NEW' || status === 'EXISTING_CONTACT' || (includeExisting && status === 'EXISTING_CUSTOMER')
}

export { waIdToIndianPhone }
