import axios from 'axios'

/**
 * Thin client for the WhatsApp Business Cloud API (Meta Graph API).
 *
 * Deliberately NOT built on a third-party SDK: Meta's own Node SDK is
 * archived, the community ones are small. The API is plain REST, and axios is
 * already a dependency. Named-parameter style follows ArnasDon/wacrm (MIT),
 * which found positional (token, phoneNumberId) swaps to be a recurring bug.
 */

/**
 * Meta error codes documented as temporary: 1 server error, 2 overloaded,
 * 4 app rate limit, 80007 WABA rate limit, 130429 throughput, 131000 unknown
 * (Meta says "try again"), 131016 / 133004 service unavailable,
 * 131056 pair rate limit, 131057 maintenance mode.
 */
const RETRYABLE_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131056, 131057, 133004])

const TEMPLATE_FIELDS = 'id,name,language,category,status,components,parameter_format,rejected_reason,quality_score,sub_category,correct_category,last_updated_time'

/** Codes the app must act on rather than retry. */
export const META_CODE = Object.freeze({
  OUTSIDE_24H_WINDOW: 131047,
  USER_OPTED_OUT_MARKETING: 131050,
  NOT_A_WHATSAPP_USER: 131026,
  PER_USER_MARKETING_LIMIT: 131049,
  USER_BLOCKED_BUSINESS: 130403,
  TEMPLATE_NOT_FOUND_OR_UNAPPROVED: 132001,
  TEMPLATE_PAUSED: 132015,
  TEMPLATE_DISABLED: 132016,
  TEMPLATE_PARAM_MISMATCH: 132000,
})

export class MetaApiError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: number|null, subcode?: number|null, httpStatus?: number|null,
   *           details?: string|null, fbtraceId?: string|null, retryable?: boolean }} f
   */
  constructor(message, f = {}) {
    super(message)
    this.name = 'MetaApiError'
    this.code = f.code ?? null
    this.subcode = f.subcode ?? null
    this.httpStatus = f.httpStatus ?? null
    this.details = f.details ?? null
    this.fbtraceId = f.fbtraceId ?? null
    this.retryable = f.retryable ?? false
  }
}

/**
 * @param {{ accessToken: string, phoneNumberId: string, wabaId?: string, apiVersion?: string, baseUrl?: string,
 *           http?: import('axios').AxiosInstance, timeoutMs?: number }} cfg
 */
export function createMetaClient(cfg) {
  const { accessToken, phoneNumberId, wabaId, appId, apiVersion = 'v25.0', timeoutMs = 15000, baseUrl = 'https://graph.facebook.com' } = cfg
  const http =
    cfg.http ??
    axios.create({
      baseURL: `${baseUrl.replace(/\/+$/, '')}/${apiVersion}`,
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json' },
    })

  function assertConfigured() {
    if (!accessToken || !phoneNumberId) {
      throw new MetaApiError('WhatsApp is not configured (missing access token or phone number id)', {
        retryable: false,
      })
    }
  }

  /** Recipient field: phone (`to`) when known, otherwise BSUID (`recipient`). */
  function addressee({ to, bsuid }) {
    if (to) return { to }
    if (bsuid) return { recipient: bsuid }
    throw new MetaApiError('No phone number or user id to send to')
  }

  async function post(path, body) {
    assertConfigured()
    try {
      const res = await http.post(path, body, { headers: { Authorization: `Bearer ${accessToken}` } })
      return res.data
    } catch (err) {
      throw toMetaError(err)
    }
  }

  function assertTemplatesConfigured() {
    if (!accessToken || !wabaId) {
      throw new MetaApiError('WhatsApp templates are not configured (missing access token or WhatsApp Business Account id)', { retryable: false })
    }
  }

  async function call(method, path, { params, data } = {}) {
    try {
      const res = await http.request({ method, url: path, params, data, headers: { Authorization: `Bearer ${accessToken}` } })
      return res.data
    } catch (err) {
      throw toMetaError(err)
    }
  }

  /** Meta answers { messages: [{ id }] } on success. */
  async function send(payload) {
    const data = await post(`/${phoneNumberId}/messages`, { messaging_product: 'whatsapp', ...payload })
    const wamid = data?.messages?.[0]?.id
    if (!wamid) throw new MetaApiError('Meta accepted the request but returned no message id')
    return { wamid }
  }

  return {
    /**
     * Free-form text. Meta only allows this inside the 24-hour customer-service
     * window — the caller (send.service.js) enforces that before getting here.
     */
    async sendText({ to, bsuid, body, replyToWamid }) {
      return send({
        ...addressee({ to, bsuid }),
        type: 'text',
        text: { body, preview_url: false },
        ...(replyToWamid ? { context: { message_id: replyToWamid } } : {}),
      })
    },

    /**
     * Uploads a file to Meta and returns its media id (valid ~30 days). Limits are Meta's:
     * images 5 MB, audio/video 16 MB, documents 100 MB.
     */
    async uploadMedia({ buffer, mimeType, filename }) {
      assertConfigured()
      const form = new FormData()
      form.append('messaging_product', 'whatsapp')
      form.append('type', mimeType)
      form.append('file', new Blob([buffer], { type: mimeType }), filename || 'file')
      try {
        const res = await http.post(`/${phoneNumberId}/media`, form, {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': undefined },
          maxBodyLength: Infinity,
          timeout: 60000,
        })
        if (!res.data?.id) throw new MetaApiError('Meta accepted the file but returned no media id')
        return { mediaId: String(res.data.id) }
      } catch (err) {
        throw toMetaError(err)
      }
    },

    /** Sends an already uploaded image / video / audio / document. Inside the 24-hour window only. */
    async sendMedia({ to, bsuid, mediaType, mediaId, caption, filename, replyToWamid }) {
      const body = { id: mediaId }
      if (caption && (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')) body.caption = caption
      if (filename && mediaType === 'document') body.filename = filename
      return send({
        ...addressee({ to, bsuid }),
        type: mediaType,
        [mediaType]: body,
        ...(replyToWamid ? { context: { message_id: replyToWamid } } : {}),
      })
    },

    /** Downloads a customer's (or our own) attachment by media id. Meta's download URL needs the access token too. */
    async downloadMedia(mediaId) {
      assertConfigured()
      try {
        const info = await call('get', `/${mediaId}`)
        if (!info?.url) throw new MetaApiError('Meta has no download link for this file (it may have expired)')
        const res = await axios.get(info.url, {
          responseType: 'arraybuffer',
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 60000,
          maxContentLength: 110 * 1024 * 1024,
        })
        return { buffer: Buffer.from(res.data), mimeType: info.mime_type || res.headers['content-type'] || 'application/octet-stream' }
      } catch (err) {
        throw toMetaError(err)
      }
    },

    /** Approved template. Required outside the 24-hour window. */
    async sendTemplate({ to, bsuid, name, language, components }) {
      return send({
        ...addressee({ to, bsuid }),
        type: 'template',
        template: { name, language: { code: language }, ...(components?.length ? { components } : {}) },
      })
    },

    // ─── Message templates (WABA level) ─────────────────────────────
    // https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management

    /** Submit a new template for review. Meta answers { id, status: 'PENDING', category }. */
    async createTemplate({ name, language, category, parameterFormat = 'NAMED', components, allowCategoryChange = true }) {
      assertTemplatesConfigured()
      const d = await call('post', `/${wabaId}/message_templates`, {
        data: { name, language, category, parameter_format: parameterFormat, components, allow_category_change: allowCategoryChange },
      })
      if (!d?.id) throw new MetaApiError('Meta accepted the template but returned no template id')
      return { id: String(d.id), status: String(d.status ?? 'PENDING').toUpperCase(), category: d.category ? String(d.category).toUpperCase() : null }
    },

    /**
     * Resumable Upload API: turns a sample image/video/PDF into the `header_handle` a media-header template needs.
     * Needs the Meta App ID. https://developers.facebook.com/docs/graph-api/guides/upload
     */
    async uploadTemplateSample({ buffer, mimeType, fileName = 'sample' }) {
      if (!accessToken || !appId) {
        throw new MetaApiError('Add the Meta App ID in WhatsApp settings first. It is needed to upload the sample image Meta reviews.', { retryable: false })
      }
      const session = await call('post', `/${appId}/uploads`, { params: { file_length: buffer.length, file_type: mimeType, file_name: fileName } })
      if (!session?.id) throw new MetaApiError('Meta did not start the upload')
      try {
        const res = await http.post(`/${session.id}`, buffer, { headers: { Authorization: `OAuth ${accessToken}`, file_offset: '0', 'Content-Type': 'application/octet-stream' }, maxBodyLength: Infinity })
        if (!res.data?.h) throw new MetaApiError('Meta did not return a file handle')
        return { handle: String(res.data.h) }
      } catch (err) {
        throw toMetaError(err)
      }
    },

    /** Replaces ALL components of an existing template; Meta re-reviews it. */
    async editTemplate(templateId, { components, category }) {
      assertTemplatesConfigured()
      await call('post', `/${templateId}`, { data: { components, ...(category ? { category } : {}) } })
    },

    /** Deletes ONE template (name + id), not every language of that name. */
    async deleteTemplate({ name, hsmId }) {
      assertTemplatesConfigured()
      await call('delete', `/${wabaId}/message_templates`, { params: { name, hsm_id: hsmId } })
    },

    /** One page of the account's templates. */
    async listTemplates({ after, limit = 100 } = {}) {
      assertTemplatesConfigured()
      const d = await call('get', `/${wabaId}/message_templates`, { params: { fields: TEMPLATE_FIELDS, limit, ...(after ? { after } : {}) } })
      return { data: Array.isArray(d?.data) ? d.data : [], after: d?.paging?.next ? d?.paging?.cursors?.after ?? null : null }
    },

    /** Every template, following the paging cursors (bounded so a bad cursor can never loop forever). */
    async listAllTemplates({ maxPages = 50 } = {}) {
      const all = []
      let after
      for (let page = 0; page < maxPages; page++) {
        const r = await this.listTemplates({ after })
        all.push(...r.data)
        if (!r.after) return all
        after = r.after
      }
      throw new MetaApiError(`Template list has more than ${maxPages} pages; stopping`)
    },

    async getTemplate(templateId) {
      assertTemplatesConfigured()
      return call('get', `/${templateId}`, { params: { fields: TEMPLATE_FIELDS } })
    },

    /** Marks an inbound message as read (blue ticks for the customer). */
    async markRead(wamid) {
      await post(`/${phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: wamid,
      })
    },
  }
}

/** Convert an axios failure into a MetaApiError carrying Meta's structured error. */
export function toMetaError(err) {
  if (err instanceof MetaApiError) return err
  const status = err?.response?.status ?? null
  const e = err?.response?.data?.error
  if (e) {
    // 5xx and the codes Meta documents as temporary/throttling are worth retrying;
    // auth, validation, 24h-window (131047), opted-out (131050) etc. are not.
    // Source: developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
    const retryable = (status != null && status >= 500) || RETRYABLE_CODES.has(e.code)
    return new MetaApiError(e.message ?? 'Meta API error', {
      code: typeof e.code === 'number' ? e.code : null,
      subcode: typeof e.error_subcode === 'number' ? e.error_subcode : null,
      httpStatus: status,
      details: e.error_data?.details ?? null,
      fbtraceId: e.fbtrace_id ?? null,
      retryable,
    })
  }
  // No response at all: DNS/timeout/connection reset — transient.
  return new MetaApiError(err?.message ?? 'Network error talking to Meta', {
    httpStatus: status,
    retryable: status == null || status >= 500,
  })
}
