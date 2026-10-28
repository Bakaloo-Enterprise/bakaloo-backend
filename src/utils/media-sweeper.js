import { query } from '../config/database.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { getMediaFolder } from '../config/media.js'
import { purgeDue, restoreAsset, trashAsset } from './media-storage.js'

/**
 * Finds stored images that nothing references any more (replaced, removed, abandoned uploads) and moves them to
 * trash/. Nothing is deleted for good until MEDIA_TRASH_DAYS have passed, so a mistake is recoverable.
 *
 * How it decides: it scans every text/varchar/json/jsonb/array column in the database for our public ids
 * (so it covers products, banners, theme JSON, WhatsApp templates and campaigns, avatars... without each module
 * having to register itself) and trashes only registered assets that are absent from that set AND either
 * were released by an owner more than MEDIA_RELEASE_GRACE_MINUTES ago, or are older than MEDIA_ORPHAN_GRACE_HOURS
 * (so an image uploaded in a form that has not been saved yet is left alone).
 */

// Tables that cannot hold image links and can be huge: scanning them would only slow the sweep down.
// media_url_rewrite_log keeps old/new URLs on purpose (so a rewrite can be undone); counting it as a reference would
// stop every migrated image from ever being cleaned up.
const SKIP_TABLES = new Set(['media_assets', 'media_url_rewrite_log', '_migrations', 'wa_messages', 'audit_logs', 'shop_audit_logs', 'refresh_tokens', 'otp_codes'])
const MAX_TRASH_RATIO = 0.5 // abort if a sweep would trash more than half of the candidates: that smells like a bad scan
const MAX_TRASH_PER_RUN = 500

let columnCache = { at: 0, cols: null }

export async function mediaColumns() {
  if (columnCache.cols && Date.now() - columnCache.at < 10 * 60_000) return columnCache.cols
  const { rows } = await query(`
    SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND (c.data_type IN ('text', 'character varying', 'json', 'jsonb') OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar')))`)
  const cols = rows.filter((r) => !SKIP_TABLES.has(r.table_name))
  columnCache = { at: Date.now(), cols }
  return cols
}

const q = (id) => `"${String(id).replaceAll('"', '""')}"`
const exprOf = (c) => (c.data_type === 'ARRAY' ? `array_to_string(${q(c.column_name)}, ' ')` : `${q(c.column_name)}::text`)
const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&')

/** True as soon as any column mentions this public id. */
export async function isReferenced(publicId) {
  const pattern = `%${escapeLike(publicId)}%`
  for (const c of await mediaColumns()) {
    const { rowCount } = await query(`SELECT 1 FROM ${q(c.table_name)} WHERE ${exprOf(c)} LIKE $1 LIMIT 1`, [pattern])
    if (rowCount > 0) return true
  }
  return false
}

/** Every `<folder>/...` id mentioned anywhere (with and without a file extension, so Lottie ids match too). */
export async function collectReferencedIds() {
  const folder = getMediaFolder().replace(/[^A-Za-z0-9_-]/g, '')
  // One capture group around the whole id; the optional extension is non-capturing.
  const pattern = `(${folder}/[A-Za-z0-9_/-]+(?:\\.[A-Za-z0-9]{2,6})?)`
  const ids = new Set()
  for (const c of await mediaColumns()) {
    const expr = exprOf(c)
    const { rows } = await query(
      `SELECT DISTINCT m[1] AS id FROM ${q(c.table_name)}, regexp_matches(${expr}, $1, 'g') AS m WHERE ${expr} LIKE $2`,
      [pattern, `%${escapeLike(folder)}/%`],
    )
    for (const r of rows) {
      ids.add(r.id)
      ids.add(r.id.replace(/\.[A-Za-z0-9]{2,6}$/, ''))
    }
  }
  return ids
}

/** A trashed file that something points at again (e.g. an old form saved late) is put back. */
async function restoreReferenced(referenced) {
  const { rows } = await query(`SELECT public_id FROM media_assets WHERE status = 'trashed' ORDER BY trashed_at DESC LIMIT 2000`)
  let restored = 0
  for (const r of rows) if (referenced.has(r.public_id) && (await restoreAsset(r.public_id))) restored++
  return restored
}

export async function sweepOrphans({ dryRun = false } = {}) {
  const { rows: candidates } = await query(
    `SELECT public_id FROM media_assets
     WHERE status = 'active'
       AND ((released_at IS NOT NULL AND released_at < NOW() - make_interval(mins => $1))
         OR created_at < NOW() - make_interval(hours => $2))
     ORDER BY created_at LIMIT 5000`,
    [env.MEDIA_RELEASE_GRACE_MINUTES, env.MEDIA_ORPHAN_GRACE_HOURS],
  )
  const referenced = await collectReferencedIds()
  const restored = dryRun ? 0 : await restoreReferenced(referenced)
  if (candidates.length === 0) return { candidates: 0, orphans: [], trashed: 0, restored, purged: dryRun ? 0 : await purgeDue(), aborted: null }

  const orphans = candidates.map((r) => r.public_id).filter((id) => !referenced.has(id))

  if (orphans.length > MAX_TRASH_PER_RUN || (candidates.length >= 20 && orphans.length / candidates.length > MAX_TRASH_RATIO)) {
    logger.error({ candidates: candidates.length, orphans: orphans.length }, 'Media sweep aborted: too many files would be trashed, check the scan before retrying')
    return { candidates: candidates.length, orphans, trashed: 0, restored, purged: 0, aborted: 'too-many-orphans' }
  }

  let trashed = 0
  if (!dryRun) {
    for (const id of orphans) {
      // Re-check each one right before moving it: a row may have been saved while the scan ran.
      if (await isReferenced(id)) continue
      if (await trashAsset(id)) trashed++
    }
  }
  const purged = dryRun ? 0 : await purgeDue()
  logger.info({ candidates: candidates.length, orphans: orphans.length, trashed, restored, purged, dryRun }, 'Media sweep finished')
  return { candidates: candidates.length, orphans, trashed, restored, purged, aborted: null }
}
