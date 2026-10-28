import { UploadsController } from './uploads.controller.js'
import { UploadsService } from './uploads.service.js'

/**
 * Uploads routes plugin
 * Prefix: /api/v1/uploads
 */
export default async function uploadsRoutes(fastify) {
  const service = new UploadsService()
  const controller = new UploadsController(service)

  // POST /image — Upload single image [AUTH]
  fastify.post('/image', {
    schema: {
      tags: ['Uploads'],
      summary: 'Upload single image (query: kind=products|banners|themes|whatsapp|...)',
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
    },
    preHandler: [fastify.authenticate],
  }, controller.uploadImage.bind(controller))

  // POST /images — Upload multiple images [ADMIN]
  fastify.post('/images', {
    schema: {
      tags: ['Uploads'],
      summary: 'Upload multiple images [ADMIN] (query: kind)',
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
    },
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.uploadMultipleImages.bind(controller))

  // POST /file — Upload any file (Lottie, etc.) [ADMIN]
  fastify.post('/file', {
    schema: {
      tags: ['Uploads'],
      summary: 'Upload a Lottie file [ADMIN]',
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
    },
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.uploadFile.bind(controller))

  // GET /proxy — Proxy a Cloudinary file for mobile clients
  fastify.get('/proxy', {
    schema: {
      tags: ['Uploads'],
      summary: 'Proxy a media file download',
      querystring: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string' },
          encoding: { type: 'string' },
        },
      },
    },
  }, controller.proxyFile.bind(controller))

  // DELETE /image — Delete image from Cloudinary [ADMIN]
  fastify.delete('/image', {
    schema: {
      tags: ['Uploads'],
      summary: 'Delete an image (released, then trashed once unused) [ADMIN]',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['publicId'],
        properties: {
          publicId: { type: 'string' },
        },
      },
    },
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.deleteImage.bind(controller))

  // POST /cleanup — trash images nothing uses any more [ADMIN]
  fastify.post('/cleanup', {
    schema: {
      tags: ['Uploads'],
      summary: 'Find unused images and move them to the 30-day trash [ADMIN]; ?dryRun=true only reports',
      security: [{ bearerAuth: [] }],
      querystring: { type: 'object', properties: { dryRun: { type: 'string' } } },
    },
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.cleanup.bind(controller))
}
