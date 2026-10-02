import { cacheDeletePattern } from '../../utils/cache.js'
import { logger } from '../../config/logger.js'

// Same namespaces ShopProductsService busts after a price / stock edit, so the storefront never serves stale numbers.
const SHOP_PREFIX = 'bakaloo:shop-products:v1'

/** Best-effort: a cache hiccup must never undo a committed stock or price change. */
export async function invalidateCatalogCaches({ shopIds = [], productIds = [] } = {}) {
  try {
    for (const id of new Set(shopIds)) await cacheDeletePattern(`${SHOP_PREFIX}:${id}:*`)
    for (const id of new Set(productIds)) await cacheDeletePattern(`products:detail:*:${id}`)
    for (const pat of ['products:list:*', 'products:featured*', 'products:slug:*', 'products:options:*', 'bakaloo:tab_home:*', 'bakaloo:sections:public:*']) {
      await cacheDeletePattern(pat)
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Could not clear catalog caches after a procurement / bulk change')
  }
}
