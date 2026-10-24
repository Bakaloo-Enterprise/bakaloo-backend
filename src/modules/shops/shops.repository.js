import { query } from '../../config/database.js'
import { salesReports, scopeOf } from '../reports-shared/sales-reports.js'

/**
 * Shops repository — all SQL queries for shops
 * NEVER uses SELECT * — always named columns
 * All queries use parameterized placeholders ($1, $2...)
 *
 * Note (R14.7 / design §3.3): Phase A migrations 039–047 do NOT add any new
 * columns to the `shops` table itself. The new multi-vendor columns live on
 * sibling tables and are projected by their own repositories:
 *   - `orders.auto_assignment_status`  (migration 040) → orders repository
 *   - `shop_products.approval_status`, `approved_at`, `approved_by`,
 *     `rejection_reason` (migration 041) → shop-products repository
 * Every SELECT in this file already enumerates columns explicitly per R14.7.
 */
export class ShopsRepository {
  /**
   * Create a new shop
   * @param {object} data - Shop data
   * @returns {Promise<object>} Created shop
   */
  async create(data) {
    const { rows } = await query(
      `INSERT INTO shops (
        name, slug, branch_code, description, logo_url, banner_url,
        phone, email, address_line1, address_line2, city, state, pincode,
        lat, lng, serviceable_pincodes, delivery_radius_km, pincode_only,
        operating_hours, commission_rate,
        bank_account_number, bank_ifsc, bank_name, bank_holder_name,
        gst_number, pan_number, created_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18,
        $19, $20,
        $21, $22, $23, $24,
        $25, $26, $27
      )
      RETURNING id, name, slug, branch_code, description, logo_url, banner_url,
        phone, email, address_line1, address_line2, city, state, pincode,
        lat, lng, serviceable_pincodes, delivery_radius_km, pincode_only,
        is_active, is_verified, operating_hours, commission_rate,
        bank_account_number, bank_ifsc, bank_name, bank_holder_name,
        gst_number, pan_number, total_orders, total_revenue,
        created_by, created_at, updated_at`,
      [
        data.name, data.slug, data.branch_code,
        data.description || null, data.logo_url || null, data.banner_url || null,
        data.phone || null, data.email || null,
        data.address_line1, data.address_line2 || null,
        data.city, data.state, data.pincode,
        data.lat, data.lng,
        data.serviceable_pincodes || [],
        data.delivery_radius_km,
        data.pincode_only ?? false,
        JSON.stringify(data.operating_hours || {}),
        data.commission_rate,
        data.bank_account_number || null, data.bank_ifsc || null,
        data.bank_name || null, data.bank_holder_name || null,
        data.gst_number || null, data.pan_number || null,
        data.created_by,
      ]
    )
    return rows[0]
  }

  /**
   * Live lifetime sales per shop on the shared sales rules (orders that stood; money kept = sold − refunds).
   * The `shops.total_orders` / `total_revenue` columns are never updated by anything, so they stay 0 —
   * screens must show these numbers instead.
   * @param {string[]} ids
   * @returns {Promise<Map<string, {total_orders: number, total_revenue: number}>>}
   */
  async salesTotals(ids) {
    if (!ids?.length) return new Map()
    const { data } = await salesReports.stores(scopeOf({}, ids), 1, ids.length, { topShape: true })
    return new Map(data.map((r) => [r.shop_id, { total_orders: r.total_orders, total_revenue: r.total_revenue }]))
  }

  /**
   * Find shop by ID (Requirement 15.3 — excludes soft-deleted by default).
   * Pass `includeDeleted: true` to include rows with deleted_at IS NOT NULL —
   * intended for Super Admin restoration / audit views only.
   * @param {string} id - Shop UUID
   * @param {object} [opts]
   * @param {boolean} [opts.includeDeleted=false]
   * @returns {Promise<object|null>}
   */
  async findById(id, { includeDeleted = false } = {}) {
    const sql =
      `SELECT id, name, slug, branch_code, description, logo_url, banner_url,
        phone, email, address_line1, address_line2, city, state, pincode,
        lat, lng, serviceable_pincodes, delivery_radius_km, pincode_only,
        is_active, is_verified, operating_hours, commission_rate,
        bank_account_number, bank_ifsc, bank_name, bank_holder_name,
        gst_number, pan_number, total_orders, total_revenue,
        created_by, deleted_at, created_at, updated_at
      FROM shops
      WHERE id = $1` + (includeDeleted ? '' : ' AND deleted_at IS NULL')
    const { rows } = await query(sql, [id])
    return rows[0] || null
  }

  /**
   * Find shop by slug.
   *
   * Intentionally does NOT filter by deleted_at — slug uniqueness must be
   * preserved across soft-deleted rows so that:
   *   1. The DB UNIQUE(slug) constraint cannot be bypassed by deleting+re-using
   *      a slug at the application layer.
   *   2. Restoring a soft-deleted shop never finds its slug already taken by
   *      a fresh shop.
   * Used only by `generateUniqueSlug` for conflict detection — does not leak
   * soft-deleted shop data into customer-facing reads.
   *
   * @param {string} slug
   * @returns {Promise<object|null>}
   */
  async findBySlug(slug) {
    const { rows } = await query(
      `SELECT id, slug FROM shops WHERE slug = $1`,
      [slug]
    )
    return rows[0] || null
  }

  /**
   * Find shops with slug matching a prefix (for conflict resolution).
   *
   * Same uniqueness-preservation rationale as findBySlug — soft-deleted slugs
   * are intentionally included so we never re-issue a slug that's still in
   * the table.
   *
   * @param {string} baseSlug - Base slug to check
   * @returns {Promise<Array>} Matching slugs
   */
  async findSlugsLike(baseSlug) {
    const { rows } = await query(
      `SELECT slug FROM shops WHERE slug = $1 OR slug LIKE $2`,
      [baseSlug, `${baseSlug}-%`]
    )
    return rows.map(r => r.slug)
  }

  /**
   * Find shop by branch_code.
   *
   * Same uniqueness-preservation rationale as findBySlug — branch_code
   * uniqueness is preserved across soft-deleted rows.
   *
   * @param {string} branchCode
   * @returns {Promise<object|null>}
   */
  async findByBranchCode(branchCode) {
    const { rows } = await query(
      `SELECT id, branch_code FROM shops WHERE branch_code = $1`,
      [branchCode]
    )
    return rows[0] || null
  }

  /**
   * List shops with filtering, sorting, pagination.
   *
   * Requirement 15.3 — soft-deleted rows are excluded by default. Pass
   * `include_deleted: 'true'` (matches the route schema enum) or
   * `includeDeleted: true` to surface soft-deleted shops in admin
   * "show deleted" / restoration views.
   *
   * @param {object} filters
   * @returns {Promise<{shops: Array, total: number}>}
   */
  async findMany({
    page = 1,
    limit = 20,
    city,
    is_active,
    search,
    include_deleted,
    includeDeleted,
  } = {}) {
    const offset = (page - 1) * limit
    const showDeleted =
      includeDeleted === true || include_deleted === 'true'
    const conditions = []
    const params = []
    let paramIdx = 1

    if (!showDeleted) {
      conditions.push('s.deleted_at IS NULL')
    }

    if (city) {
      conditions.push(`s.city ILIKE $${paramIdx++}`)
      params.push(`%${city}%`)
    }

    if (is_active === 'true') {
      conditions.push('s.is_active = true')
    } else if (is_active === 'false') {
      conditions.push('s.is_active = false')
    }

    if (search) {
      conditions.push(`(s.name ILIKE $${paramIdx} OR s.slug ILIKE $${paramIdx} OR s.branch_code ILIKE $${paramIdx})`)
      params.push(`%${search}%`)
      paramIdx++
    }

    const where = conditions.length > 0 ? conditions.join(' AND ') : 'TRUE'

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT s.id, s.name, s.slug, s.branch_code, s.description,
          s.logo_url, s.banner_url, s.phone, s.email,
          s.address_line1, s.address_line2, s.city, s.state, s.pincode,
          s.lat, s.lng, s.serviceable_pincodes, s.delivery_radius_km, s.pincode_only,
          s.is_active, s.is_verified, s.operating_hours, s.commission_rate,
          s.total_orders, s.total_revenue, s.created_at, s.updated_at
        FROM shops s
        WHERE ${where}
        ORDER BY s.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total FROM shops s WHERE ${where}`,
        params
      ),
    ])

    return {
      shops: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Update shop by ID
   * @param {string} id - Shop UUID
   * @param {object} data - Fields to update
   * @returns {Promise<object|null>}
   */
  async update(id, data) {
    const fieldMap = {
      name: 'name',
      description: 'description',
      logo_url: 'logo_url',
      banner_url: 'banner_url',
      phone: 'phone',
      email: 'email',
      address_line1: 'address_line1',
      address_line2: 'address_line2',
      city: 'city',
      state: 'state',
      pincode: 'pincode',
      lat: 'lat',
      lng: 'lng',
      delivery_radius_km: 'delivery_radius_km',
      pincode_only: 'pincode_only',
      is_active: 'is_active',
      is_verified: 'is_verified',
      commission_rate: 'commission_rate',
      bank_account_number: 'bank_account_number',
      bank_ifsc: 'bank_ifsc',
      bank_name: 'bank_name',
      bank_holder_name: 'bank_holder_name',
      gst_number: 'gst_number',
      pan_number: 'pan_number',
      slug: 'slug',
    }

    const fields = []
    const params = []
    let idx = 1

    for (const [key, dbCol] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbCol} = $${idx++}`)
        params.push(data[key])
      }
    }

    // Handle JSON/array fields separately
    if (data.serviceable_pincodes !== undefined) {
      fields.push(`serviceable_pincodes = $${idx++}`)
      params.push(data.serviceable_pincodes)
    }

    if (data.operating_hours !== undefined) {
      fields.push(`operating_hours = $${idx++}`)
      params.push(JSON.stringify(data.operating_hours))
    }

    if (fields.length === 0) return this.findById(id)

    fields.push('updated_at = NOW()')
    params.push(id)

    const { rows } = await query(
      `UPDATE shops SET ${fields.join(', ')}
       WHERE id = $${idx} AND deleted_at IS NULL
       RETURNING id, name, slug, branch_code, description, logo_url, banner_url,
        phone, email, address_line1, address_line2, city, state, pincode,
        lat, lng, serviceable_pincodes, delivery_radius_km, pincode_only,
        is_active, is_verified, operating_hours, commission_rate,
        bank_account_number, bank_ifsc, bank_name, bank_holder_name,
        gst_number, pan_number, total_orders, total_revenue,
        created_by, created_at, updated_at`,
      params
    )
    return rows[0] || null
  }

  /**
   * Soft-delete shop by ID
   * @param {string} id - Shop UUID
   * @returns {Promise<boolean>}
   */
  async softDelete(id) {
    const { rowCount } = await query(
      `UPDATE shops SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    )
    return rowCount > 0
  }
}
