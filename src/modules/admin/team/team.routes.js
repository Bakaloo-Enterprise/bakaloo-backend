import { TeamController } from './team.controller.js'
import { query } from '../../../config/database.js'
import {
    createRoleSchema,
    updateRoleSchema,
    deleteRoleSchema,
    inviteMemberSchema,
    updateMemberSchema,
    removeMemberSchema,
} from './team.schema.js'

const ctrl = new TeamController()

/**
 * Who may SEE the team and roles lists: developers, platform Super Admins, or anyone whose role has team.view /
 * team.manage (the built-in "Super Admin" role has both). Every team member signs in as platform ADMIN, so ADMIN by
 * itself must NOT be enough — before this, any signed-in admin, even one whose role grants nothing, could read every
 * member's email and role.
 */
function requireTeamView(fastify) {
    return async function teamViewGuard(request, reply) {
        const { rows } = await query(
            `SELECT u.platform_role, (u.is_developer AND u.is_active) AS is_developer, COALESCE(r.permissions, '[]'::jsonb) AS permissions
               FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.is_active = true`,
            [request.user.id],
        )
        const me = rows[0]
        const perms = Array.isArray(me?.permissions) ? me.permissions : []
        const ok = me && (me.is_developer === true || me.platform_role === 'SUPER_ADMIN' || perms.includes('team.view') || perms.includes('team.manage'))
        if (!ok) {
            return reply.code(403).send({ success: false, message: "Forbidden — requires 'team.view' permission", code: 'PERMISSION_DENIED' })
        }
    }
}

/**
 * Roles routes — prefix: /roles
 * GET  /          — team.view (list all roles)
 * POST /          — team.manage (create role)
 * PATCH /:id      — team.manage (update role)
 * DELETE /:id     — team.manage (delete role)
 */
export async function roleRoutes(fastify) {
    const auth = [fastify.authenticate, fastify.requireAdmin]
    const authManage = [...auth, fastify.requirePermission('team.manage')]

    fastify.get('/', { preHandler: [...auth, requireTeamView(fastify)] }, ctrl.listRoles.bind(ctrl))

    fastify.post('/', {
        schema: createRoleSchema,
        preHandler: authManage,
    }, ctrl.createRole.bind(ctrl))

    fastify.patch('/:id', {
        schema: updateRoleSchema,
        preHandler: authManage,
    }, ctrl.updateRole.bind(ctrl))

    fastify.delete('/:id', {
        schema: deleteRoleSchema,
        preHandler: authManage,
    }, ctrl.deleteRole.bind(ctrl))
}

/**
 * Team routes — prefix: /team
 * GET  /                 — team.view (list members)
 * POST /invite           — team.manage (invite)
 * PATCH /:id             — team.manage (update)
 * DELETE /:id            — team.manage (remove)
 * POST /:id/reset-password — team.manage (reset to a fresh temp password)
 */
export async function teamRoutes(fastify) {
    const auth = [fastify.authenticate, fastify.requireAdmin]
    const authManage = [...auth, fastify.requirePermission('team.manage')]

    fastify.get('/', { preHandler: [...auth, requireTeamView(fastify)] }, ctrl.listMembers.bind(ctrl))

    fastify.post('/invite', {
        schema: inviteMemberSchema,
        preHandler: authManage,
    }, ctrl.inviteMember.bind(ctrl))

    fastify.patch('/:id', {
        schema: updateMemberSchema,
        preHandler: authManage,
    }, ctrl.updateMember.bind(ctrl))

    fastify.delete('/:id', {
        schema: removeMemberSchema,
        preHandler: authManage,
    }, ctrl.removeMember.bind(ctrl))

    fastify.post('/:id/reset-password', {
        preHandler: authManage,
    }, ctrl.resetMemberPassword.bind(ctrl))
}
