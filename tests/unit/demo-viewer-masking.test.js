import { describe, it, expect } from 'vitest'
import { maskContact, maskPayload } from '../../src/modules/demo/demo-viewer.js'

const allowed = new Set(['9100010134', 'joy@demo.local'])
const plain = { crm: false, vendors: false, allowed }
const crm = { crm: true, vendors: false, allowed }

describe('demo viewer masking', () => {
  it('blurs phones and e-mails', () => {
    expect(maskContact('9876543210')).toBe('98••••••10')
    expect(maskContact('ravi@gmail.com')).toBe('r•••@••••.com')
  })

  it('keeps demo customers visible outside the CRM, hides everyone else', () => {
    const out = maskPayload({ rows: [{ phone: '9100010134', email: 'Joy@demo.local' }, { phone: '9999999999', rider_phone: '9888888888' }] }, plain)
    expect(out.rows[0]).toEqual({ phone: '9100010134', email: 'Joy@demo.local' })
    expect(out.rows[1].phone).toContain('•')
    expect(out.rows[1].rider_phone).toContain('•')
  })

  it('shows no number at all inside WhatsApp CRM, even for demo customers, including message text', () => {
    const out = maskPayload({ phone: '9100010134', waId: '919100010134', body: 'call me on 9100010134 or +14155550123 order 2026-10-28' }, crm)
    expect(out.phone).toContain('•')
    expect(out.waId).toContain('•')
    expect(out.body).not.toMatch(/9100010134|4155550123/)
    expect(out.body).toContain('2026-10-28')
  })

  it('blurs the name and picture of a customer who is not a demo customer, keeps demo customers readable', () => {
    const out = maskPayload({ rows: [{ name: 'Joy Das', phone: '9100010134', avatar_url: 'a.png' }, { name: 'Ravi Kumar', phone: '9999999999', avatar_url: 'b.png' }] }, plain)
    expect(out.rows[0]).toEqual({ name: 'Joy Das', phone: '9100010134', avatar_url: 'a.png' })
    expect(out.rows[1].name).toContain('•')
    expect(out.rows[1].avatar_url).toBeNull()
  })

  it('leaves flags, ids and non-contact fields alone', () => {
    const out = maskPayload({ id: 'a-b', whatsapp_enabled: true, phone_verified: 'yes', name: 'Joy' }, plain)
    expect(out).toEqual({ id: 'a-b', whatsapp_enabled: true, phone_verified: 'yes', name: 'Joy' })
  })

  it('blurs vendor names and rider names', () => {
    const out = maskPayload({ vendor_name: 'Fresh Farms', riderName: 'Suresh' }, plain)
    expect(out.vendor_name).toContain('•')
    expect(out.riderName).toContain('•')
  })
})
