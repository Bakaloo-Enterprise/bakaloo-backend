import { CrmError } from './errors.js'
import { MetaApiError } from './meta-client.js'
import { componentsToInput, interpretTemplateWebhook, normalizeLanguage, summarizeComponents, validateTemplateInput } from './template.js'

const STATUSES = new Set(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'ARCHIVED', 'DELETED'])
const CATEGORIES = new Set(['MARKETING', 'UTILITY', 'AUTHENTICATION'])
const SCORES = new Set(['GREEN', 'YELLOW', 'RED', 'UNKNOWN'])
/** Meta only lets these be edited (docs: template-management). */
const EDITABLE = new Set(['DRAFT', 'APPROVED', 'REJECTED', 'PAUSED'])

/** Translate a Meta failure into something staff can act on. */
export function mapMetaError(err) {
  if (err instanceof CrmError || !(err instanceof MetaApiError)) return err
  if (/not configured/i.test(err.message)) {
    return new CrmError('WhatsApp is not connected yet. Add the WhatsApp Business Account details in the server settings.', 409, 'NOT_CONFIGURED')
  }
  const detail = err.details || err.message
  if (err.code === 100 && err.subcode === 2388024) {
    return new CrmError('A template with this name already exists in this language. (Meta keeps the name of a deleted approved template reserved for 30 days.)', 409, 'TEMPLATE_EXISTS')
  }
  if (err.subcode === 2388019) return new CrmError('Your WhatsApp account has reached its template limit (250, or 6,000 for a verified business).', 409, 'TEMPLATE_LIMIT')
  if ([0, 3, 10, 190].includes(err.code) || (err.code >= 200 && err.code <= 299)) {
    return new CrmError('WhatsApp refused our access token or permissions. Check the WhatsApp connection in the server settings.', 502, 'WHATSAPP_AUTH')
  }
  if (err.httpStatus === 400) return new CrmError(`Meta did not accept this: ${detail}`, 422, 'META_REJECTED')
  return new CrmError(`Could not reach WhatsApp: ${detail}`, 502, 'WHATSAPP_UNAVAILABLE')
}

/** Map one template object from Meta's list/get response onto our columns. */
export function mapRemoteTemplate(t, now = new Date()) {
  const category = String(t.category ?? '').toUpperCase()
  const status = String(t.status ?? '').toUpperCase()
  const format = t.parameter_format === 'NAMED' ? 'NAMED' : 'POSITIONAL' // Meta's default is positional
  const components = Array.isArray(t.components) ? t.components : []
  const s = summarizeComponents(components, format)
  const score = String(t.quality_score?.score ?? '').toUpperCase()
  const correct = String(t.correct_category ?? '').toUpperCase()
  return {
    meta_template_id: String(t.id),
    name: t.name,
    language: normalizeLanguage(t.language),
    meta_category: CATEGORIES.has(category) ? category : 'UTILITY',
    parameter_format: format,
    status: STATUSES.has(status) ? status : 'PENDING',
    components,
    body_text: s.bodyText,
    header_format: s.headerFormat,
    variables: s.variables,
    rejection_reason: status === 'REJECTED' && t.rejected_reason && t.rejected_reason !== 'NONE' ? String(t.rejected_reason) : null,
    quality_score: SCORES.has(score) ? score : null,
    pending_category: correct && CATEGORIES.has(correct) && correct !== category ? correct : null,
    last_status_at: now,
  }
}

/** Template library, Meta submission and approval tracking. */
export class TemplateService {
  /**
   * @param {{ repo: import('./template.repository.js').TemplateRepository,
   *           client: ReturnType<typeof import('./meta-client.js').createMetaClient>,
   *           emit: (e: string, p: object) => void,
   *           logger: { info: Function, warn: Function },
   *           now?: () => Date }} deps
   */
  constructor({ repo, client, emit, logger, now = () => new Date() }) {
    this.repo = repo
    this.client = client
    this.emit = emit
    this.logger = logger
    this.now = now
  }

  // ─── Reads ────────────────────────────────────────────────────────
  async list(filters) {
    const [templates, counts, lastSyncedAt] = await Promise.all([this.repo.list(filters), this.repo.counts(), this.repo.lastSyncedAt()])
    return { templates, counts, lastSyncedAt }
  }

  async get(id) {
    const template = await this.repo.get(id)
    if (!template || template.status === 'DELETED') throw new CrmError('Template not found', 404, 'TEMPLATE_NOT_FOUND')
    const editor = componentsToInput(template.components, template.parameter_format)
    return { template, events: await this.repo.events(id), editor }
  }

  // ─── Create / edit ────────────────────────────────────────────────
  async createDraft(input, userId) {
    const v = validateTemplateInput(input)
    if (!v.ok) throw new CrmError('Please fix the highlighted problems', 400, 'INVALID_TEMPLATE', v.errors)
    try {
      const row = await this.repo.insert(v.value, userId)
      await this.repo.addEvent(row.id, 'CREATED', 'Saved as draft', 'MANUAL')
      this.emit('crm:template', { templateId: row.id })
      return { template: row, warnings: v.warnings }
    } catch (err) {
      if (err.code === '23505') throw new CrmError('A template with this name and language already exists', 409, 'TEMPLATE_EXISTS')
      throw err
    }
  }

  async update(id, input, userId) {
    const row = await this.repo.get(id)
    if (!row || row.status === 'DELETED') throw new CrmError('Template not found', 404, 'TEMPLATE_NOT_FOUND')
    if (!EDITABLE.has(row.status)) {
      throw new CrmError(`This template cannot be edited while its status is ${row.status.replace(/_/g, ' ').toLowerCase()}. Meta only allows edits when it is approved, rejected or paused.`, 409, 'NOT_EDITABLE')
    }
    if (row.parameter_format !== 'NAMED') {
      throw new CrmError('This template uses numbered variables and can only be edited in WhatsApp Manager.', 409, 'NOT_EDITABLE')
    }
    const submitted = Boolean(row.meta_template_id)

    // Name and language are fixed once Meta knows the template; an approved template's category is fixed too.
    const merged = {
      ...input,
      name: submitted ? row.name : input.name ?? row.name,
      language: submitted ? row.language : input.language ?? row.language,
      metaCategory: row.status === 'APPROVED' ? row.meta_category : input.metaCategory ?? row.meta_category,
      purpose: input.purpose ?? row.purpose,
      allowCategoryChange: input.allowCategoryChange ?? row.allow_category_change,
    }
    const v = validateTemplateInput(merged)
    if (!v.ok) throw new CrmError('Please fix the highlighted problems', 400, 'INVALID_TEMPLATE', v.errors)
    const n = v.value

    if (!submitted) {
      try {
        const out = await this.repo.patch(id, {
          name: n.name, language: n.language, meta_category: n.metaCategory, purpose: n.purpose, components: n.components,
          body_text: n.bodyText, header_format: n.headerFormat, variables: n.variables, allow_category_change: n.allowCategoryChange,
        })
        await this.repo.addEvent(id, 'EDITED', 'Draft updated', 'MANUAL')
        this.emit('crm:template', { templateId: id })
        return { template: out, warnings: v.warnings }
      } catch (err) {
        if (err.code === '23505') throw new CrmError('A template with this name and language already exists', 409, 'TEMPLATE_EXISTS')
        throw err
      }
    }

    try {
      await this.client.editTemplate(row.meta_template_id, {
        components: n.components,
        category: row.status !== 'APPROVED' && n.metaCategory !== row.meta_category ? n.metaCategory : undefined,
      })
    } catch (err) {
      throw mapMetaError(err)
    }
    const out = await this.repo.patch(id, {
      meta_category: n.metaCategory, purpose: n.purpose, components: n.components, body_text: n.bodyText, header_format: n.headerFormat,
      variables: n.variables, allow_category_change: n.allowCategoryChange,
      status: 'PENDING', rejection_reason: null, rejection_detail: null, last_status_at: this.now(),
    })
    await this.repo.addEvent(id, 'EDITED', 'Sent to Meta for re-review', 'MANUAL')
    this.emit('crm:template', { templateId: id })
    return { template: out, warnings: v.warnings }
  }

  // ─── Submit ───────────────────────────────────────────────────────
  async submit(id) {
    const claimed = await this.repo.claimForSubmit(id)
    if (!claimed) {
      const row = await this.repo.get(id)
      if (!row || row.status === 'DELETED') throw new CrmError('Template not found', 404, 'TEMPLATE_NOT_FOUND')
      throw new CrmError(`Only drafts can be submitted (this one is ${row.status.replace(/_/g, ' ').toLowerCase()}).`, 409, 'NOT_A_DRAFT')
    }
    let result
    try {
      result = await this.client.createTemplate({
        name: claimed.name,
        language: claimed.language,
        category: claimed.meta_category,
        parameterFormat: claimed.parameter_format,
        components: claimed.components,
        allowCategoryChange: claimed.allow_category_change,
      })
    } catch (err) {
      await this.repo.revertToDraft(id) // nothing reached Meta: back to a draft the team can fix
      throw mapMetaError(err)
    }
    const status = STATUSES.has(result.status) ? result.status : 'PENDING'
    const category = result.category && CATEGORIES.has(result.category) ? result.category : claimed.meta_category
    const out = await this.repo.patch(id, { meta_template_id: result.id, status, meta_category: category, last_status_at: this.now() })
    await this.repo.addEvent(id, 'SUBMITTED', `Sent to Meta for review (id ${result.id})`, 'SUBMIT')
    if (category !== claimed.meta_category) {
      await this.repo.addEvent(id, 'CATEGORY_ADJUSTED', `Meta set the category to ${category} (you chose ${claimed.meta_category}). Message prices follow ${category}.`, 'SUBMIT')
    }
    this.emit('crm:template', { templateId: id })
    return out
  }

  // ─── Delete ───────────────────────────────────────────────────────
  async remove(id) {
    const row = await this.repo.get(id)
    if (!row || row.status === 'DELETED') throw new CrmError('Template not found', 404, 'TEMPLATE_NOT_FOUND')
    if (row.status === 'DRAFT' && !row.meta_template_id) {
      await this.repo.deleteRow(id)
      this.emit('crm:template', { templateId: id })
      return { deleted: true, remote: false }
    }
    try {
      await this.client.deleteTemplate({ name: row.name, hsmId: row.meta_template_id })
    } catch (err) {
      throw mapMetaError(err)
    }
    await this.repo.patch(id, { status: 'DELETED', last_status_at: this.now() })
    await this.repo.addEvent(id, 'DELETED', row.status === 'APPROVED' ? 'Deleted at Meta. The name stays reserved for 30 days.' : 'Deleted at Meta', 'MANUAL')
    this.emit('crm:template', { templateId: id })
    return { deleted: true, remote: true, nameReservedDays: row.status === 'APPROVED' ? 30 : 0 }
  }

  // ─── Media header sample ──────────────────────────────────────────
  /**
   * Fetch an already-uploaded sample (Cloudinary https link) and hand it to Meta's Resumable Upload API.
   * Meta limits: images JPEG/PNG ≤ 5 MB, videos MP4 ≤ 16 MB, documents PDF ≤ 100 MB.
   */
  async uploadHeaderSample({ url, format }) {
    const kind = String(format ?? 'IMAGE').toUpperCase()
    const RULES = { IMAGE: { types: ['image/jpeg', 'image/png'], max: 5 * 1024 * 1024, label: 'a JPEG or PNG image up to 5 MB' }, VIDEO: { types: ['video/mp4'], max: 16 * 1024 * 1024, label: 'an MP4 video up to 16 MB' }, DOCUMENT: { types: ['application/pdf'], max: 100 * 1024 * 1024, label: 'a PDF up to 100 MB' } }
    const rule = RULES[kind]
    if (!rule) throw new CrmError('Choose image, video or document', 400, 'INVALID_HEADER')
    let host
    try {
      host = new URL(url)
    } catch {
      throw new CrmError('That link is not valid', 400, 'INVALID_HEADER')
    }
    if (host.protocol !== 'https:' || host.hostname !== 'res.cloudinary.com') throw new CrmError('Upload the file with the upload button first', 400, 'INVALID_HEADER')
    let res
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20000) })
    } catch {
      throw new CrmError('Could not read the uploaded file. Try uploading it again.', 502, 'FETCH_FAILED')
    }
    if (!res.ok) throw new CrmError('Could not read the uploaded file. Try uploading it again.', 502, 'FETCH_FAILED')
    const mimeType = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!rule.types.includes(mimeType)) throw new CrmError(`WhatsApp needs ${rule.label}. This file is ${mimeType || 'an unknown type'}.`, 400, 'INVALID_HEADER')
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length > rule.max) throw new CrmError(`The file is too big. WhatsApp allows ${rule.label}.`, 400, 'INVALID_HEADER')
    try {
      const ext = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1]
      const { handle } = await this.client.uploadTemplateSample({ buffer, mimeType, fileName: `header.${ext}` })
      return { handle, format: kind }
    } catch (err) {
      throw mapMetaError(err)
    }
  }

  // ─── Sync with Meta ───────────────────────────────────────────────
  /** Pull every template from Meta and reconcile. One at a time (advisory lock). */
  async sync() {
    const run = await this.repo.withSyncLock(async () => {
      let remote
      try {
        remote = await this.client.listAllTemplates()
      } catch (err) {
        throw mapMetaError(err)
      }
      const live = await this.repo.liveMetaRows()
      const seen = new Set()
      const out = { total: remote.length, created: 0, updated: 0, conflicts: 0, markedMissing: 0, warnings: [] }

      for (const t of remote) {
        if (!t?.id || !t.name) continue
        seen.add(String(t.id))
        const r = await this._upsertRemote(t)
        out[r]++
      }

      if (remote.length === 0 && live.length > 0) {
        // Almost certainly the wrong account or a bad response — never wipe the library on that evidence.
        out.warnings.push('Meta returned no templates at all, so nothing was marked as missing. Check that the WhatsApp Business Account id is correct.')
      } else {
        for (const l of live) {
          if (seen.has(l.meta_template_id)) continue
          await this.repo.patch(l.id, { status: 'DELETED', last_status_at: this.now() })
          await this.repo.addEvent(l.id, 'MISSING_AT_META', 'No longer exists at Meta', 'SYNC')
          out.markedMissing++
        }
      }
      return out
    })
    if (!run.locked) throw new CrmError('A sync is already running. Try again in a moment.', 409, 'SYNC_RUNNING')
    this.emit('crm:template', { templateId: null })
    this.logger.info(run.result, 'WhatsApp template sync finished')
    return run.result
  }

  /** @returns {'created'|'updated'|'conflicts'} */
  async _upsertRemote(t) {
    const f = mapRemoteTemplate(t, this.now())
    const existing = await this.repo.findByIdent({ metaId: f.meta_template_id, name: f.name, language: f.language })
    if (!existing) {
      const row = await this.repo.insertSynced(f)
      await this.repo.addEvent(row.id, 'IMPORTED', `Found at Meta (status ${f.status})`, 'SYNC')
      return 'created'
    }
    if (existing.meta_template_id !== f.meta_template_id) return 'conflicts' // a local draft/in-flight submit shares this name+language: leave it alone

    const changed = existing.status !== f.status
    await this.repo.patch(existing.id, { ...f, last_synced_at: this.now() })
    if (changed) await this.repo.addEvent(existing.id, `STATUS_${f.status}`, `Was ${existing.status}`, 'SYNC')
    return 'updated'
  }

  /** Re-read ONE template from Meta (used when a webhook says something we cannot apply from the event alone). */
  async refetch(metaId) {
    let t
    try {
      t = await this.client.getTemplate(metaId)
    } catch (err) {
      this.logger.warn({ err: err.message, metaId }, 'Could not refetch template from Meta; the next sync will repair it')
      return null
    }
    if (!t?.id) return null
    await this._upsertRemote({ ...t, id: t.id })
    return this.repo.findByIdent({ metaId: String(t.id) })
  }

  // ─── Webhooks ─────────────────────────────────────────────────────
  /**
   * @param {{ field: string, wabaId: string|null, time: Date, value: object }} ev one parsed template event
   */
  async applyWebhook(ev) {
    const eff = interpretTemplateWebhook(ev.field, ev.value)
    if (!eff) return { applied: false, reason: 'unrecognised event' }
    if (eff.accountLevel) {
      this.logger.warn({ event: eff.event }, 'Meta reports a template account limit event')
      return { applied: false, reason: 'account level' }
    }

    let row = await this.repo.findByIdent(eff.ident)
    if (!row || eff.refetch) {
      // Unknown template (made in WhatsApp Manager) or an event that does not say the new state: ask Meta.
      if (eff.ident.metaId) row = (await this.refetch(eff.ident.metaId)) ?? row
      if (!row) return { applied: false, reason: 'unknown template' }
      if (eff.refetch) {
        await this.repo.addEvent(row.id, eff.event, 'Refreshed from Meta', 'WEBHOOK')
        this.emit('crm:template', { templateId: row.id })
        return { applied: true, refetched: true }
      }
    }

    // A webhook can arrive before our own submit() has stored the Meta id — adopt it.
    const patch = { ...eff.patch }
    if (!row.meta_template_id && eff.ident.metaId) patch.meta_template_id = eff.ident.metaId

    const at = ev.time ?? this.now()
    const updated = eff.kind === 'status' ? await this.repo.patchStatusIfNewer(row.id, patch, at) : await this.repo.patch(row.id, patch)
    if (!updated) return { applied: false, reason: 'older than current state' }

    const detail = [eff.patch.rejection_reason, eff.patch.rejection_detail, eff.patch.quality_score, eff.patch.pending_category, eff.patch.meta_category].filter(Boolean).join(' · ')
    await this.repo.addEvent(row.id, eff.event, detail || null, 'WEBHOOK')
    this.emit('crm:template', { templateId: row.id })
    return { applied: true }
  }
}
