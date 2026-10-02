import { query, getClient } from '../../../config/database.js'
import bcrypt from 'bcrypt'

export class TeamRepository {
    /* ── Roles ── */

    async findAllRoles() {
        const { rows } = await query(`
      SELECT r.*,
             (SELECT COUNT(*)::int FROM users u WHERE u.role_id = r.id AND u.role = 'ADMIN') AS admin_count
      FROM roles r
      ORDER BY r.is_system DESC, r.name ASC
    `)
        return rows
    }

    async findRoleByName(name, exceptId = null) {
        const { rows: [role] } = await query(
            `SELECT id, name FROM roles WHERE lower(btrim(name)) = lower(btrim($1)) AND ($2::uuid IS NULL OR id <> $2::uuid)`,
            [name, exceptId]
        )
        return role || null
    }

    async countMembersWithRole(id) {
        const { rows: [row] } = await query(`SELECT COUNT(*)::int AS n FROM users WHERE role_id = $1`, [id])
        return row.n
    }

    /** Who is asking: developer / HQ tier flags plus the permissions on their role. */
    async findAccessOf(userId) {
        const { rows: [row] } = await query(
            `SELECT u.platform_role, (u.is_developer AND u.is_active) AS is_developer,
                    r.is_system AS role_is_system, r.name AS role_name,
                    COALESCE(r.permissions, '[]'::jsonb) AS permissions
               FROM users u LEFT JOIN roles r ON r.id = u.role_id
              WHERE u.id = $1`,
            [userId]
        )
        return row || null
    }

    /** Shop staff are tied to shops; they must never be turned into HQ users by a role change. */
    async isShopStaff(userId) {
        const { rowCount } = await query(`SELECT 1 FROM shop_staff WHERE user_id = $1 LIMIT 1`, [userId])
        return rowCount > 0
    }

    async findPlatformRole(userId) {
        const { rows: [row] } = await query(`SELECT platform_role FROM users WHERE id = $1`, [userId])
        return row?.platform_role ?? null
    }

    async findRoleById(id) {
        const { rows: [role] } = await query('SELECT * FROM roles WHERE id = $1', [id])
        return role || null
    }

    async createRole({ name, description, permissions }) {
        const { rows: [role] } = await query(
            `INSERT INTO roles (name, description, permissions)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
            [name, description || '', JSON.stringify(permissions || [])]
        )
        return { ...role, admin_count: 0 }
    }

    async updateRole(id, { name, description, permissions }) {
        const sets = []
        const params = []
        let idx = 1

        if (name !== undefined) { sets.push(`name = $${idx++}`); params.push(name) }
        if (description !== undefined) { sets.push(`description = $${idx++}`); params.push(description) }
        if (permissions !== undefined) { sets.push(`permissions = $${idx++}::jsonb`); params.push(JSON.stringify(permissions)) }

        if (sets.length === 0) return this.findRoleById(id)

        sets.push(`updated_at = NOW()`)
        params.push(id)

        const { rows: [role] } = await query(
            `UPDATE roles SET ${sets.join(', ')} WHERE id = $${idx} AND is_system = false RETURNING *`,
            params
        )
        return role || null
    }

    async deleteRole(id) {
        // Don't delete system roles; reassign members to null
        const client = await getClient()
        try {
            await client.query('BEGIN')
            await client.query('UPDATE users SET role_id = NULL WHERE role_id = $1', [id])
            const { rowCount } = await client.query('DELETE FROM roles WHERE id = $1 AND is_system = false', [id])
            await client.query('COMMIT')
            return rowCount > 0
        } catch (err) {
            await client.query('ROLLBACK')
            throw err
        } finally {
            client.release()
        }
    }

    /* ── Team Members ── */

    async findAllMembers() {
        const { rows } = await query(`
      SELECT u.id, u.name, u.email, u.phone, u.role_id, u.is_active, u.created_at,
             COALESCE(r.name, 'No Role') AS role_name,
             COALESCE(r.permissions, '[]'::jsonb) AS permissions
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.role = 'ADMIN'
      ORDER BY u.created_at ASC
    `)
        return rows
    }

    async findMemberById(id) {
        const { rows: [member] } = await query(`
      SELECT u.id, u.name, u.email, u.phone, u.role_id, u.is_active, u.created_at,
             COALESCE(r.name, 'No Role') AS role_name,
             COALESCE(r.permissions, '[]'::jsonb) AS permissions
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.role = 'ADMIN'
    `, [id])
        return member || null
    }

    /**
     * platform_role is what lets a team member log in at all (HQ login branch); force_password_change makes them
     * replace the password the inviter typed on first login. users.phone is NOT NULL, so a member invited without a
     * phone gets a clearly-fake unique placeholder (never a dialable number).
     */
    async inviteMember({ name, email, phone, roleId, passwordHash, platformRole }) {
        const { rows: [user] } = await query(
            `INSERT INTO users (name, email, phone, role, role_id, platform_role, password_hash, is_active, force_password_change)
       VALUES ($1, $2, COALESCE($3, 'TM-' || substr(md5(random()::text || clock_timestamp()::text), 1, 10)), 'ADMIN', $4, $5, $6, true, true)
       RETURNING id, name, email, phone, role_id, is_active, created_at`,
            [name, email, phone || null, roleId, platformRole, passwordHash]
        )
        return user
    }

    async updateMember(id, { roleId, isActive, platformRole }) {
        const sets = []
        const params = []
        let idx = 1

        if (roleId !== undefined) { sets.push(`role_id = $${idx++}`); params.push(roleId) }
        if (isActive !== undefined) { sets.push(`is_active = $${idx++}`); params.push(isActive) }
        if (platformRole !== undefined) { sets.push(`platform_role = $${idx++}`); params.push(platformRole) }
        // A changed role / access level must reach the person's live session straight away.
        // ...and so must a switch-off: without this a deactivated member's existing login keeps working until it expires.
        if (roleId !== undefined || platformRole !== undefined || isActive !== undefined) sets.push(`session_version = session_version + 1`)

        if (sets.length === 0) return this.findMemberById(id)

        sets.push(`updated_at = NOW()`)
        params.push(id)

        await query(
            `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} AND role = 'ADMIN'`,
            params
        )
        return this.findMemberById(id)
    }

    async removeMember(id) {
        // Instead of deleting, deactivate the user
        const { rowCount } = await query(
            `UPDATE users SET is_active = false, role_id = NULL, session_version = session_version + 1, updated_at = NOW() WHERE id = $1 AND role = 'ADMIN'`,
            [id]
        )
        return rowCount > 0
    }

    async findByEmail(email) {
        const { rows: [user] } = await query('SELECT id FROM users WHERE lower(email) = lower($1)', [email])
        return user || null
    }

    async findByPhone(phone) {
        const { rows: [user] } = await query('SELECT id FROM users WHERE phone = $1', [phone])
        return user || null
    }

    /**
     * Set a new password hash for a team member, force a password change on
     * their next login, and bump session_version so every previously issued
     * JWT for this user is invalidated immediately (mirrors shop-staff's
     * `resetPasswordTx` — same `users` table, same three-column contract).
     */
    async resetPassword(id, passwordHash) {
        const { rowCount } = await query(
            `UPDATE users
                SET password_hash = $1,
                    force_password_change = true,
                    session_version = session_version + 1,
                    updated_at = NOW()
              WHERE id = $2 AND role = 'ADMIN'`,
            [passwordHash, id]
        )
        return rowCount > 0
    }
}
