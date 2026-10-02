import { Queue, Worker } from 'bullmq'
import { env } from './env.js'
import { logger } from './logger.js'

/**
 * BullMQ Redis connection config
 */
const connection = {
  host: env.BULL_REDIS_HOST,
  port: env.BULL_REDIS_PORT,
  maxRetriesPerRequest: null,
}

if (env.BULL_REDIS_PASSWORD) {
  connection.password = env.BULL_REDIS_PASSWORD
}

// ─── QUEUES ──────────────────────────────────────────────

/**
 * Notification queue — push notifications, in-app, SMS
 */
export const notificationQueue = new Queue('notifications', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 24 * 3600 },   // Keep completed for 24h
    removeOnFail: { age: 7 * 24 * 3600 },   // Keep failed for 7 days
  },
})

/**
 * Order processing queue — status updates, assignment, cleanup
 */
export const orderQueue = new Queue('orders', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
})

/**
 * SMS queue — OTP delivery via 2Factor
 */
export const smsQueue = new Queue('sms', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 3000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 24 * 3600 },
  },
})

/**
 * Theme processing queue — scheduled activation, asset warmup
 */
export const themeQueue = new Queue('themes', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
})

/**
 * Allocation queue — recompute user-shop allocations on shop area change
 * (Requirements 4.8, 4.9). Concurrency 2, retry 3x exponential backoff.
 */
export const allocationQueue = new Queue('allocation', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
})

/**
 * Settlement queue — daily/weekly/monthly Shop_Financial aggregation
 * (Requirements 6.2, 6.3, 6.4, 6.7, 6.9, 14.6, 14.11).
 *
 * Concurrency 1 (financial writes serialized), 3 attempts with exponential
 * backoff (Req 6.7), and an extended retention window so failed jobs stay
 * inspectable for two weeks.
 */
export const settlementQueue = new Queue('settlement', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 3600 },
    removeOnFail: { age: 14 * 24 * 3600 },
  },
})

/**
 * Payouts queue — weekly payout processing (Requirements 8.1–8.7, 14.6).
 *
 * Cron-driven `weekly-run` fans out a `process-payout` job per PENDING
 * shop_financials row, plus admin-triggered `set-hold` / `release-hold`
 * jobs from the Super Admin endpoints.
 *
 * Concurrency 1: payout state transitions and ledger writes are
 * serialized so concurrent runs cannot move the same row twice. Three
 * attempts with exponential backoff complement the row-level
 * `attempt_count` field — Req 8.5 limits row-level retries to 3 before
 * flipping to HELD, while job-level retries cover transient infra hiccups
 * (Redis blip, transient DB error) without burning through a payout
 * attempt.
 */
export const payoutQueue = new Queue('payouts', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 3600 },
    removeOnFail: { age: 14 * 24 * 3600 },
  },
})

/**
 * Stock notifications queue — restock notifications to wishlist customers
 * (Requirements 3.4, 11.6; task 13.2 worker).
 *
 * Producer side (shop-products service post-commit handler in task 13.1):
 *   - Enqueues `wishlist-restock` jobs when a Shop_Product transitions
 *     from stock_quantity = 0 to a positive value, so the worker can
 *     fan-out push notifications to every Customer who has wishlisted
 *     the underlying product.
 *
 * Worker config (per design.md Background Job Architecture):
 *   - attempts 2, fixed backoff (5s) — restock alerts are best-effort and
 *     should not flood Redis with deep retry chains
 *   - concurrency 2 (applied at worker registration in task 13.2)
 *   - removeOnComplete 24h, removeOnFail 7d
 */
export const stockNotificationsQueue = new Queue('stock-notifications', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
})

/**
 * Scheduled orders queue — fires customer scheduled orders at their
 * scheduled_for time (Requirements 10.2, 10.3, 10.5; task 10.3 worker).
 *
 * Producer side (scheduled-orders module): enqueues delayed jobs with a
 * deterministic jobId (`scheduled-order:{row.id}`) so:
 *   - duplicate enqueues coalesce (idempotent retries)
 *   - cancellation can remove the queued job by id (Requirement 10.6)
 *
 * Worker config (per design.md Background Job Architecture):
 *   - attempts 3, exponential backoff (2s base)
 *   - removeOnComplete 24h, removeOnFail 7d
 *   - concurrency 3 (applied at worker registration in task 10.3)
 */
export const scheduledOrdersQueue = new Queue('scheduled-orders', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
})

/**
 * Report pre-compute queue — caches results of slow reports (>100ms median)
 * into Redis under deterministic keys (Requirements 14.6, design.md).
 *
 * Concurrency 2: report queries are read-only and can safely overlap.
 * Retry 3× exponential backoff covers transient DB/Redis failures.
 */
export const reportPrecomputeQueue = new Queue('report-precompute', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
})

/**
 * Address purge queue — daily cron that hard-deletes soft-deleted
 * addresses once their retention window (ADDRESS_RETENTION_DAYS) has
 * elapsed. Single low-volume job/day, so no special retry tuning needed
 * beyond the queue defaults.
 */
export const addressPurgeQueue = new Queue('address-purge', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
})

/**
 * Ledger-billing queue — daily B2B credit-ledger cycle open + overdue
 * sweep (see src/workers/ledger-billing.worker.js).
 *
 * Concurrency 1: mirrors payoutQueue — billing-cycle writes and the
 * account suspend/reactivate transitions they can trigger are serialized.
 * Single low-volume job/day, same reasoning as addressPurgeQueue.
 */
export const ledgerBillingQueue = new Queue('ledger-billing', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 7 * 24 * 3600 },
    removeOnFail: { age: 14 * 24 * 3600 },
  },
})

/**
 * WhatsApp inbound queue — processes stored Meta webhook events (customer
 * messages + delivery statuses). The job carries only the wa_webhook_events id;
 * the payload is read from Postgres, so Redis loss never loses a message.
 *   - attempts 8 with exponential backoff (5s, 10s, 20s ...) so a status that
 *     raced ahead of our own "message sent" write is retried shortly after
 */
export const whatsappInboundQueue = new Queue('whatsapp-inbound', {
  connection,
  defaultJobOptions: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
})

// ─── WORKERS ─────────────────────────────────────────────

const workers = []

/**
 * Start notification worker
 */
export function startNotificationWorker(processor) {
  const worker = new Worker('notifications', processor, {
    connection,
    concurrency: env.BULL_CONCURRENCY,
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, name: job.name }, 'Notification job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'Notification job failed')
  })

  workers.push(worker)
  logger.info('Notification worker started')
  return worker
}

/**
 * Start order processing worker
 */
export function startOrderWorker(processor) {
  const worker = new Worker('orders', processor, {
    connection,
    concurrency: env.BULL_CONCURRENCY,
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, name: job.name }, 'Order job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'Order job failed')
  })

  workers.push(worker)
  logger.info('Order worker started')
  return worker
}

/**
 * Start SMS worker
 */
export function startSmsWorker(processor) {
  const worker = new Worker('sms', processor, {
    connection,
    concurrency: 2,  // Low concurrency for SMS API rate limits
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'SMS job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'SMS job failed')
  })

  workers.push(worker)
  logger.info('SMS worker started')
  return worker
}

/**
 * Start theme worker
 */
export function startThemeWorker(processor) {
  const worker = new Worker('themes', processor, {
    connection,
    concurrency: 2,
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, name: job.name }, 'Theme job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, name: job?.name, err: err.message }, 'Theme job failed')
  })

  workers.push(worker)
  logger.info('Theme worker started')
  return worker
}

/**
 * Start allocation worker — handles `recompute-by-shop` jobs that fan out
 * pincode/radius changes to affected customers (Requirements 4.8, 4.9).
 * Concurrency 2 per design.md Background Job Architecture.
 */
export function startAllocationWorker(processor) {
  const worker = new Worker('allocation', processor, {
    connection,
    concurrency: 2,
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, name: job.name }, 'Allocation job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, name: job?.name, err: err.message },
      'Allocation job failed'
    )
  })

  workers.push(worker)
  logger.info('Allocation worker started')
  return worker
}

/**
 * Start scheduled-orders worker — fires customer scheduled orders at their
 * scheduled_for time (Requirements 10.2, 10.3, 10.5).
 *
 * The actual job processor (validate stock, place real order, link
 * placed_order_id, compute next recurrence, mark FAILED on stock failure)
 * is implemented in task 10.3. This factory exists so 10.2 can wire the
 * queue producer end-to-end without coupling to the worker, and 10.3 just
 * needs to register a processor.
 *
 * Concurrency 3 per design.md Background Job Architecture.
 */
export function startScheduledOrderWorker(processor) {
  const worker = new Worker('scheduled-orders', processor, {
    connection,
    concurrency: 3,
  })

  worker.on('completed', (job) => {
    logger.debug(
      { jobId: job.id, name: job.name },
      'Scheduled-order job completed'
    )
  })

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, name: job?.name, err: err.message },
      'Scheduled-order job failed'
    )
  })

  workers.push(worker)
  logger.info('Scheduled-orders worker started')
  return worker
}

/**
 * Start settlement worker — handles daily/weekly/monthly Shop_Financial
 * aggregation jobs (Requirements 6.2, 6.7, 6.9, 14.6).
 *
 * Concurrency 1: financial writes are serialized so the daily UPSERT
 * loop never races with itself across multiple worker processes.
 */
export function startSettlementWorker(processor) {
  const worker = new Worker('settlement', processor, {
    connection,
    concurrency: 1,
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, name: job.name }, 'Settlement job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        name: job?.name,
        err: err.message,
        shop_id: job?.data?.shopId || null,
        period_start: job?.data?.date || job?.data?.periodStart || null,
        attempt: job?.attemptsMade,
        action: 'settlement_job_failed',
      },
      'Settlement job failed'
    )
  })

  workers.push(worker)
  logger.info('Settlement worker started')
  return worker
}

/**
 * Start payout worker — handles weekly payout processing
 * (Requirements 8.1–8.7, 14.6).
 *
 * Concurrency 1: every payout job locks one shop_financials row with
 * SELECT FOR UPDATE and writes to the ledger; serializing job execution
 * keeps the lock window short and avoids worker contention on the same
 * row when retries collide.
 */
export function startPayoutWorker(processor) {
  const worker = new Worker('payouts', processor, {
    connection,
    concurrency: 1,
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, name: job.name }, 'Payout job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        name: job?.name,
        err: err.message,
        financialId: job?.data?.financialId || null,
        type: job?.data?.type || job?.name,
        attempt: job?.attemptsMade,
        action: 'payout_job_failed',
      },
      'Payout job failed'
    )
  })

  workers.push(worker)
  logger.info('Payout worker started')
  return worker
}

/**
 * Start stock-notifications worker — fans out restock alerts to customers
 * who wishlisted a Shop_Product when stock transitions from 0 to >0
 * (Requirements 3.4, 11.6).
 *
 * Concurrency 2 per design.md Background Job Architecture: restock fan-out
 * can run in parallel across products without contention on shared rows.
 * The actual processor (lookup wishlist users, send push) is implemented
 * in task 13.2.
 */
export function startStockNotificationsWorker(processor) {
  const worker = new Worker('stock-notifications', processor, {
    connection,
    concurrency: 2,
  })

  worker.on('completed', (job) => {
    logger.debug(
      { jobId: job.id, name: job.name },
      'Stock-notifications job completed'
    )
  })

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, name: job?.name, err: err.message },
      'Stock-notifications job failed'
    )
  })

  workers.push(worker)
  logger.info('Stock-notifications worker started')
  return worker
}

/**
 * Start report-precompute worker — runs slow report queries and caches
 * results to Redis under deterministic keys (Requirements 14.6).
 *
 * Concurrency 2: report queries are read-only and can safely overlap
 * without contention on shared rows.
 */
export function startReportPrecomputeWorker(processor) {
  const worker = new Worker('report-precompute', processor, {
    connection,
    concurrency: 2,
  })

  worker.on('completed', (job) => {
    logger.debug(
      { jobId: job.id, name: job.name },
      'Report-precompute job completed'
    )
  })

  worker.on('failed', (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        name: job?.name,
        err: err.message,
        reportType: job?.data?.reportType || null,
        action: 'report_precompute_job_failed',
      },
      'Report-precompute job failed'
    )
  })

  workers.push(worker)
  logger.info('Report-precompute worker started')
  return worker
}

/**
 * Start address-purge worker — runs the daily job that hard-deletes
 * soft-deleted addresses past their retention window.
 */
export function startAddressPurgeWorker(processor) {
  const worker = new Worker('address-purge', processor, {
    connection,
    concurrency: 1,
  })

  worker.on('completed', (job) => {
    logger.info(
      { jobId: job.id, name: job.name, result: job.returnvalue },
      'Address-purge job completed'
    )
  })

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, name: job?.name, err: err.message, action: 'address_purge_job_failed' },
      'Address-purge job failed'
    )
  })

  workers.push(worker)
  logger.info('Address-purge worker started')
  return worker
}

/**
 * Start ledger-billing worker — handles the daily B2B credit-ledger
 * billing-cycle open + overdue sweep.
 *
 * Concurrency 1: see ledgerBillingQueue's docstring above.
 */
export function startLedgerBillingWorker(processor) {
  const worker = new Worker('ledger-billing', processor, {
    connection,
    concurrency: 1,
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, name: job.name }, 'Ledger-billing job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, name: job?.name, err: err.message, action: 'ledger_billing_job_failed' },
      'Ledger-billing job failed'
    )
  })

  workers.push(worker)
  logger.info('Ledger-billing worker started')
  return worker
}

/**
 * Start WhatsApp inbound worker (webhook event processing + stale-event sweep)
 */
export function startWhatsappInboundWorker(processor) {
  const worker = new Worker('whatsapp-inbound', processor, {
    connection,
    concurrency: 4,
  })

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, name: job.name }, 'WhatsApp inbound job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, name: job?.name, attemptsMade: job?.attemptsMade, err: err.message },
      'WhatsApp inbound job failed'
    )
  })

  workers.push(worker)
  logger.info('WhatsApp inbound worker started')
  return worker
}

/**
 * Close all queues and workers (graceful shutdown)
 */
export async function closeBullMQ() {
  for (const worker of workers) {
    await worker.close()
  }
  await notificationQueue.close()
  await orderQueue.close()
  await smsQueue.close()
  await themeQueue.close()
  await allocationQueue.close()
  await scheduledOrdersQueue.close()
  await settlementQueue.close()
  await payoutQueue.close()
  await stockNotificationsQueue.close()
  await reportPrecomputeQueue.close()
  await addressPurgeQueue.close()
  await ledgerBillingQueue.close()
  await whatsappInboundQueue.close()
  logger.info('BullMQ queues and workers closed')
}
