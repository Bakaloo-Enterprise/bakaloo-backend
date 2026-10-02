import { success, error } from '../../../utils/apiResponse.js'
import { logger } from '../../../config/logger.js'
import { CrmError } from '../../whatsapp-crm/errors.js'
import { CRM_PERM, loadCrmAccess } from '../../whatsapp-crm/access.js'
import { PURPOSES } from '../../whatsapp-crm/template.js'
import { getWhatsappServices, getWhatsappConfigStatus } from '../../whatsapp-crm/whatsapp.factory.js'
import { emit as emitAudit } from '../../../utils/audit-log.js'

/** Turns domain errors into the API's error shape; anything else is a real 500. */
function fail(reply, err) {
  if (err instanceof CrmError) {
    const body = error(err.message, err.code)
    return reply.code(err.statusCode).send(err.details !== undefined ? { ...body, details: err.details } : body)
  }
  throw err
}

export class AdminWhatsappCrmController {
  async status() {
    const { botRepo } = getWhatsappServices()
    // botEnabled lets the inbox show bot controls only when the bot can actually act.
    const bot = await botRepo.getSettings().catch(() => null)
    return success({ ...(await getWhatsappConfigStatus()), botEnabled: Boolean(bot?.enabled) }, 'WhatsApp CRM status')
  }

  /** What the signed-in user may do — the dashboard uses this to show/hide controls. */
  async me(request) {
    const a = request.crm
    return success(
      {
        userId: a.userId,
        isSuper: a.isSuper,
        permissions: Object.values(CRM_PERM).filter((p) => a.has(p)),
      },
      'CRM access',
    )
  }

  async listConversations(request) {
    const { repo } = getWhatsappServices()
    const a = request.crm
    const { status, assignedTo, labelId, search, limit, offset } = request.query
    const rows = await repo.listConversations({
      status,
      labelId,
      search,
      limit,
      offset,
      assignedTo: assignedTo === 'me' ? a.userId : assignedTo,
      // Agents without view_all only ever see their own + unassigned chats.
      visibleTo: a.has(CRM_PERM.INBOX_VIEW_ALL) ? undefined : a.userId,
    })
    return success(rows, 'Conversations fetched', { limit, offset })
  }

  // ─── WhatsApp connection settings (Settings page) ───
  async settingsView(request, reply) {
    const { settings } = getWhatsappServices()
    try {
      const proto = request.headers['x-forwarded-proto'] ?? request.protocol
      const host = request.headers['x-forwarded-host'] ?? request.headers.host
      // Everyone signed in may READ the connection state; only someone with crm.settings.manage sees the verify token and gets editing.
      const canManage = (await loadCrmAccess(request.user.id)).has(CRM_PERM.SETTINGS_MANAGE)
      return success(await settings.view({ origin: host ? `${proto}://${host}` : '', canManage }), 'WhatsApp settings fetched')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async settingsSave(request, reply) {
    const { settings } = getWhatsappServices()
    try {
      const out = await settings.save(request.body, request.user.id)
      // Which fields changed — never their values.
      emitAudit('whatsapp.settings.save', { actor_user_id: request.user.id, actor_role: 'ADMIN', target_type: 'wa_settings', after: { fields: out.savedFields } })
      return success(out, 'Settings saved')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async settingsTest(request, reply) {
    const { settings } = getWhatsappServices()
    try {
      const result = await settings.test({ sendTo: request.body?.sendTo }, request.user.id)
      emitAudit('whatsapp.settings.test', { actor_user_id: request.user.id, actor_role: 'ADMIN', target_type: 'wa_settings', after: { ok: result.ok, level: result.level } })
      return success(result, result.ok ? 'Connected' : 'Connection failed')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async settingsEnable(request, reply) {
    const { settings } = getWhatsappServices()
    try {
      await settings.setEnabled(request.body.enabled, request.user.id)
      emitAudit('whatsapp.settings.enable', { actor_user_id: request.user.id, actor_role: 'ADMIN', target_type: 'wa_settings', after: { enabled: request.body.enabled } })
      return success({ enabled: request.body.enabled }, request.body.enabled ? 'WhatsApp switched on' : 'WhatsApp switched off')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async settingsClear(request, reply) {
    const { settings } = getWhatsappServices()
    try {
      await settings.clearCredentials(request.user.id)
      emitAudit('whatsapp.settings.clear', { actor_user_id: request.user.id, actor_role: 'ADMIN', target_type: 'wa_settings', after: {} })
      return success({}, 'Saved WhatsApp details removed')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async openCustomerConversation(request, reply) {
    const { crm } = getWhatsappServices()
    try {
      return success(await crm.openCustomerConversation(request.params.userId, request.crm), 'Conversation ready')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async customerThread(request, reply) {
    const { crm } = getWhatsappServices()
    try {
      return success(await crm.customerThread(request.params.userId, request.crm), 'WhatsApp history fetched')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async getConversation(request, reply) {
    const { crm } = getWhatsappServices()
    try {
      return success(await crm.getAccessibleConversation(request.params.id, request.crm), 'Conversation fetched')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async listMessages(request, reply) {
    const { repo, crm } = getWhatsappServices()
    try {
      const conv = await crm.getAccessibleConversation(request.params.id, request.crm)
      const rows = await repo.listMessages(conv.id, { before: request.query.before, limit: request.query.limit })
      return success(rows, 'Messages fetched')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async sendMessage(request, reply) {
    const { send, crm } = getWhatsappServices()
    try {
      await crm.getAccessibleConversation(request.params.id, request.crm)
      const message = await send.sendText({
        conversationId: request.params.id,
        body: request.body.body,
        replyToWamid: request.body.replyToWamid,
        sentBy: request.user.id,
      })
      return success(message, 'Message sent')
    } catch (err) {
      return fail(reply, err)
    }
  }

  /** Clears the unread badge and (best effort) shows blue ticks to the customer. */
  async markRead(request, reply) {
    const { repo, client, crm } = getWhatsappServices()
    try {
      const conv = await crm.getAccessibleConversation(request.params.id, request.crm)
      await repo.markConversationRead(conv.id)
      try {
        const wamid = await repo.getLatestInboundWamid(conv.id)
        if (wamid) await client.markRead(wamid)
      } catch (err) {
        // Read receipts are cosmetic — never fail the request because Meta refused one.
        logger.warn({ err: err.message, conversationId: conv.id }, 'WhatsApp read receipt failed')
      }
      return success({ id: conv.id, unreadCount: 0 }, 'Marked as read')
    } catch (err) {
      return fail(reply, err)
    }
  }

  // ─── Assignment ─────────────────────────────────────────────────
  async assign(request, reply) {
    const { crm } = getWhatsappServices()
    try {
      return success(await crm.assign(request.params.id, request.body.userId, request.crm), 'Conversation updated')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async bulkAssign(request, reply) {
    const { crm } = getWhatsappServices()
    try {
      return success(await crm.bulkAssign(request.body.conversationIds, request.body.userId, request.crm), 'Conversations reassigned')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async assignmentHistory(request, reply) {
    const { crm, admin } = getWhatsappServices()
    try {
      const conv = await crm.getAccessibleConversation(request.params.id, request.crm)
      return success(await admin.assignmentHistory(conv.id), 'Assignment history')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async agents() {
    const { admin } = getWhatsappServices()
    return success(await admin.listAgents(), 'Agents fetched')
  }

  async workload() {
    const { admin } = getWhatsappServices()
    return success(await admin.workload(), 'Workload fetched')
  }

  // ─── Labels ─────────────────────────────────────────────────────
  async listLabels() {
    const { admin } = getWhatsappServices()
    return success(await admin.listLabels(), 'Labels fetched')
  }

  async createLabel(request, reply) {
    const { crm } = getWhatsappServices()
    try {
      return success(await crm.createLabel(request.body, request.crm), 'Label created')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async updateLabel(request, reply) {
    const { crm } = getWhatsappServices()
    try {
      return success(await crm.updateLabel(request.params.id, request.body), 'Label updated')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async deleteLabel(request, reply) {
    const { crm } = getWhatsappServices()
    try {
      await crm.deleteLabel(request.params.id)
      return success(null, 'Label deleted')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async addConversationLabel(request, reply) {
    const { crm } = getWhatsappServices()
    try {
      return success(await crm.addConversationLabel(request.params.id, request.body.labelId, request.crm), 'Label added')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async removeConversationLabel(request, reply) {
    const { crm } = getWhatsappServices()
    try {
      return success(await crm.removeConversationLabel(request.params.id, request.params.labelId, request.crm), 'Label removed')
    } catch (err) {
      return fail(reply, err)
    }
  }

  // ─── Pipeline ───────────────────────────────────────────────────
  async pipelineBoard(request) {
    const { pipeline } = getWhatsappServices()
    const a = request.crm
    const { assignedTo, labelId, b2b, search } = request.query
    const board = await pipeline.board(
      { assignedTo: assignedTo === 'me' ? a.userId : assignedTo, labelId, b2b, search },
      a.has(CRM_PERM.INBOX_VIEW_ALL),
      a.userId,
    )
    return success(board, 'Pipeline fetched')
  }

  async moveCard(request, reply) {
    const { pipeline } = getWhatsappServices()
    try {
      return success(await pipeline.moveCard(request.params.contactId, request.body.stageId, request.crm), 'Card moved')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async cardHistory(request, reply) {
    const { pipeline } = getWhatsappServices()
    try {
      return success(await pipeline.history(request.params.contactId, request.crm), 'Stage history')
    } catch (err) {
      return fail(reply, err)
    }
  }

  // ─── Bot ────────────────────────────────────────────────────────
  async botSettings() {
    const { botAdmin } = getWhatsappServices()
    return success(await botAdmin.getSettings(), 'Bot settings')
  }

  async updateBotSettings(request, reply) {
    const { botAdmin } = getWhatsappServices()
    try {
      return success(await botAdmin.updateSettings(request.body, request.user.id), 'Bot settings saved')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async listBotRules() {
    const { botAdmin } = getWhatsappServices()
    return success(await botAdmin.listRules(), 'Bot rules')
  }

  async createBotRule(request, reply) {
    const { botAdmin } = getWhatsappServices()
    try {
      return success(await botAdmin.createRule(request.body, request.user.id), 'Rule created')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async updateBotRule(request, reply) {
    const { botAdmin } = getWhatsappServices()
    try {
      return success(await botAdmin.updateRule(request.params.id, request.body), 'Rule updated')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async deleteBotRule(request, reply) {
    const { botAdmin } = getWhatsappServices()
    try {
      await botAdmin.deleteRule(request.params.id)
      return success(null, 'Rule deleted')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async reorderBotRules(request) {
    const { botAdmin } = getWhatsappServices()
    return success(await botAdmin.reorder(request.body.ids), 'Rules reordered')
  }

  async testBot(request) {
    const { bot } = getWhatsappServices()
    return success(await bot.test(request.body.message, request.body.when), 'Bot test')
  }

  async botActivity(request) {
    const { botRepo } = getWhatsappServices()
    return success(await botRepo.recentEvents(request.query.limit), 'Bot activity')
  }

  /** "Take over" (HUMAN) or "Resume bot" (BOT) for one conversation. */
  async setConversationBot(request, reply) {
    const { bot, crm } = getWhatsappServices()
    try {
      const conv = await crm.getAccessibleConversation(request.params.id, request.crm)
      await bot.setState(conv.id, request.body.state)
      return success({ id: conv.id, botState: request.body.state }, 'Bot state updated')
    } catch (err) {
      return fail(reply, err)
    }
  }

  // ─── Templates ──────────────────────────────────────────────────
  async listTemplates(request) {
    const { templates } = getWhatsappServices()
    const data = await templates.list(request.query)
    return success({ ...data, purposes: PURPOSES }, 'Templates fetched')
  }

  async getTemplate(request, reply) {
    const { templates } = getWhatsappServices()
    try {
      return success(await templates.get(request.params.id), 'Template fetched')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async createTemplate(request, reply) {
    const { templates } = getWhatsappServices()
    try {
      return success(await templates.createDraft(request.body, request.user.id), 'Template saved as draft')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async updateTemplate(request, reply) {
    const { templates } = getWhatsappServices()
    try {
      return success(await templates.update(request.params.id, request.body, request.user.id), 'Template updated')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async submitTemplate(request, reply) {
    const { templates } = getWhatsappServices()
    try {
      return success(await templates.submit(request.params.id), 'Submitted to Meta for review')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async deleteTemplate(request, reply) {
    const { templates } = getWhatsappServices()
    try {
      return success(await templates.remove(request.params.id), 'Template deleted')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async syncTemplates(request, reply) {
    const { templates } = getWhatsappServices()
    try {
      return success(await templates.sync(), 'Synced with Meta')
    } catch (err) {
      return fail(reply, err)
    }
  }

  /** Values we can auto-fill for this customer (customer_name, order_number, cart_value…). */
  async templateValues(request, reply) {
    const { templateSend } = getWhatsappServices()
    try {
      return success(await templateSend.valuesFor(request.params.id, request.crm), 'Known values')
    } catch (err) {
      return fail(reply, err)
    }
  }

  async sendTemplate(request, reply) {
    const { templateSend } = getWhatsappServices()
    // Sending is a reply to the customer: it needs reply permission as well as the template permission.
    if (!request.crm.has(CRM_PERM.INBOX_REPLY)) {
      return reply.code(403).send(error(`Forbidden — requires '${CRM_PERM.INBOX_REPLY}' permission`, 'PERMISSION_DENIED'))
    }
    try {
      const message = await templateSend.send({
        conversationId: request.params.id,
        templateId: request.body.templateId,
        values: request.body.values ?? {},
        headerMediaUrl: request.body.headerMediaUrl,
        sentBy: request.user.id,
        access: request.crm,
      })
      return success(message, 'Template sent')
    } catch (err) {
      return fail(reply, err)
    }
  }
}
