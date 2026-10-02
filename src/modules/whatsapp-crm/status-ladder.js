/**
 * Outbound message status ordering.
 *
 * Meta delivers `sent`, `delivered`, `read` and `failed` webhooks in no
 * guaranteed order and may repeat them. So a status may only move FORWARD:
 *
 *   QUEUED -> SENT -> DELIVERED -> READ
 *
 * `FAILED` is accepted only while the message is still QUEUED or SENT, and is
 * terminal. (A late "delivered" arriving after "read" must not move the
 * message backwards; a "failed" must not overwrite a message the customer has
 * already received.) Logic adapted from ArnasDon/wacrm (MIT).
 */

const RANK = Object.freeze({ QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 })

/**
 * Meta webhook status -> our status. Unknown values (e.g. "deleted") -> null.
 * @param {string | undefined} metaStatus
 * @returns {'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | null}
 */
export function mapMetaStatus(metaStatus) {
  switch (String(metaStatus ?? '').toLowerCase()) {
    case 'sent':
      return 'SENT'
    case 'delivered':
      return 'DELIVERED'
    case 'read':
      return 'READ'
    case 'failed':
      return 'FAILED'
    default:
      return null
  }
}

/**
 * @param {string} current  stored status
 * @param {string} incoming mapped incoming status
 * @returns {boolean} true if the row should be updated
 */
export function canTransition(current, incoming) {
  if (current === 'FAILED') return false
  if (incoming === 'FAILED') return current === 'QUEUED' || current === 'SENT'
  const from = RANK[current]
  const to = RANK[incoming]
  if (to === undefined) return false
  if (from === undefined) return false // e.g. an inbound row ('RECEIVED') never takes a delivery status
  return to > from
}
