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

export class TeamService {
    /* ── Roles ── */

    async listRoles() {
        return repo.findAllRoles()
    }

    async getRole(id) {
        return repo.findRoleById(id)
    }

    async createRole(data, adminId, ip) {
        const role = await repo.createRole(data)
        logAdminActivity(adminId, 'CREATE_ROLE', 'role', role.id, null, { name: data.name }, ip)
        return role
    }

    async updateRole(id, data, adminId, ip) {
        const role = await repo.updateRole(id, data)
        if (role) {
            logAdminActivity(adminId, 'UPDATE_ROLE', 'role', id, null, { name: data.name }, ip)
        }
        return role
    }

    async deleteRole(id, adminId, ip) {
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
        // Check duplicate email
        const existing = await repo.findByEmail(data.email)
        if (existing) {
            const err = new Error('A user with this email already exists')
            err.statusCode = 409
            throw err
        }

        const passwordHash = await bcrypt.hash(data.password, 12)
        const user = await repo.inviteMember({
            name: data.name,
            email: data.email,
            phone: data.phone,
            roleId: data.role_id,
            passwordHash,
        })

        // Fetch full member record with role info
        const member = await repo.findMemberById(user.id)
        logAdminActivity(adminId, 'INVITE_MEMBER', 'user', user.id, null, { email: data.email }, ip)
        return member
    }

    async updateMember(id, data, adminId, ip) {
        await assertNotProtectedDeveloper(id, adminId)
        const member = await repo.updateMember(id, {
            roleId: data.role_id,
            isActive: data.is_active,
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
