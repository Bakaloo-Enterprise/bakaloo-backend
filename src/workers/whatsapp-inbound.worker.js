import { logger } from '../config/logger.js'
import { getWhatsappServices } from '../modules/whatsapp-crm/whatsapp.factory.js'

/**
 * WhatsApp inbound worker.
 *
 *   'process' — apply one stored webhook event (customer message / delivery status)
 *   'sweep'   — every minute: re-enqueue stored events whose job was lost
 *               (e.g. the API crashed between saving the event and queueing it)
 *
 * Both are idempotent. Unlike the in-process setInterval jobs elsewhere in this
 * codebase, the sweep is a BullMQ repeatable job, so it runs once no matter how
 * many API/worker copies are alive.
 */
export function createWhatsappInboundProcessor() {
  return async function processWhatsappInbound(job) {
    const { repo, inbound, pipeline, templates, campaigns, workflows } = getWhatsappServices()

    if (job.name === 'pipeline-reconcile') return pipeline.reconcile()
    if (job.name === 'campaign-tick') return campaigns.tick()
    if (job.name === 'workflow-tick') return workflows.tick()
    if (job.name === 'templates-sync') return syncTemplatesQuietly(templates)

    if (job.name === 'sweep') {
      return sweepStaleEvents(job.queue, repo)
    }

    const { eventId } = job.data
    try {
      return await inbound.processEvent(eventId)
    } catch (err) {
      await repo.markEventFailed(eventId, err.message).catch(() => {})
      throw err // BullMQ retries with backoff
    }
  }
}

/** Repairs missed template webhooks. Does nothing (quietly) when WhatsApp is not connected. */
async function syncTemplatesQuietly(templates) {
  try {
    return await templates.sync()
  } catch (err) {
    if (err?.code === 'NOT_CONFIGURED' || err?.code === 'SYNC_RUNNING') return { skipped: err.code }
    logger.warn({ err: err.message }, 'Scheduled template sync failed')
    return { failed: true }
  }
}

async function sweepStaleEvents(queue, repo) {
  const stale = await repo.listStaleUnprocessedEvents()
  let requeued = 0
  for (const { id, attempts } of stale) {
    const existing = await queue.getJob(id)
    if (existing) {
      const state = await existing.getState()
      if (state === 'failed') {
        await existing.retry()
        requeued++
      }
      continue // waiting / active / delayed: already in flight
    }
    await queue.add('process', { eventId: id }, { jobId: id })
    requeued++
  }
  if (requeued > 0) logger.warn({ requeued }, 'WhatsApp sweep re-enqueued stale webhook events')
  return { checked: stale.length, requeued }
}

export async function scheduleWhatsappSweep(queue) {
  if (!queue) return
  await queue.add(
    'pipeline-reconcile',
    {},
    { repeat: { every: 60 * 1000 }, jobId: 'whatsapp-pipeline-reconcile', removeOnComplete: true, removeOnFail: true, attempts: 1 },
  )
  await queue.add(
    'templates-sync',
    {},
    { repeat: { every: 6 * 60 * 60 * 1000 }, jobId: 'whatsapp-templates-sync', removeOnComplete: true, removeOnFail: true, attempts: 1 },
  )
  await queue.add(
    'campaign-tick',
    {},
    { repeat: { every: 10 * 1000 }, jobId: 'whatsapp-campaign-tick', removeOnComplete: true, removeOnFail: true, attempts: 1 },
  )
  await queue.add(
    'workflow-tick',
    {},
    { repeat: { every: 30 * 1000 }, jobId: 'whatsapp-workflow-tick', removeOnComplete: true, removeOnFail: true, attempts: 1 },
  )
  await queue.add(
    'sweep',
    {},
    { repeat: { every: 60 * 1000 }, jobId: 'whatsapp-inbound-sweep', removeOnComplete: true, removeOnFail: true, attempts: 1 },
  )
}
