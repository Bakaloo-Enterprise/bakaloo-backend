const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } }

// NOTE: the app runs AJV with removeAdditional:'all' — any field not declared here is dropped.

export const peopleSchema = {
  querystring: { type: 'object', properties: { search: { type: 'string', maxLength: 60 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } } },
}
export const listChannelsSchema = { querystring: { type: 'object', properties: { archived: { type: 'boolean', default: false } } } }
export const channelIdSchema = { params: idParams }
export const createChannelSchema = {
  body: {
    type: 'object',
    required: ['kind'],
    properties: {
      kind: { type: 'string', enum: ['DM', 'GROUP', 'CHANNEL'] },
      userId: uuid,
      name: { type: 'string', maxLength: 80 },
      description: { type: 'string', maxLength: 300 },
      memberIds: { type: 'array', items: uuid, maxItems: 100 },
      audience: { type: 'object', properties: { hq: { type: 'boolean' }, shopIds: { type: 'array', items: uuid, maxItems: 50 } } },
    },
  },
}
export const updateChannelSchema = {
  params: idParams,
  body: { type: 'object', properties: { name: { type: 'string', maxLength: 80 }, description: { type: 'string', maxLength: 300 } } },
}
export const addMembersSchema = {
  params: idParams,
  body: { type: 'object', required: ['userIds'], properties: { userIds: { type: 'array', items: uuid, minItems: 1, maxItems: 100 } } },
}
export const removeMemberSchema = { params: { type: 'object', required: ['id', 'userId'], properties: { id: uuid, userId: uuid } } }
export const listMessagesSchema = {
  params: idParams,
  querystring: { type: 'object', properties: { before: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } } },
}
export const sendMessageSchema = {
  params: idParams,
  body: {
    type: 'object',
    properties: {
      body: { type: 'string', maxLength: 4500 },
      mentions: { type: 'array', items: uuid, maxItems: 50 },
      ref: { type: 'object', required: ['type', 'id'], properties: { type: { type: 'string', enum: ['ORDER', 'PRODUCT', 'CUSTOMER'] }, id: uuid } },
    },
  },
}
export const messageIdSchema = { params: { type: 'object', required: ['id', 'messageId'], properties: { id: uuid, messageId: uuid } } }
export const refsSchema = {
  querystring: { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: ['ORDER', 'PRODUCT', 'CUSTOMER'] }, q: { type: 'string', maxLength: 60 } } },
}
