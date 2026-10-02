import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { getSocketEmitter } from '../../plugins/socket-emitter.js'
import { WhatsappRepository } from './whatsapp.repository.js'
import { createLazyMetaClient } from './dynamic-client.js'
import { WhatsappSettingsRepository } from './settings.repository.js'
import { WhatsappSettingsService } from './settings.service.js'
import { InboundService } from './inbound.service.js'
import { SendService } from './send.service.js'
import { CrmAdminRepository } from './crm-admin.repository.js'
import { CrmAdminService } from './crm-admin.service.js'
import { PipelineRepository } from './pipeline.repository.js'
import { PipelineService } from './pipeline.service.js'
import { BotRepository } from './bot.repository.js'
import { BotService } from './bot.service.js'
import { BotAdminService } from './bot-admin.service.js'
import { TemplateRepository } from './template.repository.js'
import { TemplateService } from './template.service.js'
import { TemplateSendService } from './template-send.service.js'
import { AutomatedSender } from './automated-sender.js'
import { CampaignRepository } from './campaign.repository.js'
import { CampaignService } from './campaign.service.js'
import { ProspectRepository } from './prospect.repository.js'
import { ProspectService } from './prospect.service.js'
import { AnalyticsRepository } from './analytics.repository.js'
import { AnalyticsService } from './analytics.service.js'
import { WorkflowRepository } from './workflow.repository.js'
import { WorkflowService } from './workflow.service.js'
import { StoreStatusService } from '../store-status/store-status.service.js'

/**
 * Wires the WhatsApp CRM pieces from env config. Built lazily and cached, so
 * importing this file never touches Redis/DB and the API boots fine with
 * WhatsApp unconfigured.
 */
let cached = null

/** Realtime fan-out to the dashboard (works from both the API and worker processes). */
export function emitCrmEvent(event, payload) {
  try {
    // Phase 1: every admin / HQ dashboard session. Per-agent rooms arrive with CRM roles (Phase 3).
    getSocketEmitter().to('admin:dashboard').to('hq:global').emit(event, payload)
  } catch (err) {
    logger.warn({ err: err.message, event }, 'Could not emit CRM realtime event')
  }
}

export function getWhatsappServices() {
  if (cached) return cached
  const repo = new WhatsappRepository()
  const admin = new CrmAdminRepository()
  const pipeline = new PipelineService({ repo: new PipelineRepository(), emit: emitCrmEvent, logger })
  // Credentials come from the dashboard settings first, then .env — looked up per call (cached a few seconds).
  const settings = new WhatsappSettingsService({ repo: new WhatsappSettingsRepository(), env, logger })
  const client = createLazyMetaClient(() => settings.resolved())
  const crmService = new CrmAdminService({ repo, admin, emit: emitCrmEvent })
  const botRepo = new BotRepository()
  const tplRepo = new TemplateRepository()
  const templates = new TemplateService({ repo: tplRepo, client, emit: emitCrmEvent, logger })
  const storeStatus = new StoreStatusService()
  const bot = new BotService({
    botRepo,
    repo,
    client,
    // One source of truth for "are we open": the same evaluator the storefront uses.
    isStoreOpen: async (at) => (await storeStatus.isOpen(at)).isOpen,
    emit: emitCrmEvent,
    logger,
  })
  const sender = new AutomatedSender({ repo, tplRepo, client, emit: emitCrmEvent, logger })
  cached = {
    repo,
    settings,
    client,
    inbound: new InboundService({ repo, emit: emitCrmEvent, logger, phoneNumberId: async () => (await settings.resolved()).phoneNumberId, pipeline, bot, templates }),
    send: new SendService({ repo, client, emit: emitCrmEvent, logger, pipeline, bot }),
    pipeline,
    bot,
    botRepo,
    botAdmin: new BotAdminService({ botRepo, emit: emitCrmEvent }),
    templates,
    tplRepo,
    templateSend: new TemplateSendService({ repo, tplRepo, client, getConversation: (id, access) => crmService.getAccessibleConversation(id, access), emit: emitCrmEvent, logger, pipeline, bot }),
    campaigns: new CampaignService({ repo: new CampaignRepository(), tplRepo, sender, emit: emitCrmEvent, logger }),
    prospects: new ProspectService({ repo: new ProspectRepository(), logger }),
    analytics: new AnalyticsService({ repo: new AnalyticsRepository() }),
    workflows: new WorkflowService({ repo: new WorkflowRepository(), tplRepo, sender, emit: emitCrmEvent, logger, appUrl: env.CUSTOMER_APP_URL }),
    admin,
    crm: crmService,
  }
  return cached
}

/** Which pieces are configured (dashboard settings + .env). Never returns the values. */
export async function getWhatsappConfigStatus() {
  const c = await getWhatsappServices().settings.resolved()
  return {
    enabled: c.enabled,
    apiVersion: c.apiVersion,
    configured: {
      phoneNumberId: Boolean(c.phoneNumberId),
      wabaId: Boolean(c.wabaId),
      accessToken: Boolean(c.accessToken),
      verifyToken: Boolean(c.verifyToken),
      appSecret: Boolean(c.appSecret),
    },
    // Templates can be listed/created locally without Meta, but submit/sync/send need these two.
    templatesReady: Boolean(c.wabaId && c.accessToken),
    webhookPath: '/api/webhook/whatsapp',
  }
}
