import { buildMediaUrl, isOwnMediaUrl, isSelfProvider } from '../../config/media.js'
import { ensureWhatsappJpeg } from '../../utils/media-storage.js'

/**
 * Meta only accepts JPEG/PNG (≤ 5 MB) for image headers, and our public images are WebP. For one of our own images
 * this makes sure a JPEG copy exists (created on first use) and returns its link; anything else is returned as is.
 */
export async function whatsappSendableUrl(url) {
  if (!url || !isSelfProvider() || !isOwnMediaUrl(url)) return url
  const id = await ensureWhatsappJpeg(url)
  return id ? buildMediaUrl(id, 'wa-jpeg') : url
}
