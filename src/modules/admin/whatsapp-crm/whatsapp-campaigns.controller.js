import { success, error } from '../../../utils/apiResponse.js'
import { CrmError } from '../../whatsapp-crm/errors.js'
import { getWhatsappServices } from '../../whatsapp-crm/whatsapp.factory.js'

function fail(reply, err) {
  if (err instanceof CrmError) {
    const body = error(err.message, err.code)
    return reply.code(err.statusCode).send(err.details !== undefined ? { ...body, details: err.details } : body)
  }
  throw err
}

/** Runs a service call and converts domain errors into API errors. */
const run = (message, fn) =>
  async function handler(request, reply) {
    try {
      return success(await fn(getWhatsappServices(), request), message)
    } catch (err) {
      return fail(reply, err)
    }
  }

/** Campaigns, consent, suppression and workflows (Phase 7). */
export class AdminWhatsappCampaignsController {
  // Campaigns
  listCampaigns = run('Campaigns fetched', ({ campaigns }, r) => campaigns.list(r.query))
  campaignOptions = run('Options fetched', ({ campaigns }) => campaigns.options())
  getCampaign = run('Campaign fetched', ({ campaigns }, r) => campaigns.get(r.params.id))
  createCampaign = run('Campaign saved as draft', ({ campaigns }, r) => campaigns.create(r.body, r.user.id))
  updateCampaign = run('Campaign updated', ({ campaigns }, r) => campaigns.update(r.params.id, r.body))
  deleteCampaign = run('Campaign deleted', async ({ campaigns }, r) => { await campaigns.remove(r.params.id); return { id: r.params.id } })
  previewCampaign = run('Audience checked', ({ campaigns }, r) => campaigns.preview(r.params.id))
  launchCampaign = run('Campaign launched', ({ campaigns }, r) => campaigns.launch(r.params.id, { scheduledAt: r.body?.scheduledAt ?? null }))
  pauseCampaign = run('Campaign paused', ({ campaigns }, r) => campaigns.pause(r.params.id))
  resumeCampaign = run('Campaign resumed', ({ campaigns }, r) => campaigns.resume(r.params.id))
  cancelCampaign = run('Campaign cancelled', ({ campaigns }, r) => campaigns.cancel(r.params.id))
  campaignRecipients = run('Recipients fetched', ({ campaigns }, r) => campaigns.recipients(r.params.id, r.query))

  // Consent & suppression
  recordConsent = run('Consent recorded', ({ campaigns }, r) => campaigns.recordConsent(r.body))
  listSuppressed = run('Do-not-contact list fetched', ({ campaigns }, r) => campaigns.listSuppressed(r.query))
  suppress = run('Added to the do-not-contact list', async ({ campaigns }, r) => { await campaigns.suppress(r.params.contactId, r.body?.reason, r.user.id); return { contactId: r.params.contactId } })
  unsuppress = run('Removed from the do-not-contact list', async ({ campaigns }, r) => { await campaigns.unsuppress(r.params.contactId); return { contactId: r.params.contactId } })

  // Prospect imports (Phase 8)
  listImports = run('Prospect lists fetched', ({ prospects }) => prospects.list())
  getImport = run('Prospect list fetched', ({ prospects }, r) => prospects.get(r.params.id))
  importRows = run('Rows fetched', ({ prospects }, r) => prospects.rows(r.params.id, r.query))
  confirmImport = run('Prospects added', ({ prospects }, r) => prospects.confirm(r.params.id, r.body, r.user.id))
  discardImport = run('Prospect list discarded', async ({ prospects }, r) => { await prospects.discard(r.params.id); return { id: r.params.id } })

  /** multipart: a .csv / .xlsx file plus an optional "name" field. Nothing is created until it is confirmed. */
  async uploadImport(request, reply) {
    const file = await request.file()
    if (!file) return reply.code(400).send(error('No file uploaded', 'BAD_REQUEST'))
    try {
      const buffer = await file.toBuffer()
      const name = file.fields?.name?.value
      return success(await getWhatsappServices().prospects.preview({ buffer, filename: file.filename, name, userId: request.user.id }), 'File checked')
    } catch (err) {
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(400).send(error('That file is too large.', 'FILE_TOO_LARGE'))
      return fail(reply, err)
    }
  }

  // Workflows
  workflowCatalog = run('Workflow options fetched', ({ workflows }) => workflows.catalog())
  listWorkflows = run('Workflows fetched', ({ workflows }) => workflows.list())
  getWorkflow = run('Workflow fetched', ({ workflows }, r) => workflows.get(r.params.id))
  createWorkflow = run('Workflow saved (switched off)', ({ workflows }, r) => workflows.create(r.body, r.user.id))
  updateWorkflow = run('Workflow updated', ({ workflows }, r) => workflows.update(r.params.id, r.body))
  activateWorkflow = run('Workflow updated', ({ workflows }, r) => workflows.setActive(r.params.id, r.body.active))
  deleteWorkflow = run('Workflow deleted', async ({ workflows }, r) => { await workflows.remove(r.params.id); return { id: r.params.id } })
}
