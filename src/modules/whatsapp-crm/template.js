/**
 * WhatsApp template rules — pure functions, no I/O.
 *
 * Every limit here comes from Meta's template documentation (checked 2026-10-01):
 *   header text ≤ 60 chars, ≤ 1 variable, no markdown · body ≤ 1024 · footer ≤ 60, no variables
 *   buttons ≤ 10 (quick reply ≤ 10, URL ≤ 2, phone ≤ 1), label ≤ 25, URL ≤ 2000 with ONE variable at the END
 *   quick-reply buttons must be grouped (not interleaved with other types)
 *   variables must not start/end the body or sit next to each other (error 2388299 / INVALID_FORMAT)
 *   every variable needs an example; names are lowercase letters and underscores
 */

export const PURPOSES = Object.freeze([
  { key: 'welcome', label: 'Welcome' },
  { key: 'new_customer', label: 'New Customer' },
  { key: 'abandoned_cart', label: 'Abandoned Cart' },
  { key: 'first_order', label: 'First Order' },
  { key: 'second_order', label: 'Second Order' },
  { key: 'third_order', label: 'Third Order' },
  { key: 'order_confirmation', label: 'Order Confirmation' },
  { key: 'order_packed', label: 'Order Packed' },
  { key: 'out_for_delivery', label: 'Out for Delivery' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'payment_reminder', label: 'Payment Reminder' },
  { key: 'coupon', label: 'Coupon' },
  { key: 'product_offer', label: 'Product Offer' },
  { key: 'inactive_customer', label: 'Inactive Customer' },
  { key: 'b2b_offer', label: 'B2B Offer' },
  { key: 'custom', label: 'Custom' },
])
const PURPOSE_KEYS = new Set(PURPOSES.map((p) => p.key))

export const LIMITS = Object.freeze({
  name: 512,
  header: 60,
  body: 1024,
  footer: 60,
  buttons: 10,
  quickReply: 10,
  url: 2,
  phone: 1,
  buttonText: 25,
  urlLength: 2000,
  phoneLength: 20,
  example: 200,
})

/** Webhooks send "en-US"; the API uses "en_US". Compare and store the API form. */
export function normalizeLanguage(code) {
  return String(code ?? '').trim().replace(/-/g, '_')
}

const VAR_RE = /\{\{\s*([^{}]*?)\s*\}\}/g
const NAME_RE = /^[a-z]+(?:_[a-z]+)*$/

/** Variables in order of first appearance: [{ name }] (name may be "1" for positional text). */
export function extractVariables(text) {
  const seen = new Set()
  const out = []
  for (const m of String(text ?? '').matchAll(VAR_RE)) {
    const name = m[1]
    if (!seen.has(name)) {
      seen.add(name)
      out.push({ name })
    }
  }
  return out
}

const stripVars = (text) => String(text ?? '').replace(VAR_RE, ' ')

/**
 * Validate and build a NEW template. New templates always use NAMED parameters
 * ({{customer_name}}): self-describing, order-independent, and they map straight
 * onto the values the CRM can fill automatically.
 *
 * @param {object} i
 * @returns {{ ok: boolean, errors: Array<{field: string, message: string}>, warnings: string[], value?: object }}
 */
export function validateTemplateInput(i) {
  const errors = []
  const warnings = []
  const err = (field, message) => errors.push({ field, message })

  // ── identity ───────────────────────────────────────────────────────
  const name = String(i.name ?? '').trim()
  if (!name) err('name', 'Give the template a name')
  else if (!/^[a-z0-9_]+$/.test(name)) err('name', 'Name can only use lowercase letters, numbers and underscores (e.g. abandoned_cart_reminder)')
  else if (name.length > LIMITS.name) err('name', `Name is too long (max ${LIMITS.name})`)

  const language = normalizeLanguage(i.language)
  if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) err('language', 'Choose a language (e.g. en, en_US, hi, bn)')

  const metaCategory = String(i.metaCategory ?? '').toUpperCase()
  if (metaCategory === 'AUTHENTICATION') err('metaCategory', 'Authentication (one-time-password) templates are not supported yet')
  else if (!['MARKETING', 'UTILITY'].includes(metaCategory)) err('metaCategory', 'Choose Marketing or Utility')

  const purpose = i.purpose ? String(i.purpose) : 'custom'
  if (!PURPOSE_KEYS.has(purpose)) err('purpose', 'Unknown template type')

  // ── body ───────────────────────────────────────────────────────────
  const bodyText = String(i.bodyText ?? '').trim()
  if (!bodyText) err('bodyText', 'Write the message text')
  else if (bodyText.length > LIMITS.body) err('bodyText', `The message is too long (${bodyText.length}/${LIMITS.body})`)

  const bodyVars = checkVariables(bodyText, 'bodyText', err)
  if (bodyText) {
    const t = bodyText.trim()
    if (/^\{\{/.test(t)) err('bodyText', 'The message cannot START with a variable. Add a word before it (e.g. “Hi {{customer_name}}”).')
    if (/\}\}[\s.!?,;:)\]]*$/.test(t) && /\}\}$/.test(t)) err('bodyText', 'The message cannot END with a variable. Add text after it.')
    if (/\}\}\s*\{\{/.test(t)) err('bodyText', 'Two variables cannot sit next to each other. Put words or punctuation between them.')
    const words = stripVars(t).split(/\s+/).filter(Boolean).length
    if (bodyVars.length && words < bodyVars.length * 3) warnings.push('This message has many variables for its length. Meta may reject it. Add more fixed text.')
  }

  // ── header (text only) ─────────────────────────────────────────────
  const headerText = i.headerText ? String(i.headerText).trim() : ''
  let headerVars = []
  if (headerText) {
    if (headerText.length > LIMITS.header) err('headerText', `The header is too long (${headerText.length}/${LIMITS.header})`)
    headerVars = checkVariables(headerText, 'headerText', err)
    if (headerVars.length > 1) err('headerText', 'A header can contain at most one variable')
    if (/[*_~`]/.test(stripVars(headerText))) err('headerText', 'The header cannot use formatting characters (* _ ~ `)')
  }

  // ── footer ─────────────────────────────────────────────────────────
  const footerText = i.footerText ? String(i.footerText).trim() : ''
  if (footerText) {
    if (footerText.length > LIMITS.footer) err('footerText', `The footer is too long (${footerText.length}/${LIMITS.footer})`)
    if (/\{\{|\}\}/.test(footerText)) err('footerText', 'The footer cannot contain variables')
  }

  // ── buttons ────────────────────────────────────────────────────────
  const buttons = Array.isArray(i.buttons) ? i.buttons : []
  const builtButtons = []
  const urlVars = []
  if (buttons.length > LIMITS.buttons) err('buttons', `At most ${LIMITS.buttons} buttons`)
  const kinds = { QUICK_REPLY: 0, URL: 0, PHONE_NUMBER: 0 }
  buttons.slice(0, LIMITS.buttons).forEach((b, idx) => {
    const f = `buttons[${idx}]`
    const text = String(b?.text ?? '').trim()
    if (!['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(b?.type)) return err(f, 'Unknown button type')
    kinds[b.type]++
    if (!text) err(f, 'Give the button a label')
    else if (text.length > LIMITS.buttonText) err(f, `Button label is too long (${text.length}/${LIMITS.buttonText})`)
    if (b.type === 'QUICK_REPLY') {
      builtButtons.push({ type: 'QUICK_REPLY', text })
    } else if (b.type === 'PHONE_NUMBER') {
      const phone = String(b.phoneNumber ?? '').replace(/[\s()-]/g, '')
      if (!/^\+?\d{7,19}$/.test(phone) || phone.length > LIMITS.phoneLength) err(f, 'Enter a valid phone number with country code (e.g. +919876543210)')
      builtButtons.push({ type: 'PHONE_NUMBER', text, phone_number: phone.replace(/^\+/, '') })
    } else {
      const url = String(b.url ?? '').trim()
      if (!/^https:\/\/\S+$/.test(url)) err(f, 'The link must start with https://')
      else if (url.length > LIMITS.urlLength) err(f, `The link is too long (max ${LIMITS.urlLength})`)
      const vars = extractVariables(url)
      if (vars.length > 1) err(f, 'A link can contain only one variable')
      else if (vars.length === 1) {
        if (!url.endsWith(`{{${vars[0].name}}}`)) err(f, 'The variable must be at the very end of the link (e.g. https://bakaloo.in/cart/{{cart_id}})')
        if (!NAME_RE.test(vars[0].name)) err(f, 'Variable names use lowercase letters and underscores, e.g. {{cart_id}}')
        else urlVars.push({ name: vars[0].name, where: `button${idx}`, buttonIndex: idx })
      }
      builtButtons.push({ type: 'URL', text, url, _idx: idx })
    }
  })
  if (kinds.QUICK_REPLY > LIMITS.quickReply) err('buttons', `At most ${LIMITS.quickReply} quick-reply buttons`)
  if (kinds.URL > LIMITS.url) err('buttons', `At most ${LIMITS.url} link buttons`)
  if (kinds.PHONE_NUMBER > LIMITS.phone) err('buttons', 'At most 1 call button')
  if (!quickRepliesGrouped(buttons.map((b) => b?.type))) err('buttons', 'Quick-reply buttons must be together, before or after the other buttons — not mixed in between')

  // ── names unique across the whole template + examples ──────────────
  const all = [
    ...headerVars.map((v) => ({ ...v, where: 'header' })),
    ...bodyVars.map((v) => ({ ...v, where: 'body' })),
    ...urlVars,
  ]
  const seen = new Set()
  for (const v of all) {
    if (seen.has(v.name)) err('variables', `The variable {{${v.name}}} is used in more than one place. Each variable name must be unique.`)
    seen.add(v.name)
  }
  const examples = i.examples && typeof i.examples === 'object' ? i.examples : {}
  const variables = all.map((v) => {
    const example = String(examples[v.name] ?? '').trim()
    if (!example) err(`examples.${v.name}`, `Add an example for {{${v.name}}} (Meta needs a sample value)`)
    else if (example.length > LIMITS.example || /[\r\n]/.test(example)) err(`examples.${v.name}`, `The example for {{${v.name}}} must be one short line`)
    return { name: v.name, example, where: v.where }
  })

  if (errors.length) return { ok: false, errors, warnings }

  // ── build Meta components ──────────────────────────────────────────
  const exOf = (n) => variables.find((v) => v.name === n).example
  const components = []
  if (headerText) {
    components.push({
      type: 'HEADER',
      format: 'TEXT',
      text: headerText,
      ...(headerVars.length ? { example: { header_text_named_params: [{ param_name: headerVars[0].name, example: exOf(headerVars[0].name) }] } } : {}),
    })
  }
  components.push({
    type: 'BODY',
    text: bodyText,
    ...(bodyVars.length ? { example: { body_text_named_params: bodyVars.map((v) => ({ param_name: v.name, example: exOf(v.name) })) } } : {}),
  })
  if (footerText) components.push({ type: 'FOOTER', text: footerText })
  if (builtButtons.length) {
    components.push({
      type: 'BUTTONS',
      buttons: builtButtons.map((b) => {
        if (b.type !== 'URL') return b
        const v = urlVars.find((u) => u.buttonIndex === b._idx)
        return {
          type: 'URL',
          text: b.text,
          url: b.url,
          ...(v ? { example: [b.url.replace(`{{${v.name}}}`, exOf(v.name))] } : {}),
        }
      }),
    })
  }

  return {
    ok: true,
    errors: [],
    warnings,
    value: {
      name,
      language,
      metaCategory,
      purpose,
      parameterFormat: 'NAMED',
      allowCategoryChange: i.allowCategoryChange !== false,
      components,
      bodyText,
      headerFormat: headerText ? 'TEXT' : null,
      variables,
    },
  }
}

function checkVariables(text, field, err) {
  const vars = extractVariables(text)
  for (const v of vars) {
    if (/^\d+$/.test(v.name)) err(field, `Use a descriptive name like {{customer_name}} instead of {{${v.name}}}`)
    else if (!NAME_RE.test(v.name)) err(field, `Variable names use lowercase letters and underscores, e.g. {{customer_name}} (found {{${v.name}}})`)
  }
  // Whatever remains after removing well-formed {{...}} must not contain a stray "{{" or "}}".
  if (/\{\{|\}\}/.test(String(text).replace(VAR_RE, ''))) {
    err(field, 'A variable looks incomplete. Write it as {{customer_name}} with two curly brackets on each side.')
  }
  return vars
}

function quickRepliesGrouped(types) {
  // valid: QR..QR + others, or others + QR..QR; invalid: QR, other, QR
  let state = 0 // 0 = before any QR, 1 = in QR run, 2 = QR run ended
  for (const t of types) {
    const qr = t === 'QUICK_REPLY'
    if (qr) {
      if (state === 2) return false
      state = 1
    } else if (state === 1) state = 2
  }
  return true
}

// ─── Reading templates that came FROM Meta (sync) ─────────────────────

/**
 * Pull the denormalised columns out of a Meta components array.
 * @param {any[]} components
 * @param {'NAMED'|'POSITIONAL'} parameterFormat
 */
export function summarizeComponents(components, parameterFormat = 'NAMED') {
  const comps = Array.isArray(components) ? components : []
  const header = comps.find((c) => c.type === 'HEADER')
  const body = comps.find((c) => c.type === 'BODY')
  const buttons = comps.find((c) => c.type === 'BUTTONS')?.buttons ?? []
  const variables = []

  const add = (name, example, where, key) => variables.push({ name, example: example ?? '', where, key: key ?? name })

  if (header?.format === 'TEXT') {
    extractVariables(header.text).forEach((v) => {
      const ex = header.example?.header_text_named_params?.find((p) => p.param_name === v.name)?.example ?? header.example?.header_text?.[0]
      add(v.name, ex, 'header', parameterFormat === 'NAMED' ? v.name : `header.${v.name}`)
    })
  }
  if (body?.text) {
    extractVariables(body.text).forEach((v, n) => {
      const ex =
        body.example?.body_text_named_params?.find((p) => p.param_name === v.name)?.example ?? body.example?.body_text?.[0]?.[n]
      add(v.name, ex, 'body', parameterFormat === 'NAMED' ? v.name : `body.${v.name}`)
    })
  }
  buttons.forEach((b, idx) => {
    if (b.type !== 'URL') return
    extractVariables(b.url).forEach((v) => add(v.name, b.example?.[0] ?? '', `button${idx}`, parameterFormat === 'NAMED' ? v.name : `button${idx}.${v.name}`))
  })

  return {
    bodyText: body?.text ?? '',
    headerFormat: header ? header.format ?? 'TEXT' : null,
    variables,
  }
}

/**
 * Turn stored components back into the editor's fields.
 * Only simple NAMED templates (text/no header, supported buttons) are editable here.
 * @returns {{ editable: boolean, reason?: string, input?: object }}
 */
export function componentsToInput(components, parameterFormat) {
  if (parameterFormat !== 'NAMED') return { editable: false, reason: 'This template uses numbered variables ({{1}}). Edit it in WhatsApp Manager, or create a new one here.' }
  const comps = Array.isArray(components) ? components : []
  const header = comps.find((c) => c.type === 'HEADER')
  if (header && header.format !== 'TEXT') return { editable: false, reason: `This template has a ${String(header.format).toLowerCase()} header, which can only be edited in WhatsApp Manager.` }
  const buttons = comps.find((c) => c.type === 'BUTTONS')?.buttons ?? []
  if (buttons.some((b) => !['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(b.type))) return { editable: false, reason: 'This template has a button type that can only be edited in WhatsApp Manager.' }

  const s = summarizeComponents(components, 'NAMED')
  const examples = {}
  for (const v of s.variables) if (v.example) examples[v.name] = v.example
  return {
    editable: true,
    input: {
      headerText: header?.text ?? '',
      bodyText: comps.find((c) => c.type === 'BODY')?.text ?? '',
      footerText: comps.find((c) => c.type === 'FOOTER')?.text ?? '',
      buttons: buttons.map((b) =>
        b.type === 'QUICK_REPLY' ? { type: 'QUICK_REPLY', text: b.text } : b.type === 'URL' ? { type: 'URL', text: b.text, url: b.url } : { type: 'PHONE_NUMBER', text: b.text, phoneNumber: `+${b.phone_number}` },
      ),
      examples,
    },
  }
}

// ─── Sending ──────────────────────────────────────────────────────────

/** Meta rejects newlines/tabs and long runs of spaces inside parameter text. */
export function sanitizeParam(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {4,}/g, '   ')
    .trim()
    .slice(0, 1000)
}

const MEDIA = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' }

/**
 * Can this template be sent right now? (the single gate used by every send path)
 * @returns {{ ok: boolean, reason?: string }}
 */
export function canSend(t) {
  const why = {
    DRAFT: 'This template has not been submitted to Meta yet.',
    PENDING: 'Meta is still reviewing this template.',
    REJECTED: 'Meta rejected this template. Edit and resubmit it.',
    PAUSED: 'Meta paused this template because of customer feedback.',
    DISABLED: 'Meta disabled this template.',
    IN_APPEAL: 'This template is under appeal.',
    PENDING_DELETION: 'This template is being deleted.',
    ARCHIVED: 'This template is archived.',
    DELETED: 'This template was deleted.',
  }
  if (t.status !== 'APPROVED') return { ok: false, reason: why[t.status] ?? 'This template is not approved.' }
  if (t.name === 'hello_world') return { ok: false, reason: 'Meta’s “hello_world” sample can only be sent from Meta’s test numbers. Use one of your own approved templates.' }
  if (t.meta_category === 'AUTHENTICATION') return { ok: false, reason: 'Authentication templates are not supported yet.' }
  if (t.header_format === 'LOCATION') return { ok: false, reason: 'Templates with a location header are not supported yet.' }
  return { ok: true }
}

/**
 * Build the `components` array for a template SEND.
 *
 * @param {{ components: any[], parameter_format: string }} template
 * @param {Record<string, string>} values keyed by variable `key` (name for NAMED templates)
 * @param {{ headerMediaUrl?: string }} [opts]
 * @returns {{ components: any[], missing: string[], error?: string }}
 */
export function buildSendComponents(template, values, opts = {}) {
  const named = template.parameter_format === 'NAMED'
  const summary = summarizeComponents(template.components, template.parameter_format)
  const val = (key) => sanitizeParam(values?.[key])
  const missing = []
  const need = (v) => {
    const x = val(v.key)
    if (!x) missing.push(v.key)
    return x
  }
  const textParam = (v) => ({ type: 'text', ...(named ? { parameter_name: v.name } : {}), text: need(v) })

  const out = []
  const comps = template.components ?? []
  const header = comps.find((c) => c.type === 'HEADER')

  if (header) {
    if (header.format === 'TEXT') {
      const hv = summary.variables.filter((v) => v.where === 'header')
      if (hv.length) out.push({ type: 'header', parameters: hv.map(textParam) })
    } else if (MEDIA[header.format]) {
      const url = String(opts.headerMediaUrl ?? '').trim()
      if (!/^https:\/\/\S+$/.test(url)) return { components: [], missing, error: `This template has a ${header.format.toLowerCase()} header. Provide an https:// link to the ${header.format.toLowerCase()}.` }
      const kind = MEDIA[header.format]
      out.push({ type: 'header', parameters: [{ type: kind, [kind]: { link: url } }] })
    } else {
      return { components: [], missing, error: 'This header type cannot be sent from here yet.' }
    }
  }

  const bv = summary.variables.filter((v) => v.where === 'body')
  if (bv.length) out.push({ type: 'body', parameters: bv.map(textParam) })

  const buttons = comps.find((c) => c.type === 'BUTTONS')?.buttons ?? []
  buttons.forEach((b, idx) => {
    if (b.type !== 'URL') return
    const uv = summary.variables.filter((v) => v.where === `button${idx}`)
    if (!uv.length) return
    const v = uv[0]
    const x = need(v)
    // Meta requires URL parameters to be percent-encoded.
    out.push({ type: 'button', sub_type: 'url', index: String(idx), parameters: [{ type: 'text', ...(named ? { parameter_name: v.name } : {}), text: x ? encodeURIComponent(x) : '' }] })
  })

  return { components: out, missing }
}

/**
 * Human-readable text of what the customer will see (header, body, footer, buttons).
 * With fallbackToExample, unfilled variables show their sample value (editor preview).
 */
export function renderPreview(template, values = {}, { fallbackToExample = false } = {}) {
  const summary = summarizeComponents(template.components, template.parameter_format)
  const fill = (text, where) =>
    String(text ?? '').replace(VAR_RE, (_, name) => {
      const v = summary.variables.find((x) => x.name === name && (x.where === where || where === 'any'))
      const given = v ? sanitizeParam(values[v.key]) : ''
      return given || (fallbackToExample && v?.example ? v.example : `{{${name}}}`)
    })
  const comps = template.components ?? []
  const parts = []
  const header = comps.find((c) => c.type === 'HEADER')
  if (header?.format === 'TEXT') parts.push(fill(header.text, 'header'))
  else if (header) parts.push(`[${String(header.format).toLowerCase()}]`)
  const body = comps.find((c) => c.type === 'BODY')
  if (body) parts.push(fill(body.text, 'body'))
  const footer = comps.find((c) => c.type === 'FOOTER')
  if (footer) parts.push(footer.text)
  const buttons = comps.find((c) => c.type === 'BUTTONS')?.buttons ?? []
  if (buttons.length) parts.push(buttons.map((b) => `[ ${b.text} ]`).join(' '))
  return parts.join('\n\n')
}

// ─── Webhook interpretation ───────────────────────────────────────────

const STATUS_EVENTS = {
  APPROVED: { status: 'APPROVED', flagged: false },
  REJECTED: { status: 'REJECTED' },
  PENDING: { status: 'PENDING' },
  PAUSED: { status: 'PAUSED' },
  DISABLED: { status: 'DISABLED' },
  IN_APPEAL: { status: 'IN_APPEAL' },
  PENDING_DELETION: { status: 'PENDING_DELETION' },
  ARCHIVED: { status: 'ARCHIVED' },
  DELETED: { status: 'DELETED' },
  REINSTATED: { status: 'APPROVED', flagged: false },
  FLAGGED: { flagged: true },
  LOCKED: { locked: true },
}

/**
 * Meta template webhook -> what to change. Pure.
 * @param {string} field   change.field
 * @param {any} value      change.value
 * @returns {null | { kind: 'status'|'quality'|'category'|'components', ident: {metaId: string|null, name: string|null, language: string|null},
 *                    event: string, patch: object, refetch?: boolean, accountLevel?: boolean }}
 */
export function interpretTemplateWebhook(field, value) {
  const v = value ?? {}
  const ident = {
    metaId: v.message_template_id != null ? String(v.message_template_id) : null,
    name: v.message_template_name ?? null,
    language: v.message_template_language ? normalizeLanguage(v.message_template_language) : null,
  }

  if (field === 'message_template_status_update') {
    const event = String(v.event ?? '').toUpperCase()
    if (event === 'LIMIT_EXCEEDED') return { kind: 'status', ident, event, patch: {}, accountLevel: true }
    if (event === 'UNARCHIVED') return { kind: 'status', ident, event, patch: {}, refetch: true } // restored to its PREVIOUS status, which the event does not say
    const base = STATUS_EVENTS[event]
    if (!base) return null
    const patch = { ...base }
    if (event === 'REJECTED') {
      patch.rejection_reason = v.reason && v.reason !== 'NONE' ? String(v.reason) : null
      const info = v.rejection_info
      patch.rejection_detail = info ? [info.reason, info.recommendation].filter(Boolean).join(' ') : null
    }
    if (event === 'APPROVED' || event === 'REINSTATED') {
      patch.rejection_reason = null
      patch.rejection_detail = null
    }
    if (event === 'LOCKED' && v.other_info?.title === 'UNPAUSE') patch.locked = false
    return { kind: 'status', ident, event, patch }
  }

  if (field === 'message_template_quality_update') {
    const score = String(v.new_quality_score ?? '').toUpperCase()
    if (!['GREEN', 'YELLOW', 'RED', 'UNKNOWN'].includes(score)) return null
    return { kind: 'quality', ident, event: 'QUALITY', patch: { quality_score: score } }
  }

  if (field === 'template_category_update') {
    if (v.correct_category) {
      // Impending: the template WILL be re-categorised at category_update_timestamp.
      return {
        kind: 'category',
        ident,
        event: 'CATEGORY_PENDING',
        patch: { pending_category: String(v.correct_category).toUpperCase(), pending_category_at: v.category_update_timestamp ? new Date(Number(v.category_update_timestamp) * 1000) : null },
      }
    }
    if (v.new_category) return { kind: 'category', ident, event: 'CATEGORY_CHANGED', patch: { meta_category: String(v.new_category).toUpperCase(), pending_category: null, pending_category_at: null } }
    return null
  }

  if (field === 'message_template_components_update') return { kind: 'components', ident, event: 'COMPONENTS', patch: {}, refetch: true }
  return null
}
