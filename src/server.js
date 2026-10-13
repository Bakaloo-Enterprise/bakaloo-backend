import { buildApp } from './app.js'
import { env } from './config/env.js'
import { testConnection, closePool } from './config/database.js'
import { closeRedis } from './config/redis.js'
import { logger } from './config/logger.js'
import { runPermissionAudit } from './utils/permission-audit.js'
import { startCampaignScheduler, stopCampaignScheduler } from './workers/campaign-scheduler.worker.js'
import { startPaymentExpiryWorker, stopPaymentExpiryWorker } from './workers/payment-expiry.worker.js'
import {
  startDeliveryCalendarGenerationWorker,
  stopDeliveryCalendarGenerationWorker,
} from './workers/delivery-calendar-generation.worker.js'
import {
  startStoreStatusSchedulerWorker,
  stopStoreStatusSchedulerWorker,
} from './workers/store-status-scheduler.worker.js'
import {
  startAbandonedCartWorker,
  stopAbandonedCartWorker,
} from './workers/abandoned-cart.worker.js'
import {
  startWalletTopupReconciliationWorker,
  stopWalletTopupReconciliationWorker,
} from './workers/wallet-topup-reconciliation.worker.js'
import { startWalletExpiryWorker, stopWalletExpiryWorker } from './workers/wallet-expiry.worker.js'

const start = async () => {
  try {
    // Test database connection before starting
    await testConnection()

    // Build Fastify app
    const app = await buildApp()

    // ─── BOOT-TIME PERMISSION AUDIT (R17 AC#9, task 2.7) ───────────
    // After every plugin and module route has been registered, ensure
    // each protected dashboard route declares a canonical Permission_String
    // (design §4.5). `app.ready()` flushes all pending registrations so
    // every onRoute hook callback has fired into `app.permissionAuditRoutes`.
    // When STRICT_PERMISSION_AUDIT is true and any violation is found, abort
    // boot with exit code 1 per R17 AC#9; otherwise log a warning so the
    // misconfiguration stays visible while Phase C wires permissions in.
    await app.ready()
    const audit = runPermissionAudit({
      collectedRoutes: app.permissionAuditRoutes,
      strict: env.STRICT_PERMISSION_AUDIT,
      logger,
    })
    if (!audit.ok) {
      // Logged at error level inside runPermissionAudit. Close the
      // half-built app to release sockets and DB clients before exit so
      // graceful shutdown observers do not see a stuck process.
      await app.close().catch(() => {})
      await closePool().catch(() => {})
      await closeRedis().catch(() => {})
      process.exit(1)
    }

    // Start listening
    await app.listen({ port: env.PORT, host: env.HOST })

    logger.info(`🚀 ${env.APP_NAME} running on http://${env.HOST}:${env.PORT}`)
    if (env.ENABLE_SWAGGER) {
      logger.info(`📖 Swagger docs at http://localhost:${env.PORT}/documentation`)
    }
    if (app.io) {
      logger.info(`🔌 Socket.IO ready on ws://${env.HOST}:${env.PORT}`)
    }

    // Start campaign scheduler poller
    startCampaignScheduler()

    // Start payment expiry worker (cleans up abandoned 15-min payment windows)
    startPaymentExpiryWorker()

    // Start delivery calendar generation worker (keeps the slot picker topped up)
    startDeliveryCalendarGenerationWorker()

    // Start store status scheduler worker (auto-detects weekly-schedule
    // open/close transitions and pushes them live, no admin action needed)
    startStoreStatusSchedulerWorker()

    // Start abandoned cart sweep worker (detects carts inactive 10+ min)
    startAbandonedCartWorker(app)

    // Start wallet top-up reconciliation worker (catches payments Razorpay
    // captured but the app never confirmed back to us)
    startWalletTopupReconciliationWorker()

    // Expire lapsed bonus/cashback wallet credits and notify customers
    startWalletExpiryWorker()

    // PM2 ready signal
    if (process.send) {
      process.send('ready')
    }

    // ─── GRACEFUL SHUTDOWN ──────────────────────────
    const shutdown = async (signal) => {
      logger.info({ signal }, 'Shutdown signal received')

      // Stop campaign scheduler
      stopCampaignScheduler()

      // Stop payment expiry worker
      stopPaymentExpiryWorker()

      // Stop delivery calendar generation worker
      stopDeliveryCalendarGenerationWorker()

      // Stop store status scheduler worker
      stopStoreStatusSchedulerWorker()

      // Stop abandoned cart sweep worker
      stopAbandonedCartWorker()

      // Stop wallet top-up reconciliation worker
      stopWalletTopupReconciliationWorker()
      stopWalletExpiryWorker()

      // Close Socket.IO
      if (app.io) {
        app.io.close()
        logger.info('Socket.IO closed')
      }

      // Stop accepting new connections
      await app.close()
      logger.info('Fastify closed')

      // Close database pool
      await closePool()
      logger.info('PostgreSQL pool closed')

      // Close Redis
      await closeRedis()
      logger.info('Redis closed')

      logger.info('Graceful shutdown complete')
      process.exit(0)
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))

    // Unhandled errors — log and exit
    process.on('unhandledRejection', (err) => {
      logger.fatal({ err }, 'Unhandled rejection')
      process.exit(1)
    })

    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'Uncaught exception')
      process.exit(1)
    })
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server')
    process.exit(1)
  }
}

start()
