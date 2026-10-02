/**
 * Feature locks (migration 154) block the in-development features for ordinary admins. Older HTTP tests exercise those
 * routes as plain admins, so they release every feature for the run and put the flags back afterwards.
 */
export async function releaseFeatures(query) {
  const { rows } = await query(`SELECT key, released FROM feature_flags`)
  await query(`UPDATE feature_flags SET released = true`)
  return async () => {
    for (const r of rows) await query(`UPDATE feature_flags SET released = $2 WHERE key = $1`, [r.key, r.released])
  }
}
