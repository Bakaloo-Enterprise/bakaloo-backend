/**
 * HQ Reports Repository — parameterized SQL queries for global reports.
 *
 * All queries use $1, $2... placeholders. No SELECT *.
 * Pagination enforced at query level with LIMIT/OFFSET.
 *
 * @module modules/admin/reports/repository
 */

import { query } from '../../../config/database.js'

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
  async getGmv(filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildFilters(filters)
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countResult = await query(
      `SELECT COUNT(DISTINCT DATE(created_at)) as total FROM orders ${where}`,
      values
    )

    const dataResult = await query(
      `SELECT DATE(created_at) as date, SUM(total_amount) as gmv, COUNT(id) as order_count
       FROM orders ${where}
       GROUP BY DATE(created_at)
       ORDER BY date DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...values, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Orders — order count and status breakdown.
   */
  async getOrders(filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildFilters(filters)
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countResult = await query(
      `SELECT COUNT(DISTINCT DATE(created_at)) as total FROM orders ${where}`,
      values
    )

    const dataResult = await query(
      `SELECT DATE(created_at) as date, status, COUNT(id) as count
       FROM orders ${where}
       GROUP BY DATE(created_at), status
       ORDER BY date DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...values, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Revenue — net revenue (total - refunds).
   */
  async getRevenue(filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildFilters(filters)
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countResult = await query(
      `SELECT COUNT(DISTINCT DATE(created_at)) as total FROM orders ${where}`,
      values
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
      [...values, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Refunds — refund amounts and counts.
   */
  async getRefunds(filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildFilters(filters)
    const baseConditions = conditions.length > 0
      ? [...conditions, "status = 'REFUNDED'"]
      : ["status = 'REFUNDED'"]
    const where = `WHERE ${baseConditions.join(' AND ')}`

    const countResult = await query(
      `SELECT COUNT(DISTINCT DATE(created_at)) as total FROM orders ${where}`,
      values
    )

    const dataResult = await query(
      `SELECT DATE(created_at) as date, COUNT(id) as refund_count, SUM(total_amount) as refund_amount
       FROM orders ${where}
       GROUP BY DATE(created_at)
       ORDER BY date DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...values, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Shop performance — per-shop order/revenue metrics.
   */
  async getShopPerformance(filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildFilters(filters)
    const prefixed = conditions.map((c) => `o.${c}`)
    const where = prefixed.length > 0 ? `WHERE ${prefixed.join(' AND ')}` : ''

    const countResult = await query(
      `SELECT COUNT(DISTINCT o.shop_id) as total FROM orders o ${where}`,
      values
    )

    const dataResult = await query(
      `SELECT o.shop_id, s.name as shop_name,
              COUNT(o.id) as order_count,
              SUM(o.total_amount) as revenue,
              AVG(o.total_amount) as avg_order_value
       FROM orders o
       JOIN shops s ON s.id = o.shop_id
       ${where}
       GROUP BY o.shop_id, s.name
       ORDER BY revenue DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...values, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Top shops — ranked by revenue.
   */
  async getTopShops(filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildFilters(filters)
    const prefixed = conditions.map((c) => `o.${c}`)
    const where = prefixed.length > 0 ? `WHERE ${prefixed.join(' AND ')}` : ''

    const countResult = await query(
      `SELECT COUNT(DISTINCT o.shop_id) as total FROM orders o ${where}`,
      values
    )

    const dataResult = await query(
      `SELECT o.shop_id, s.name as shop_name,
              SUM(o.total_amount) as total_revenue,
              COUNT(o.id) as total_orders
       FROM orders o
       JOIN shops s ON s.id = o.shop_id
       ${where}
       GROUP BY o.shop_id, s.name
       ORDER BY total_revenue DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...values, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Top products — ranked by quantity sold.
   */
  async getTopProducts(filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildFilters(filters)
    const prefixed = conditions.map((c) =>
      c.replace('created_at', 'o.created_at').replace('shop_id', 'o.shop_id')
    )
    const where = prefixed.length > 0 ? `WHERE ${prefixed.join(' AND ')}` : ''

    const countResult = await query(
      `SELECT COUNT(DISTINCT oi.product_id) as total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${where}`,
      values
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
      [...values, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

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
  async getRiderPerformance(filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildFilters(filters)
    const prefixed = conditions.map((c) =>
      c.replace('created_at', 'o.created_at').replace('shop_id', 'o.shop_id')
    )
    const riderFilter = 'o.rider_id IS NOT NULL'
    const allConditions = prefixed.length > 0
      ? [...prefixed, riderFilter]
      : [riderFilter]
    const where = `WHERE ${allConditions.join(' AND ')}`

    const countResult = await query(
      `SELECT COUNT(DISTINCT o.rider_id) as total FROM orders o ${where}`,
      values
    )

    const dataResult = await query(
      `SELECT o.rider_id, u.name AS full_name, u.phone,
              COUNT(o.id) as deliveries,
              AVG(EXTRACT(EPOCH FROM (o.delivered_at - o.assigned_at))) as avg_delivery_seconds
       FROM orders o
       JOIN users u ON u.id = o.rider_id
       ${where}
       GROUP BY o.rider_id, u.name, u.phone
       ORDER BY deliveries DESC
       LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
      [...values, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

  /**
   * Coupon usage — redemption stats per coupon.
   */
  async getCouponUsage(filters, page, limit) {
    const offset = (page - 1) * limit
    const { conditions, values, nextIndex } = this._buildFilters(filters)
    const prefixed = conditions.map((c) =>
      c.replace('created_at', 'o.created_at').replace('shop_id', 'o.shop_id')
    )
    const couponFilter = 'o.coupon_code IS NOT NULL'
    const allConditions = prefixed.length > 0
      ? [...prefixed, couponFilter]
      : [couponFilter]
    const where = `WHERE ${allConditions.join(' AND ')}`

    const countResult = await query(
      `SELECT COUNT(DISTINCT o.coupon_code) as total FROM orders o ${where}`,
      values
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
      [...values, limit, offset]
    )

    return {
      data: dataResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
    }
  }

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
