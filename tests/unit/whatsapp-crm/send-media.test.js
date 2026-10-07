import { describe, it, expect, vi } from 'vitest'
import { SendService, classifyMedia } from '../../../src/modules/whatsapp-crm/send.service.js'
import { InboundService } from '../../../src/modules/whatsapp-crm/inbound.service.js'

const conv = { id: 'c1', contact_id: 'k1', wa_id: '919999999999', bsuid: null, window_open: true, assigned_to: null }

function build(over = {}) {
  const repo = {
    getConversation: vi.fn().mockResolvedValue(conv),
    insertOutboundQueued: vi.fn().mockResolvedValue({ id: 'm1' }),
    bumpConversationForOutbound: vi.fn(),
    setMessageMedia: vi.fn(),
    markOutboundSent: vi.fn().mockResolvedValue({ id: 'm1', status: 'SENT' }),
    markOutboundFailed: vi.fn(),
    ...over.repo,
  }
  const client = {
    uploadMedia: vi.fn().mockResolvedValue({ mediaId: 'MID' }),
    sendMedia: vi.fn().mockResolvedValue({ wamid: 'wamid.1' }),
    ...over.client,
  }
  const emit = vi.fn()
  return { repo, client, emit, svc: new SendService({ repo, client, emit, logger: { warn: vi.fn() } }) }
}

describe('classifyMedia', () => {
  it('maps mime types to WhatsApp message types and limits', () => {
    expect(classifyMedia('image/jpeg')).toMatchObject({ type: 'image' })
    expect(classifyMedia('video/mp4')).toMatchObject({ type: 'video' })
    expect(classifyMedia('audio/ogg; codecs=opus')).toMatchObject({ type: 'audio' })
    expect(classifyMedia('application/pdf')).toMatchObject({ type: 'document' })
    expect(classifyMedia('image/webp')).toBeNull()
    expect(classifyMedia('application/x-msdownload')).toBeNull()
  })
})

describe('SendService.sendMedia', () => {
  it('uploads, sends with the caption, stores the media id and marks the message sent', async () => {
    const { svc, repo, client } = build()
    await svc.sendMedia({ conversationId: 'c1', buffer: Buffer.alloc(10, 1), mimeType: 'image/png', filename: 'a.png', caption: '  Fresh stock  ', sentBy: 'u1' })
    expect(repo.insertOutboundQueued).toHaveBeenCalledWith(expect.objectContaining({ type: 'image', body: 'Fresh stock', sentBy: 'u1' }))
    expect(client.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/png' }))
    expect(repo.setMessageMedia).toHaveBeenCalledWith('m1', expect.objectContaining({ id: 'MID' }))
    expect(client.sendMedia).toHaveBeenCalledWith(expect.objectContaining({ to: '919999999999', mediaType: 'image', mediaId: 'MID', caption: 'Fresh stock' }))
    expect(repo.markOutboundSent).toHaveBeenCalledWith('m1', 'wamid.1')
  })

  it('refuses outside the 24-hour window without touching Meta', async () => {
    const { svc, client } = build({ repo: { getConversation: vi.fn().mockResolvedValue({ ...conv, window_open: false }) } })
    await expect(svc.sendMedia({ conversationId: 'c1', buffer: Buffer.alloc(5), mimeType: 'image/png' })).rejects.toMatchObject({ code: 'OUTSIDE_24H_WINDOW' })
    expect(client.uploadMedia).not.toHaveBeenCalled()
  })

  it('rejects unsupported types and oversized photos', async () => {
    const { svc } = build()
    await expect(svc.sendMedia({ conversationId: 'c1', buffer: Buffer.alloc(5), mimeType: 'application/zip' })).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' })
    await expect(svc.sendMedia({ conversationId: 'c1', buffer: Buffer.alloc(6 * 1024 * 1024), mimeType: 'image/jpeg' })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })

  it('marks the message failed (not lost) when Meta rejects the upload', async () => {
    const { svc, repo } = build({ client: { uploadMedia: vi.fn().mockRejectedValue(new Error('boom')) } })
    await expect(svc.sendMedia({ conversationId: 'c1', buffer: Buffer.alloc(5), mimeType: 'image/png' })).rejects.toMatchObject({ code: 'WHATSAPP_SEND_FAILED' })
    expect(repo.markOutboundFailed).toHaveBeenCalledWith('m1', expect.anything())
  })
})

describe('InboundService: a brand-new number', () => {
  it('still tells the dashboards about the chat when placing it on the pipeline board fails', async () => {
    const repo = {
      findCustomerIdByPhone: vi.fn().mockResolvedValue(null),
      withTransaction: vi.fn(async (fn) => fn({})),
      upsertContact: vi.fn().mockResolvedValue({ contact: { id: 'k9', stage_id: null }, created: true }),
      ensureConversation: vi.fn().mockResolvedValue({ id: 'c9' }),
      insertInboundMessage: vi.fn().mockResolvedValue({ id: 'm9' }),
      bumpConversationForInbound: vi.fn().mockResolvedValue({ id: 'c9', assigned_to: null }),
    }
    const emit = vi.fn()
    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
    const svc = new InboundService({ repo, emit, logger, pipeline: { evaluateContact: vi.fn().mockRejectedValue(new Error('pipeline down')) } })
    await svc.handleMessage({ waId: '14155550123', bsuid: null, type: 'text', body: 'Hello', wamid: 'w1', timestamp: new Date(), profileName: null })
    expect(emit).toHaveBeenCalledWith('crm:message', expect.objectContaining({ conversationId: 'c9', newContact: true }))
    expect(logger.warn).toHaveBeenCalled()
  })
})
