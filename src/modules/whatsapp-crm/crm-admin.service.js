import { CrmError } from './errors.js'
import { CRM_PERM, canAccessConversation } from './access.js'

const MAX_BULK = 200

/** Ownership + label rules for the inbox (Phase 3). */
export class CrmAdminService {
  /**
   * @param {{ repo: import('./whatsapp.repository.js').WhatsappRepository,
   *           admin: import('./crm-admin.repository.js').CrmAdminRepository,
   *           emit: (e: string, p: object) => void }} deps
   */
  constructor({ repo, admin, emit }) {
    this.repo = repo
    this.admin = admin
    this.emit = emit
  }

  /** Loads a conversation and enforces "agents only see own + unassigned". */
  async getAccessibleConversation(id, access) {
    const conv = await this.repo.getConversation(id)
    // Same answer for "missing" and "not yours" so ids of other agents' chats are not probeable.
    if (!conv || !canAccessConversation(access, conv)) {
      throw new CrmError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND')
    }
    return conv
  }

  // ─── From the customer profile ────────────────────────────────────
  /** Open (creating if needed) the WhatsApp conversation of a Bakaloo customer. Needs crm.inbox.reply (checked by the route). */
  async openCustomerConversation(userId, access) {
    const id = await this.repo.ensureCustomerConversation(userId)
    if (!id) throw new CrmError('This customer has no valid mobile number, so they cannot be reached on WhatsApp.', 409, 'NO_WHATSAPP_NUMBER')
    return this.getAccessibleConversation(id, access)
  }

  /** What was exchanged with this customer on WhatsApp (nothing is created). `restricted` = it belongs to another agent. */
  async customerThread(userId, access, limit = 30) {
    const id = await this.repo.findCustomerConversationId(userId)
    if (!id) return { conversation: null, messages: [], restricted: false }
    let conv
    try {
      conv = await this.getAccessibleConversation(id, access)
    } catch (err) {
      if (err.code === 'CONVERSATION_NOT_FOUND') return { conversation: null, messages: [], restricted: true }
      throw err
    }
    return { conversation: conv, messages: await this.repo.listMessages(conv.id, { limit }), restricted: false }
  }

  // ─── Assignment ───────────────────────────────────────────────────
  /**
   * @param {string} conversationId
   * @param {string|null} toUserId null = unassign
   * @param {{ userId: string, has: (p: string) => boolean }} access
   */
  async assign(conversationId, toUserId, access) {
    const conv = await this.getAccessibleConversation(conversationId, access)
    const selfClaim = toUserId === access.userId && !conv.assigned_to

    // An agent may take an UNASSIGNED chat for themselves; everything else is a manager action.
    if (selfClaim) {
      if (!access.has(CRM_PERM.INBOX_REPLY)) throw forbidden(CRM_PERM.INBOX_REPLY)
    } else if (!access.has(CRM_PERM.ASSIGN)) {
      throw forbidden(CRM_PERM.ASSIGN)
    }
    if (toUserId) await this.assertEligible(toUserId)

    const action = selfClaim ? 'CLAIM' : !toUserId ? 'UNASSIGN' : conv.assigned_to ? 'TRANSFER' : 'ASSIGN'
    const changed = await this.admin.assign([conv.id], toUserId, access.userId, action)
    if (changed.length) this.emitChange([conv.id], toUserId, changed.map((c) => c.from))
    return this.repo.getConversation(conv.id)
  }

  async bulkAssign(conversationIds, toUserId, access) {
    if (!access.has(CRM_PERM.ASSIGN)) throw forbidden(CRM_PERM.ASSIGN)
    const ids = [...new Set(conversationIds)]
    if (ids.length === 0) throw new CrmError('Select at least one conversation', 400, 'NOTHING_SELECTED')
    if (ids.length > MAX_BULK) throw new CrmError(`You can move at most ${MAX_BULK} conversations at once`, 400, 'TOO_MANY')
    if (toUserId) await this.assertEligible(toUserId)

    const changed = await this.admin.assign(ids, toUserId, access.userId, 'BULK')
    if (changed.length) this.emitChange(changed.map((c) => c.id), toUserId, changed.map((c) => c.from))
    return { requested: ids.length, changed: changed.length }
  }

  async assertEligible(userId) {
    if (!(await this.admin.isEligibleAgent(userId))) {
      throw new CrmError('That team member cannot work the WhatsApp inbox', 400, 'NOT_AN_AGENT')
    }
  }

  emitChange(conversationIds, toUserId, fromUserIds = []) {
    // Content-free: clients refetch through the permission-checked API.
    this.emit('crm:conversation', { conversationIds, assignedTo: toUserId ?? null, previousOwners: [...new Set(fromUserIds.filter(Boolean))] })
  }

  // ─── Labels ───────────────────────────────────────────────────────
  async createLabel(input, access) {
    try {
      return await this.admin.createLabel(input, access.userId)
    } catch (err) {
      if (err.code === '23505') throw new CrmError('A label with this name already exists', 409, 'LABEL_EXISTS')
      throw err
    }
  }

  async updateLabel(id, input) {
    try {
      const label = await this.admin.updateLabel(id, input)
      if (!label) throw new CrmError('Label not found', 404, 'LABEL_NOT_FOUND')
      this.emit('crm:conversation', { conversationIds: [], labelsChanged: true })
      return label
    } catch (err) {
      if (err.code === '23505') throw new CrmError('A label with this name already exists', 409, 'LABEL_EXISTS')
      throw err
    }
  }

  async deleteLabel(id) {
    if (!(await this.admin.deleteLabel(id))) throw new CrmError('Label not found', 404, 'LABEL_NOT_FOUND')
    this.emit('crm:conversation', { conversationIds: [], labelsChanged: true })
  }

  async addConversationLabel(conversationId, labelId, access) {
    const conv = await this.getAccessibleConversation(conversationId, access)
    if (!(await this.admin.labelExists(labelId))) throw new CrmError('Label not found', 404, 'LABEL_NOT_FOUND')
    await this.admin.addContactLabel(conv.contact_id, labelId, access.userId)
    this.emit('crm:conversation', { conversationIds: [conv.id] })
    return this.repo.getConversation(conv.id)
  }

  async removeConversationLabel(conversationId, labelId, access) {
    const conv = await this.getAccessibleConversation(conversationId, access)
    await this.admin.removeContactLabel(conv.contact_id, labelId)
    this.emit('crm:conversation', { conversationIds: [conv.id] })
    return this.repo.getConversation(conv.id)
  }
}

function forbidden(perm) {
  return new CrmError(`Forbidden — requires '${perm}' permission`, 403, 'PERMISSION_DENIED')
}
