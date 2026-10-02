import { describe, expect, it, vi } from 'vitest'
import { createMetaClient, MetaApiError, toMetaError, META_CODE } from '../../../src/modules/whatsapp-crm/meta-client.js'

const cfg = { accessToken: 'TOKEN', phoneNumberId: 'PN1' }

function fakeHttp(impl) {
  return { post: vi.fn(impl) }
}

describe('meta client — requests', () => {
  it('sendText posts the right payload, with the bearer token, and returns the wamid', async () => {
    const http = fakeHttp(async () => ({ data: { messages: [{ id: 'wamid.OK' }] } }))
    const client = createMetaClient({ ...cfg, http })
    const res = await client.sendText({ to: '919876543210', body: 'Hello' })

    expect(res).toEqual({ wamid: 'wamid.OK' })
    const [path, body, opts] = http.post.mock.calls[0]
    expect(path).toBe('/PN1/messages')
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '919876543210', type: 'text', text: { body: 'Hello' } })
    expect(opts.headers.Authorization).toBe('Bearer TOKEN')
  })

  it('addresses a username-only customer by BSUID using `recipient`, never `to`', async () => {
    const http = fakeHttp(async () => ({ data: { messages: [{ id: 'w' }] } }))
    await createMetaClient({ ...cfg, http }).sendText({ bsuid: 'IN.1349120865', body: 'hi' })
    const body = http.post.mock.calls[0][1]
    expect(body.recipient).toBe('IN.1349120865')
    expect(body.to).toBeUndefined()
  })

  it('prefers the phone number when both are known', async () => {
    const http = fakeHttp(async () => ({ data: { messages: [{ id: 'w' }] } }))
    await createMetaClient({ ...cfg, http }).sendText({ to: '919876543210', bsuid: 'IN.1349120865', body: 'hi' })
    const body = http.post.mock.calls[0][1]
    expect(body.to).toBe('919876543210')
    expect(body.recipient).toBeUndefined()
  })

  it('sendTemplate includes language and components only when given', async () => {
    const http = fakeHttp(async () => ({ data: { messages: [{ id: 'w' }] } }))
    const client = createMetaClient({ ...cfg, http })
    await client.sendTemplate({ to: '919876543210', name: 'abandoned_cart', language: 'en' })
    expect(http.post.mock.calls[0][1].template).toEqual({ name: 'abandoned_cart', language: { code: 'en' } })
    await client.sendTemplate({
      to: '919876543210',
      name: 'abandoned_cart',
      language: 'en',
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Rahul' }] }],
    })
    expect(http.post.mock.calls[1][1].template.components).toHaveLength(1)
  })

  it('throws (without calling Meta) when not configured or no recipient', async () => {
    const http = fakeHttp(async () => ({ data: {} }))
    await expect(createMetaClient({ accessToken: '', phoneNumberId: 'PN1', http }).sendText({ to: '9', body: 'x' })).rejects.toThrow(/not configured/)
    await expect(createMetaClient({ ...cfg, http }).sendText({ body: 'x' })).rejects.toThrow(/No phone number/)
    expect(http.post).not.toHaveBeenCalled()
  })

  it('treats a 200 without a message id as an error', async () => {
    const http = fakeHttp(async () => ({ data: {} }))
    await expect(createMetaClient({ ...cfg, http }).sendText({ to: '919876543210', body: 'x' })).rejects.toThrow(/no message id/)
  })
})

describe('meta client — error mapping', () => {
  const axiosErr = (status, error) => ({ response: { status, data: { error } } })

  it('keeps Meta’s code, details and trace id', () => {
    const e = toMetaError(axiosErr(400, { code: META_CODE.OUTSIDE_24H_WINDOW, message: 'x', error_data: { details: 'use a template' }, fbtrace_id: 'T1' }))
    expect(e).toBeInstanceOf(MetaApiError)
    expect(e).toMatchObject({ code: 131047, details: 'use a template', fbtraceId: 'T1', httpStatus: 400, retryable: false })
  })

  it.each([130429, 131016, 80007, 2, 131056])('marks documented temporary code %i as retryable', (code) => {
    expect(toMetaError(axiosErr(400, { code, message: 'x' })).retryable).toBe(true)
  })

  it.each([131047, 131050, 131026, 190, 100, 132001])('does NOT retry code %i', (code) => {
    expect(toMetaError(axiosErr(400, { code, message: 'x' })).retryable).toBe(false)
  })

  it('retries 5xx and network failures but not a plain 4xx without a body', () => {
    expect(toMetaError(axiosErr(503, { code: 999, message: 'x' })).retryable).toBe(true)
    expect(toMetaError({ message: 'timeout of 15000ms exceeded' }).retryable).toBe(true)
    expect(toMetaError({ message: 'bad', response: { status: 404, data: {} } }).retryable).toBe(false)
  })
})

describe('meta client — real HTTP against a local listener', () => {
  it('sends the exact request Meta expects (path, auth header, JSON body) and parses the answer', async () => {
    const http = await import('node:http')
    const seen = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, ctype: req.headers['content-type'], body: JSON.parse(body) })
        res.setHeader('content-type', 'application/json')
        if (req.url.includes('BAD')) {
          res.statusCode = 400
          return res.end(JSON.stringify({ error: { message: '(#131047) Re-engagement message', code: 131047, error_data: { details: 'use a template' }, fbtrace_id: 'TR1' } }))
        }
        res.end(JSON.stringify({ messages: [{ id: 'wamid.LOCAL1' }] }))
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}/` // trailing slash must be tolerated
    try {
      const client = createMetaClient({ accessToken: 'TKN', phoneNumberId: 'PN9', apiVersion: 'v25.0', baseUrl: base })
      await expect(client.sendText({ to: '919876543210', body: 'Hello 👋' })).resolves.toEqual({ wamid: 'wamid.LOCAL1' })
      expect(seen[0]).toMatchObject({
        method: 'POST', url: '/v25.0/PN9/messages', auth: 'Bearer TKN',
        body: { messaging_product: 'whatsapp', to: '919876543210', type: 'text', text: { body: 'Hello 👋', preview_url: false } },
      })
      expect(seen[0].ctype).toMatch(/application\/json/)

      await client.markRead('wamid.IN1')
      expect(seen[1].body).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN1' })

      const bad = createMetaClient({ accessToken: 'TKN', phoneNumberId: 'BAD', baseUrl: base })
      await expect(bad.sendText({ to: '919876543210', body: 'x' })).rejects.toMatchObject({ code: 131047, details: 'use a template', fbtraceId: 'TR1', httpStatus: 400, retryable: false })
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})

describe('meta client — template endpoints against a real local listener', () => {
  async function withServer(handler, fn) {
    const http = await import('node:http')
    const seen = []
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const u = new URL(req.url, 'http://x')
        const rec = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization, body: body ? JSON.parse(body) : null }
        seen.push(rec)
        res.setHeader('content-type', 'application/json')
        const out = handler(rec)
        res.statusCode = out.status ?? 200
        res.end(JSON.stringify(out.json))
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    try {
      await fn(`http://127.0.0.1:${server.address().port}`, seen)
    } finally {
      await new Promise((r) => server.close(r))
    }
  }
  const mk = (baseUrl, over = {}) => createMetaClient({ accessToken: 'TKN', phoneNumberId: 'PN1', wabaId: 'WABA9', apiVersion: 'v25.0', baseUrl, ...over })

  it('createTemplate posts the documented body and returns id/status/category', async () => {
    await withServer(() => ({ json: { id: '1234567890', status: 'PENDING', category: 'MARKETING' } }), async (base, seen) => {
      const comps = [{ type: 'BODY', text: 'Hi' }]
      const r = await mk(base).createTemplate({ name: 'hello_world', language: 'en_US', category: 'MARKETING', components: comps })
      expect(r).toEqual({ id: '1234567890', status: 'PENDING', category: 'MARKETING' })
      expect(seen[0]).toMatchObject({ method: 'POST', path: '/v25.0/WABA9/message_templates', auth: 'Bearer TKN' })
      expect(seen[0].body).toEqual({ name: 'hello_world', language: 'en_US', category: 'MARKETING', parameter_format: 'NAMED', components: comps, allow_category_change: true })
    })
  })

  it('editTemplate replaces components on the template id', async () => {
    await withServer(() => ({ json: { success: true } }), async (base, seen) => {
      await mk(base).editTemplate('555', { components: [{ type: 'BODY', text: 'New' }] })
      expect(seen[0]).toMatchObject({ method: 'POST', path: '/v25.0/555', body: { components: [{ type: 'BODY', text: 'New' }] } })
    })
  })

  it('deleteTemplate targets ONE template by name + hsm_id (not every language)', async () => {
    await withServer(() => ({ json: { success: true } }), async (base, seen) => {
      await mk(base).deleteTemplate({ name: 'order_confirmation', hsmId: '1407680676729941' })
      expect(seen[0]).toMatchObject({ method: 'DELETE', path: '/v25.0/WABA9/message_templates', query: { name: 'order_confirmation', hsm_id: '1407680676729941' } })
    })
  })

  it('listAllTemplates follows the paging cursor until the end and asks for the fields we need', async () => {
    await withServer((rec) => {
      if (!rec.query.after) return { json: { data: [{ id: '1' }, { id: '2' }], paging: { cursors: { after: 'C1' }, next: 'https://graph/next' } } }
      if (rec.query.after === 'C1') return { json: { data: [{ id: '3' }], paging: { cursors: { after: 'C2' } } } } // no `next` => last page
      return { status: 500, json: {} }
    }, async (base, seen) => {
      const all = await mk(base).listAllTemplates()
      expect(all.map((t) => t.id)).toEqual(['1', '2', '3'])
      expect(seen).toHaveLength(2)
      expect(seen[0].query.fields).toMatch(/rejected_reason/)
      expect(seen[0].query.fields).toMatch(/quality_score/)
      expect(seen[0].query.fields).toMatch(/components/)
    })
  })

  it('listAllTemplates refuses to loop forever on a bad cursor', async () => {
    await withServer(() => ({ json: { data: [{ id: 'x' }], paging: { cursors: { after: 'SAME' }, next: 'n' } } }), async (base) => {
      await expect(mk(base).listAllTemplates({ maxPages: 3 })).rejects.toThrow(/more than 3 pages/)
    })
  })

  it('maps Meta template errors (duplicate name) and refuses to call without a WABA id', async () => {
    await withServer(() => ({ status: 400, json: { error: { message: 'x', code: 100, error_subcode: 2388024, error_data: { details: 'Content in This Language Already Exists' } } } }), async (base) => {
      await expect(mk(base).createTemplate({ name: 'a', language: 'en', category: 'UTILITY', components: [] })).rejects.toMatchObject({ code: 100, subcode: 2388024, details: 'Content in This Language Already Exists', retryable: false })
    })
    const none = createMetaClient({ accessToken: 'TKN', phoneNumberId: 'PN1' })
    await expect(none.listTemplates()).rejects.toThrow(/not configured/)
    await expect(none.createTemplate({ name: 'a', language: 'en', category: 'UTILITY', components: [] })).rejects.toThrow(/not configured/)
  })
})
