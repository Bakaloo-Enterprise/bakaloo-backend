import { query } from '../../config/database.js'
import { ERROR_CODES, httpStatusFor } from '../../constants/errors.js'
import { logger } from '../../config/logger.js'

/**
 * Stock_Movement_Type vocabulary — must stay in sync with the
 * `chk_stock_movements_type` CHECK constraint in migration 042.
 *
 * @see Requirements R23.2, R23.4
 */
export const STOCK_MOVEMENT_TYPES = Object.freeze({
  MANUAL_ADJUSTMENT: 'MANUAL_ADJUSTMENT',
  ORDER_DEDUCTION: 'ORDER_DEDUCTION',
  CANCELLATION_RESTORE: 'CANCELLATION_RESTORE',
  DAMAGED_STOCK: 'DAMAGED_STOCK',
  RETURN_STOCK: 'RETURN_STOCK',
  // Phase 12 (migration 151): procurement splits / reversals and the bulk Excel update.
  PROCUREMENT_RECEIPT: 'PROCUREMENT_RECEIPT',
  PROCUREMENT_REVERSAL: 'PROCUREMENT_REVERSAL',
  BULK_UPDATE: 'BULK_UPDATE',
})

const ALLOWED_STOCK_MOVEMENT_TYPES = new Set(Object.values(STOCK_MOVEMENT_TYPES))

/**
 * Stock_Movement_Source vocabulary — must stay in sync with the
 * `chk_stock_movements_source` CHECK constraint in migration 042.
 *
 * @see Requirements R23.2, R23.4
 */
export const STOCK_MOVEMENT_SOURCES = Object.freeze({
  DASHBOARD: 'DASHBOARD',
  ORDER: 'ORDER',
  JOB: 'JOB',
  API: 'API',
})

const ALLOWED_STOCK_MOVEMENT_SOURCES = new Set(
  Object.values(STOCK_MOVEMENT_SOURCES)
)

/**
 * Build a typed error suitable for callers that translate `err.code` into an
 * HTTP status via `httpStatusFor` (see `src/constants/errors.js`).
 *
 * The returned `Error` carries:
 *   - `code`        — one of `ERROR_CODES`
 *   - `statusCode`  — HTTP status (kept in sync with `httpStatusFor`)
 *   - `details`     — structured context (e.g. `{ before, after }`) for logs
 *
 * Used by `applyStockChange` to surface STOCK_NEGATIVE_FORBIDDEN, validation
 * errors on `type`/`source`, and product-not-found cases.
 *
 * @param {string} code      one of `ERROR_CODES.*`
 * @param {string} message   human-readable message (no PII)
 * @param {object} [details] structured context for logging
 * @returns {Error & { code: string, statusCode: number, details?: object }}
 */
function applyStockChangeError(code, message, details) {
  const err = new Error(message)
  err.code = code
  err.statusCode = httpStatusFor(code)
  if (details) err.details = details
  return err
}

/**
 * Shop Products repository — all SQL queries for shop_products
 *
 * Conventions:
 *   - NEVER `SELECT *` — every column is named explicitly
 *   - All queries use parameterized placeholders ($1, $2…)
 *   - Mutations that need row-level locks (stock updates) are executed against
 *     a transaction client passed in by the service. The plain `query()` helper
 *     uses a fresh pool client per call and cannot hold a transaction.
 *
 * Migration reference: src/database/migrations/031_shop_products.sql
 */
export class ShopProductsRepository {
  // ────────────────────────────────────────────────────────
  // Column projections — keep these in sync with the schema
  //
  // Approval columns (approval_status, approved_at, approved_by,
  // rejection_reason) were added by migration 041_shop_products_approval.sql
  // for R23 AC#10/AC#11/AC#22/AC#23 and are surfaced here per R14.7
  // (named columns, never SELECT *) and design §3.3.
  //
  // is_featured added by migration 054_shop_products_is_featured.sql.
  // ────────────────────────────────────────────────────────
  static SELECT_COLUMNS = `
    id, shop_id, product_id,
    price, sale_price, cost_price, wholesale_price,
    stock_quantity, low_stock_threshold, max_order_qty,
    is_available, is_featured, bulk_order_eligible,
    bulk_min_quantity, bulk_max_quantity, bulk_sale_start_at, bulk_sale_end_at, sold_out_at,
    approval_status, approved_at, approved_by, rejection_reason,
    deleted_at, created_at, updated_at
  `

  /**
   * Insert a new shop_product row.
   * @param {object} data - Validated fields
   * @returns {Promise<object>} Created record
   */
  async create(data) {
    const soldOutAt =
      data.stock_quantity === 0 && data.is_available === false
        ? new Date()
        : null

    const { rows } = await query(
      `INSERT INTO shop_products (
        shop_id, product_id,
        price, sale_price, cost_price, wholesale_price,
        stock_quantity, low_stock_threshold, max_order_qty,
        is_available, is_featured, bulk_order_eligible,
        bulk_min_quantity, bulk_max_quantity, bulk_sale_start_at, bulk_sale_end_at, sold_out_at
      ) VALUES (
        $1, $2,
        $3, $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12,
        $13, $14, $15, $16, $17
      )
      RETURNING ${ShopProductsRepository.SELECT_COLUMNS}`,
      [
        data.shop_id,
        data.product_id,
        data.price ?? null,
        data.sale_price ?? null,
        data.cost_price ?? null,
        data.wholesale_price ?? null,
        data.stock_quantity,
        data.low_stock_threshold,
        data.max_order_qty,
        data.is_available,
        data.is_featured ?? false,
        data.bulk_order_eligible ?? true,
        data.bulk_min_quantity ?? null,
        data.bulk_max_quantity ?? null,
        data.bulk_sale_start_at ?? null,
        data.bulk_sale_end_at ?? null,
        soldOutAt,
      ]
    )
    return rows[0]
  }

  /**
   * Revive a soft-deleted shop_product row in place instead of inserting a
   * new one. `uq_shop_products_shop_product UNIQUE (shop_id, product_id)` is
   * not partial — it still counts soft-deleted rows — so re-adding a product
   * that was previously removed from this shop must UPDATE the existing row
   * (clearing deleted_at) rather than INSERT, or Postgres rejects the insert
   * with a 23505 duplicate-key error.
   *
   * Resets approval/sold-out state the same way a fresh INSERT would, so a
   * revived row carries no stale state from its previous lifecycle.
   *
   * @param {string} id - shop_product UUID (the soft-deleted row to revive)
   * @param {string} shopId
   * @param {object} data - Same shape as `create()`
   * @returns {Promise<object>} Revived record
   */
  async revive(id, shopId, data) {
    const soldOutAt =
      data.stock_quantity === 0 && data.is_available === false
        ? new Date()
        : null

    const { rows } = await query(
      `UPDATE shop_products SET
        price = $3, sale_price = $4, cost_price = $5, wholesale_price = $6,
        stock_quantity = $7, low_stock_threshold = $8, max_order_qty = $9,
        is_available = $10, is_featured = $11, bulk_order_eligible = $12,
        bulk_min_quantity = $13, bulk_max_quantity = $14, bulk_sale_start_at = $15, bulk_sale_end_at = $16,
        sold_out_at = $17,
        approval_status = 'APPROVED', approved_at = NULL, approved_by = NULL,
        rejection_reason = NULL,
        deleted_at = NULL, updated_at = NOW()
      WHERE id = $1 AND shop_id = $2
      RETURNING ${ShopProductsRepository.SELECT_COLUMNS}`,
      [
        id,
        shopId,
        data.price ?? null,
        data.sale_price ?? null,
        data.cost_price ?? null,
        data.wholesale_price ?? null,
        data.stock_quantity,
        data.low_stock_threshold,
        data.max_order_qty,
        data.is_available,
        data.is_featured ?? false,
        data.bulk_order_eligible ?? true,
        data.bulk_min_quantity ?? null,
        data.bulk_max_quantity ?? null,
        data.bulk_sale_start_at ?? null,
        data.bulk_sale_end_at ?? null,
        soldOutAt,
      ]
    )
    return rows[0] || null
  }

  /**
   * Find a shop_product by id, scoped to a shop (excludes soft-deleted).
   * Uses idx_shop_products_shop_available (shop_id, is_available).
   * @param {string} id - shop_product UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @returns {Promise<object|null>}
   */
  async findById(id, shopId) {
    const { rows } = await query(
      `SELECT ${ShopProductsRepository.SELECT_COLUMNS}
        FROM shop_products
        WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL`,
      [id, shopId]
    )
    return rows[0] || null
  }

  /**
   * Find an existing shop_product by (shop_id, product_id).
   * Used for duplicate detection on create. Includes soft-deleted records so
   * the caller can decide whether to undelete or reject.
   * Uses uq_shop_products_shop_product unique index.
   * @param {string} shopId
   * @param {string} productId
   * @returns {Promise<object|null>}
   */
  async findByShopAndProduct(shopId, productId) {
    const { rows } = await query(
      `SELECT ${ShopProductsRepository.SELECT_COLUMNS}
        FROM shop_products
        WHERE shop_id = $1 AND product_id = $2`,
      [shopId, productId]
    )
    return rows[0] || null
  }

  /**
   * List shop_products for a shop with filters and pagination.
   * Joins products (name, sku, thumbnail_url, category) and shops (name) so
   * the dashboard can display product identity and store context without
   * extra round-trips.
   *
   * Each returned row is enriched with a nested `product` object
   * ({ id, name, sku, image_url, category_id, category_name }) and
   * `shop_name` to match the dashboard ShopProduct type expectations.
   *
   * @param {object} filters
   * @param {string} filters.shopId
   * @param {number} [filters.page=1]
   * @param {number} [filters.limit=20]
   * @param {string} [filters.is_available] - 'true' | 'false'
   * @param {string} [filters.low_stock] - 'true' | 'false'
   * @param {string} [filters.search] - Search by product name or SKU
   * @param {boolean} [filters.includeDeleted=false]
   * @returns {Promise<{items: Array, total: number}>}
   */
  async findMany({
    shopId,
    page = 1,
    limit = 20,
    is_available,
    low_stock,
    search,
    includeDeleted = false,
  }) {
    const offset = (page - 1) * limit
    const conditions = ['sp.shop_id = $1']
    const params = [shopId]
    let paramIdx = 2

    if (!includeDeleted) {
      conditions.push('sp.deleted_at IS NULL')
    }

    if (is_available === 'true') {
      conditions.push('sp.is_available = true')
    } else if (is_available === 'false') {
      conditions.push('sp.is_available = false')
    }

    if (low_stock === 'true') {
      conditions.push('sp.stock_quantity <= sp.low_stock_threshold')
    }

    if (search) {
      // Search by product name OR SKU (case-insensitive)
      conditions.push(`(p.name ILIKE $${paramIdx} OR p.sku ILIKE $${paramIdx})`)
      params.push(`%${search}%`)
      paramIdx++
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT
          sp.id,
          sp.shop_id,
          sp.product_id,
          sp.price,
          sp.sale_price,
          sp.cost_price,
          sp.wholesale_price,
          sp.stock_quantity,
          sp.low_stock_threshold,
          sp.max_order_qty,
          sp.is_available,
          sp.is_featured,
          sp.bulk_order_eligible,
          sp.bulk_min_quantity,
          sp.bulk_max_quantity,
          sp.bulk_sale_start_at,
          sp.bulk_sale_end_at,
          sp.sold_out_at,
          sp.approval_status,
          sp.approved_at,
          sp.approved_by,
          sp.rejection_reason,
          sp.deleted_at,
          sp.created_at,
          sp.updated_at,
          p.name          AS product_name,
          p.sku           AS product_sku,
          COALESCE(p.thumbnail_url, p.images->>0)
                          AS product_image_url,
          p.category_id   AS product_category_id,
          c.name          AS product_category_name,
          p.unit          AS product_unit,
          p.net_quantity  AS product_net_quantity,
          s.name          AS shop_name
        FROM shop_products sp
        LEFT JOIN products p ON p.id = sp.product_id
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN shops s ON s.id = sp.shop_id
        WHERE ${where}
        ORDER BY sp.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
        FROM shop_products sp
        LEFT JOIN products p ON p.id = sp.product_id
        WHERE ${where}`,
        params
      ),
    ])

    // Reshape flat SQL rows into the nested structure the dashboard expects:
    //   { ...shopProductFields, product: { id, name, sku, image_url, category_id, category_name }, shop_name }
    const items = dataResult.rows.map((row) => ({
      id: row.id,
      shop_id: row.shop_id,
      product_id: row.product_id,
      price: row.price,
      sale_price: row.sale_price,
      cost_price: row.cost_price,
      wholesale_price: row.wholesale_price,
      stock_quantity: row.stock_quantity,
      low_stock_threshold: row.low_stock_threshold,
      max_order_qty: row.max_order_qty,
      is_available: row.is_available,
      is_featured: row.is_featured ?? false,
      bulk_order_eligible: row.bulk_order_eligible,
      bulk_min_quantity: row.bulk_min_quantity,
      bulk_max_quantity: row.bulk_max_quantity,
      bulk_sale_start_at: row.bulk_sale_start_at,
      bulk_sale_end_at: row.bulk_sale_end_at,
      sold_out_at: row.sold_out_at,
      approval_status: row.approval_status,
      approved_at: row.approved_at,
      approved_by: row.approved_by,
      rejection_reason: row.rejection_reason,
      deleted_at: row.deleted_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      // Nested product object — matches ShopProductCatalogRef on the dashboard
      product: {
        id: row.product_id,
        name: row.product_name ?? null,
        sku: row.product_sku ?? null,
        image_url: row.product_image_url ?? null,
        category_id: row.product_category_id ?? null,
        category_name: row.product_category_name ?? null,
        unit: row.product_unit ?? null,
        net_quantity: row.product_net_quantity ?? null,
      },
      shop_name: row.shop_name ?? null,
    }))

    return {
      items,
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Update a shop_product (excluding stock_quantity — see applyStockUpdate).
   * Scoped to shop_id; fails (returns null) if record is missing or soft-deleted.
   * @param {string} id - shop_product UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @param {object} data - Fields to update
   * @returns {Promise<object|null>}
   */
  async update(id, shopId, data) {
    const fields = []
    const params = []
    let idx = 1

    const updatable = [
      'price',
      'sale_price',
      'cost_price',
      'wholesale_price',
      'low_stock_threshold',
      'max_order_qty',
      'is_available',
      'is_featured',
      'bulk_order_eligible',
      'bulk_min_quantity',
      'bulk_max_quantity',
      'bulk_sale_start_at',
      'bulk_sale_end_at',
    ]

    for (const key of updatable) {
      if (data[key] !== undefined) {
        fields.push(`${key} = $${idx++}`)
        params.push(data[key])
      }
    }

    if (fields.length === 0) {
      return this.findById(id, shopId)
    }

    fields.push('updated_at = NOW()')
    params.push(id, shopId)

    const { rows } = await query(
      `UPDATE shop_products SET ${fields.join(', ')}
       WHERE id = $${idx} AND shop_id = $${idx + 1} AND deleted_at IS NULL
       RETURNING ${ShopProductsRepository.SELECT_COLUMNS}`,
      params
    )
    return rows[0] || null
  }

  /**
   * Soft-delete a shop_product (deleted_at = NOW()).
   * @param {string} id
   * @param {string} shopId
   * @returns {Promise<boolean>}
   */
  async softDelete(id, shopId) {
    const { rowCount } = await query(
      `UPDATE shop_products
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL`,
      [id, shopId]
    )
    return rowCount > 0
  }

  /**
   * Look up the product name for a shop_product row. Used by post-commit
   * side effects (Socket.IO emission, push notifications) so we can include
   * a human-readable name in the payload without a separate fetch on every
   * caller.
   *
   * Returns null when the row is missing, soft-deleted, or has no joined
   * product (defensive — products are FK NOT NULL today, but we don't want
   * the side-effect path to crash when the catalog row was archived).
   *
   * Uses the shop_products PK and the products PK — no full scan.
   *
   * @param {string} id - shop_product UUID
   * @param {string} shopId - Shop UUID for scope enforcement
   * @returns {Promise<{product_name: string|null, product_id: string}|null>}
   */
  async findProductMetaById(id, shopId) {
    const { rows } = await query(
      `SELECT sp.product_id, p.name AS product_name
        FROM shop_products sp
        LEFT JOIN products p ON p.id = sp.product_id
        WHERE sp.id = $1 AND sp.shop_id = $2 AND sp.deleted_at IS NULL`,
      [id, shopId]
    )
    return rows[0] || null
  }

  // ────────────────────────────────────────────────────────
  // Transactional helpers — caller passes a pg Client that owns BEGIN
  // ────────────────────────────────────────────────────────

  /**
   * Lock a shop_product row for update inside a transaction.
   * Used by stock-update flows (Requirement 3.8, 11.7).
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @param {string} shopId
   * @returns {Promise<object|null>}
   */
  async findByIdForUpdate(client, id, shopId) {
    const { rows } = await client.query(
      `SELECT ${ShopProductsRepository.SELECT_COLUMNS}
        FROM shop_products
        WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [id, shopId]
    )
    return rows[0] || null
  }

  /**
   * Apply a stock-quantity write inside an open transaction.
   * Caller is responsible for ensuring the row was locked first via
   * findByIdForUpdate, and that newStockQuantity >= 0 (the DB CHECK constraint
   * enforces this defensively, but the service guards beforehand for nicer
   * error codes — Requirements 3.5, 3.8, 11.7).
   *
   * Also updates is_available and sold_out_at according to the transition
   * (Requirements 3.3, 3.4, 11.1, 11.6):
   *   - new=0 → is_available=false, sold_out_at=NOW()
   *   - new>0 AND prev was 0 → is_available=true,  sold_out_at=NULL
   *   - otherwise: leave is_available/sold_out_at untouched
   *
   * Note: The CASE expressions reference only the parameter $1 (newQty) and
   * existing column values. No user input is interpolated into SQL text.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @param {string} shopId
   * @param {number} newStockQuantity
   * @returns {Promise<object|null>}
   */
  async applyStockUpdate(client, id, shopId, newStockQuantity) {
    const { rows } = await client.query(
      `UPDATE shop_products
       SET stock_quantity = $1,
           is_available = CASE
             WHEN $1 = 0 THEN false
             WHEN stock_quantity = 0 AND $1 > 0 THEN true
             ELSE is_available
           END,
           sold_out_at = CASE
             WHEN $1 = 0 THEN NOW()
             WHEN stock_quantity = 0 AND $1 > 0 THEN NULL
             ELSE sold_out_at
           END,
           updated_at = NOW()
       WHERE id = $2 AND shop_id = $3 AND deleted_at IS NULL
       RETURNING ${ShopProductsRepository.SELECT_COLUMNS}`,
      [newStockQuantity, id, shopId]
    )
    return rows[0] || null
  }

  /**
   * Centralized stock-write entry point — every change to
   * `shop_products.stock_quantity` MUST flow through this method so that
   * exactly one `stock_movements` row is appended in the same transaction
   * (R23.4, R23.14, design §8.1). This is the single insertion path
   * referenced by every order / cancellation / manual-adjust / damage /
   * return code path.
   *
   * Behavior (single transaction owned by the caller):
   *   1. `SELECT … FOR UPDATE` on `shop_products` by id, returning
   *      `shop_id`, `product_id`, and `stock_quantity` (the lock and the
   *      current state). Serializes concurrent writers (R3.8, R23.14,
   *      R11.7). Soft-deleted rows are not lockable.
   *   2. Compute `quantity_after = quantity_before + delta`. Reject with
   *      `STOCK_NEGATIVE_FORBIDDEN` (HTTP 409) if the result would go below
   *      zero (R23.9). The DB CHECK constraint
   *      `chk_shop_products_stock_quantity` is the final defence — the
   *      service-level guard just gives callers a nicer error code than a
   *      raw 23514.
   *   3. Delegate the UPDATE to `applyStockUpdate()` so the
   *      `is_available` / `sold_out_at` transition logic lives in exactly
   *      one place (R11.1, R11.6, R11.8):
   *        - new=0 → is_available=false, sold_out_at=NOW()
   *        - new>0 AND prev was 0 → is_available=true, sold_out_at=NULL
   *        - otherwise: leave is_available / sold_out_at unchanged
   *   4. INSERT one row into the append-only `stock_movements` ledger
   *      (R23.1, R23.2, R23.4) with `quantity_before`, `quantity_after`,
   *      and the actor / source / order context.
   *
   * Caller contract:
   *   - MUST pass a transactional client. The method throws a
   *     `VALIDATION_ERROR` if `client` is missing — the plain pool query
   *     helper cannot hold the row lock across the UPDATE + INSERT.
   *   - Owns BEGIN / COMMIT / ROLLBACK. This method never opens or closes
   *     a transaction; on any thrown error the caller MUST ROLLBACK so the
   *     stock_movements INSERT is also rolled back (preserves the "exactly
   *     one ledger row per stock change" invariant of R23.4).
   *   - Passes `actor.userId` + `actor.shopRole` for DASHBOARD / API
   *     sources; leaves them `null` for ORDER / JOB sources (system
   *     writes).
   *   - Populates `orderId` for `ORDER_DEDUCTION`, `CANCELLATION_RESTORE`,
   *     and `RETURN_STOCK` so the order-detail "stock impact" view can
   *     join via `idx_stock_movements_order` (design §3.2.4).
   *   - Cache invalidation (`bakaloo:shop-products:*` SCAN) runs from the
   *     service layer **after** COMMIT (R23.13).
   *
   * Validation:
   *   - `type` must be one of MANUAL_ADJUSTMENT, ORDER_DEDUCTION,
   *     CANCELLATION_RESTORE, DAMAGED_STOCK, RETURN_STOCK
   *     (chk_stock_movements_type, migration 042).
   *   - `source` must be one of DASHBOARD, ORDER, JOB, API
   *     (chk_stock_movements_source, migration 042).
   *   - `delta` must be a finite, non-zero integer.
   *   Each is validated before issuing SQL so the caller gets a structured
   *   `VALIDATION_ERROR` instead of a raw 23514 from PostgreSQL.
   *
   * Errors thrown (all carry `{ code, statusCode }` so callers can map to
   * the API envelope via `httpStatusFor`):
   *   - VALIDATION_ERROR (400)         — missing client, bad `type`,
   *                                      `source`, or `delta`
   *   - PRODUCT_NOT_FOUND (404)        — shop_product missing or
   *                                      soft-deleted
   *   - STOCK_NEGATIVE_FORBIDDEN (409) — resulting stock would be < 0
   *
   * @param {import('pg').PoolClient} client - Transactional client; caller
   *   owns BEGIN/COMMIT/ROLLBACK. REQUIRED — throws if missing.
   * @param {object} params
   * @param {string} params.shopProductId - shop_products.id (UUID)
   * @param {number} params.delta         - Signed integer delta (non-zero)
   * @param {'MANUAL_ADJUSTMENT'|'ORDER_DEDUCTION'|'CANCELLATION_RESTORE'|'DAMAGED_STOCK'|'RETURN_STOCK'} params.type
   * @param {'DASHBOARD'|'ORDER'|'JOB'|'API'} params.source
   * @param {string|null} [params.reason]   - Optional free-text (≤500 chars)
   * @param {{ userId: string|null, shopRole: string|null }|null} [params.actor]
   *   Actor context. `userId` is a users.id (null for JOB/ORDER system
   *   writes); `shopRole` is the actor's Shop_Staff_Record role at write
   *   time (null when no human acted).
   * @param {object|null} [params.metadata] - JSONB context (defaults to {})
   * @param {string|null} [params.orderId]  - orders.id for ORDER_DEDUCTION /
   *   CANCELLATION_RESTORE / RETURN_STOCK
   * @returns {Promise<{ stockProduct: object, movement: object }>}
   *   `stockProduct` is the updated `shop_products` row (full
   *   SELECT_COLUMNS projection); `movement` is the inserted
   *   `stock_movements` row.
   *
   * @see Requirements R23.4, R23.14, R11.1, R11.7, R11.8
   *      (also: R3.8, R23.1, R23.2, R23.9, R11.6)
   * @see Design §8.1 of .kiro/specs/multi-vendor-system/design.md
   */
  async applyStockChange(
    client,
    {
      shopProductId,
      delta,
      type,
      reason = null,
      actor = null,
      source,
      metadata = null,
      orderId = null,
    } = {}
  ) {
    // 0a. Reject missing transaction client up front. Without a single
    //     client holding BEGIN, the SELECT FOR UPDATE cannot serialize
    //     concurrent writers (R23.14) and the UPDATE + INSERT cannot be
    //     rolled back together (breaks R23.4).
    if (!client || typeof client.query !== 'function') {
      throw applyStockChangeError(
        ERROR_CODES.VALIDATION_ERROR,
        'applyStockChange requires a transactional pg client',
        { got: typeof client }
      )
    }

    // 0b. Validate enum vocabulary BEFORE issuing SQL so callers get a
    //     structured VALIDATION_ERROR instead of a raw 23514 from PostgreSQL
    //     (chk_stock_movements_type / chk_stock_movements_source).
    if (!ALLOWED_STOCK_MOVEMENT_TYPES.has(type)) {
      throw applyStockChangeError(
        ERROR_CODES.VALIDATION_ERROR,
        `Invalid stock_movements.type: ${String(type)}`,
        { allowed: Array.from(ALLOWED_STOCK_MOVEMENT_TYPES), got: type }
      )
    }
    if (!ALLOWED_STOCK_MOVEMENT_SOURCES.has(source)) {
      throw applyStockChangeError(
        ERROR_CODES.VALIDATION_ERROR,
        `Invalid stock_movements.source: ${String(source)}`,
        { allowed: Array.from(ALLOWED_STOCK_MOVEMENT_SOURCES), got: source }
      )
    }
    if (
      typeof delta !== 'number' ||
      !Number.isFinite(delta) ||
      !Number.isInteger(delta) ||
      delta === 0
    ) {
      throw applyStockChangeError(
        ERROR_CODES.VALIDATION_ERROR,
        'stock_movements.quantity_delta must be a non-zero finite integer',
        { got: delta }
      )
    }

    const actorUserId = actor?.userId ?? null
    const actorShopRole = actor?.shopRole ?? null

    // 1. SELECT FOR UPDATE on shop_products by id — the lock and the
    //    current state. We resolve `shop_id` from the row itself so the
    //    caller only has to supply the shop_product id (centralization
    //    benefit: callers can't accidentally pass a mismatched shop_id).
    //    Soft-deleted rows are excluded so the ledger never accrues
    //    movements against a row a vendor has already retired.
    const lockResult = await client.query(
      `SELECT id, shop_id, product_id, stock_quantity
         FROM shop_products
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [shopProductId]
    )
    if (lockResult.rows.length === 0) {
      throw applyStockChangeError(
        ERROR_CODES.PRODUCT_NOT_FOUND,
        'Shop product not found',
        { shopProductId }
      )
    }
    const locked = lockResult.rows[0]
    const shopId = locked.shop_id
    const productId = locked.product_id
    const before = Number(locked.stock_quantity)
    const after = before + delta

    // 2. Reject negative resulting stock (R23.9). The DB CHECK constraint
    //    chk_shop_products_stock_quantity is the final defence.
    if (after < 0) {
      throw applyStockChangeError(
        ERROR_CODES.STOCK_NEGATIVE_FORBIDDEN,
        'Resulting stock_quantity cannot be negative',
        { before, delta, after, shopProductId, shopId }
      )
    }

    // 3. Delegate the UPDATE to applyStockUpdate so the
    //    is_available / sold_out_at transitions live in one place
    //    (R11.1, R11.6, R11.8). The same FOR UPDATE lock above guards
    //    this UPDATE from concurrent writers.
    const stockProduct = await this.applyStockUpdate(
      client,
      shopProductId,
      shopId,
      after
    )
    if (!stockProduct) {
      // Defensive — the FOR UPDATE lock is held for the duration of the
      // transaction so the row should still be present and not
      // soft-deleted. If we ever hit this branch it indicates a logic
      // error rather than a user-facing condition.
      throw applyStockChangeError(
        ERROR_CODES.PRODUCT_NOT_FOUND,
        'Shop product not found during stock update',
        { shopProductId, shopId }
      )
    }

    // 4. INSERT stock_movements (append-only ledger, R23.1, R23.4). One
    //    row per stock change, written on the same client so it commits
    //    atomically with the shop_products UPDATE. Application role holds
    //    INSERT+SELECT only — see migration 042 COMMENT ON TABLE.
    const movementResult = await client.query(
      `INSERT INTO stock_movements (
         shop_id, shop_product_id, product_id, type, quantity_delta,
         quantity_before, quantity_after, reason, order_id, actor_user_id,
         actor_shop_role, source, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, shop_id, shop_product_id, product_id, type,
                 quantity_delta, quantity_before, quantity_after, reason,
                 order_id, actor_user_id, actor_shop_role, source,
                 metadata, created_at`,
      [
        shopId,
        shopProductId,
        productId,
        type,
        delta,
        before,
        after,
        reason ?? null,
        orderId ?? null,
        actorUserId,
        actorShopRole,
        source,
        JSON.stringify(metadata ?? {}),
      ]
    )

    return {
      stockProduct,
      movement: movementResult.rows[0],
    }
  }

  /**
   * Restore stock for every line item of an order that's being cancelled
   * before delivery — the shared entry point for the three cancel paths
   * (customer self-cancel, shop-staff cancel, HQ admin cancel), each of
   * which previously either bypassed the ledger or skipped restoration
   * entirely. Every restored line goes through `applyStockChange()` so it
   * gets a `CANCELLATION_RESTORE` ledger row and the same cache
   * invalidation every other stock mutation gets.
   *
   * Items without a `shopProductId` (legacy orders predating Phase 3, or a
   * shop_product that's since been hard-deleted) are skipped — there is no
   * row left to restore stock onto. Per-item failures are caught and
   * logged rather than thrown, so one bad line can't block the rest of the
   * order's stock from being restored or abort the cancellation itself.
   *
   * @param {import('pg').PoolClient} client - Transactional client.
   * @param {object} params
   * @param {string} params.orderId
   * @param {Array<{shop_product_id?: string, shopProductId?: string, quantity: number, name?: string}>} params.items
   * @param {'DASHBOARD'|'ORDER'|'JOB'|'API'} params.source
   * @param {{ userId: string|null, shopRole: string|null }|null} [params.actor]
   * @returns {Promise<{ restoredCount: number, failedItems: Array<{ shopProductId: string, productName: string|null, reason: string }> }>}
   */
  async restoreStockForCancelledOrder(client, { orderId, items, source, actor = null }) {
    let restoredCount = 0
    const failedItems = []
    for (const item of items || []) {
      const shopProductId = item.shopProductId || item.shop_product_id
      const quantity = Number(item.quantity)
      if (!shopProductId || !Number.isFinite(quantity) || quantity <= 0) continue

      try {
        await this.applyStockChange(client, {
          shopProductId,
          delta: quantity,
          type: STOCK_MOVEMENT_TYPES.CANCELLATION_RESTORE,
          source,
          orderId,
          actor,
        })
        restoredCount++
      } catch (err) {
        // Previously silent — only logged, never surfaced to the admin who
        // cancelled the order. Most commonly hit when the listing was
        // deleted between order placement and cancellation (applyStockChange
        // excludes soft-deleted rows), in which case there's genuinely
        // nothing left to restore stock to — but the admin still needs to
        // know so they don't assume inventory is accurate.
        logger.error(
          { err: err.message, orderId, shopProductId, quantity },
          'Stock restore failed for one order line during cancellation (non-blocking)'
        )
        failedItems.push({
          shopProductId,
          productName: item.name || null,
          reason: err.message,
        })
      }
    }
    return { restoredCount, failedItems }
  }

  /**
   * Deduct stock for every line item of a B2B "Place Order" order whose
   * deduction was deferred until admin approval (see migration
   * 128_b2b_place_order.sql and OrderSplitterService#createOrders'
   * `deferStockDeduction` option) — the counterpart to
   * restoreStockForCancelledOrder above, but with the opposite failure
   * philosophy: restoring stock on cancellation is best-effort (a failed
   * line is logged and skipped, since the order is already gone either
   * way), but deducting stock to actually fulfil an order is not — a
   * single insufficient-stock line here throws and ABORTS THE WHOLE
   * APPROVAL (the caller's transaction rolls back, the order stays
   * PENDING approval), since shipping some lines and silently dropping
   * others would be a wrong order, not a partially-restored one. Every
   * line still goes through applyStockChange() for the same
   * ORDER_DEDUCTION ledger row and cache-invalidation contract every
   * other order's stock deduction gets.
   *
   * @param {import('pg').PoolClient} client - Transactional client.
   * @param {object} params
   * @param {string} params.orderId
   * @param {Array<{shop_product_id?: string, shopProductId?: string, quantity: number, name?: string}>} params.items
   * @param {'DASHBOARD'|'ORDER'|'JOB'|'API'} params.source
   * @param {{ userId: string|null, shopRole: string|null }|null} [params.actor]
   * @returns {Promise<Array<{shopId: string, shopProduct: object, prevQty: number, newQty: number, lowStockThreshold: number, productMeta: {product_name: string|null}}>>}
   *   Stock transitions, shaped for OrderSplitterService#firePostCommitSideEffects.
   */
  async deductStockForApprovedOrder(client, { orderId, items, source, actor = null }) {
    const transitions = []
    for (const item of items || []) {
      const shopProductId = item.shopProductId || item.shop_product_id
      const quantity = Number(item.quantity)
      if (!shopProductId || !Number.isFinite(quantity) || quantity <= 0) continue

      const { stockProduct, movement } = await this.applyStockChange(client, {
        shopProductId,
        delta: -quantity,
        type: STOCK_MOVEMENT_TYPES.ORDER_DEDUCTION,
        source,
        orderId,
        actor,
      })

      transitions.push({
        shopId: stockProduct.shop_id,
        shopProduct: stockProduct,
        prevQty: Number(movement.quantity_before),
        newQty: Number(movement.quantity_after),
        lowStockThreshold: Number(stockProduct.low_stock_threshold),
        productMeta: { product_name: item.name || null },
      })
    }
    return transitions
  }

  // ────────────────────────────────────────────────────────
  // Bulk price update — price-only writes (R23.12)
  // ────────────────────────────────────────────────────────

  /**
   * Update price / sale_price / cost_price on a single shop_product
   * inside an open transaction. Caller MUST have already locked the row
   * via {@link findByIdForUpdate} so the before/after snapshot is
   * race-free with concurrent writers (R23.12, design §8.1).
   *
   * Stock fields are intentionally untouched — the bulk endpoint NEVER
   * invokes the stock_movements ledger (design §8.1 explicitly: "Bulk
   * price update never invokes [applyStockChange]; price-only changes
   * don't write stock_movements per R23 AC#12"). The DB CHECK constraint
   * on `sale_price < price` is the final defence; the schema-layer Zod
   * refinement is the friendly first layer.
   *
   * Returns null when the row was deleted between the lock and this
   * UPDATE (defensive — should be impossible while the FOR UPDATE lock
   * is held).
   *
   * @param {import('pg').PoolClient} client
   * @param {string} shopProductId
   * @param {string} shopId
   * @param {{ price?: number, sale_price?: number, cost_price?: number }} prices
   * @returns {Promise<object|null>}
   */
  async applyPriceUpdate(client, shopProductId, shopId, prices) {
    const fields = []
    const params = []
    let idx = 1

    if (prices.price !== undefined) {
      fields.push(`price = $${idx++}`)
      params.push(prices.price)
    }
    if (prices.sale_price !== undefined) {
      fields.push(`sale_price = $${idx++}`)
      params.push(prices.sale_price)
    }
    if (prices.cost_price !== undefined) {
      fields.push(`cost_price = $${idx++}`)
      params.push(prices.cost_price)
    }

    if (fields.length === 0) {
      // No-op caller; surface the locked row unchanged.
      const { rows } = await client.query(
        `SELECT ${ShopProductsRepository.SELECT_COLUMNS}
           FROM shop_products
          WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL`,
        [shopProductId, shopId]
      )
      return rows[0] || null
    }

    fields.push('updated_at = NOW()')
    params.push(shopProductId, shopId)

    const { rows } = await client.query(
      `UPDATE shop_products SET ${fields.join(', ')}
        WHERE id = $${idx} AND shop_id = $${idx + 1} AND deleted_at IS NULL
        RETURNING ${ShopProductsRepository.SELECT_COLUMNS}`,
      params
    )
    return rows[0] || null
  }

  // ────────────────────────────────────────────────────────
  // Stock movements ledger reads (R23.5)
  // ────────────────────────────────────────────────────────

  /**
   * List rows from the append-only `stock_movements` ledger for a shop,
   * optionally filtered by product, type, actor, or date range.
   *
   * Pagination is default 20 / max 100 (caller responsibility — the Zod
   * schema enforces those bounds before reaching the repo). Sort is
   * always `created_at DESC` per R23.5; the supporting indexes are
   * `idx_stock_movements_shop_created` (default) and
   * `idx_stock_movements_type` (when type is present) — see migration
   * 042.
   *
   * Joined with `products` (LEFT JOIN — products are FK NOT NULL but the
   * left join avoids a hard failure if a master row is ever archived) so
   * the response includes `product_name` for the dashboard without an
   * N+1 lookup.
   *
   * Validates: Requirement R23.5
   *
   * @param {object} filters
   * @param {string} filters.shopId         — required shop scope
   * @param {string} [filters.productId]    — filter to one shop_product
   *                                          (uses idx_stock_movements_shop_product)
   * @param {string} [filters.type]         — filter on Stock_Movement_Type
   * @param {string} [filters.actorUserId]  — filter on actor (uses
   *                                          idx_stock_movements_actor partial)
   * @param {Date}   [filters.fromDate]     — created_at >= fromDate
   * @param {Date}   [filters.toDate]       — created_at <= toDate
   * @param {number} [filters.page=1]
   * @param {number} [filters.limit=20]     — caller-bounded to ≤100
   * @returns {Promise<{items: Array, total: number}>}
   */
  async findStockMovements({
    shopId,
    productId,
    type,
    actorUserId,
    fromDate,
    toDate,
    page = 1,
    limit = 20,
  }) {
    const offset = (page - 1) * limit
    const conditions = ['sm.shop_id = $1']
    const params = [shopId]
    let idx = 2

    if (productId) {
      conditions.push(`sm.shop_product_id = $${idx++}`)
      params.push(productId)
    }
    if (type) {
      conditions.push(`sm.type = $${idx++}`)
      params.push(type)
    }
    if (actorUserId) {
      conditions.push(`sm.actor_user_id = $${idx++}`)
      params.push(actorUserId)
    }
    if (fromDate) {
      conditions.push(`sm.created_at >= $${idx++}`)
      params.push(fromDate)
    }
    if (toDate) {
      conditions.push(`sm.created_at <= $${idx++}`)
      params.push(toDate)
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT
            sm.id, sm.shop_id, sm.shop_product_id, sm.product_id,
            sm.type, sm.quantity_delta, sm.quantity_before, sm.quantity_after,
            sm.reason, sm.order_id, sm.actor_user_id, sm.actor_shop_role,
            sm.source, sm.metadata, sm.created_at,
            p.name AS product_name
           FROM stock_movements sm
           LEFT JOIN products p ON p.id = sm.product_id
          WHERE ${where}
          ORDER BY sm.created_at DESC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM stock_movements sm
          WHERE ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows,
      total: countResult.rows[0]?.total || 0,
    }
  }

  // ────────────────────────────────────────────────────────
  // Approval workflow — HQ-only (R23.10, R23.11)
  // ────────────────────────────────────────────────────────

  /**
   * Lock a shop_product row by id (no shop scope) — used by HQ approve /
   * reject endpoints which act across shops. Returns the canonical
   * column projection plus the joined product_name for audit context.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findByIdForApprovalUpdate(client, id) {
    const { rows } = await client.query(
      `SELECT ${ShopProductsRepository.SELECT_COLUMNS}
         FROM shop_products
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [id]
    )
    return rows[0] || null
  }

  /**
   * Set a shop_product to APPROVED inside an open transaction. Caller
   * MUST have locked the row via {@link findByIdForApprovalUpdate}.
   * Clears `rejection_reason` so a previously rejected row that gets
   * approved doesn't carry the stale reason forward.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @param {string} approverUserId
   * @returns {Promise<object|null>}
   */
  async setApproved(client, id, approverUserId) {
    const { rows } = await client.query(
      `UPDATE shop_products
          SET approval_status = 'APPROVED',
              approved_at = NOW(),
              approved_by = $2,
              rejection_reason = NULL,
              updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING ${ShopProductsRepository.SELECT_COLUMNS}`,
      [id, approverUserId]
    )
    return rows[0] || null
  }

  /**
   * Set a shop_product to REJECTED inside an open transaction. Caller
   * MUST have locked the row via {@link findByIdForApprovalUpdate}.
   *
   * @param {import('pg').PoolClient} client
   * @param {string} id
   * @param {string} approverUserId
   * @param {string} reason — caller-validated 10-500 char string
   * @returns {Promise<object|null>}
   */
  async setRejected(client, id, approverUserId, reason) {
    const { rows } = await client.query(
      `UPDATE shop_products
          SET approval_status = 'REJECTED',
              approved_at = NOW(),
              approved_by = $2,
              rejection_reason = $3,
              updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING ${ShopProductsRepository.SELECT_COLUMNS}`,
      [id, approverUserId, reason]
    )
    return rows[0] || null
  }
}
