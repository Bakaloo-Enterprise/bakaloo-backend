const SECTION_TYPES = [
  'animated_banner',
  'fee_strip',
  'seasonal_mosaic',
  'round_category_icons',
  'category_product_grid',
  'product_carousel',
  'trending_products',
  'promo_carousel',
  'bank_offers',
  'arched_product_showcase',
  'custom_banner',
  'text_header',
  'spacer',
]

const merchBindingSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    category_ids: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      default: [],
    },
    product_ids: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      default: [],
    },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    source: { type: 'string', enum: ['category', 'tag', 'manual'] },
    tags: {
      type: 'array',
      items: { type: 'string' },
      default: [],
    },
  },
}

const audienceQuerystring = {
  type: 'object',
  properties: {
    audience: { type: 'string', enum: ['B2C', 'B2B'], default: 'B2C' },
  },
}

export const tabIdSchema = {
  params: {
    type: 'object',
    required: ['tabId'],
    properties: {
      tabId: { type: 'string', format: 'uuid' },
    },
  },
  querystring: audienceQuerystring,
}

export const sectionIdSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const createSectionSchema = {
  params: tabIdSchema.params,
  body: {
    type: 'object',
    required: ['section_type'],
    properties: {
      section_type: { type: 'string', enum: SECTION_TYPES },
      config: { type: 'object' },
      visible: { type: 'boolean', default: true },
      merch_binding: merchBindingSchema,
      audience: { type: 'string', enum: ['B2C', 'B2B'], default: 'B2C' },
    },
  },
}

export const updateSectionSchema = {
  params: sectionIdSchema.params,
  body: {
    type: 'object',
    properties: {
      section_type: { type: 'string', enum: SECTION_TYPES },
      config: { type: 'object' },
      visible: { type: 'boolean' },
    },
  },
}

export const updateMerchSchema = {
  params: sectionIdSchema.params,
  body: merchBindingSchema,
}

export const reorderSectionsSchema = {
  params: tabIdSchema.params,
  querystring: audienceQuerystring,
  body: {
    type: 'object',
    required: ['order'],
    properties: {
      order: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
      },
    },
  },
}

export const rollbackSchema = {
  params: tabIdSchema.params,
  body: {
    type: 'object',
    required: ['version_id'],
    properties: {
      version_id: { type: 'string', format: 'uuid' },
    },
  },
}

export const scheduleSchema = {
  params: tabIdSchema.params,
  querystring: audienceQuerystring,
  body: {
    type: 'object',
    required: ['scheduled_at'],
    properties: {
      scheduled_at: { type: 'string', format: 'date-time' },
    },
  },
}

export const copyToB2BSchema = {
  params: tabIdSchema.params,
}

export const copyToB2CSchema = {
  params: tabIdSchema.params,
}
