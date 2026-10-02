// NOTE: the app runs AJV with removeAdditional:'all' — fields not declared here are dropped.
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } }

export const idSchema = { params: idParams }
export const rowsSchema = { params: idParams, querystring: { type: 'object', properties: { status: { type: 'string', enum: ['VALID', 'ERROR', 'UNCHANGED'] }, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 } } } }
export const applySchema = { params: idParams, body: { type: 'object', properties: { confirm: { type: 'boolean' }, skipErrors: { type: 'boolean' } } } }
export const exportSchema = { querystring: { type: 'object', properties: { shopId: uuid } } }
export const availabilitySchema = {
  body: {
    type: 'object', required: ['action', 'productIds', 'shopIds'],
    properties: {
      action: { type: 'string', enum: ['ENABLE', 'DISABLE', 'ASSIGN'] },
      productIds: { type: 'array', minItems: 1, maxItems: 2000, items: uuid }, shopIds: { type: 'array', minItems: 1, maxItems: 200, items: uuid }, dryRun: { type: 'boolean' },
    },
  },
}
