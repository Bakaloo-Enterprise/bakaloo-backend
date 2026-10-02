import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { clientKey, cleanAccessToken, generateVerifyToken, maskSecret, resolveConfig, validateSettingsInput } from '../../../src/modules/whatsapp-crm/settings.js'
import { decryptSecret, encryptSecret } from '../../../src/utils/secret-box.js'

const TOKEN = 'EAAGm0PX4ZCpsBO' + 'x'.repeat(60)

describe('validateSettingsInput', () => {
  it('accepts the five values Meta gives you', () => {
    const { values, errors } = validateSettingsInput({ phoneNumberId: ' 109876543210987 ', wabaId: '123456789012345', accessToken: TOKEN, appSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', verifyToken: 'my-secret_word-1', appId: '1234567890123' })
    expect(errors).toEqual({})
    expect(values).toMatchObject({ phoneNumberId: '109876543210987', wabaId: '123456789012345', accessToken: TOKEN, verifyToken: 'my-secret_word-1' })
  })
  it('explains each mistake in plain words', () => {
    const { errors } = validateSettingsInput({ phoneNumberId: '+91 98765 43210', wabaId: 'abc', accessToken: 'short', appSecret: 'nothex', verifyToken: 'x y', appId: '12' })
    expect(Object.keys(errors).sort()).toEqual(['accessToken', 'appId', 'appSecret', 'phoneNumberId', 'verifyToken', 'wabaId'])
    expect(errors.phoneNumberId).toMatch(/NOT the phone number/)
    expect(errors.accessToken).toMatch(/EAA/)
  })
  it('strips "Bearer " and stray spaces / line breaks from a pasted token', () => {
    expect(cleanAccessToken(`  Bearer ${TOKEN.slice(0, 20)}\n${TOKEN.slice(20)} `)).toBe(TOKEN)
    expect(validateSettingsInput({ accessToken: `Bearer ${TOKEN}\n` }).values.accessToken).toBe(TOKEN)
  })
  it('leaves untouched what was not sent; an empty secret keeps the saved one; an empty plain field clears it', () => {
    expect(validateSettingsInput({}).values).toEqual({})
    expect(validateSettingsInput({ accessToken: '', appSecret: '  ', verifyToken: '' }).values).toEqual({})
    expect(validateSettingsInput({ phoneNumberId: '', wabaId: '' }).values).toEqual({ phoneNumberId: null, wabaId: null })
  })
  it('removes a secret only when asked explicitly', () => {
    expect(validateSettingsInput({ clear: ['accessToken', 'bogus'] }).values).toEqual({ accessToken: null })
  })
})

describe('masking and tokens', () => {
  it('shows enough to recognise a secret, never enough to use it', () => {
    expect(maskSecret(TOKEN)).toMatch(/^EAAG…xxxx$/)
    expect(maskSecret('short')).toBe('•••••')
    expect(maskSecret('')).toBe('')
    expect(maskSecret(TOKEN)).not.toContain(TOKEN.slice(10, 40))
  })
  it('generates different verify tokens that pass our own validation', () => {
    const a = generateVerifyToken()
    expect(a).not.toBe(generateVerifyToken())
    expect(validateSettingsInput({ verifyToken: a }).errors).toEqual({})
  })
})

describe('resolveConfig — dashboard wins, .env fills the gaps', () => {
  const env = { WHATSAPP_ENABLED: false, WHATSAPP_PHONE_NUMBER_ID: '111111111', WHATSAPP_ACCESS_TOKEN: 'ENVTOKEN', META_APP_SECRET: 'envsecret', WHATSAPP_API_VERSION: 'v25.0' }
  it('uses .env alone when nothing is saved', () => {
    const c = resolveConfig(null, null, env)
    expect(c).toMatchObject({ phoneNumberId: '111111111', accessToken: 'ENVTOKEN', enabled: false, enabledSource: 'server', wabaId: null })
    expect(c.sources).toMatchObject({ phoneNumberId: 'server', accessToken: 'server', wabaId: null })
  })
  it('a saved value beats the same value in .env, field by field', () => {
    const c = resolveConfig({ phone_number_id: '222222222', waba_id: '333333333', enabled: true }, { accessToken: 'SAVED' }, env)
    expect(c).toMatchObject({ phoneNumberId: '222222222', wabaId: '333333333', accessToken: 'SAVED', appSecret: 'envsecret', enabled: true, enabledSource: 'dashboard' })
    expect(c.sources).toMatchObject({ phoneNumberId: 'dashboard', accessToken: 'dashboard', appSecret: 'server' })
  })
  it('enabled = null in the database follows .env', () => {
    expect(resolveConfig({ enabled: null }, {}, { ...env, WHATSAPP_ENABLED: true }).enabled).toBe(true)
    expect(resolveConfig({ enabled: false }, {}, { ...env, WHATSAPP_ENABLED: true }).enabled).toBe(false)
  })
  it('the client fingerprint changes only when something it uses changes', () => {
    const a = resolveConfig({ phone_number_id: '222222222' }, { accessToken: 'T' }, env)
    expect(clientKey(a)).toBe(clientKey(resolveConfig({ phone_number_id: '222222222' }, { accessToken: 'T', verifyToken: 'other' }, env)))
    expect(clientKey(a)).not.toBe(clientKey(resolveConfig({ phone_number_id: '222222222' }, { accessToken: 'T2' }, env)))
  })
})

describe('secret box', () => {
  const key = crypto.createHash('sha256').update('k1').digest()
  it('round-trips and never stores the plain text', () => {
    const blob = encryptSecret(TOKEN, key)
    expect(blob.startsWith('v1:')).toBe(true)
    expect(blob).not.toContain(TOKEN)
    expect(decryptSecret(blob, key)).toBe(TOKEN)
  })
  it('uses a fresh IV every time', () => {
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key))
  })
  it('refuses a wrong key, a tampered value and rubbish — returning null, not throwing', () => {
    const blob = encryptSecret(TOKEN, key)
    expect(decryptSecret(blob, crypto.createHash('sha256').update('k2').digest())).toBeNull()
    const [v, iv, tag, data] = blob.split(':')
    expect(decryptSecret([v, iv, tag, Buffer.from('tampered').toString('base64')].join(':'), key)).toBeNull()
    for (const bad of [null, '', 'v1:onlyone', 'v9:a:b:c', 123]) expect(decryptSecret(bad, key)).toBeNull()
  })
})
