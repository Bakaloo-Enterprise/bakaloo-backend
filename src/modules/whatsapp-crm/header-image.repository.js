import { query } from '../../config/database.js'

/** Where product pictures come from. Read-only. */
export class HeaderImageRepository {
  /** Photos of these products (active ones only), thumbnail first. */
  async productImages(ids) {
    if (!ids?.length) return []
    const { rows } = await query(
      `SELECT COALESCE(NULLIF(thumbnail_url, ''), images->>0) AS url FROM products WHERE id = ANY($1::uuid[]) AND is_active = true`,
      [ids],
    )
    return rows.map((r) => r.url).filter(Boolean)
  }

  /** Photos of in-stock products that are on sale right now (sale price below the normal price). */
  async offerImages(limit = 60) {
    const { rows } = await query(
      `SELECT COALESCE(NULLIF(thumbnail_url, ''), images->>0) AS url
         FROM products
        WHERE is_active = true AND stock_quantity > 0 AND sale_price IS NOT NULL AND sale_price < price
        ORDER BY total_sold DESC LIMIT $1`,
      [limit],
    )
    return rows.map((r) => r.url).filter(Boolean)
  }

  /** Photos of what the customer left in their cart, biggest line first. */
  async cartImages(cartId) {
    const { rows } = await query(
      `SELECT product_thumbnail_url AS url FROM abandoned_cart_items WHERE abandoned_cart_id = $1 AND product_thumbnail_url IS NOT NULL ORDER BY line_total DESC`,
      [cartId],
    )
    return rows.map((r) => r.url)
  }
}
