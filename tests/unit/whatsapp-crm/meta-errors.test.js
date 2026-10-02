import { describe, expect, it } from 'vitest'
import { explainMetaError, parseGraphError } from '../../../src/modules/whatsapp-crm/meta-errors.js'

const graph = (httpStatus, code, message, extra = {}) => ({ response: { status: httpStatus, data: { error: { code, message, type: 'OAuthException', fbtrace_id: 'AbC123', ...extra } } } })
const explain = (err, ctx) => explainMetaError(parseGraphError(err), ctx)

describe('parseGraphError', () => {
  it('reads Meta’s error body and keeps the trace id for support', () => {
    expect(parseGraphError(graph(400, 190, 'bad', { error_subcode: 463 }))).toMatchObject({ httpStatus: 400, code: 190, subcode: 463, fbtraceId: 'AbC123', network: null })
  })
  it('recognises "never reached Meta" errors', () => {
    expect(parseGraphError({ code: 'ENOTFOUND', message: 'getaddrinfo' })).toMatchObject({ network: 'ENOTFOUND', httpStatus: null })
    expect(parseGraphError({ request: {}, message: 'x' }).network).toBe('NO_RESPONSE')
  })
})

describe('explainMetaError — every message tells you what to do', () => {
  it('expired token → how to create a permanent one', () => {
    const e = explain(graph(401, 190, 'Error validating access token: Session has expired', { error_subcode: 463 }))
    expect(e.title).toMatch(/expired/)
    expect(e.fixes.join(' ')).toMatch(/System users/)
    expect(e.fixes.join(' ')).toMatch(/Never/)
  })
  it('a wrong / cut token', () => {
    const e = explain(graph(400, 190, 'Invalid OAuth access token - Cannot parse access token'))
    expect(e.title).toMatch(/does not accept this access token/)
    expect(e.fixes[0]).toMatch(/EAA/)
  })
  it('a token cancelled by a password change', () => {
    expect(explain(graph(400, 190, 'The session has been invalidated because the user changed their password', { error_subcode: 460 })).title).toMatch(/cancelled/)
  })
  it('wrong phone number id / waba id read differently', () => {
    const m = "Unsupported get request. Object with ID '123' does not exist, cannot be loaded due to missing permissions, or does not support this operation"
    expect(explain(graph(400, 100, m, { error_subcode: 33 }), { step: 'phone' }).title).toMatch(/Phone number ID/)
    expect(explain(graph(400, 100, m, { error_subcode: 33 }), { step: 'waba' }).title).toMatch(/Business Account ID/)
  })
  it('missing permission', () => {
    const e = explain(graph(403, 200, '(#200) Requires whatsapp_business_management permission'))
    expect(e.title).toMatch(/not allowed/)
    expect(e.fixes.join(' ')).toMatch(/whatsapp_business_messaging/)
  })
  it('rate limit, temporary and restricted account', () => {
    expect(explain(graph(400, 4, 'Application request limit reached')).title).toMatch(/too many requests/)
    expect(explain(graph(500, 2, 'Service temporarily unavailable')).title).toMatch(/temporary/)
    expect(explain(graph(400, 368, 'Temporarily blocked for policies violations')).title).toMatch(/restricted/)
  })
  it('send-time problems: test-mode recipient, payment method, unregistered number, not on WhatsApp', () => {
    expect(explain(graph(400, 131030, 'Recipient phone number not in allowed list'), { step: 'send' }).title).toMatch(/test list/)
    expect(explain(graph(400, 131042, 'Business eligibility payment issue')).title).toMatch(/payment method/)
    expect(explain(graph(400, 133010, 'Account not registered')).title).toMatch(/not registered/)
    expect(explain(graph(400, 131026, 'Message undeliverable')).title).toMatch(/not on WhatsApp/)
  })
  it('network problems say what the server — not the details — is doing wrong', () => {
    expect(explain({ code: 'ETIMEDOUT', message: 'timeout of 12000ms exceeded' }).title).toMatch(/did not answer in time/)
    expect(explain({ code: 'ENOTFOUND', message: 'x' }).title).toMatch(/find Meta/)
    expect(explain({ code: 'ECONNREFUSED', message: 'x' }).title).toMatch(/cut/)
  })
  it('anything unknown still gets a title, the raw message and the technical block', () => {
    const e = explain(graph(400, 99999, 'Something odd'))
    expect(e.title).toBe('Meta returned an error')
    expect(e.cause).toBe('Something odd')
    expect(e.technical).toMatchObject({ code: 99999, fbtraceId: 'AbC123' })
  })
  it('every explanation has at least one fix step and no secrets in it', () => {
    for (const code of [190, 100, 200, 4, 368, 131042, 131030, 133010, 131026, 132001, 1, 99999]) {
      const e = explain(graph(400, code, 'm', { error_subcode: code === 100 ? 33 : undefined }))
      expect(e.fixes.length, `code ${code}`).toBeGreaterThan(0)
      expect(JSON.stringify(e)).not.toMatch(/EAA[A-Za-z0-9]{20}/)
    }
  })
})
