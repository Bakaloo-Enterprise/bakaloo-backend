import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { waIdToIndianPhone, toWaId, isBsuid } from '../../../src/modules/whatsapp-crm/phone.js'
import {
  verifyMetaSignature,
  checkVerifyHandshake,
  parseSecrets,
} from '../../../src/modules/whatsapp-crm/webhook-signature.js'

describe('waIdToIndianPhone', () => {
  it('maps a WhatsApp id to the 10-digit number stored in users.phone', () => {
    expect(waIdToIndianPhone('919876543210')).toBe('9876543210')
  })
  it('returns null for non-Indian, malformed or empty ids instead of guessing', () => {
    expect(waIdToIndianPhone('14155551212')).toBeNull() // US
    expect(waIdToIndianPhone('915876543210')).toBeNull() // Indian mobiles start 6-9
    expect(waIdToIndianPhone('91987654321')).toBeNull() // too short
    expect(waIdToIndianPhone('')).toBeNull()
    expect(waIdToIndianPhone(null)).toBeNull()
  })
  it('does not partially match: a different customer with the same last 8 digits is NOT the same', () => {
    expect(waIdToIndianPhone('919876543210')).not.toBe(waIdToIndianPhone('918876543210'))
  })
})

describe('toWaId', () => {
  it.each([
    ['9876543210', '919876543210'],
    ['09876543210', '919876543210'],
    ['919876543210', '919876543210'],
    ['+91 98765-43210', '919876543210'],
    ['+1 (415) 555-1212', '14155551212'],
  ])('accepts %s', (input, expected) => {
    expect(toWaId(input)).toBe(expected)
  })
  it.each(['4155551212', '12345', 'abc', '', null, undefined, '+0123456789'])(
    'rejects ambiguous/invalid %s',
    (input) => {
      expect(toWaId(input)).toBeNull()
    },
  )
})

describe('isBsuid', () => {
  it('recognises business-scoped user ids and never confuses them with phones', () => {
    expect(isBsuid('IN.13491208655302741918')).toBe(true)
    expect(isBsuid('US.ENT.11815799212886844830')).toBe(true)
    expect(isBsuid('919876543210')).toBe(false)
    expect(isBsuid(undefined)).toBe(false)
  })
})

describe('verifyMetaSignature', () => {
  const secret = 'app-secret-123'
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] })
  const sign = (b, s) => 'sha256=' + crypto.createHmac('sha256', s).update(b).digest('hex')

  it('accepts a correctly signed raw body (string or Buffer)', () => {
    expect(verifyMetaSignature(body, sign(body, secret), secret)).toBe(true)
    expect(verifyMetaSignature(Buffer.from(body), sign(body, secret), secret)).toBe(true)
  })
  it('rejects a tampered body, wrong secret, missing/odd header', () => {
    expect(verifyMetaSignature(body + ' ', sign(body, secret), secret)).toBe(false)
    expect(verifyMetaSignature(body, sign(body, 'other'), secret)).toBe(false)
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false)
    expect(verifyMetaSignature(body, 'sha256=abc', secret)).toBe(false) // wrong length must not throw
    expect(verifyMetaSignature(body, sign(body, secret).replace('sha256=', 'md5='), secret)).toBe(false)
  })
  it('FAILS CLOSED when no secret is configured', () => {
    expect(verifyMetaSignature(body, sign(body, secret), undefined)).toBe(false)
    expect(verifyMetaSignature(body, sign(body, secret), '')).toBe(false)
    expect(verifyMetaSignature(body, sign(body, ''), ' , ')).toBe(false)
  })
  it('accepts any of several comma-separated app secrets', () => {
    expect(parseSecrets(' a , b ,, c')).toEqual(['a', 'b', 'c'])
    expect(verifyMetaSignature(body, sign(body, 'second'), 'first, second')).toBe(true)
  })
})

describe('checkVerifyHandshake', () => {
  const q = (o) => ({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '12345', ...o })
  it('echoes the challenge for the right token', () => {
    expect(checkVerifyHandshake(q({}), 'tok')).toBe('12345')
  })
  it('refuses wrong token, wrong mode, missing challenge, or no configured token', () => {
    expect(checkVerifyHandshake(q({ 'hub.verify_token': 'nope' }), 'tok')).toBeNull()
    expect(checkVerifyHandshake(q({ 'hub.mode': 'unsubscribe' }), 'tok')).toBeNull()
    expect(checkVerifyHandshake(q({ 'hub.challenge': '' }), 'tok')).toBeNull()
    expect(checkVerifyHandshake(q({}), undefined)).toBeNull()
  })
})
