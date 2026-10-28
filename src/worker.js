import fs from 'node:fs/promises'
import { testConnection, closePool } from './config/database.js'
import { redis, closeRedis } from './config/redis.js'
import { env } from './config/env.js'
import { logger } from './config/logger.js'
import { sweepOrphans } from './utils/media-sweeper.js'
import { startWorkerRuntime, closeWorkerRuntime } from './runtime/workers.js'

const WORKER_HEARTBEAT_FILE =
  process.env.WORKER_HEARTBEAT_FILE || '/tmp/bakaloo-worker-heartbeat'
const WORKER_HEARTBEAT_INTERVAL_MS = 30000

const start = async () => {
  try {
    await testConnection()
    await redis.ping()
    await startWorkerRuntime()
    await fs.writeFile(WORKER_HEARTBEAT_FILE, new Date().toISOString())

    const heartbeatInterval = setInterval(async () => {
      try {
        await fs.writeFile(WORKER_HEARTBEAT_FILE, new Date().toISOString())
      } catch (err) {
        logger.warn(
          { err: err.message, path: WORKER_HEARTBEAT_FILE },
          'Failed to update worker heartbeat file'
        )
      }
    }, WORKER_HEARTBEAT_INTERVAL_MS)
    heartbeatInterval.unref()

    // Self-hosted media: trash images nothing uses any more (replaced/removed/abandoned), purge old trash.
    // One worker instance only, so no two sweeps race.
    let mediaSweepTimer = null
    if (env.MEDIA_PROVIDER === 'self') {
      mediaSweepTimer = setInterval(async () => {
        try {
          await sweepOrphans()
        } catch (err) {
          logger.warn({ err: err.message }, 'Media sweep failed')
        }
      }, 10 * 60_000)
      mediaSweepTimer.unref()
    }

    logger.info('Worker runtime is healthy')

    if (process.send) {
      process.send('ready')
    }

    const shutdown = async (signal) => {
      logger.info({ signal }, 'Worker shutdown signal received')
      clearInterval(heartbeatInterval)
      if (mediaSweepTimer) clearInterval(mediaSweepTimer)

      await closeWorkerRuntime()
      await closePool()
      logger.info('PostgreSQL pool closed')

      await closeRedis()
      logger.info('Redis closed')

      logger.info('Worker shutdown complete')
      process.exit(0)
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))

    process.on('unhandledRejection', (err) => {
      logger.fatal({ err }, 'Worker unhandled rejection')
      process.exit(1)
    })

    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'Worker uncaught exception')
      process.exit(1)
    })
  } catch (err) {
    logger.fatal({ err }, 'Failed to start worker runtime')
    process.exit(1)
  }
}

start()
