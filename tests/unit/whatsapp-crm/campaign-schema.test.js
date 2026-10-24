import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { createCampaignSchema, updateCampaignSchema } from '../../../src/modules/admin/whatsapp-crm/whatsapp-crm.schema.js'
import { validateImageSource } from '../../../src/modules/whatsapp-crm/header-image.js'

// Same ajv options as src/app.js: removeAdditional:'all' used to strip the whole picture source down to {}.
async function through(schema, payload) {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: 'all', useDefaults: true, coerceTypes: 'array' } } })
  app.post('/:id', { schema }, async (r) => r.body)
  const res = await app.inject({ method: 'POST', url: `/${uuid}`, payload })
  await app.close()
  if (res.statusCode !== 200) throw new Error(res.body)
  return res.json()
}

const uuid = '22222222-2222-4222-8222-222222222222'
const base = { name: 'x', templateId: '11111111-1111-4111-8111-111111111111', audience: { type: 'ALL_OPTED_IN', ids: [] } }

describe('campaign picture source survives request validation', () => {
  for (const src of [
    { mode: 'OFFER_PRODUCTS' },
    { mode: 'IMAGES', urls: ['https://a/1.png', 'https://a/2.png'], fallbackUrl: 'https://a/b.png' },
    { mode: 'PRODUCTS', productIds: [uuid] },
    { mode: 'ONE', urls: ['https://a/1.png'] },
  ]) {
    it(`keeps ${src.mode}`, async () => {
      for (const schema of [createCampaignSchema, updateCampaignSchema]) {
        const body = await through(schema, { ...base, headerImageSource: src })
        expect(body.headerImageSource).toEqual(src)
        expect(validateImageSource(body.headerImageSource).error).toBeUndefined()
      }
    })
  }
})
