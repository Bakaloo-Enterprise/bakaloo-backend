import { describe, expect, it } from 'vitest'
import { canShareOrder, channelAbilities, cleanAudience, cleanBody, cleanIds, dmKey, filterMentions, MAX_BODY, previewOf, validateNewChannel } from '../../../src/modules/team-chat/chat.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

describe('dmKey', () => {
  it('is the same whichever side starts the chat', () => expect(dmKey(A, B)).toBe(dmKey(B, A)))
  it('differs per pair', () => expect(dmKey(A, B)).not.toBe(dmKey(A, C)))
})

describe('cleanIds', () => {
  it('drops junk, duplicates and excluded ids, keeps order', () => {
    expect(cleanIds([B, 'nope', A, B.toUpperCase(), null, C], [A])).toEqual([B, C])
  })
  it('tolerates a non-array', () => expect(cleanIds(undefined)).toEqual([]))
})

describe('cleanBody', () => {
  it('trims and normalises line breaks', () => expect(cleanBody('  hi\r\nthere \n').body).toBe('hi\nthere'))
  it('refuses empty text unless something is attached', () => {
    expect(() => cleanBody('   ')).toThrow(/Write a message/)
    expect(cleanBody('', { hasRef: true }).body).toBe('')
  })
  it('refuses very long text', () => expect(() => cleanBody('x'.repeat(MAX_BODY + 1))).toThrow(/at most 4000/))
})

describe('filterMentions', () => {
  it('only members, never the sender, no repeats', () => {
    expect(filterMentions([A, B, B, C, 'bad'], [A, B], A)).toEqual([B])
  })
})

describe('previewOf', () => {
  it('shows text, a shared item, or the deleted marker', () => {
    expect(previewOf({ body: 'Hello\n  team' })).toBe('Hello team')
    expect(previewOf({ body: '', ref_label: 'Order ORD1' })).toBe('Shared Order ORD1')
    expect(previewOf({ body: 'secret', deleted_at: 'x' })).toBe('Message deleted')
    expect(previewOf(null)).toBe('')
  })
})

describe('channelAbilities', () => {
  const mgr = { canManage: true }
  const staff = { canManage: false }
  const grp = { kind: 'GROUP', archived_at: null }
  it('a DM can only be written in', () => {
    const a = channelAbilities({ kind: 'DM', archived_at: null }, { role: 'MEMBER' }, mgr)
    expect(a).toMatchObject({ send: true, rename: false, manageMembers: false, leave: false, archive: false })
  })
  it('a group owner manages it; a member can only leave', () => {
    expect(channelAbilities(grp, { role: 'OWNER' }, staff)).toMatchObject({ rename: true, manageMembers: true, archive: true, leave: true })
    expect(channelAbilities(grp, { role: 'MEMBER' }, staff)).toMatchObject({ rename: false, manageMembers: false, archive: false, leave: true })
  })
  it('an HQ manager can rename/archive any group but not add people to someone else\'s group', () => {
    expect(channelAbilities(grp, { role: 'MEMBER' }, mgr)).toMatchObject({ rename: true, archive: true, manageMembers: false })
  })
  it('channels are run by managers; members cannot leave them', () => {
    const ch = { kind: 'CHANNEL', archived_at: null }
    expect(channelAbilities(ch, { role: 'MEMBER' }, mgr)).toMatchObject({ manageMembers: true, refreshAudience: true, leave: false })
    expect(channelAbilities(ch, { role: 'MEMBER' }, staff)).toMatchObject({ manageMembers: false, refreshAudience: false, leave: false })
  })
  it('an archived chat is read-only and can be restored', () => {
    const a = channelAbilities({ kind: 'GROUP', archived_at: 'x' }, { role: 'OWNER' }, staff)
    expect(a).toMatchObject({ send: false, rename: false, manageMembers: false, archive: false, unarchive: true })
  })
})

describe('validateNewChannel', () => {
  const staff = { canManage: false }
  const mgr = { canManage: true }
  it('needs a kind', () => expect(() => validateNewChannel({}, staff)).toThrow(/Choose what to create/))
  it('DM needs a person', () => {
    expect(() => validateNewChannel({ kind: 'DM' }, staff)).toThrow(/Pick who/)
    expect(validateNewChannel({ kind: 'DM', userId: A.toUpperCase() }, staff)).toEqual({ kind: 'DM', userId: A })
  })
  it('a group needs a name and at least one other person', () => {
    expect(() => validateNewChannel({ kind: 'GROUP', name: 'x', memberIds: [A] }, staff)).toThrow(/name/)
    expect(() => validateNewChannel({ kind: 'GROUP', name: 'Store 1 pickers', memberIds: [] }, staff)).toThrow(/at least one/)
    expect(validateNewChannel({ kind: 'GROUP', name: ' Store 1 pickers ', memberIds: [A, A] }, staff)).toMatchObject({ name: 'Store 1 pickers', memberIds: [A], audience: null })
  })
  it('only managers create channels', () => {
    expect(() => validateNewChannel({ kind: 'CHANNEL', name: 'HQ team', memberIds: [A] }, staff)).toThrow(/Only HQ managers/)
    expect(validateNewChannel({ kind: 'CHANNEL', name: 'HQ team', audience: { hq: true } }, mgr).audience).toEqual({ hq: true, shopIds: [] })
  })
  it('a channel needs people or an audience', () => {
    expect(() => validateNewChannel({ kind: 'CHANNEL', name: 'Empty' }, mgr)).toThrow(/Choose who/)
  })
})

describe('cleanAudience / canShareOrder', () => {
  it('empty audience is null', () => expect(cleanAudience({ hq: false, shopIds: ['x'] })).toBeNull())
  it('keeps valid shop ids', () => expect(cleanAudience({ shopIds: [A, 'bad'] })).toEqual({ hq: false, shopIds: [A] }))
  it('HQ shares any order; store staff only their own store', () => {
    expect(canShareOrder({ isHq: true, viewerShopIds: [] }, A)).toBe(true)
    expect(canShareOrder({ isHq: false, viewerShopIds: [A] }, A)).toBe(true)
    expect(canShareOrder({ isHq: false, viewerShopIds: [A] }, B)).toBe(false)
    expect(canShareOrder({ isHq: false, viewerShopIds: [A] }, null)).toBe(false)
  })
})
