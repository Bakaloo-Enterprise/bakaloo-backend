import { query } from '../../config/database.js'

const COLS = `enabled, phone_number_id, waba_id, app_id, access_token_enc, verify_token_enc, app_secret_enc,
  connection_status, last_test, last_tested_at, connected_at, updated_by, updated_at`

export class WhatsappSettingsRepository {
  async get() {
    const { rows } = await query(`SELECT ${COLS} FROM wa_settings WHERE id = 1`)
    return rows[0] ?? null
  }

  /** Write only the given columns (snake_case keys). Creates the single row on first use. */
  async update(patch, userId) {
    await query(`INSERT INTO wa_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`)
    const cols = Object.keys(patch)
    const sets = cols.map((c, i) => `${c} = $${i + 2}`)
    const params = [1, ...cols.map((c) => patch[c])]
    params.push(userId ?? null)
    const { rows } = await query(`UPDATE wa_settings SET ${sets.join(', ')}${sets.length ? ', ' : ''}updated_by = $${params.length}, updated_at = NOW() WHERE id = $1 RETURNING ${COLS}`, params)
    return rows[0]
  }

  /** What we have received from Meta (messages and delivery updates). */
  async webhookInfo() {
    const { rows } = await query(`SELECT MAX(received_at) AS last_received_at, COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '7 days')::int AS last_7d FROM wa_webhook_events`)
    return { lastReceivedAt: rows[0].last_received_at, last7d: rows[0].last_7d }
  }
}
