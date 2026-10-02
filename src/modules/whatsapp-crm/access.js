import { query } from '../../config/database.js'
import { error } from '../../utils/apiResponse.js'

/**
 * CRM permissions (free-form strings in roles.permissions, see migration 142).
 * HQ SUPER_ADMIN / ADMIN (users.platform_role) always pass — their role rows
 * hold the canonical 37 strings and have no crm.* entries.
 */
export const CRM_PERM = Object.freeze({
  INBOX_VIEW: 'crm.inbox.view',
  INBOX_VIEW_ALL: 'crm.inbox.view_all',
  INBOX_REPLY: 'crm.inbox.reply',
  LABELS_APPLY: 'crm.labels.apply',
  LABELS_MANAGE: 'crm.labels.manage',
  ASSIGN: 'crm.conversations.assign',
  WORKLOAD_VIEW: 'crm.workload.view',
  PIPELINE_VIEW: 'crm.pipeline.view',
  PIPELINE_MOVE: 'crm.pipeline.move',
  BOT_MANAGE: 'crm.bot.manage',
  TEMPLATES_VIEW: 'crm.templates.view',
  TEMPLATES_SEND: 'crm.templates.send',
  TEMPLATES_MANAGE: 'crm.templates.manage',
  CAMPAIGNS_VIEW: 'crm.campaigns.view',
  CAMPAIGNS_MANAGE: 'crm.campaigns.manage',
  WORKFLOWS_MANAGE: 'crm.workflows.manage',
  ANALYTICS_VIEW: 'crm.analytics.view',
  RATES_MANAGE: 'crm.rates.manage',
  SETTINGS_MANAGE: 'crm.settings.manage',
})

const HQ_BYPASS = new Set(['SUPER_ADMIN', 'ADMIN'])

/** @returns {Promise<{ userId: string, isSuper: boolean, has: (p: string) => boolean }>} */
export async function loadCrmAccess(userId) {
  const { rows } = await query(
    `SELECT u.platform_role, u.role_id, r.is_system AS role_is_system, COALESCE(r.permissions, '[]'::jsonb) AS permissions
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.is_active = true`,
    [userId],
  )
  const row = rows[0]
  // Every team member signs in as platform ADMIN, so ADMIN alone cannot mean "everything": someone given a custom
  // role is governed by that role. HQ levels with no role (or a built-in one) keep full access.
  const hasCustomRole = Boolean(row?.role_id) && row?.role_is_system === false
  const isSuper = HQ_BYPASS.has(row?.platform_role) && !hasCustomRole
  const perms = new Set(Array.isArray(row?.permissions) ? row.permissions : [])
  return { userId, isSuper, has: (p) => Boolean(row) && (isSuper || perms.has(p)) }
}

/** preHandler factory. Runs after authenticate + requireAdmin. Attaches request.crm. */
export function requireCrm(permission) {
  return async function crmGuard(request, reply) {
    const access = await loadCrmAccess(request.user.id)
    request.crm = access
    if (!access.has(permission)) {
      return reply.code(403).send(error(`Forbidden — requires '${permission}' permission`, 'PERMISSION_DENIED'))
    }
  }
}

/** Agents without view_all only see conversations that are theirs or unassigned. */
export function canAccessConversation(access, conversation) {
  if (access.has(CRM_PERM.INBOX_VIEW_ALL)) return true
  return !conversation.assigned_to || conversation.assigned_to === access.userId
}
