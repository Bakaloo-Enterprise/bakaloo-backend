import pg from 'pg'
import { env } from './env.js'
import { logger } from './logger.js'
import { waitForDb } from '../database/waitForDb.js'
import { requestContext } from '../plugins/requestContext.plugin.js'

const { Pool } = pg

export const pool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  min: env.DB_POOL_MIN,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT,
  ...(env.DB_SSL && { ssl: { rejectUnauthorized: false } }),
})

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PostgreSQL pool error')
})

pool.on('connect', () => {
  logger.debug('New PostgreSQL client connected')
})

/**
 * Demo-viewer scope (migration 171). While a demo viewer's read request runs, requestContext carries demoScope=true and
 * every statement runs with demo_scope first in search_path, so the filtered views shadow the real customer tables.
 * Background work started by the request inherits the flag; it only ever reads.
 */
const SCOPED_PATH = 'demo_scope, public'
const inDemoScope = () => requestContext.getStore()?.demoScope === true

async function scopedQuery(text, params) {
  const client = await pool.connect()
  let broken = false
  try {
    await client.query(`SET search_path TO ${SCOPED_PATH}`)
    return await client.query(text, params)
  } finally {
    try {
      await client.query('RESET search_path')
    } catch {
      broken = true // never hand a client with a leaked search_path back to the pool
    }
    client.release(broken)
  }
}

/**
 * Execute a parameterized SQL query
 * @param {string} text - SQL query with $1, $2, ... placeholders
 * @param {Array} params - Parameter values
 * @returns {Promise<pg.QueryResult>}
 */
export const query = (text, params) => (inDemoScope() ? scopedQuery(text, params) : pool.query(text, params))

/**
 * Get a client from the pool for transactions
 * @returns {Promise<pg.PoolClient>}
 */
export const getClient = async () => {
  const client = await pool.connect()
  if (!inDemoScope()) return client
  await client.query(`SET search_path TO ${SCOPED_PATH}`)
  const release = client.release.bind(client)
  client.release = (err) => {
    client.release = release
    client.query('RESET search_path').then(() => release(err), () => release(true))
  }
  return client
}

/**
 * Test the database connection
 */
export const testConnection = async () => {
  await waitForDb(pool, {
    retries: env.DB_CONNECT_RETRIES,
    delayMs: env.DB_CONNECT_RETRY_DELAY,
    logger,
  })

  const client = await pool.connect()
  try {
    await client.query('SELECT NOW()')
    logger.info('✅ PostgreSQL connected successfully')
  } finally {
    client.release()
  }
}

/**
 * Close the pool (for graceful shutdown)
 */
export const closePool = () => pool.end()
