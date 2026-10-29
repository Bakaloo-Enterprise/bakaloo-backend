import path from 'node:path'

import {
  buildCloudinaryUrl,
  buildCloudinaryVariants,
  extractCloudinaryAssetInfo,
  normalizeCloudinaryDeliveryUrl,
} from './cloudinary.js'
import { env } from './env.js'

/**
 * Media URLs, for either provider.
 *
 * MEDIA_PROVIDER=cloudinary: behaves exactly as before (on-the-fly Cloudinary transforms).
 * MEDIA_PROVIDER=self:       files live on our own disk and are served by nginx as
 *                            <MEDIA_PUBLIC_BASE_URL>/<profile>/<publicId>.webp
 *                            (profile = master | icon | thumb | card | banner | detail | capped1080 | avatar).
 *
 * The publicId is the same string Cloudinary used (e.g. grocery-app/products/abc123), which is what makes the
 * migration mechanical: an old res.cloudinary.com URL still stored anywhere maps to the same file on our disk.
 */

// Width buckets (no crop, aspect kept, never upscaled): the app asks for an uncropped image at a width.
export const WIDTH_BUCKETS = [160, 320, 480, 640, 960, 1280]
export const MEDIA_PROFILES = ['icon', 'thumb', 'card', 'banner', 'detail', 'capped1080', 'avatar', ...WIDTH_BUCKETS.map((w) => `w${w}`)]

/** Smallest bucket profile with at least `pixels` of width ('master' beyond the largest). */
export function bucketForWidth(pixels) {
  const w = WIDTH_BUCKETS.find((b) => b >= pixels)
  return w ? `w${w}` : 'master'
}
const ALL_PROFILES = new Set(['master', 'wa-jpeg', ...MEDIA_PROFILES])
const PUBLIC_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

export const isSelfProvider = () => env.MEDIA_PROVIDER === 'self'
export const getMediaRoot = () => path.resolve(env.MEDIA_STORAGE_DIR)
export const getMediaBaseUrl = () => (env.MEDIA_PUBLIC_BASE_URL || '').replace(/\/+$/, '')
export const getMediaFolder = () => env.MEDIA_FOLDER || env.CLOUDINARY_FOLDER

/** Normalise a publicId; null when empty or unsafe (traversal, odd characters). */
export function sanitizePublicId(publicId) {
  if (typeof publicId !== 'string') return null
  const segments = publicId.split('/').filter(Boolean)
  if (segments.length === 0) return null
  if (!segments.every((s) => PUBLIC_ID_SEGMENT.test(s) && !s.includes('..'))) return null
  return segments.join('/')
}

/** Absolute path of <root>/<sub>/<relative>, or null if it would escape the media root. */
export function resolveMediaPath(sub, relative) {
  const root = getMediaRoot()
  const base = path.resolve(root, sub)
  const full = path.resolve(base, relative)
  return full === base || full.startsWith(base + path.sep) ? full : null
}

const isCloudinaryRaw = (value) => /^https?:\/\/res\.cloudinary\.com\/[^/]+\/raw\/upload\//i.test(value)

/** Lottie/raw files keep their extension in the id: .../raw/upload/v12/<folder>/<name.json> */
function cloudinaryRawRelative(url) {
  const segs = new URL(url).pathname.split('/').filter(Boolean)
  return segs
    .slice(segs.indexOf('upload') + 1)
    .filter((s) => !/^v\d+$/.test(s))
    .join('/')
}

function parseOwnUrl(parsed) {
  const base = getMediaBaseUrl()
  if (!base || !URL.canParse(base) || new URL(base).origin !== parsed.origin) return null
  const basePath = new URL(base).pathname.replace(/\/+$/, '')
  const rel = parsed.pathname.slice(basePath.length).split('/').filter(Boolean)
  const [first, ...rest] = rel
  if (first === 'raw') return { raw: true, publicId: rest.join('/') }
  const tail = (first === 'private' ? rest : rel.slice(1)).join('/').replace(/\.[A-Za-z0-9]{2,5}$/, '')
  if (first === 'private' || ALL_PROFILES.has(first)) return { publicId: tail, version: null, private: first === 'private' }
  return null
}

/** { publicId, version } for a Cloudinary URL, one of our URLs, a {publicId} object, or a bare publicId. */
export function extractMediaAssetInfo(source) {
  if (!source) return null
  if (typeof source === 'object') {
    // Keep the raw/private markers when an already-parsed result is passed back in.
    const info = extractCloudinaryAssetInfo(source)
    return info ? { ...info, ...(source.raw && { raw: true }), ...(source.private && { private: true }) } : null
  }
  if (typeof source !== 'string') return null
  const value = source.trim()
  if (!value) return null

  if (URL.canParse(value)) {
    const parsed = new URL(value)
    if (parsed.hostname.includes('cloudinary.com')) {
      return isCloudinaryRaw(value) ? { publicId: cloudinaryRawRelative(value), version: null, raw: true } : extractCloudinaryAssetInfo(value)
    }
    const own = parseOwnUrl(parsed)
    return own && sanitizePublicId(own.publicId) ? own : null
  }
  return extractCloudinaryAssetInfo(value)
}

export function publicIdFromSource(source) {
  const info = extractMediaAssetInfo(source)
  return info?.publicId ? sanitizePublicId(info.publicId) : null
}

/** True only for a URL under the media base (same origin AND path prefix, e.g. https://api.bakaloo.in/media/...). */
export function isOwnMediaUrl(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return false
  const base = getMediaBaseUrl()
  if (!base || !URL.canParse(base)) return false
  const b = new URL(base)
  const u = new URL(value)
  if (b.origin !== u.origin) return false
  const prefix = b.pathname.replace(/\/+$/, '')
  return prefix === '' || u.pathname === prefix || u.pathname.startsWith(`${prefix}/`)
}

export function buildMediaUrl(source, profile = 'default') {
  if (!isSelfProvider()) return buildCloudinaryUrl(source, profile)

  const info = extractMediaAssetInfo(source)
  const base = getMediaBaseUrl()
  const publicId = info?.publicId && sanitizePublicId(info.publicId)
  if (!publicId || !base) return typeof source === 'string' ? source : null
  if (info.raw) return `${base}/raw/${publicId}`
  if (info.private) return `${base}/private/${publicId}.webp`
  const dir = ALL_PROFILES.has(profile) ? profile : 'master' // "default" and unknown names -> master
  return `${base}/${dir}/${publicId}.${dir === 'wa-jpeg' ? 'jpg' : 'webp'}`
}

export function buildMediaVariants(source, profiles = ['thumb', 'card', 'detail']) {
  if (!isSelfProvider()) return buildCloudinaryVariants(source, profiles)
  const variants = {}
  for (const profile of profiles) {
    const url = buildMediaUrl(source, profile)
    if (url) variants[profile] = url
  }
  return variants
}

/**
 * Used when sending images to clients: anything we recognise (legacy Cloudinary URL, our URL, bare id) is rewritten
 * for the active provider; unrelated external URLs pass through untouched.
 */
export function normalizeMediaDeliveryUrl(source, profile = 'default') {
  if (!isSelfProvider()) return normalizeCloudinaryDeliveryUrl(source, profile)
  const info = extractMediaAssetInfo(source)
  if (!info) return typeof source === 'string' ? source : null
  return buildMediaUrl(info, profile)
}
