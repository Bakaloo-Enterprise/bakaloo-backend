import { describe, expect, it } from 'vitest'
import { canTransition, mapMetaStatus } from '../../../src/modules/whatsapp-crm/status-ladder.js'
import { parseWebhook } from '../../../src/modules/whatsapp-crm/webhook-parser.js'

describe('status ladder', () => {
  it('maps Meta statuses and ignores unknown ones', () => {
    expect(mapMetaStatus('sent')).toBe('SENT')
    expect(mapMetaStatus('DELIVERED')).toBe('DELIVERED')
    expect(mapMetaStatus('read')).toBe('READ')
    expect(mapMetaStatus('failed')).toBe('FAILED')
    expect(mapMetaStatus('deleted')).toBeNull()
    expect(mapMetaStatus(undefined)).toBeNull()
  })

  it('moves forward only', () => {
    expect(canTransition('QUEUED', 'SENT')).toBe(true)
    expect(canTransition('SENT', 'DELIVERED')).toBe(true)
    expect(canTransition('DELIVERED', 'READ')).toBe(true)
    expect(canTransition('QUEUED', 'READ')).toBe(true) // skipping is fine (Meta may omit "delivered")
  })

  it('never goes backwards or repeats (out-of-order / duplicate webhooks)', () => {
    expect(canTransition('READ', 'DELIVERED')).toBe(false)
    expect(canTransition('DELIVERED', 'SENT')).toBe(false)
    expect(canTransition('DELIVERED', 'DELIVERED')).toBe(false)
  })

  it('FAILED only from QUEUED/SENT, and is terminal', () => {
    expect(canTransition('QUEUED', 'FAILED')).toBe(true)
    expect(canTransition('SENT', 'FAILED')).toBe(true)
    expect(canTransition('DELIVERED', 'FAILED')).toBe(false)
    expect(canTransition('READ', 'FAILED')).toBe(false)
    expect(canTransition('FAILED', 'SENT')).toBe(false)
    expect(canTransition('FAILED', 'READ')).toBe(false)
  })

  it('an inbound row never takes a delivery status', () => {
    expect(canTransition('RECEIVED', 'READ')).toBe(false)
  })
})

const wrap = (value, field = 'messages') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA1', changes: [{ field, value }] }],
})
const meta = { phone_number_id: 'PN1', display_phone_number: '15550000000' }

describe('parseWebhook — inbound messages', () => {
  it('parses a text message with the sender profile name', () => {
    const r = parseWebhook(
      wrap({
        metadata: meta,
        contacts: [{ wa_id: '919876543210', profile: { name: 'Rahul Das' } }],
        messages: [{ from: '919876543210', id: 'wamid.A', timestamp: '1790000000', type: 'text', text: { body: 'Is milk available?' } }],
      }),
    )
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0]).toMatchObject({
      wamid: 'wamid.A',
      waId: '919876543210',
      bsuid: null,
      profileName: 'Rahul Das',
      type: 'text',
      body: 'Is milk available?',
      referral: null,
    })
    expect(r.messages[0].timestamp.getTime()).toBe(1790000000 * 1000)
  })

  it('keeps Click-to-WhatsApp ad referral data untouched', () => {
    const referral = { source_url: 'https://fb.me/x', source_type: 'ad', source_id: '123', headline: 'Weekend Grocery Offer' }
    const r = parseWebhook(
      wrap({
        metadata: meta,
        contacts: [{ wa_id: '919876543210', profile: { name: 'R' } }],
        messages: [{ from: '919876543210', id: 'wamid.B', timestamp: '1', type: 'text', text: { body: 'hi' }, referral }],
      }),
    )
    expect(r.messages[0].referral).toEqual(referral)
  })

  it('username-only sender (no phone): keyed by BSUID, not dropped', () => {
    const r = parseWebhook(
      wrap({
        metadata: meta,
        contacts: [{ user_id: 'IN.13491208655302741918', profile: { name: 'Priya', username: '@priya_s' } }],
        messages: [{ from_user_id: 'IN.13491208655302741918', id: 'wamid.C', timestamp: '1', type: 'text', text: { body: 'hello' } }],
      }),
    )
    expect(r.messages[0]).toMatchObject({
      waId: null,
      bsuid: 'IN.13491208655302741918',
      profileName: 'Priya',
      username: 'priya_s',
    })
  })

  it('drops a message that has neither a phone nor a BSUID rather than inventing a contact', () => {
    const r = parseWebhook(wrap({ metadata: meta, messages: [{ id: 'wamid.D', timestamp: '1', type: 'text', text: { body: 'x' } }] }))
    expect(r.messages).toHaveLength(0)
    expect(r.skipped).toBe(1)
  })

  it('maps media, interactive replies, template quick-replies and unknown types', () => {
    const r = parseWebhook(
      wrap({
        metadata: meta,
        contacts: [{ wa_id: '919876543210', profile: { name: 'R' } }],
        messages: [
          { from: '919876543210', id: 'm1', timestamp: '1', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', sha256: 's', caption: 'this one' } },
          { from: '919876543210', id: 'm2', timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Need Help' } } },
          { from: '919876543210', id: 'm3', timestamp: '1', type: 'button', button: { text: 'View Cart', payload: 'cart' } },
          { from: '919876543210', id: 'm4', timestamp: '1', type: 'weird' },
        ],
      }),
    )
    const [img, inter, btn, weird] = r.messages
    expect(img.media).toMatchObject({ id: 'MEDIA1', mime_type: 'image/jpeg' })
    expect(img.body).toBe('this one')
    expect(inter.body).toBe('Need Help')
    expect(inter.interactive).toMatchObject({ id: 'b1' })
    expect(btn.body).toBe('View Cart')
    expect(weird.body).toBe('[Unsupported message type]')
  })

  it('flags reactions so they are not stored as chat messages', () => {
    const r = parseWebhook(
      wrap({
        metadata: meta,
        contacts: [{ wa_id: '919876543210', profile: {} }],
        messages: [{ from: '919876543210', id: 'm5', timestamp: '1', type: 'reaction', reaction: { message_id: 'wamid.X', emoji: '👍' } }],
      }),
    )
    expect(r.messages[0].isReaction).toBe(true)
  })

  it('ignores events for a different business phone number when one is configured', () => {
    const body = wrap({
      metadata: { phone_number_id: 'OTHER' },
      contacts: [{ wa_id: '919876543210', profile: {} }],
      messages: [{ from: '919876543210', id: 'm6', timestamp: '1', type: 'text', text: { body: 'x' } }],
    })
    expect(parseWebhook(body, { phoneNumberId: 'PN1' }).messages).toHaveLength(0)
    expect(parseWebhook(body, {}).messages).toHaveLength(1)
  })

  it('returns an empty result for junk instead of throwing', () => {
    for (const junk of [null, undefined, {}, { object: 'page' }, { object: 'whatsapp_business_account' }, 'x']) {
      expect(parseWebhook(junk)).toMatchObject({ messages: [], statuses: [], templateEvents: [] })
    }
  })
})

describe('parseWebhook — statuses & template events', () => {
  it('parses delivery statuses', () => {
    const r = parseWebhook(wrap({ metadata: meta, statuses: [{ id: 'wamid.S', status: 'delivered', timestamp: '1790000100', recipient_id: '919876543210' }] }))
    expect(r.statuses[0]).toMatchObject({ wamid: 'wamid.S', status: 'delivered', recipientId: '919876543210', error: null })
  })

  it('captures Meta failure reasons and billing info', () => {
    const r = parseWebhook(
      wrap({
        metadata: meta,
        statuses: [
          {
            id: 'wamid.F',
            status: 'failed',
            timestamp: '1',
            recipient_id: '919876543210',
            errors: [{ code: 131049, title: 'Healthy ecosystem', error_data: { details: 'limit' } }],
            pricing: { category: 'marketing' },
          },
        ],
      }),
    )
    expect(r.statuses[0].error).toEqual({ code: 131049, title: 'Healthy ecosystem', details: 'limit' })
    expect(r.statuses[0].pricing).toEqual({ category: 'marketing' })
  })

  it('routes template status changes separately (handled in Phase 6)', () => {
    const r = parseWebhook(wrap({ event: 'APPROVED', message_template_name: 'abandoned_cart' }, 'message_template_status_update'))
    expect(r.templateEvents).toHaveLength(1)
    expect(r.messages).toHaveLength(0)
  })

  it('also routes template_category_update (different prefix) and keeps the event time', () => {
    const body = { object: 'whatsapp_business_account', entry: [{ id: 'WABA1', time: 1746169200, changes: [{ field: 'template_category_update', value: { message_template_id: 1, previous_category: 'UTILITY', new_category: 'MARKETING' } }] }] }
    const r = parseWebhook(body)
    expect(r.templateEvents).toHaveLength(1)
    expect(r.templateEvents[0]).toMatchObject({ field: 'template_category_update', wabaId: 'WABA1' })
    expect(r.templateEvents[0].time.getTime()).toBe(1746169200 * 1000)
    expect(r.skipped).toBe(0)
  })
})
