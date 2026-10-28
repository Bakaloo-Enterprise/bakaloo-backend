import { AdminBannersRepository } from './banners.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { normalizeMediaDeliveryUrl } from '../../../config/media.js'
import { getStoreStatusService } from '../../store-status/store-status.routes.js'
import { cacheGet, cacheSet, cacheDeletePattern } from '../../../utils/cache.js'

const repo = new AdminBannersRepository()

// Every other public theme endpoint (getActiveTheme, getTabThemes,
// getTabHomeContent, getSectionManifest) is Redis cache-aside; this one
// was going straight to Postgres on every single home-screen load. Keyed
// per-user (falling back to 'anon') rather than just audience/placement,
// same convention as getTabHomeCacheKey's per-customer `scope` — segment
// targeting means two users in the same audience can legitimately see
// different banners, so caching by audience alone risks leaking a
// segment-exclusive banner to someone outside that segment.
const BANNERS_PUBLIC_CACHE_PREFIX = 'bakaloo:banners:public'
const BANNERS_PUBLIC_CACHE_TTL = 60

function getBannersPublicCacheKey(audience, placement, isOpen, userId) {
  return `${BANNERS_PUBLIC_CACHE_PREFIX}:${placement}:${audience}:${isOpen ? 'open' : 'closed'}:${userId || 'anon'}`
}

export class AdminBannersService {
  constructor(storeStatusService = null) {
    this._storeStatusService = storeStatusService
  }

  get storeStatusService() {
    return this._storeStatusService || getStoreStatusService()
  }

  async list() {
    return this._normalizeBanners(await repo.findAll())
  }

  async getById(id) {
    return this._normalizeBanner(await repo.findById(id))
  }

  async create(data, adminId, ip) {
    const mapped = {
      title: data.title,
      subtitle: data.subtitle,
      imageUrl: data.imageUrl,
      ctaText: data.linkType !== 'none' ? data.linkType : null,
      ctaLink: data.linkType !== 'none' ? data.linkValue : null,
      bannerType: data.bannerType === 'carousel' ? 'hero' : (data.bannerType || 'hero'),
      isActive: data.isActive,
      startDate: data.startDate,
      endDate: data.endDate,
      triggerType: data.triggerType,
      audience: data.audience,
      placement: data.placement,
      targetSegmentId: data.targetSegmentId,
      imageWidth: data.imageWidth,
      imageHeight: data.imageHeight,
    }
    const banner = await repo.create(mapped)
    logAdminActivity(adminId, 'CREATE_BANNER', 'banner', banner.id, null, null, ip)
    await cacheDeletePattern(`${BANNERS_PUBLIC_CACHE_PREFIX}:*`)
    return this._normalizeBanner(banner)
  }

  async update(id, data, adminId, ip) {
    const mapped = {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.imageUrl !== undefined && { imageUrl: data.imageUrl }),
      ...(data.linkType !== undefined && { ctaText: data.linkType !== 'none' ? data.linkType : null }),
      ...(data.linkValue !== undefined && { ctaLink: data.linkValue }),
      ...(data.bannerType !== undefined && { bannerType: data.bannerType === 'carousel' ? 'hero' : data.bannerType }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
      ...(data.startDate !== undefined && { startDate: data.startDate }),
      ...(data.endDate !== undefined && { endDate: data.endDate }),
      ...(data.triggerType !== undefined && { triggerType: data.triggerType }),
      ...(data.audience !== undefined && { audience: data.audience }),
      ...(data.placement !== undefined && { placement: data.placement }),
      ...(data.targetSegmentId !== undefined && { targetSegmentId: data.targetSegmentId }),
      ...(data.imageWidth !== undefined && { imageWidth: data.imageWidth }),
      ...(data.imageHeight !== undefined && { imageHeight: data.imageHeight }),
    }
    const banner = await repo.update(id, mapped)
    logAdminActivity(adminId, 'UPDATE_BANNER', 'banner', id, null, null, ip)
    await cacheDeletePattern(`${BANNERS_PUBLIC_CACHE_PREFIX}:*`)
    return this._normalizeBanner(banner)
  }

  async remove(id, adminId, ip) {
    const ok = await repo.remove(id)
    if (ok) {
      logAdminActivity(adminId, 'DELETE_BANNER', 'banner', id, null, null, ip)
      await cacheDeletePattern(`${BANNERS_PUBLIC_CACHE_PREFIX}:*`)
    }
    return ok
  }

  async reorder(orderedIds, adminId, ip) {
    await repo.reorder(orderedIds)
    logAdminActivity(adminId, 'REORDER_BANNERS', 'banner', null, null, { count: orderedIds.length }, ip)
    await cacheDeletePattern(`${BANNERS_PUBLIC_CACHE_PREFIX}:*`)
    return true
  }

  async getActive() {
    return this._normalizeBanners(await repo.findActive())
  }

  /**
   * Public-facing banner list filtered by each banner's trigger_type against
   * the current store-open/closed state — 'ALWAYS' banners always included,
   * 'STORE_CLOSED' banners only included while the store is closed — and by
   * audience (B2C/B2B viewer sees their own banners plus every 'ALL' one).
   */
  async getActiveForStoreStatus(audience = 'B2C', placement = 'HOME', userId = null) {
    const { isOpen } = await this.storeStatusService.isOpen()
    const cacheKey = getBannersPublicCacheKey(audience, placement, isOpen, userId)

    const cached = await cacheGet(cacheKey)
    if (cached) return cached

    const banners = this._normalizeBanners(
      await repo.findActiveForStoreStatus(isOpen, audience, placement, userId)
    )
    await cacheSet(cacheKey, banners, BANNERS_PUBLIC_CACHE_TTL)
    return banners
  }

  _normalizeBanners(banners = []) {
    return banners.map((banner) => this._normalizeBanner(banner))
  }

  _normalizeBanner(banner) {
    if (!banner) return banner

    return {
      ...banner,
      image_url: normalizeMediaDeliveryUrl(banner.image_url, 'w1280'),
    }
  }
}
