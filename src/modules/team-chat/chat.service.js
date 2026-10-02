import { ChatError } from './errors.js'
import { canShareOrder, channelAbilities, cleanBody, cleanIds, dmKey, filterMentions, MAX_MEMBERS, previewOf, RATE_LIMIT_PER_MINUTE, REF_TYPES, validateNewChannel } from './chat.js'

/**
 * Internal team chat for dashboard staff (Phase 9).
 *
 * Rules worth knowing:
 *  - A channel you are not in does not exist for you: every lookup answers 404, never 403.
 *  - Only members are told about messages (realtime goes to each member's personal room).
 *  - Staff who are deactivated lose access at once (the access check runs on every request).
 *  - A message can point at an order / product / customer; the sender must be allowed to see it.
 */
export class ChatService {
  /** @param {{ repo: import('./chat.repository.js').ChatRepository, emit: (userIds: string[], event: string, payload: object) => void, logger: object }} deps */
  constructor({ repo, emit, logger }) {
    Object.assign(this, { repo, emit, logger })
  }

  async access(userId) {
    const a = await this.repo.loadAccess(userId)
    if (!a) throw new ChatError('Team chat is for active dashboard users.', 403, 'FORBIDDEN')
    return a
  }

  async me(userId) {
    const a = await this.access(userId)
    return { userId: a.userId, name: a.name, canManage: a.canManage, isHq: a.isHq }
  }

  async people(userId, q) {
    await this.access(userId)
    return this.repo.people(userId, { search: q?.search?.trim() || undefined, limit: q?.limit ?? 50 })
  }

  async unread(userId) {
    await this.access(userId)
    return this.repo.unreadTotals(userId)
  }

  // ─── channels ────────────────────────────────────────────────────
  async list(userId, { archived = false } = {}) {
    const a = await this.access(userId)
    const rows = await this.repo.listChannels(userId, { archived })
    return rows.map((c) => ({ ...shape(c), preview: previewOf(c.last_message), abilities: channelAbilities(c, { role: c.my_role }, a) }))
  }

  async get(userId, channelId) {
    const a = await this.access(userId)
    const c = await this.channelOr404(channelId, userId)
    const members = await this.repo.members(channelId)
    const peer = c.kind === 'DM' ? members.find((m) => m.user_id !== userId) : null
    return {
      ...shape({ ...c, peer: peer ? { id: peer.user_id, name: peer.name, active: peer.is_active } : null }),
      member_count: members.length,
      members,
      abilities: channelAbilities(c, { role: c.my_role }, a),
    }
  }

  async create(userId, input) {
    const a = await this.access(userId)
    const v = validateNewChannel(input, a)

    if (v.kind === 'DM') {
      if (v.userId === userId) throw new ChatError('You cannot message yourself.', 400, 'VALIDATION', { userId: 'Pick someone else' })
      if ((await this.repo.eligibleUsers([v.userId])).length !== 1) throw new ChatError('That person was not found.', 404, 'PERSON_NOT_FOUND')
      const { id, created } = await this.repo.upsertDm(dmKey(userId, v.userId), userId, v.userId)
      if (created) this.emit([userId, v.userId], 'chat:channel', { channelId: id })
      return this.get(userId, id)
    }

    let memberIds = v.memberIds.filter((m) => m !== userId)
    if (v.audience) memberIds = [...new Set([...memberIds, ...(await this.repo.resolveAudience(v.audience))])].filter((m) => m !== userId)
    const eligible = await this.repo.eligibleUsers(memberIds)
    if (v.kind === 'GROUP' && eligible.length !== memberIds.length) throw new ChatError('Some of the people you picked cannot be added.', 400, 'VALIDATION', { memberIds: 'Includes someone who is not an active staff member' })
    memberIds = eligible
    if (memberIds.length + 1 > MAX_MEMBERS) throw new ChatError(`A ${v.kind === 'GROUP' ? 'group' : 'channel'} can have at most ${MAX_MEMBERS} people.`, 400, 'TOO_MANY_MEMBERS')
    if (v.kind === 'GROUP' && memberIds.length === 0) throw new ChatError('Add at least one other person.', 400, 'VALIDATION', { memberIds: 'Pick at least one person' })

    const id = await this.repo.createChannel({ kind: v.kind, name: v.name, description: v.description, audience: v.audience, creatorId: userId, memberIds })
    this.emit([userId, ...memberIds], 'chat:channel', { channelId: id })
    return this.get(userId, id)
  }

  async update(userId, channelId, { name, description }) {
    const a = await this.access(userId)
    const c = await this.channelOr404(channelId, userId)
    if (!channelAbilities(c, { role: c.my_role }, a).rename) throw new ChatError('You cannot rename this chat.', 403, 'FORBIDDEN')
    if (name !== undefined) {
      const n = String(name).trim()
      if (n.length < 2 || n.length > 80) throw new ChatError('Name must be 2–80 characters.', 400, 'VALIDATION', { name: 'Name must be 2–80 characters' })
      name = n
    }
    await this.repo.update(channelId, { name, description: description === undefined ? undefined : (String(description).trim().slice(0, 300) || null) })
    await this.notifyMembers(channelId)
    return this.get(userId, channelId)
  }

  async addMembers(userId, channelId, userIds) {
    const a = await this.access(userId)
    const c = await this.channelOr404(channelId, userId)
    if (!channelAbilities(c, { role: c.my_role }, a).manageMembers) throw new ChatError('You cannot add people to this chat.', 403, 'FORBIDDEN')
    const ids = cleanIds(userIds)
    if (!ids.length) throw new ChatError('Pick at least one person.', 400, 'VALIDATION', { userIds: 'Required' })
    const eligible = await this.repo.eligibleUsers(ids)
    if (eligible.length !== ids.length) throw new ChatError('Some of the people you picked cannot be added.', 400, 'VALIDATION', { userIds: 'Includes someone who is not an active staff member' })
    const existing = await this.repo.memberIds(channelId)
    if (new Set([...existing, ...ids]).size > MAX_MEMBERS) throw new ChatError(`At most ${MAX_MEMBERS} people per chat.`, 400, 'TOO_MANY_MEMBERS')
    const added = await this.repo.addMembers(channelId, ids)
    if (added.length) this.emit([...existing, ...added], 'chat:channel', { channelId })
    return this.get(userId, channelId)
  }

  /** Remove someone, or leave (targetId = yourself). */
  async removeMember(userId, channelId, targetId) {
    const a = await this.access(userId)
    const c = await this.channelOr404(channelId, userId)
    const ab = channelAbilities(c, { role: c.my_role }, a)
    const self = targetId === userId
    if (self ? !ab.leave && !ab.manageMembers : !ab.manageMembers) throw new ChatError(self ? 'You cannot leave this chat.' : 'You cannot remove people from this chat.', 403, 'FORBIDDEN')
    if (c.kind === 'CHANNEL' && self && !a.canManage) throw new ChatError('Ask an HQ manager to remove you from a channel.', 403, 'FORBIDDEN')
    const before = await this.repo.memberIds(channelId)
    if (!before.includes(targetId)) throw new ChatError('That person is not in this chat.', 404, 'NOT_A_MEMBER')
    await this.repo.removeMember(channelId, targetId)
    await this.repo.reassignOwner(channelId)
    this.emit(before, 'chat:channel', { channelId })
    return { channelId, userId: targetId }
  }

  async setArchived(userId, channelId, archived) {
    const a = await this.access(userId)
    const c = await this.channelOr404(channelId, userId)
    const ab = channelAbilities(c, { role: c.my_role }, a)
    if (!(archived ? ab.archive : ab.unarchive)) throw new ChatError(archived ? 'You cannot archive this chat.' : 'You cannot restore this chat.', 403, 'FORBIDDEN')
    await this.repo.setArchived(channelId, archived)
    await this.notifyMembers(channelId)
    return this.get(userId, channelId)
  }

  /** Add whoever now matches the channel's audience (new store staff). Never removes anyone. */
  async refreshAudience(userId, channelId) {
    const a = await this.access(userId)
    const c = await this.channelOr404(channelId, userId)
    if (!channelAbilities(c, { role: c.my_role }, a).refreshAudience) throw new ChatError('You cannot refresh this channel.', 403, 'FORBIDDEN')
    if (!c.audience) throw new ChatError('This channel has no audience to refresh — it only has the people you added.', 409, 'NO_AUDIENCE')
    const existing = await this.repo.memberIds(channelId)
    const wanted = await this.repo.resolveAudience(c.audience)
    const added = await this.repo.addMembers(channelId, wanted.filter((id) => !existing.includes(id)))
    if (added.length) this.emit([...existing, ...added], 'chat:channel', { channelId })
    return { added: added.length }
  }

  // ─── messages ────────────────────────────────────────────────────
  async messages(userId, channelId, { before, limit = 50 } = {}) {
    await this.access(userId)
    await this.channelOr404(channelId, userId)
    const rows = await this.repo.listMessages(channelId, { before, limit })
    return rows.map(publicMessage)
  }

  async send(userId, channelId, { body, mentions, ref } = {}) {
    const a = await this.access(userId)
    const c = await this.channelOr404(channelId, userId)
    if (c.archived_at) throw new ChatError('This chat is archived. Restore it to write here.', 409, 'ARCHIVED')
    const resolved = ref ? await this.resolveRef(a, ref) : null
    const { body: text } = cleanBody(body, { hasRef: Boolean(resolved) })
    if ((await this.repo.recentCount(userId)) >= RATE_LIMIT_PER_MINUTE) throw new ChatError('You are sending messages too fast. Wait a moment.', 429, 'RATE_LIMITED')

    const memberIds = await this.repo.memberIds(channelId)
    const msg = publicMessage(await this.repo.insertMessage({ channelId, senderId: userId, body: text, ref: resolved, mentions: filterMentions(mentions, memberIds, userId) }))
    this.emit(memberIds, 'chat:message', { channelId, message: msg })
    return msg
  }

  async deleteMessage(userId, channelId, messageId) {
    const a = await this.access(userId)
    const c = await this.channelOr404(channelId, userId)
    if (c.archived_at) throw new ChatError('This chat is archived.', 409, 'ARCHIVED')
    const m = await this.repo.getMessage(channelId, messageId)
    if (!m) throw new ChatError('Message not found.', 404, 'MESSAGE_NOT_FOUND')
    if (m.sender_id !== userId && !a.canManage) throw new ChatError('You can only delete your own messages.', 403, 'FORBIDDEN')
    await this.repo.deleteMessage(messageId)
    this.emit(await this.repo.memberIds(channelId), 'chat:message_deleted', { channelId, messageId })
    return { id: messageId }
  }

  async markRead(userId, channelId) {
    await this.access(userId)
    await this.channelOr404(channelId, userId)
    await this.repo.markRead(channelId, userId)
    this.emit([userId], 'chat:read', { channelId })
    return { channelId }
  }

  // ─── things a message can point at ───────────────────────────────
  async searchRefs(userId, { type, q }) {
    const a = await this.access(userId)
    const text = String(q ?? '').trim()
    if (text.length < 2) return []
    if (type === 'ORDER') return (await this.repo.findOrders(a, text)).map(({ shopId, ...r }) => r)
    if (type === 'PRODUCT') return this.repo.findProducts(text)
    if (type === 'CUSTOMER') return a.isHq ? this.repo.findCustomers(text) : []
    throw new ChatError('Unknown type.', 400, 'VALIDATION', { type: `One of ${REF_TYPES.join(', ')}` })
  }

  async resolveRef(a, ref) {
    if (!REF_TYPES.includes(ref?.type) || !ref.id) throw new ChatError('That attachment is not valid.', 400, 'VALIDATION', { ref: 'Invalid' })
    let found
    if (ref.type === 'ORDER') {
      found = await this.repo.getOrder(ref.id)
      if (found && !canShareOrder({ isHq: a.isHq, viewerShopIds: a.shopIds }, found.shopId)) throw new ChatError('You can only share orders from your own store.', 403, 'REF_FORBIDDEN')
    } else if (ref.type === 'PRODUCT') {
      found = await this.repo.getProduct(ref.id)
    } else {
      if (!a.isHq) throw new ChatError('Only HQ staff can share customers in chat.', 403, 'REF_FORBIDDEN')
      found = await this.repo.getCustomer(ref.id)
    }
    if (!found) throw new ChatError('That item was not found.', 404, 'REF_NOT_FOUND')
    return { type: found.type, id: found.id, label: found.label.slice(0, 160) }
  }

  // ─── helpers ─────────────────────────────────────────────────────
  async channelOr404(channelId, userId) {
    const c = await this.repo.getForMember(channelId, userId)
    if (!c) throw new ChatError('Chat not found.', 404, 'CHANNEL_NOT_FOUND')
    return c
  }

  async notifyMembers(channelId) {
    this.emit(await this.repo.memberIds(channelId), 'chat:channel', { channelId })
  }
}

function shape(c) {
  return {
    id: c.id,
    kind: c.kind,
    name: c.kind === 'DM' ? (c.peer?.name ?? 'Chat') : c.name,
    description: c.description ?? null,
    archived: Boolean(c.archived_at),
    last_message_at: c.last_message_at ?? null,
    created_at: c.created_at,
    my_role: c.my_role,
    ...(c.member_count !== undefined ? { member_count: c.member_count, unread: c.unread, unread_mentions: c.unread_mentions, peer: c.peer ?? null } : {}),
  }
}

export function publicMessage(m) {
  const deleted = Boolean(m.deleted_at)
  return {
    id: m.id,
    seq: Number(m.seq),
    channel_id: m.channel_id,
    sender_id: m.sender_id,
    sender_name: m.sender_name ?? 'Former staff member',
    body: deleted ? '' : m.body,
    ref: !deleted && m.ref_type ? { type: m.ref_type, id: m.ref_id, label: m.ref_label } : null,
    mentions: deleted ? [] : m.mentions,
    deleted,
    created_at: m.created_at,
  }
}
