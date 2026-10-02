import crypto from 'node:crypto'
import { whatsappInboundQueue } from '../../config/bullmq.js'
import { checkVerifyHandshake, verifyMetaSignature } from './webhook-signature.js'
import { getWhatsappServices } from './whatsapp.factory.js'

/**
 * Public Meta webhook — NO user auth; authenticity comes from the signature.
 * Registered at /api/webhook/whatsapp (beside the Razorpay webhook).
 *
 *   GET  — Meta's one-time verify-token handshake
 *   POST — signed event delivery. We verify, store the raw event, queue it and
 *          answer 200 immediately; Meta retries slow/failed acks and duplicates
 *          are absorbed (body hash here, wamid uniqueness later).
 */
export default async function whatsappWebhookRoutes(fastify) {
  fastify.get(
    '/whatsapp',
    {
      config: { rateLimit: false },
      schema: {
        hide: true,
        querystring: {
          type: 'object',
          properties: {
            'hub.mode': { type: 'string' },
            'hub.verify_token': { type: 'string' },
            'hub.challenge': { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const cfg = await getWhatsappServices().settings.resolved()
      const challenge = checkVerifyHandshake(request.query, cfg.verifyToken)
      if (challenge === null) return reply.code(403).send('Forbidden')
      return reply.code(200).type('text/plain').send(challenge)
    },
  )

  fastify.post(
    '/whatsapp',
    {
      // rateLimit off: Meta retries failed deliveries — never throttle a legitimate retry.
      // No `body` schema on purpose: the app runs AJV with removeAdditional:'all', which
      // strips every field not declared in a schema — even with additionalProperties:true —
      // leaving an empty object. We parse the exact signed bytes ourselves instead.
      config: { rawBody: true, rateLimit: false },
      schema: { hide: true },
    },
    async (request, reply) => {
      const cfg = await getWhatsappServices().settings.resolved()
      if (!cfg.enabled) {
        return reply.code(503).send({ success: false, message: 'WhatsApp CRM is not enabled' })
      }

      const rawBody = request.rawBody
      const signature = request.headers['x-hub-signature-256']
      if (!rawBody || !verifyMetaSignature(rawBody, signature, cfg.appSecret)) {
        // 401 (not 200) so a misconfigured secret shows up loudly in Meta's delivery dashboard.
        request.log.warn({ hasSecret: Boolean(cfg.appSecret) }, 'WhatsApp webhook rejected: bad or missing signature')
        return reply.code(401).send({ success: false, message: 'Invalid signature' })
      }

      let payload
      try {
        payload = JSON.parse(rawBody)
      } catch {
        return reply.code(400).send({ success: false, message: 'Invalid JSON' })
      }
      // Meta always sends this envelope. Anything else (even correctly signed) is not ours to store.
      if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
        return reply.code(400).send({ success: false, message: 'Not a WhatsApp Business Account event' })
      }

      const hash = crypto.createHash('sha256').update(rawBody).digest('hex')
      const { repo } = getWhatsappServices()
      const event = await repo.recordWebhookEvent(hash, payload)

      // Already handled (Meta retried after a slow ack) → nothing more to do.
      if (!event.processedAt) {
        const existing = await whatsappInboundQueue.getJob(event.id)
        if (!existing) {
          await whatsappInboundQueue.add('process', { eventId: event.id }, { jobId: event.id })
        } else if ((await existing.getState()) === 'failed') {
          await existing.retry()
        }
      }

      return reply.code(200).send({ status: 'received' })
    },
  )
}
