/**
 * Shop Reports Repository — parameterized SQL queries for shop-scoped reports.
 *
 * All queries are scoped to a specific shop_id ($1).
 * All queries use parameterized placeholders. No SELECT *.
 * Pagination enforced at query level with LIMIT/OFFSET.
 *
 * @module modules/shop-reports/repository
 */

import { query } from '../../config/database.js'

export class ShopReportsRepository {
  /**
   * Build date filter conditions starting from a given param index.
   * Shop ID is always $1.
   * @param {object} filters
   * @param {number} startIdx
   * @returns {{ conditions: string[], values: any[], nextIndex: number }}
   */
  _buildDateFilters(filters, startIdx = 2) {
    const conditions = []
    const values = []
    let idx = startIdx

    if (filters.from) {
      conditions.push(`created_at >= $${idx}`)
      values.push(filters.from)
      idx++
    }
    if (filters.to) {
      conditions.push(`created_at < ($${idx}::date + interval '1 day')`)
      values.push(filters.to)
      idx++
    }

    return { conditions, values, nextIndex: idx }
  }

  /**
   * GMV — shop-scoped gross merchandise value.
   */
  async getGmv(shopId, filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildDateFilters(filters)
    const allConditions = ['shop_id = $1', ...conditions]
    const where = `WHERE ${allConditions.join(' AND ')}`
    const allValues = [shopId, ...values]

    const countResult = await query(
      `SELECT COUNT(DISTINCT DATE(created_at)) as total FROM orders ${where}`,
      allValues
    )

    const dataResult = await query(
      `SELECT DATE(created_at) as date, SUM(total_amount) as gmv, COUNT(id) as order_count
       FROM orders ${where}
       GROUP BY DATE(created_at)
       ORDER BY date DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...allValues, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Orders — shop-scoped order breakdown.
   */
  async getOrders(shopId, filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildDateFilters(filters)
    const allConditions = ['shop_id = $1', ...conditions]
    const where = `WHERE ${allConditions.join(' AND ')}`
    const allValues = [shopId, ...values]

    const countResult = await query(
      `SELECT COUNT(DISTINCT DATE(created_at)) as total FROM orders ${where}`,
      allValues
    )

    const dataResult = await query(
      `SELECT DATE(created_at) as date, status, COUNT(id) as count
       FROM orders ${where}
       GROUP BY DATE(created_at), status
       ORDER BY date DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...allValues, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Revenue — shop-scoped net revenue.
   */
  async getRevenue(shopId, filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildDateFilters(filters)
    const allConditions = ['shop_id = $1', ...conditions]
    const where = `WHERE ${allConditions.join(' AND ')}`
    const allValues = [shopId, ...values]

    const countResult = await query(
      `SELECT COUNT(DISTINCT DATE(created_at)) as total FROM orders ${where}`,
      allValues
    )

    const dataResult = await query(
      `SELECT DATE(created_at) as date,
              SUM(total_amount) as gross_revenue,
              SUM(CASE WHEN status = 'REFUNDED' THEN total_amount ELSE 0 END) as refunded,
              SUM(CASE WHEN status != 'REFUNDED' THEN total_amount ELSE 0 END) as net_revenue
       FROM orders ${where}
       GROUP BY DATE(created_at)
       ORDER BY date DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...allValues, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Refunds — shop-scoped refund data.
   */
  async getRefunds(shopId, filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildDateFilters(filters)
    const allConditions = ['shop_id = $1', ...conditions, "status = 'REFUNDED'"]
    const where = `WHERE ${allConditions.join(' AND ')}`
    const allValues = [shopId, ...values]

    const countResult = await query(
      `SELECT COUNT(DISTINCT DATE(created_at)) as total FROM orders ${where}`,
      allValues
    )

    const dataResult = await query(
      `SELECT DATE(created_at) as date, COUNT(id) as refund_count, SUM(total_amount) as refund_amount
       FROM orders ${where}
       GROUP BY DATE(created_at)
       ORDER BY date DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...allValues, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Top products — shop-scoped, ranked by quantity sold.
   */
  async getTopProducts(shopId, filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildDateFilters(filters)
    const prefixed = conditions.map((c) => c.replace('created_at', 'o.created_at'))
    const allConditions = ['o.shop_id = $1', ...prefixed]
    const where = `WHERE ${allConditions.join(' AND ')}`
    const allValues = [shopId, ...values]

    const countResult = await query(
      `SELECT COUNT(DISTINCT oi.product_id) as total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${where}`,
      allValues
    )

    const dataResult = await query(
      `SELECT oi.product_id, p.name as product_name,
              SUM(oi.quantity) as total_quantity,
              SUM(oi.price * oi.quantity) as total_revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       ${where}
       GROUP BY oi.product_id, p.name
       ORDER BY total_quantity DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...allValues, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Low stock — shop-scoped products with stock <= 10.
   */
  async getLowStock(shopId, filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildDateFilters(filters)
    const prefixed = conditions.map((c) => c.replace('created_at', 'sp.created_at'))
    const allConditions = ['sp.shop_id = $1', ...prefixed, 'sp.stock_quantity <= 10']
    const where = `WHERE ${allConditions.join(' AND ')}`
    const allValues = [shopId, ...values]

    const countResult = await query(
      `SELECT COUNT(*) as total FROM shop_products sp ${where}`,
      allValues
    )

    const dataResult = await query(
      `SELECT sp.id, sp.product_id, p.name as product_name, sp.stock_quantity AS stock, sp.price
       FROM shop_products sp
       JOIN products p ON p.id = sp.product_id
       ${where}
       ORDER BY sp.stock_quantity ASC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...allValues, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Staff activity — actions by shop staff members.
   */
  async getStaffActivity(shopId, filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildDateFilters(filters)
    const prefixed = conditions.map((c) => c.replace('created_at', 'al.created_at'))
    const allConditions = ['al.actor_shop_id = $1', ...prefixed]
    const where = `WHERE ${allConditions.join(' AND ')}`
    const allValues = [shopId, ...values]

    const countResult = await query(
      `SELECT COUNT(*) as total FROM audit_logs al ${where}`,
      allValues
    )

    const dataResult = await query(
      `SELECT al.actor_user_id, u.name as staff_name,
              al.action, COUNT(*) as action_count,
              MAX(al.created_at) as last_activity
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.actor_user_id
       ${where}
       GROUP BY al.actor_user_id, u.name, al.action
       ORDER BY action_count DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...allValues, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Rider performance — shop-scoped delivery metrics.
   */
  async getRiderPerformance(shopId, filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildDateFilters(filters)
    const prefixed = conditions.map((c) => c.replace('created_at', 'o.created_at'))
    const allConditions = ['o.shop_id = $1', ...prefixed, 'o.rider_id IS NOT NULL']
    const where = `WHERE ${allConditions.join(' AND ')}`
    const allValues = [shopId, ...values]

    const countResult = await query(
      `SELECT COUNT(DISTINCT o.rider_id) as total FROM orders o ${where}`,
      allValues
    )

    const dataResult = await query(
      `SELECT o.rider_id, u.name as rider_name,
              COUNT(o.id) as deliveries,
              AVG(EXTRACT(EPOCH FROM (o.delivered_at - o.assigned_at))) as avg_delivery_seconds
       FROM orders o
       JOIN users u ON u.id = o.rider_id
       ${where}
       GROUP BY o.rider_id, u.name
       ORDER BY deliveries DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...allValues, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Coupon usage — shop-scoped coupon redemption stats.
   */
  async getCouponUsage(shopId, filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildDateFilters(filters)
    const prefixed = conditions.map((c) => c.replace('created_at', 'o.created_at'))
    const allConditions = ['o.shop_id = $1', ...prefixed, 'o.coupon_code IS NOT NULL']
    const where = `WHERE ${allConditions.join(' AND ')}`
    const allValues = [shopId, ...values]

    const countResult = await query(
      `SELECT COUNT(DISTINCT o.coupon_code) as total FROM orders o ${where}`,
      allValues
    )

    const dataResult = await query(
      `SELECT c.id AS coupon_id, o.coupon_code AS coupon_code,
              COUNT(o.id) as usage_count,
              SUM(o.discount_amount) as total_discount
       FROM orders o
       LEFT JOIN coupons c ON c.code = o.coupon_code
       ${where}
       GROUP BY c.id, o.coupon_code
       ORDER BY usage_count DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...allValues, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Settlement — shop-scoped transaction/payout history.
   */
  async getSettlement(shopId, filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildDateFilters(filters)
    const prefixed = conditions.map((c) => c.replace('created_at', 'st.created_at'))
    const allConditions = ['st.shop_id = $1', ...prefixed]
    const where = `WHERE ${allConditions.join(' AND ')}`
    const allValues = [shopId, ...values]

    const countResult = await query(
      `SELECT COUNT(*) as total FROM shop_transactions st ${where}`,
      allValues
    )

    const dataResult = await query(
      `SELECT st.id, st.type, st.amount, st.status, st.reference_id, st.created_at
       FROM shop_transactions st
       ${where}
       ORDER BY st.created_at DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...allValues, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }
}
