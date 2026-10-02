const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } }
const lineParams = { type: 'object', required: ['id', 'lineId'], properties: { id: uuid, lineId: uuid } }
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }

// NOTE: the app runs AJV with removeAdditional:'all' — fields not declared here are dropped.

export const orderIdSchema = { params: idParams }
export const assignPersonSchema = { params: idParams, body: { type: 'object', required: ['role', 'userId'], properties: { role: { type: 'string', enum: ['PICKER', 'PACKER'] }, userId: uuid } } }
export const scanSchema = { params: idParams, body: { type: 'object', required: ['stage', 'code'], properties: { stage: { type: 'string', enum: ['PICK', 'PACK'] }, code: { type: 'string', minLength: 1, maxLength: 120 } } } }
export const confirmLineSchema = { params: lineParams, body: { type: 'object', required: ['stage'], properties: { stage: { type: 'string', enum: ['PICK', 'PACK'] }, qty: { type: 'integer', minimum: 1, maximum: 1000 } } } }
export const missingSchema = { params: lineParams, body: { type: 'object', properties: { note: { type: 'string', maxLength: 300 } } } }
export const decisionSchema = { params: lineParams, body: { type: 'object', required: ['decision'], properties: { decision: { type: 'string', enum: ['REPLACE', 'REMOVE', 'REFUND'] }, note: { type: 'string', maxLength: 300 } } } }
export const finishPackSchema = { params: idParams, body: { type: 'object', properties: { packageCount: { type: 'integer', minimum: 1, maximum: 20 } } } }
export const riderSchema = { params: idParams, body: { type: 'object', required: ['riderId'], properties: { riderId: uuid } } }
export const staffStationSchema = { params: { type: 'object', required: ['userId'], properties: { userId: uuid } }, body: { type: 'object', required: ['station'], properties: { station: { type: ['string', 'null'], enum: ['PICKER', 'PACKER', null] } } } }
export const printerIdSchema = { params: idParams }
export const addPrinterSchema = { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2, maxLength: 80 }, paperMm: { type: 'integer', enum: [58, 80, 210] }, isDefault: { type: 'boolean' } } } }
export const updatePrinterSchema = { params: idParams, body: { type: 'object', properties: { name: { type: 'string', minLength: 2, maxLength: 80 }, paperMm: { type: 'integer', enum: [58, 80, 210] }, isDefault: { type: 'boolean' } } } }
export const jobsSchema = { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['QUEUED', 'PRINTING', 'PRINTED', 'FAILED', 'CANCELLED'] }, printerId: uuid, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } } }
export const jobIdSchema = { params: idParams }
export const jobResultSchema = { params: idParams, body: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, error: { type: 'string', maxLength: 300 } } } }
export const resolveAttentionSchema = { body: { type: 'object', required: ['orderId', 'kind'], properties: { orderId: uuid, kind: { type: 'string', maxLength: 24 }, ref: { type: 'string', maxLength: 80 }, note: { type: 'string', maxLength: 300 } } } }
export const performanceSchema = { querystring: { type: 'object', properties: { from: date, to: date } } }
