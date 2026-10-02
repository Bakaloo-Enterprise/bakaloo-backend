import { isBsuid } from './phone.js'

/**
 * Turn Meta's webhook body into plain events. Pure — no DB, no I/O.
 *
 *   { messages: [...inbound customer messages], statuses: [...delivery updates],
 *     templateEvents: [...], skipped: n }
 *
 * Handled field shapes follow Meta's Cloud API webhook reference; the identity
 * rules (phone may be missing, BSUID always present) follow Meta's
 * "business-scoped user IDs" documentation.
 *
 * @param {any} body parsed JSON of the webhook POST
 * @param {{ phoneNumberId?: string }} [opts] when set, events for any other
 *        business number are ignored.
 */
export function parseWebhook(body, opts = {}) {
  const out = { messages: [], statuses: [], templateEvents: [], skipped: 0 }
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
    return out
  }

  for (const entry of body.entry) {
    for (const change of entry?.changes ?? []) {
      const field = change?.field
      const value = change?.value ?? {}

      // Template lifecycle: message_template_status_update / _quality_update / _components_update,
      // and (note the different prefix) template_category_update.
      if (typeof field === 'string' && (field.startsWith('message_template') || field === 'template_category_update')) {
        out.templateEvents.push({ field, wabaId: entry?.id ?? null, time: toDate(entry?.time), value })
        continue
      }
      if (field !== 'messages') {
        out.skipped++
        continue
      }

      const phoneNumberId = value?.metadata?.phone_number_id ?? null
      if (opts.phoneNumberId && phoneNumberId && phoneNumberId !== opts.phoneNumberId) {
        out.skipped++
        continue
      }

      const contactsByKey = indexContacts(value.contacts)

      for (const raw of value.messages ?? []) {
        const msg = parseMessage(raw, contactsByKey, phoneNumberId)
        if (msg) out.messages.push(msg)
        else out.skipped++
      }
      for (const raw of value.statuses ?? []) {
        const st = parseStatus(raw, phoneNumberId)
        if (st) out.statuses.push(st)
        else out.skipped++
      }
    }
  }
  return out
}

/** contacts[] are paired with messages by wa_id or user_id. */
function indexContacts(contacts) {
  const map = new Map()
  for (const c of contacts ?? []) {
    if (c?.wa_id) map.set(String(c.wa_id), c)
    if (c?.user_id) map.set(String(c.user_id), c)
  }
  return map
}

function parseMessage(raw, contactsByKey, phoneNumberId) {
  if (!raw?.id || !raw?.type) return null

  const waId = raw.from ? String(raw.from).replace(/\D/g, '') || null : null
  const bsuid = isBsuid(raw.from_user_id) ? raw.from_user_id.trim() : null
  const parentBsuid = isBsuid(raw.from_parent_user_id) ? raw.from_parent_user_id.trim() : null
  // No phone AND no BSUID = nothing to key a contact on; drop rather than invent a row.
  if (!waId && !bsuid) return null

  const contact = contactsByKey.get(waId ?? '') ?? contactsByKey.get(bsuid ?? '') ?? null
  const content = extractContent(raw)

  return {
    wamid: String(raw.id),
    waId,
    bsuid,
    parentBsuid,
    profileName: contact?.profile?.name?.trim() || null,
    username: contact?.profile?.username?.trim()?.replace(/^@/, '') || null,
    timestamp: toDate(raw.timestamp),
    type: String(raw.type),
    body: content.body,
    media: content.media,
    interactive: content.interactive,
    replyToWamid: raw.context?.id ?? null,
    // Click-to-WhatsApp ad info, only present on the first message of an ad conversation.
    referral: raw.referral ?? null,
    isReaction: raw.type === 'reaction',
    reaction: raw.type === 'reaction' ? raw.reaction ?? null : null,
    phoneNumberId,
  }
}

function extractContent(raw) {
  const none = { body: null, media: null, interactive: null }
  switch (raw.type) {
    case 'text':
      return { ...none, body: raw.text?.body ?? '' }
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker': {
      const m = raw[raw.type] ?? {}
      return {
        ...none,
        body: m.caption ?? null,
        media: {
          id: m.id ?? null,
          mime_type: m.mime_type ?? null,
          sha256: m.sha256 ?? null,
          caption: m.caption ?? null,
          filename: m.filename ?? null,
        },
      }
    }
    case 'location': {
      const l = raw.location ?? {}
      return {
        ...none,
        body: [l.name, l.address].filter(Boolean).join(' — ') || 'Shared a location',
        media: { latitude: l.latitude ?? null, longitude: l.longitude ?? null },
      }
    }
    case 'interactive': {
      const i = raw.interactive ?? {}
      const reply = i.button_reply ?? i.list_reply ?? null
      return { ...none, body: reply?.title ?? null, interactive: reply ? { type: i.type, ...reply } : null }
    }
    case 'button':
      // Quick-reply button tapped on a template message.
      return { ...none, body: raw.button?.text ?? null, interactive: { type: 'button', ...raw.button } }
    case 'contacts':
      return { ...none, body: 'Shared a contact' }
    case 'reaction':
      return { ...none, body: raw.reaction?.emoji ?? null }
    default:
      return { ...none, body: '[Unsupported message type]' }
  }
}

function parseStatus(raw, phoneNumberId) {
  if (!raw?.id || !raw?.status) return null
  const err = Array.isArray(raw.errors) ? raw.errors[0] : null
  return {
    wamid: String(raw.id),
    status: String(raw.status).toLowerCase(),
    timestamp: toDate(raw.timestamp),
    recipientId: raw.recipient_id ?? null,
    recipientUserId: raw.recipient_user_id ?? null,
    error: err
      ? {
          code: typeof err.code === 'number' ? err.code : null,
          title: err.title ?? null,
          details: err.error_data?.details ?? err.message ?? null,
        }
      : null,
    // Billing info Meta attaches to statuses — used later for cost reporting (Phase 10).
    pricing: raw.pricing ?? null,
    phoneNumberId,
  }
}

function toDate(unixSeconds) {
  const n = Number(unixSeconds)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date()
}
