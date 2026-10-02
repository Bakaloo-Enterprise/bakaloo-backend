import { TeamRepository } from './team.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { generateTempPassword } from '../../../utils/tempPassword.js'
import bcrypt from 'bcrypt'
import { query } from '../../../config/database.js'
import { isDeveloper } from '../../features/feature-access.js'

const repo = new TeamRepository()

/**
 * A Developer Super Admin is the superior role: nobody else may change, deactivate or reset the password of one
 * (that would be a way to take the account over). Only another developer can.
 */
async function assertNotProtectedDeveloper(targetId, callerId) {
    const { rows } = await query(`SELECT is_developer FROM users WHERE id = $1`, [targetId])
    if (rows[0]?.is_developer === true && !(await isDeveloper(callerId))) {
        throw { statusCode: 403, code: 'DEVELOPER_PROTECTED', message: 'Only a Developer Super Admin can change a developer account.' }
    }
}

/**
 * The dashboard only lets two kinds of people in: platform ADMIN / SUPER_ADMIN (all shops) and shop staff. The lower HQ
 * levels (HQ_FINANCE / HQ_MANAGER / HQ_SUPPORT) are refused at login with "No shop assigned", so nobody may be given them here.
 */
const DASHBOARD_LEVELS = new Set(['SUPER_ADMIN', 'ADMIN'])
const NO_DASHBOARD_LEVELS = new Set(['HQ_FINANCE', 'HQ_MANAGER', 'HQ_SUPPORT'])
const DEFAULT_LEVEL = 'ADMIN' // custom roles sign in as ADMIN; the role then decides the newer modules

const fail = (statusCode, code, message) => { throw { statusCode, code, message } }

/** Built-in roles are named after the login level they stand for ("Super Admin" = SUPER_ADMIN, "ADMIN" = ADMIN). */
function systemLevelOf(role) {
    if (!role?.is_system) return null
    const level = String(role.name).trim().toUpperCase().replace(/\s+/g, '_')
    if (NO_DASHBOARD_LEVELS.has(level)) {
        fail(400, 'ROLE_CANNOT_SIGN_IN', `The built-in role ${role.name} cannot sign in to the dashboard yet. Choose Admin, Super Admin or a custom role.`)
    }
    return DASHBOARD_LEVELS.has(level) ? level : null
}

/**
 * Nobody may hand out more power than they hold themselves — otherwise anyone with "manage team" could create a
 * role with every permission and give it to themselves. Developers, platform Super Admins and holders of the built-in
 * "Super Admin" role are unrestricted.
 */
async function assertCanGrant(callerId, permissions, role = null) {
    const me = await repo.findAccessOf(callerId)
    if (!me) fail(403, 'FORBIDDEN', 'Your account was not found.')
    const unrestricted = me.is_developer === true || me.platform_role === 'SUPER_ADMIN' || (me.role_is_system === true && String(me.role_name).toLowerCase() === 'super admin')
    if (unrestricted) return
    if (role && systemLevelOf(role)) fail(403, 'ESCALATION_BLOCKED', 'Only a Super Admin can assign a built-in Admin or Super Admin role.')
    const mine = new Set(Array.isArray(me.permissions) ? me.permissions : [])
    const extra = (permissions || []).filter((p) => !mine.has(p))
    if (extra.length > 0) fail(403, 'ESCALATION_BLOCKED', `You cannot grant permissions you do not have yourself: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? '…' : ''}`)
}

async function requireRole(roleId) {
    const role = await repo.findRoleById(roleId)
    if (!role) fail(400, 'ROLE_NOT_FOUND', 'That role does not exist.')
    return role
}

function cleanRoleName(name) {
    const n = String(name ?? '').trim()
    if (!n) fail(400, 'VALIDATION_ERROR', 'Role name is required.')
    return n
}

export class TeamService {
    /* ── Roles ── */

    async listRoles() {
        return repo.findAllRoles()
    }

    async getRole(id) {
        return repo.findRoleById(id)
    }

    async createRole(data, adminId, ip) {
        const name = cleanRoleName(data.name)
        if (await repo.findRoleByName(name)) fail(409, 'ROLE_NAME_TAKEN', `A role named "${name}" already exists.`)
        await assertCanGrant(adminId, data.permissions)
        const role = await repo.createRole({ ...data, name })
        logAdminActivity(adminId, 'CREATE_ROLE', 'role', role.id, null, { name: data.name }, ip)
        return role
    }

    async updateRole(id, data, adminId, ip) {
        if (data.name !== undefined) {
            data = { ...data, name: cleanRoleName(data.name) }
            if (await repo.findRoleByName(data.name, id)) fail(409, 'ROLE_NAME_TAKEN', `A role named "${data.name}" already exists.`)
        }
        if (data.permissions !== undefined) await assertCanGrant(adminId, data.permissions)
        const role = await repo.updateRole(id, data)
        if (role) {
            logAdminActivity(adminId, 'UPDATE_ROLE', 'role', id, null, { name: data.name }, ip)
        }
        return role
    }

    async deleteRole(id, adminId, ip) {
        const inUse = await repo.countMembersWithRole(id)
        if (inUse > 0) fail(409, 'ROLE_IN_USE', `${inUse} team member${inUse === 1 ? '' : 's'} still use${inUse === 1 ? 's' : ''} this role. Move them to another role first.`)
        const ok = await repo.deleteRole(id)
        if (ok) {
            logAdminActivity(adminId, 'DELETE_ROLE', 'role', id, null, null, ip)
        }
        return ok
    }

    /* ── Team Members ── */

    async listMembers() {
        return repo.findAllMembers()
    }

    async inviteMember(data, adminId, ip) {
        const email = String(data.email).trim().toLowerCase()
        if (await repo.findByEmail(email)) fail(409, 'EMAIL_TAKEN', 'A user with this email already exists')
        const phone = data.phone ? String(data.phone).trim() : null
        if (phone && (await repo.findByPhone(phone))) fail(409, 'PHONE_TAKEN', 'A user with this phone number already exists')

        const role = await requireRole(data.role_id)
        await assertCanGrant(adminId, role.permissions, role)

        const passwordHash = await bcrypt.hash(data.password, 12)
        const user = await repo.inviteMember({
            name: data.name.trim(),
            email,
            phone,
            roleId: data.role_id,
            passwordHash,
            platformRole: systemLevelOf(role) ?? DEFAULT_LEVEL,
        })

        // Fetch full member record with role info
        const member = await repo.findMemberById(user.id)
        logAdminActivity(adminId, 'INVITE_MEMBER', 'user', user.id, null, { email: data.email }, ip)
        return member
    }

    async updateMember(id, data, adminId, ip) {
        await assertNotProtectedDeveloper(id, adminId)
        let platformRole
        if (data.role_id !== undefined) {
            const role = await requireRole(data.role_id)
            await assertCanGrant(adminId, role.permissions, role)
            // Keep the login level in step with the role, but never demote someone and never turn shop staff into HQ users.
            const current = await repo.findPlatformRole(id)
            const level = systemLevelOf(role)
            if (level) platformRole = level
            else if (!current && !(await repo.isShopStaff(id))) platformRole = DEFAULT_LEVEL
        }
        const member = await repo.updateMember(id, {
            roleId: data.role_id,
            isActive: data.is_active,
            platformRole,
        })
        if (member) {
            logAdminActivity(adminId, 'UPDATE_MEMBER', 'user', id, null, data, ip)
        }
        return member
    }

    async removeMember(id, adminId, ip) {
        await assertNotProtectedDeveloper(id, adminId)
        const ok = await repo.removeMember(id)
        if (ok) {
            logAdminActivity(adminId, 'REMOVE_MEMBER', 'user', id, null, null, ip)
        }
        return ok
    }

    /**
     * Reset a team member's password to a freshly generated temp password
     * (never a caller-supplied value — avoids weak human-chosen passwords).
     * The plaintext is returned exactly once; it is never logged. The member
     * must change it on next login (force_password_change) and every prior
     * JWT they held is invalidated immediately (session_version bump).
     */
    async resetMemberPassword(id, adminId, ip) {
        await assertNotProtectedDeveloper(id, adminId)
        const member = await repo.findMemberById(id)
        if (!member) return null

        const tempPassword = generateTempPassword()
        const passwordHash = await bcrypt.hash(tempPassword, 12)

        const ok = await repo.resetPassword(id, passwordHash)
        if (!ok) return null

        // Never pass the password/hash into the activity log payload.
        logAdminActivity(adminId, 'RESET_MEMBER_PASSWORD', 'user', id, null, null, ip)
        return { temp_password: tempPassword }
    }
}
