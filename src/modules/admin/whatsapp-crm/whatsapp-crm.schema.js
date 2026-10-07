const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
const uuid = { type: 'string', pattern: uuidPattern }
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } }

// NOTE: the app runs AJV with removeAdditional:'all' — any query/body field not
// declared below is silently dropped before the handler sees it.

export const listConversationsSchema = {
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['OPEN', 'PENDING', 'RESOLVED'] },
      // a user id, or the literals "unassigned" / "me"
      assignedTo: { type: 'string', maxLength: 36 },
      labelId: uuid,
      search: { type: 'string', maxLength: 100 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
  },
}

export const conversationIdSchema = { params: idParams }
export const customerUserSchema = { params: { type: 'object', required: ['userId'], properties: { userId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } } }

export const listMessagesSchema = {
  params: idParams,
  querystring: {
    type: 'object',
    properties: {
      before: { type: 'string', format: 'date-time' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    },
  },
}

export const sendMessageSchema = {
  params: idParams,
  body: {
    type: 'object',
    required: ['body'],
    properties: {
      body: { type: 'string', minLength: 1, maxLength: 4096 },
      replyToWamid: { type: 'string', maxLength: 255 },
    },
  },
}

export const assignSchema = {
  params: idParams,
  body: {
    type: 'object',
    required: ['userId'],
    // null = unassign
    properties: { userId: { anyOf: [uuid, { type: 'null' }] } },
  },
}

export const bulkAssignSchema = {
  body: {
    type: 'object',
    required: ['conversationIds', 'userId'],
    properties: {
      conversationIds: { type: 'array', items: uuid, minItems: 1, maxItems: 200 },
      userId: { anyOf: [uuid, { type: 'null' }] },
    },
  },
}

const colorProp = { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' }

export const createLabelSchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 40 },
      color: colorProp,
      description: { type: 'string', maxLength: 200 },
    },
  },
}

export const updateLabelSchema = {
  params: idParams,
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 40 },
      color: colorProp,
      description: { type: 'string', maxLength: 200 },
    },
  },
}

export const labelIdSchema = { params: idParams }

export const addConversationLabelSchema = {
  params: idParams,
  body: { type: 'object', required: ['labelId'], properties: { labelId: uuid } },
}

export const removeConversationLabelSchema = {
  params: {
    type: 'object',
    required: ['id', 'labelId'],
    properties: { id: uuid, labelId: uuid },
  },
}

export const pipelineBoardSchema = {
  querystring: {
    type: 'object',
    properties: {
      assignedTo: { type: 'string', maxLength: 36 }, // user id, "me" or "unassigned"
      labelId: uuid,
      b2b: { type: 'string', enum: ['B2B', 'B2C'] },
      search: { type: 'string', maxLength: 100 },
    },
  },
}

export const contactIdSchema = {
  params: { type: 'object', required: ['contactId'], properties: { contactId: uuid } },
}

export const moveCardSchema = {
  params: { type: 'object', required: ['contactId'], properties: { contactId: uuid } },
  body: { type: 'object', required: ['stageId'], properties: { stageId: uuid } },
}

const kwList = (max) => ({ type: 'array', items: { type: 'string', minLength: 1, maxLength: 80 }, maxItems: max })
const ruleProps = {
  name: { type: 'string', minLength: 1, maxLength: 80 },
  matchType: { type: 'string', enum: ['CONTAINS', 'EXACT', 'STARTS_WITH', 'PINCODE'] },
  keywords: kwList(60),
  exactKeywords: kwList(30),
  whenHours: { type: 'string', enum: ['ANY', 'OPEN', 'CLOSED'] },
  action: { type: 'string', enum: ['REPLY', 'REPLY_HANDOFF', 'HANDOFF', 'OPT_OUT', 'OPT_IN'] },
  replyText: { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'null' }] },
  cooldownMinutes: { type: 'integer', minimum: 0, maximum: 1440 },
  isActive: { type: 'boolean' },
}

export const createBotRuleSchema = { body: { type: 'object', required: ['name', 'matchType'], properties: ruleProps } }
export const updateBotRuleSchema = { params: idParams, body: { type: 'object', properties: ruleProps } }
export const botRuleIdSchema = { params: idParams }
export const reorderBotRulesSchema = {
  body: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: uuid, minItems: 1, maxItems: 200 } } },
}
export const updateBotSettingsSchema = {
  body: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      humanPauseMinutes: { type: 'integer', minimum: 5, maximum: 10080 },
      maxRepliesPerHour: { type: 'integer', minimum: 1, maximum: 60 },
      fallbackEnabled: { type: 'boolean' },
      fallbackText: { type: 'string', maxLength: 1000 },
    },
  },
}
export const testBotSchema = {
  body: {
    type: 'object',
    required: ['message'],
    properties: {
      message: { type: 'string', minLength: 1, maxLength: 500 },
      when: { type: 'string', enum: ['NOW', 'OPEN', 'CLOSED'] },
    },
  },
}
export const botActivitySchema = {
  querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } },
}
export const setConversationBotSchema = {
  params: idParams,
  body: { type: 'object', required: ['state'], properties: { state: { type: 'string', enum: ['BOT', 'HUMAN'] } } },
}

// ─── Templates (Phase 6) ─────────────────────────────────────────────
// `examples` / `values` have DYNAMIC keys (variable names). AJV runs with removeAdditional:'all', which would
// silently strip them — so the key pattern is declared explicitly.
const stringMap = (keyPattern, max) => ({
  type: 'object',
  patternProperties: { [keyPattern]: { type: 'string', maxLength: max } },
  additionalProperties: false,
})

const templateProps = {
  name: { type: 'string', maxLength: 512 },
  language: { type: 'string', maxLength: 20 },
  metaCategory: { type: 'string', enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'] },
  purpose: { type: 'string', maxLength: 30 },
  headerText: { type: 'string', maxLength: 200 },
  headerFormat: { type: 'string', enum: ['IMAGE', 'VIDEO', 'DOCUMENT'] },
  headerHandle: { type: 'string', maxLength: 600 },
  bodyText: { type: 'string', maxLength: 3000 },
  footerText: { type: 'string', maxLength: 200 },
  allowCategoryChange: { type: 'boolean' },
  buttons: {
    type: 'array',
    maxItems: 12,
    items: {
      type: 'object',
      properties: {
        type: { type: 'string', maxLength: 20 },
        text: { type: 'string', maxLength: 100 },
        url: { type: 'string', maxLength: 2100 },
        phoneNumber: { type: 'string', maxLength: 40 },
      },
    },
  },
  examples: stringMap('^[a-z_]+$', 300),
}

export const listTemplatesSchema = {
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', maxLength: 20 },
      metaCategory: { type: 'string', enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'] },
      purpose: { type: 'string', maxLength: 30 },
      search: { type: 'string', maxLength: 100 },
    },
  },
}
export const createTemplateSchema = { body: { type: 'object', required: ['name'], properties: templateProps } }
export const updateTemplateSchema = { params: idParams, body: { type: 'object', properties: templateProps } }
export const headerSampleSchema = { body: { type: 'object', required: ['url'], properties: { url: { type: 'string', maxLength: 2000 }, format: { type: 'string', enum: ['IMAGE', 'VIDEO', 'DOCUMENT'] } } } }
export const templateIdSchema = { params: idParams }
export const sendTemplateSchema = {
  params: idParams,
  body: {
    type: 'object',
    required: ['templateId'],
    properties: {
      templateId: uuid,
      values: stringMap('^[a-z0-9_.]+$', 1100),
      headerMediaUrl: { type: 'string', maxLength: 2000 },
    },
  },
}

// ─── Campaigns, consent, suppression, workflows (Phase 7) ─────────────
const campaignProps = {
  name: { type: 'string', maxLength: 120 },
  templateId: uuid,
  templateValues: stringMap('^[a-z0-9_.]+$', 500),
  headerMediaUrl: { type: 'string', maxLength: 2000 },
  headerImageSource: { type: ['object', 'null'], additionalProperties: true },
  ratePerMinute: { type: 'integer', minimum: 1, maximum: 600 },
  audience: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['SEGMENT', 'LABEL', 'STAGE', 'IMPORT', 'ALL_OPTED_IN'] },
      ids: { type: 'array', maxItems: 20, items: uuid },
    },
  },
}
export const listCampaignsSchema = {
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED', 'COMPLETED', 'CANCELLED'] },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
  },
}
export const createCampaignSchema = { body: { type: 'object', required: ['name', 'templateId', 'audience'], properties: campaignProps } }
export const updateCampaignSchema = { params: idParams, body: { type: 'object', properties: campaignProps } }
export const campaignIdSchema = { params: idParams }
export const launchCampaignSchema = {
  params: idParams,
  body: { type: 'object', properties: { scheduledAt: { type: 'string', format: 'date-time' } } },
}
export const campaignRecipientsSchema = {
  params: idParams,
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED'] },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
  },
}
export const recordConsentSchema = {
  body: {
    type: 'object',
    required: ['phones', 'source', 'confirm'],
    properties: {
      phones: { type: 'array', maxItems: 5000, items: { type: 'string', maxLength: 20 } },
      source: { type: 'string', maxLength: 40 },
      confirm: { type: 'boolean' },
    },
  },
}
export const listSuppressionSchema = {
  querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 }, offset: { type: 'integer', minimum: 0, default: 0 } } },
}
export const suppressSchema = {
  params: { type: 'object', required: ['contactId'], properties: { contactId: uuid } },
  body: { type: 'object', properties: { reason: { type: 'string', maxLength: 200 } } },
}
export const unsuppressSchema = { params: { type: 'object', required: ['contactId'], properties: { contactId: uuid } } }

const workflowProps = {
  name: { type: 'string', maxLength: 120 },
  description: { type: 'string', maxLength: 300 },
  triggerType: { type: 'string', enum: ['CART_ABANDONED', 'ORDER_STATUS'] },
  triggerConfig: {
    type: 'object',
    properties: { delayMinutes: { type: 'integer', minimum: 1, maximum: 1440 }, status: { type: 'string', maxLength: 30 } },
  },
  conditions: {
    type: 'array',
    maxItems: 5,
    items: {
      type: 'object',
      properties: {
        field: { type: 'string', maxLength: 30 },
        op: { type: 'string', maxLength: 5 },
        value: { type: ['string', 'number'] },
      },
    },
  },
  actions: {
    type: 'array',
    maxItems: 3,
    items: {
      type: 'object',
      properties: {
        type: { type: 'string', maxLength: 20 },
        templateId: uuid,
        labelId: uuid,
        couponId: uuid,
        imageSource: { type: ['object', 'null'], additionalProperties: true },
        values: stringMap('^[a-z0-9_.]+$', 500),
      },
    },
  },
}
export const createWorkflowSchema = { body: { type: 'object', required: ['name', 'triggerType', 'actions'], properties: workflowProps } }
export const updateWorkflowSchema = { params: idParams, body: { type: 'object', properties: workflowProps } }
export const workflowIdSchema = { params: idParams }
export const activateWorkflowSchema = { params: idParams, body: { type: 'object', required: ['active'], properties: { active: { type: 'boolean' } } } }

// ─── Prospect imports (Phase 8) ───────────────────────────────────────
export const importIdSchema = { params: idParams }
export const importRowsSchema = {
  params: idParams,
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['NEW', 'EXISTING_CONTACT', 'EXISTING_CUSTOMER', 'INVALID', 'DUPLICATE', 'OPTED_OUT', 'SUPPRESSED'] },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
  },
}
export const confirmImportSchema = {
  params: idParams,
  body: {
    type: 'object',
    required: ['confirm', 'source'],
    properties: { confirm: { type: 'boolean' }, source: { type: 'string', maxLength: 30 }, includeExisting: { type: 'boolean' } },
  },
}

// ─── Analytics and cost (Phase 10) ────────────────────────────────────
const dateString = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const rangeProps = { from: dateString, to: dateString, attributionDays: { type: 'integer', minimum: 1, maximum: 30 } }
export const analyticsRangeSchema = { querystring: { type: 'object', properties: rangeProps } }
export const analyticsBreakdownSchema = {
  params: { type: 'object', required: ['by'], properties: { by: { type: 'string', enum: ['campaign', 'workflow', 'template'] } } },
  querystring: { type: 'object', properties: rangeProps },
}
export const addRateCardSchema = {
  body: {
    type: 'object',
    required: ['category', 'rate', 'effectiveFrom'],
    properties: { category: { type: 'string', maxLength: 14 }, rate: { type: 'number' }, effectiveFrom: dateString, note: { type: 'string', maxLength: 200 } },
  },
}
export const rateCardIdSchema = { params: idParams }

// WhatsApp connection settings. Only the declared fields survive (AJV removeAdditional:'all').
export const saveSettingsSchema = {
  body: {
    type: 'object',
    properties: {
      phoneNumberId: { type: 'string', maxLength: 40 },
      wabaId: { type: 'string', maxLength: 40 },
      appId: { type: 'string', maxLength: 40 },
      accessToken: { type: 'string', maxLength: 1500 },
      appSecret: { type: 'string', maxLength: 100 },
      verifyToken: { type: 'string', maxLength: 120 },
      generateVerifyToken: { type: 'boolean' },
      enabled: { type: 'boolean' },
      clear: { type: 'array', maxItems: 3, items: { type: 'string', enum: ['accessToken', 'verifyToken', 'appSecret'] } },
    },
  },
}
export const testSettingsSchema = { body: { type: 'object', properties: { sendTo: { type: 'string', maxLength: 20 } } } }
export const enableSettingsSchema = { body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } } }

export const messageMediaSchema = {
  params: {
    type: 'object',
    required: ['id', 'messageId'],
    properties: { id: uuid, messageId: uuid },
  },
}
