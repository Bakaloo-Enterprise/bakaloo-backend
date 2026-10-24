/** Pure helpers for the Data Explorer: search patterns, phone masking and spreadsheet-safe CSV. */

/** `%` and `_` typed by a person must search for themselves, not act as wildcards. */
export function likePattern(q) {
  const s = String(q ?? '').trim().slice(0, 60)
  return s ? `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null
}

/** 9876543210 → 98••••3210. Staff see enough to recognise a customer, not a callable list. */
export function maskPhone(p) {
  const s = String(p ?? '').replace(/\D/g, '')
  return s.length >= 6 ? `${s.slice(0, 2)}••••${s.slice(-4)}` : s ? '••••' : ''
}

/**
 * One CSV cell. Cells starting with = + - @ (or tab / CR) are prefixed with an apostrophe so a spreadsheet shows them as text
 * instead of running them as a formula ("CSV injection": a customer name like =HYPERLINK(...) must stay inert).
 */
export function csvCell(v) {
  if (v == null) return ''
  let s = v instanceof Date ? v.toISOString() : String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(columns, rows) {
  const head = columns.map((c) => csvCell(c.label)).join(',')
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(','))
  return `﻿${[head, ...body].join('\r\n')}\r\n` // BOM so Excel opens ₹ and Indic names correctly
}
