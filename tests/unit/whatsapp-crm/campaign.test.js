import { describe, expect, it } from 'vitest'
import {
  cartRef, classifySendError, consentDecision, evaluateConditions, interpolate, isQuietHoursIST,
  resolveTemplateValues, unfillableKeys, validateCampaignInput, validateWorkflowInput,
} from '../../../src/modules/whatsapp-crm/campaign.js'
import { MetaApiError } from '../../../src/modules/whatsapp-crm/meta-client.js'

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tpl = {
  parameter_format: 'NAMED',
  components: [{ type: 'BODY', text: 'Hi {{customer_name}}, your cart of Rs {{cart_value}} awaits. Code {{coupon_code}}', example: { body_text_named_params: [
    { param_name: 'customer_name', example: 'Rahul' }, { param_name: 'cart_value', example: '500' }, { param_name: 'coupon_code', example: 'SAVE10' }] } }],
}

describe('consentDecision', () => {
  const base = { category: 'MARKETING', consent: 'OPTED_IN', hasAddress: true }
  it('allows opted-in contacts for any category', () => {
    expect(consentDecision(base).ok).toBe(true)
    expect(consentDecision({ ...base, category: 'UTILITY' }).ok).toBe(true)
  })
  it('never sends to opted-out or suppressed contacts, even when opted in before', () => {
    expect(consentDecision({ ...base, consent: 'OPTED_OUT' })).toEqual({ ok: false, reason: 'OPTED_OUT' })
    expect(consentDecision({ ...base, suppressed: true })).toEqual({ ok: false, reason: 'SUPPRESSED' })
  })
  it('blocks marketing to unknown consent, even if they once messaged us', () => {
    expect(consentDecision({ ...base, consent: 'UNKNOWN', hasMessagedUs: true })).toEqual({ ok: false, reason: 'NO_CONSENT' })
  })
  it('lets a utility message reach an unknown-consent contact only if they messaged us first', () => {
    expect(consentDecision({ ...base, category: 'UTILITY', consent: 'UNKNOWN', hasMessagedUs: true }).ok).toBe(true)
    expect(consentDecision({ ...base, category: 'UTILITY', consent: 'UNKNOWN', hasMessagedUs: false })).toEqual({ ok: false, reason: 'NO_CONSENT' })
  })
  it('needs an address', () => {
    expect(consentDecision({ ...base, hasAddress: false })).toEqual({ ok: false, reason: 'NO_ADDRESS' })
  })
})

describe('isQuietHoursIST', () => {
  it('is quiet 9 pm – 9 am India time', () => {
    expect(isQuietHoursIST(new Date('2026-10-01T15:29:00Z'))).toBe(false) // 20:59 IST
    expect(isQuietHoursIST(new Date('2026-10-01T15:30:00Z'))).toBe(true) // 21:00 IST
    expect(isQuietHoursIST(new Date('2026-10-01T22:00:00Z'))).toBe(true) // 03:30 IST
    expect(isQuietHoursIST(new Date('2026-10-01T03:29:00Z'))).toBe(true) // 08:59 IST
    expect(isQuietHoursIST(new Date('2026-10-01T03:30:00Z'))).toBe(false) // 09:00 IST
  })
})

describe('template values', () => {
  it('interpolates known tokens and blanks unknown ones', () => {
    expect(interpolate('Hi {{customer_name}} {{nope}}!', { customer_name: 'Asha' })).toBe('Hi Asha !')
  })
  it('typed value wins, otherwise the same-named token fills in, otherwise it is missing', () => {
    const r = resolveTemplateValues(tpl, { cart_value: 'about {{cart_value}}' }, { customer_name: 'Asha', cart_value: 700 })
    expect(r.values).toEqual({ customer_name: 'Asha', cart_value: 'about 700' })
    expect(r.missing).toEqual(['coupon_code'])
  })
  it('unfillableKeys reports variables nobody can fill', () => {
    expect(unfillableKeys(tpl, {}, ['customer_name', 'cart_value'])).toEqual(['coupon_code'])
    expect(unfillableKeys(tpl, { coupon_code: 'X' }, ['customer_name', 'cart_value'])).toEqual([])
  })
})

describe('classifySendError', () => {
  const err = (code, retryable = false) => new MetaApiError('x', { code, retryable })
  it('retries temporary errors up to the limit, then fails', () => {
    expect(classifySendError(err(131056, true), 1)).toEqual({ retry: true })
    expect(classifySendError(err(131056, true), 3).retry).toBe(false)
  })
  it('turns customer-level refusals into skips and records opt-out', () => {
    expect(classifySendError(err(131050), 1)).toMatchObject({ status: 'SKIPPED', reason: 'OPTED_OUT', setConsent: 'OPTED_OUT' })
    expect(classifySendError(err(131049), 1)).toMatchObject({ status: 'SKIPPED', reason: 'MARKETING_CAP' })
    expect(classifySendError(err(131026), 1)).toMatchObject({ status: 'SKIPPED', reason: 'NOT_ON_WHATSAPP' })
  })
  it('pauses the campaign when the template itself is the problem', () => {
    for (const c of [132001, 132015, 132016]) expect(classifySendError(err(c), 1)).toMatchObject({ status: 'FAILED', pauseCampaign: true })
  })
})

describe('validateCampaignInput', () => {
  const ok = { name: 'Diwali', templateId: uuid(1), audience: { type: 'SEGMENT', ids: [uuid(2)] } }
  it('accepts a valid campaign', () => {
    expect(validateCampaignInput(ok).errors).toEqual({})
  })
  it('needs ids for segment/label/stage audiences but not for ALL_OPTED_IN', () => {
    expect(validateCampaignInput({ ...ok, audience: { type: 'SEGMENT', ids: [] } }).errors.audience).toBeTruthy()
    expect(validateCampaignInput({ ...ok, audience: { type: 'ALL_OPTED_IN' } }).errors).toEqual({})
  })
  it('rejects bad name, template, rate and media link', () => {
    const { errors } = validateCampaignInput({ name: ' ', templateId: 'x', audience: ok.audience, ratePerMinute: 0, headerMediaUrl: 'http://a' })
    expect(Object.keys(errors).sort()).toEqual(['headerMediaUrl', 'name', 'ratePerMinute', 'templateId'])
  })
})

describe('validateWorkflowInput', () => {
  const send = { type: 'SEND_TEMPLATE', templateId: uuid(3), values: {} }
  it('defaults the cart wait to 5 minutes and bounds it', () => {
    const r = validateWorkflowInput({ name: 'Cart', triggerType: 'CART_ABANDONED', triggerConfig: {}, actions: [send] })
    expect(r.value.triggerConfig).toEqual({ delay_minutes: 5 })
    expect(validateWorkflowInput({ name: 'c', triggerType: 'CART_ABANDONED', triggerConfig: { delayMinutes: 0 }, actions: [send] }).errors.triggerConfig).toBeTruthy()
  })
  it('order workflows need a known status', () => {
    expect(validateWorkflowInput({ name: 'o', triggerType: 'ORDER_STATUS', triggerConfig: { status: 'PACKED' }, actions: [send] }).errors).toEqual({})
    expect(validateWorkflowInput({ name: 'o', triggerType: 'ORDER_STATUS', triggerConfig: { status: 'PENDING' }, actions: [send] }).errors.triggerConfig).toBeTruthy()
  })
  it('only allows conditions that belong to the trigger', () => {
    const base = { name: 'c', triggerType: 'CART_ABANDONED', triggerConfig: {}, actions: [send] }
    expect(validateWorkflowInput({ ...base, conditions: [{ field: 'cart_value', op: 'gt', value: 500 }] }).errors).toEqual({})
    expect(validateWorkflowInput({ ...base, conditions: [{ field: 'order_total', op: 'gt', value: 500 }] }).errors.conditions).toBeTruthy()
    expect(validateWorkflowInput({ ...base, conditions: [{ field: 'cart_value', op: 'like', value: 5 }] }).errors.conditions).toBeTruthy()
  })
  it('allows a coupon only on a cart reminder', () => {
    const withCoupon = { ...send, couponId: uuid(4) }
    expect(validateWorkflowInput({ name: 'c', triggerType: 'CART_ABANDONED', triggerConfig: {}, actions: [withCoupon] }).errors).toEqual({})
    expect(validateWorkflowInput({ name: 'o', triggerType: 'ORDER_STATUS', triggerConfig: { status: 'PACKED' }, actions: [withCoupon] }).errors.actions).toBeTruthy()
  })
  it('needs at least one action and no unknown ones', () => {
    expect(validateWorkflowInput({ name: 'c', triggerType: 'CART_ABANDONED', triggerConfig: {}, actions: [] }).errors.actions).toBeTruthy()
    expect(validateWorkflowInput({ name: 'c', triggerType: 'CART_ABANDONED', triggerConfig: {}, actions: [{ type: 'DELETE_ALL' }] }).errors.actions).toBeTruthy()
  })
})

describe('evaluateConditions', () => {
  it('requires every condition and treats unknown facts as failing', () => {
    const conds = [{ field: 'cart_value', op: 'gt', value: 500 }, { field: 'order_count', op: 'eq', value: 0 }]
    expect(evaluateConditions(conds, { cart_value: 600, order_count: 0 })).toBe(true)
    expect(evaluateConditions(conds, { cart_value: 400, order_count: 0 })).toBe(false)
    expect(evaluateConditions(conds, { cart_value: 600 })).toBe(false)
    expect(evaluateConditions([], {})).toBe(true)
  })
  it('compares text case-insensitively', () => {
    expect(evaluateConditions([{ field: 'payment_method', op: 'eq', value: 'cod' }], { payment_method: 'COD' })).toBe(true)
    expect(evaluateConditions([{ field: 'payment_method', op: 'neq', value: 'cod' }], { payment_method: 'COD' })).toBe(false)
  })
})

describe('cartRef', () => {
  it('is a short stable code', () => {
    expect(cartRef('123e4567-e89b-12d3-a456-426614174000')).toBe('123e4567e8')
  })
})
