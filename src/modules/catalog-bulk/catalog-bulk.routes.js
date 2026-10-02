import { BusinessError } from '../../utils/business-error.js'
import { BIZ_PERM, requireBusiness, sendBusinessError } from '../../utils/business-access.js'
import { error, success } from '../../utils/apiResponse.js'
import { CatalogBulkRepository } from './catalog-bulk.repository.js'
import { CatalogBulkService } from './catalog-bulk.service.js'
import * as S from './catalog-bulk.schema.js'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Bulk catalog — mounted at /api/v1/admin/catalog-bulk. Authenticated admin + catalog.bulk (HQ always passes). */
export default async function catalogBulkRoutes(fastify) {
  const service = new CatalogBulkService({ repo: new CatalogBulkRepository() })
  fastify.addHook('onRequest', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })
  const run = (message, fn) => async (request, reply) => {
    try {
      return success(await fn(request), message)
    } catch (err) {
      return sendBusinessError(reply, err, BusinessError)
    }
  }
  const route = (method, url, schema, message, fn) =>
    fastify[method](url, { schema, preValidation: requireBusiness(BIZ_PERM.CATALOG_BULK), config: { requiredPermission: BIZ_PERM.CATALOG_BULK } }, run(message, fn))

  route('get', '/uploads', undefined, 'Uploads fetched', () => service.list())
  route('get', '/uploads/:id', S.idSchema, 'Upload fetched', (r) => service.get(r.params.id))
  route('get', '/uploads/:id/rows', S.rowsSchema, 'Rows fetched', (r) => service.rows(r.params.id, r.query))
  route('post', '/uploads/:id/apply', S.applySchema, 'Changes applied', (r) => {
    if (r.body?.confirm !== true) throw new BusinessError('Confirm the changes to apply them.', 400, 'CONFIRM_REQUIRED')
    return service.apply(r.params.id, r.body, { userId: r.user.id })
  })
  route('delete', '/uploads/:id', S.idSchema, 'Upload discarded', (r) => service.discard(r.params.id))
  route('post', '/availability', S.availabilitySchema, 'Checked', (r) => service.setAvailability(r.body, { userId: r.user.id }))

  /** multipart: a .csv / .xlsx file. Creates a preview only. */
  fastify.post('/uploads', { preValidation: requireBusiness(BIZ_PERM.CATALOG_BULK), config: { requiredPermission: BIZ_PERM.CATALOG_BULK } }, async (request, reply) => {
    const file = await request.file()
    if (!file) return reply.code(400).send(error('No file uploaded', 'BAD_REQUEST'))
    try {
      const buffer = await file.toBuffer()
      return success(await service.preview({ buffer, filename: file.filename, userId: request.user.id }), 'File checked')
    } catch (err) {
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(400).send(error('That file is too large.', 'FILE_TOO_LARGE'))
      return sendBusinessError(reply, err, BusinessError)
    }
  })
  fastify.get('/template', { preValidation: requireBusiness(BIZ_PERM.CATALOG_BULK), config: { requiredPermission: BIZ_PERM.CATALOG_BULK } }, async (request, reply) =>
    reply.header('Content-Type', XLSX).header('Content-Disposition', 'attachment; filename="bakaloo-catalog-template.xlsx"').send(await service.template()))
  fastify.get('/export', { schema: S.exportSchema, preValidation: requireBusiness(BIZ_PERM.CATALOG_BULK), config: { requiredPermission: BIZ_PERM.CATALOG_BULK } }, async (request, reply) =>
    reply.header('Content-Type', XLSX).header('Content-Disposition', 'attachment; filename="bakaloo-catalog.xlsx"').send(await service.exportCatalog(request.query)))
}
