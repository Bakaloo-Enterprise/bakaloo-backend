import { ChatError } from './errors.js'

/** Pure rules for internal team chat (Phase 9). No database access here. */

export const CHAT_PERM = Object.freeze({ USE: 'chat.use', MANAGE: 'chat.manage' })
export const KINDS = Object.freeze(['DM', 'GROUP', 'CHANNEL'])
export const REF_TYPES = Object.freeze(['ORDER', 'PRODUCT', 'CUSTOMER'])
export const MAX_BODY = 4000
export const MAX_MEMBERS = 100
export const RATE_LIMIT_PER_MINUTE = 30

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v) => UUID.test(String(v ?? ''))

/** One DM per pair, whichever side starts it. */
export function dmKey(a, b) {
  return [String(a), String(b)].sort().join(':')
}

/** Unique valid ids, in first-seen order, without `exclude`. */
export function cleanIds(ids, exclude = []) {
  const skip = new Set(exclude.map(String))
  const out = []
  for (const id of Array.isArray(ids) ? ids : []) {
    const s = String(id).toLowerCase()
    if (isUuid(s) && !skip.has(s) && !out.includes(s)) out.push(s)
  }
  return out
}

/** @returns {{ body: string }} trimmed text; throws when there is nothing to send. */
export function cleanBody(raw, { hasRef = false } = {}) {
  const body = String(raw ?? '').replace(/\r\n/g, '\n').trim()
  if (body.length > MAX_BODY) throw new ChatError(`Messages can be at most ${MAX_BODY} characters.`, 400, 'BODY_TOO_LONG')
  if (!body && !hasRef) throw new ChatError('Write a message first.', 400, 'EMPTY_MESSAGE')
  return { body }
}

/** Only people who are in the channel (and not the sender) can be mentioned; anything else is dropped. */
export function filterMentions(mentioned, memberIds, senderId) {
  const members = new Set(memberIds.map(String))
  return cleanIds(mentioned, [senderId]).filter((id) => members.has(id))
}

/** Short text for the channel list. */
export function previewOf(msg) {
  if (!msg) return ''
  if (msg.deleted_at) return 'Message deleted'
  const text = String(msg.body ?? '').replace(/\s+/g, ' ').trim()
  if (text) return text.slice(0, 80)
  return msg.ref_label ? `Shared ${msg.ref_label}` : ''
}

/**
 * What the caller may do in a channel they belong to.
 * @param {{ kind: string, archived_at: string|null }} channel
 * @param {{ role: string }} membership
 * @param {{ canManage: boolean }} access
 */
export function channelAbilities(channel, membership, access) {
  const owner = membership.role === 'OWNER'
  const archived = Boolean(channel.archived_at)
  const dm = channel.kind === 'DM'
  return {
    send: !archived,
    rename: !dm && !archived && (owner || access.canManage),
    manageMembers: !dm && !archived && (owner || (channel.kind === 'CHANNEL' && access.canManage)),
    leave: channel.kind === 'GROUP' && !archived,
    archive: !dm && !archived && (owner || access.canManage),
    unarchive: !dm && archived && (owner || access.canManage),
    refreshAudience: channel.kind === 'CHANNEL' && !archived && access.canManage,
  }
}

export function validateNewChannel(input, access) {
  const kind = input?.kind
  if (!KINDS.includes(kind)) throw new ChatError('Choose what to create: a direct message, a group or a channel.', 400, 'VALIDATION', { kind: 'Required' })
  if (kind === 'DM') {
    if (!isUuid(input.userId)) throw new ChatError('Pick who to message.', 400, 'VALIDATION', { userId: 'Required' })
    return { kind, userId: String(input.userId).toLowerCase() }
  }
  const name = String(input.name ?? '').trim()
  if (name.length < 2 || name.length > 80) throw new ChatError('Give it a name (2–80 characters).', 400, 'VALIDATION', { name: 'Name must be 2–80 characters' })
  const description = input.description ? String(input.description).trim().slice(0, 300) : null
  if (kind === 'CHANNEL' && !access.canManage) throw new ChatError('Only HQ managers can create channels. Start a group instead.', 403, 'FORBIDDEN')
  const memberIds = cleanIds(input.memberIds)
  const audience = kind === 'CHANNEL' ? cleanAudience(input.audience) : null
  if (kind === 'GROUP' && memberIds.length === 0) throw new ChatError('Add at least one other person.', 400, 'VALIDATION', { memberIds: 'Pick at least one person' })
  if (kind === 'CHANNEL' && memberIds.length === 0 && !audience) throw new ChatError('Choose who is in the channel.', 400, 'VALIDATION', { memberIds: 'Pick people or an audience' })
  return { kind, name, description, memberIds, audience }
}

/** { hq?: boolean, shopIds?: uuid[] } or null when empty. */
export function cleanAudience(a) {
  if (!a || typeof a !== 'object') return null
  const shopIds = cleanIds(a.shopIds).slice(0, 50)
  const hq = a.hq === true
  return hq || shopIds.length ? { hq, shopIds } : null
}

/** Whether `viewer` may attach this order to a chat: HQ always; shop staff only for their own shops. */
export function canShareOrder({ isHq, viewerShopIds }, orderShopId) {
  return isHq || (orderShopId != null && viewerShopIds.includes(orderShopId))
}
