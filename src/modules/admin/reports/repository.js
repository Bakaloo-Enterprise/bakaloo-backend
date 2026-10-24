/**
 * HQ Reports Repository — parameterized SQL queries for global reports.
 *
 * All queries use $1, $2... placeholders. No SELECT *.
 * Pagination enforced at query level with LIMIT/OFFSET.
 *
 * @module modules/admin/reports/repository
 */

import { query } from '../../../config/database.js'
import { salesReports, scopeOf } from '../../reports-shared/sales-reports.js'

export class AdminReportsRepository {
  /**
   * Parse common filter params into SQL conditions and values.
   * @param {object} filters
   * @param {string} [filters.from]
   * @param {string} [filters.to]
   * @param {string[]} [filters.shopIds]
   * @param {number} startParamIndex
   * @returns {{ conditions: string[], values: any[], nextIndex: number }}
   */
  _buildFilters(filters, startParamIndex = 1) {
    const conditions = []
    const values = []
    let idx = startParamIndex

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
    if (filters.shopIds && filters.shopIds.length > 0) {
      conditions.push(`shop_id = ANY($${idx})`)
      values.push(filters.shopIds)
      idx++
    }

    return { conditions, values, nextIndex: idx }
  }

  /**
   * GMV — total gross merchandise value from orders.
   */
  async getGmv(filters, page, limit) { return salesReports.gmv(scopeOf(filters, filters.shopIds), page, limit) }

  /**
   * Orders — order count and status breakdown.
   */
  async getOrders(filters, page, limit) { return salesReports.orders(scopeOf(filters, filters.shopIds), page, limit) }

  /**
   * Revenue — net revenue (total - refunds).
   */
  async getRevenue(filters, page, limit) { return salesReports.revenue(scopeOf(filters, filters.shopIds), page, limit) }

  /**
   * Refunds — refund amounts and counts.
   */
  async getRefunds(filters, page, limit) { return salesReports.refunds(scopeOf(filters, filters.shopIds), page, limit) }

  /**
   * Shop performance — per-shop order/revenue metrics.
   */
  async getShopPerformance(filters, page, limit) { return salesReports.stores(scopeOf(filters, filters.shopIds), page, limit) }

  /**
   * Top shops — ranked by revenue.
   */
  async getTopShops(filters, page, limit) { return salesReports.stores(scopeOf(filters, filters.shopIds), page, limit, { topShape: true }) }

  /**
   * Top products — ranked by quantity sold.
   */
  async getTopProducts(filters, page, limit) { return salesReports.products(scopeOf(filters, filters.shopIds), page, limit) }

  /**
   * Low stock — products with stock below threshold.
   */
  async getLowStock(filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildFilters(filters)
    const prefixed = conditions.map((c) => c.replace('created_at', 'sp.created_at'))
    const stockConditions = [...prefixed, 'sp.stock_quantity <= 10']
    if (filters.shopIds && filters.shopIds.length > 0) {
      // shop_id filter already in conditions via _buildFilters, just prefix it
      const idx = stockConditions.findIndex((c) => c.includes('shop_id'))
      if (idx >= 0) {
        stockConditions[idx] = stockConditions[idx].replace('shop_id', 'sp.shop_id')
      }
    }
    const where = `WHERE ${stockConditions.join(' AND ')}`

    const countResult = await query(
      `SELECT COUNT(*) as total FROM shop_products sp ${where}`,
      values
    )

    const dataResult = await query(
      `SELECT sp.id, sp.shop_id, s.name as shop_name,
              sp.product_id, p.name as product_name,
              sp.stock_quantity AS stock, sp.price
       FROM shop_products sp
       JOIN shops s ON s.id = sp.shop_id
       JOIN products p ON p.id = sp.product_id
       ${where}
       ORDER BY sp.stock_quantity ASC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...values, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Rider performance — delivery metrics per rider.
   */
  async getRiderPerformance(filters, page, limit) { return salesReports.riders(scopeOf(filters, filters.shopIds), page, limit) }

  /**
   * Coupon usage — redemption stats per coupon.
   */
  async getCouponUsage(filters, page, limit) { return salesReports.coupons(scopeOf(filters, filters.shopIds), page, limit) }

  /**
   * Payouts — shop payout summary from shop_transactions.
   */
  async getPayouts(filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildFilters(filters)
    const prefixed = conditions.map((c) => c.replace('created_at', 'st.created_at').replace('shop_id', 'st.shop_id'))
    const payoutConditions = [...prefixed, "st.type = 'payout'"]
    const where = `WHERE ${payoutConditions.join(' AND ')}`

    const countResult = await query(
      `SELECT COUNT(*) as total FROM shop_transactions st ${where}`,
      values
    )

    const dataResult = await query(
      `SELECT st.id, st.shop_id, s.name as shop_name,
              st.amount, st.status, st.created_at
       FROM shop_transactions st
       JOIN shops s ON s.id = st.shop_id
       ${where}
       ORDER BY st.created_at DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...values, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Customer acquisition — new user registrations over time.
   * NOTE: This endpoint retains PII (full_name, phone, email).
   */
  async getCustomerAcquisition(filters, page, limit) {
    const offset = (page - 1) * limit
    const conditions = []
    const values = []
    let idx = 1

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
    // shop_ids filter not applicable to users table

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countResult = await query(
      `SELECT COUNT(*) as total FROM users ${where}`,
      values
    )

    const dataResult = await query(
      `SELECT id, name AS full_name, phone, email, created_at
       FROM users
       ${where}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }
}
