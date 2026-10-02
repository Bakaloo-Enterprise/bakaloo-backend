import { AdminWhatsappCrmController } from './whatsapp-crm.controller.js'
import { AdminWhatsappCampaignsController } from './whatsapp-campaigns.controller.js'
import { AdminWhatsappAnalyticsController } from './whatsapp-analytics.controller.js'
import { CRM_PERM, requireCrm } from '../../whatsapp-crm/access.js'
import * as S from './whatsapp-crm.schema.js'

const ctrl = new AdminWhatsappCrmController()
const camp = new AdminWhatsappCampaignsController()
const analytics = new AdminWhatsappAnalyticsController()

/**
 * WhatsApp CRM admin API — mounted at /api/v1/admin/crm.
 *
 * Every route needs an authenticated admin AND a CRM permission (see
 * modules/whatsapp-crm/access.js). HQ SUPER_ADMIN / ADMIN always pass.
 * Finer rules (agents only see own + unassigned chats, who may assign) live in
 * crm-admin.service.js.
 */
export default async function adminWhatsappCrmRoutes(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  const route = (method, url, perm, schema, handler, owner = ctrl) =>
    fastify[method](url, { schema, preValidation: requireCrm(perm), config: { requiredPermission: perm } }, handler.bind(owner))
  const croute = (method, url, perm, schema, handler) => route(method, url, perm, schema, handler, camp)
  const aroute = (method, url, perm, schema, handler) => route(method, url, perm, schema, handler, analytics)

  const { INBOX_VIEW, INBOX_REPLY, LABELS_APPLY, LABELS_MANAGE, ASSIGN, WORKLOAD_VIEW, PIPELINE_VIEW, PIPELINE_MOVE, BOT_MANAGE, TEMPLATES_VIEW, TEMPLATES_SEND, TEMPLATES_MANAGE, CAMPAIGNS_VIEW, CAMPAIGNS_MANAGE, WORKFLOWS_MANAGE, ANALYTICS_VIEW, RATES_MANAGE, SETTINGS_MANAGE } = CRM_PERM

  route('get', '/status', INBOX_VIEW, undefined, ctrl.status)

  // Connection settings: credentials are saved encrypted and are never returned (only masked).
  // The view: any signed-in admin (the hook above authenticates). It hides the verify token and reports canManage;
  // the four actions below need crm.settings.manage. None of these five is held back by the CRM lock (see feature-access.js).
  fastify.get('/settings', ctrl.settingsView.bind(ctrl))
  route('put', '/settings', SETTINGS_MANAGE, S.saveSettingsSchema, ctrl.settingsSave)
  route('post', '/settings/test', SETTINGS_MANAGE, S.testSettingsSchema, ctrl.settingsTest)
  route('post', '/settings/connect-replies', SETTINGS_MANAGE, undefined, ctrl.settingsConnectReplies)
  route('post', '/settings/enable', SETTINGS_MANAGE, S.enableSettingsSchema, ctrl.settingsEnable)
  route('delete', '/settings/credentials', SETTINGS_MANAGE, undefined, ctrl.settingsClear)
  route('get', '/me', INBOX_VIEW, undefined, ctrl.me)
  route('get', '/agents', INBOX_VIEW, undefined, ctrl.agents)
  route('get', '/workload', WORKLOAD_VIEW, undefined, ctrl.workload)

  // From the customer profile: read the WhatsApp history, or open (find / create) the customer's conversation to message them.
  route('get', '/customers/:userId/thread', INBOX_VIEW, S.customerUserSchema, ctrl.customerThread)
  route('post', '/customers/:userId/conversation', INBOX_REPLY, S.customerUserSchema, ctrl.openCustomerConversation)

  route('get', '/conversations', INBOX_VIEW, S.listConversationsSchema, ctrl.listConversations)
  route('post', '/conversations/bulk-assign', ASSIGN, S.bulkAssignSchema, ctrl.bulkAssign)
  route('get', '/conversations/:id', INBOX_VIEW, S.conversationIdSchema, ctrl.getConversation)
  route('get', '/conversations/:id/messages', INBOX_VIEW, S.listMessagesSchema, ctrl.listMessages)
  route('post', '/conversations/:id/messages', INBOX_REPLY, S.sendMessageSchema, ctrl.sendMessage)
  route('post', '/conversations/:id/read', INBOX_VIEW, S.conversationIdSchema, ctrl.markRead)
  // Finer rule inside: an agent may claim an UNASSIGNED chat for themselves; moving it elsewhere needs ASSIGN.
  route('post', '/conversations/:id/assign', INBOX_VIEW, S.assignSchema, ctrl.assign)
  route('get', '/conversations/:id/assignments', INBOX_VIEW, S.conversationIdSchema, ctrl.assignmentHistory)
  route('post', '/conversations/:id/labels', LABELS_APPLY, S.addConversationLabelSchema, ctrl.addConversationLabel)
  route('delete', '/conversations/:id/labels/:labelId', LABELS_APPLY, S.removeConversationLabelSchema, ctrl.removeConversationLabel)

  route('get', '/pipeline', PIPELINE_VIEW, S.pipelineBoardSchema, ctrl.pipelineBoard)
  route('post', '/pipeline/contacts/:contactId/stage', PIPELINE_MOVE, S.moveCardSchema, ctrl.moveCard)
  route('get', '/pipeline/contacts/:contactId/history', PIPELINE_VIEW, S.contactIdSchema, ctrl.cardHistory)

  route('get', '/bot/settings', BOT_MANAGE, undefined, ctrl.botSettings)
  route('put', '/bot/settings', BOT_MANAGE, S.updateBotSettingsSchema, ctrl.updateBotSettings)
  route('get', '/bot/rules', BOT_MANAGE, undefined, ctrl.listBotRules)
  route('post', '/bot/rules', BOT_MANAGE, S.createBotRuleSchema, ctrl.createBotRule)
  route('post', '/bot/rules/reorder', BOT_MANAGE, S.reorderBotRulesSchema, ctrl.reorderBotRules)
  route('patch', '/bot/rules/:id', BOT_MANAGE, S.updateBotRuleSchema, ctrl.updateBotRule)
  route('delete', '/bot/rules/:id', BOT_MANAGE, S.botRuleIdSchema, ctrl.deleteBotRule)
  route('post', '/bot/test', BOT_MANAGE, S.testBotSchema, ctrl.testBot)
  route('get', '/bot/activity', BOT_MANAGE, S.botActivitySchema, ctrl.botActivity)
  // Agents pause / resume the bot on a chat they can access.
  route('post', '/conversations/:id/bot', INBOX_REPLY, S.setConversationBotSchema, ctrl.setConversationBot)

  route('get', '/templates', TEMPLATES_VIEW, S.listTemplatesSchema, ctrl.listTemplates)
  route('post', '/templates', TEMPLATES_MANAGE, S.createTemplateSchema, ctrl.createTemplate)
  route('post', '/templates/sync', TEMPLATES_MANAGE, undefined, ctrl.syncTemplates)
  route('get', '/templates/:id', TEMPLATES_VIEW, S.templateIdSchema, ctrl.getTemplate)
  route('patch', '/templates/:id', TEMPLATES_MANAGE, S.updateTemplateSchema, ctrl.updateTemplate)
  route('post', '/templates/:id/submit', TEMPLATES_MANAGE, S.templateIdSchema, ctrl.submitTemplate)
  route('delete', '/templates/:id', TEMPLATES_MANAGE, S.templateIdSchema, ctrl.deleteTemplate)
  route('get', '/conversations/:id/template-values', TEMPLATES_SEND, S.conversationIdSchema, ctrl.templateValues)
  route('post', '/conversations/:id/templates/send', TEMPLATES_SEND, S.sendTemplateSchema, ctrl.sendTemplate)

  route('get', '/labels', INBOX_VIEW, undefined, ctrl.listLabels)
  route('post', '/labels', LABELS_MANAGE, S.createLabelSchema, ctrl.createLabel)
  route('patch', '/labels/:id', LABELS_MANAGE, S.updateLabelSchema, ctrl.updateLabel)
  route('delete', '/labels/:id', LABELS_MANAGE, S.labelIdSchema, ctrl.deleteLabel)

  croute('get', '/campaigns', CAMPAIGNS_VIEW, S.listCampaignsSchema, camp.listCampaigns)
  croute('get', '/campaigns/options', CAMPAIGNS_VIEW, undefined, camp.campaignOptions)
  croute('post', '/campaigns', CAMPAIGNS_MANAGE, S.createCampaignSchema, camp.createCampaign)
  croute('get', '/campaigns/:id', CAMPAIGNS_VIEW, S.campaignIdSchema, camp.getCampaign)
  croute('patch', '/campaigns/:id', CAMPAIGNS_MANAGE, S.updateCampaignSchema, camp.updateCampaign)
  croute('delete', '/campaigns/:id', CAMPAIGNS_MANAGE, S.campaignIdSchema, camp.deleteCampaign)
  croute('post', '/campaigns/:id/preview', CAMPAIGNS_MANAGE, S.campaignIdSchema, camp.previewCampaign)
  croute('post', '/campaigns/:id/launch', CAMPAIGNS_MANAGE, S.launchCampaignSchema, camp.launchCampaign)
  croute('post', '/campaigns/:id/pause', CAMPAIGNS_MANAGE, S.campaignIdSchema, camp.pauseCampaign)
  croute('post', '/campaigns/:id/resume', CAMPAIGNS_MANAGE, S.campaignIdSchema, camp.resumeCampaign)
  croute('post', '/campaigns/:id/cancel', CAMPAIGNS_MANAGE, S.campaignIdSchema, camp.cancelCampaign)
  croute('get', '/campaigns/:id/recipients', CAMPAIGNS_VIEW, S.campaignRecipientsSchema, camp.campaignRecipients)

  croute('post', '/consent/record', CAMPAIGNS_MANAGE, S.recordConsentSchema, camp.recordConsent)
  croute('get', '/suppression', CAMPAIGNS_VIEW, S.listSuppressionSchema, camp.listSuppressed)
  croute('post', '/suppression/:contactId', CAMPAIGNS_MANAGE, S.suppressSchema, camp.suppress)
  croute('delete', '/suppression/:contactId', CAMPAIGNS_MANAGE, S.unsuppressSchema, camp.unsuppress)

  croute('get', '/workflows', WORKFLOWS_MANAGE, undefined, camp.listWorkflows)
  croute('get', '/workflows/catalog', WORKFLOWS_MANAGE, undefined, camp.workflowCatalog)
  croute('post', '/workflows', WORKFLOWS_MANAGE, S.createWorkflowSchema, camp.createWorkflow)
  croute('get', '/workflows/:id', WORKFLOWS_MANAGE, S.workflowIdSchema, camp.getWorkflow)
  croute('patch', '/workflows/:id', WORKFLOWS_MANAGE, S.updateWorkflowSchema, camp.updateWorkflow)
  croute('post', '/workflows/:id/activate', WORKFLOWS_MANAGE, S.activateWorkflowSchema, camp.activateWorkflow)
  croute('delete', '/workflows/:id', WORKFLOWS_MANAGE, S.workflowIdSchema, camp.deleteWorkflow)

  croute('get', '/prospects/imports', CAMPAIGNS_VIEW, undefined, camp.listImports)
  croute('post', '/prospects/imports', CAMPAIGNS_MANAGE, undefined, camp.uploadImport)
  croute('get', '/prospects/imports/:id', CAMPAIGNS_VIEW, S.importIdSchema, camp.getImport)
  croute('get', '/prospects/imports/:id/rows', CAMPAIGNS_VIEW, S.importRowsSchema, camp.importRows)
  croute('post', '/prospects/imports/:id/confirm', CAMPAIGNS_MANAGE, S.confirmImportSchema, camp.confirmImport)
  croute('delete', '/prospects/imports/:id', CAMPAIGNS_MANAGE, S.importIdSchema, camp.discardImport)

  aroute('get', '/analytics/overview', ANALYTICS_VIEW, S.analyticsRangeSchema, analytics.overview)
  aroute('get', '/analytics/inbox', ANALYTICS_VIEW, S.analyticsRangeSchema, analytics.inbox)
  aroute('get', '/analytics/breakdown/:by', ANALYTICS_VIEW, S.analyticsBreakdownSchema, analytics.breakdown)
  aroute('get', '/rate-cards', ANALYTICS_VIEW, undefined, analytics.rateCards)
  aroute('post', '/rate-cards', RATES_MANAGE, S.addRateCardSchema, analytics.addRateCard)
  aroute('delete', '/rate-cards/:id', RATES_MANAGE, S.rateCardIdSchema, analytics.removeRateCard)
}
