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
import { salesReports, scopeOf } from '../reports-shared/sales-reports.js'

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
  async getGmv(shopId, filters, page, limit) { return salesReports.gmv(scopeOf(filters, [shopId]), page, limit) }

  /**
   * Orders — shop-scoped order breakdown.
   */
  async getOrders(shopId, filters, page, limit) { return salesReports.orders(scopeOf(filters, [shopId]), page, limit) }

  /**
   * Revenue — shop-scoped net revenue.
   */
  async getRevenue(shopId, filters, page, limit) { return salesReports.revenue(scopeOf(filters, [shopId]), page, limit) }

  /**
   * Refunds — shop-scoped refund data.
   */
  async getRefunds(shopId, filters, page, limit) { return salesReports.refunds(scopeOf(filters, [shopId]), page, limit) }

  /**
   * Top products — shop-scoped, ranked by quantity sold.
   */
  async getTopProducts(shopId, filters, page, limit) { return salesReports.products(scopeOf(filters, [shopId]), page, limit) }

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
  async getRiderPerformance(shopId, filters, page, limit) { return salesReports.riders(scopeOf(filters, [shopId]), page, limit, { shopShape: true }) }

  /**
   * Coupon usage — shop-scoped coupon redemption stats.
   */
  async getCouponUsage(shopId, filters, page, limit) { return salesReports.coupons(scopeOf(filters, [shopId]), page, limit) }

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
