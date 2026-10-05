/**
 * Which picture goes in a template's image header when a message is sent.
 *
 * The template is approved by Meta once with a sample picture; the picture sent to each customer is chosen here, per
 * message. A source is plain JSON so it can live inside a workflow action or a campaign:
 *
 *   { mode: 'ONE',            urls: [u] }                    always the same picture
 *   { mode: 'IMAGES',         urls: [u1, u2, …] }            one picked at random (e.g. Navratri banners)
 *   { mode: 'PRODUCTS',       productIds: [id, …] }          the photo of a random one of these products
 *   { mode: 'OFFER_PRODUCTS' }                               the photo of a random product that is on sale right now
 *   { mode: 'CART_PRODUCT',   pick: 'TOP'|'RANDOM' } the customer's own abandoned-cart item (cart workflows)
 *   + fallbackUrl                                            used when nothing above gives a picture
 */
export const IMAGE_MODES = ['ONE', 'IMAGES', 'PRODUCTS', 'OFFER_PRODUCTS', 'CART_PRODUCT']
export const CART_PICKS = ['TOP', 'RANDOM']
export const MAX_IMAGES = 20
export const MAX_PRODUCTS = 50

const HTTPS = /^https:\/\/\S+$/

/** @returns {{ error?: string, value?: object|null }} null = no image source (the template's header is not an image, or a link is typed by hand) */
export function validateImageSource(src, { allowCart = false } = {}) {
  if (src == null || src === '') return { value: null }
  if (typeof src !== 'object') return { error: 'Choose where the picture comes from.' }
  if (!IMAGE_MODES.includes(src.mode)) return { error: 'Choose where the picture comes from.' }
  if (src.mode === 'CART_PRODUCT' && !allowCart) return { error: 'The customer’s cart picture only works for cart reminders.' }
  const urls = (Array.isArray(src.urls) ? src.urls : []).map((u) => String(u ?? '').trim()).filter(Boolean)
  if (urls.some((u) => !HTTPS.test(u) || u.length > 2000)) return { error: 'Every picture link must start with https://' }
  const fallbackUrl = String(src.fallbackUrl ?? '').trim()
  if (fallbackUrl && (!HTTPS.test(fallbackUrl) || fallbackUrl.length > 2000)) return { error: 'The backup picture link must start with https://' }
  const out = { mode: src.mode }
  if (src.mode === 'ONE') {
    if (urls.length !== 1) return { error: 'Add the picture.' }
    out.urls = urls
  } else if (src.mode === 'IMAGES') {
    if (!urls.length) return { error: 'Add at least one picture.' }
    if (urls.length > MAX_IMAGES) return { error: `At most ${MAX_IMAGES} pictures.` }
    out.urls = [...new Set(urls)]
  } else if (src.mode === 'PRODUCTS') {
    const ids = [...new Set((Array.isArray(src.productIds) ? src.productIds : []).map(String))]
    if (!ids.length) return { error: 'Choose at least one product.' }
    if (ids.length > MAX_PRODUCTS || ids.some((i) => !/^[0-9a-f-]{36}$/i.test(i))) return { error: 'Choose up to 50 products.' }
    out.productIds = ids
  } else if (src.mode === 'CART_PRODUCT') {
    out.pick = CART_PICKS.includes(src.pick) ? src.pick : 'TOP'
  }
  if (fallbackUrl) out.fallbackUrl = fallbackUrl
  return { value: out }
}

/**
 * WhatsApp only shows JPEG/PNG up to 5 MB. Our pictures live on Cloudinary, which can convert and shrink on the fly,
 * so a product photo saved as WebP or 8000 px wide still goes through.
 */
export function toWhatsappImageUrl(url) {
  const u = String(url ?? '').trim()
  if (!HTTPS.test(u)) return null
  const m = u.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/)
  if (!m) return u
  if (/^[^/]*f_(?:jpg|png)/.test(m[2])) return u // already converted
  return `${m[1]}f_jpg,q_auto,w_1200,c_limit/${m[2]}`
}

const pickOne = (list, rnd) => (list.length ? list[Math.min(list.length - 1, Math.floor(rnd() * list.length))] : null)

/**
 * @param {object|null} src
 * @param {{ cartImages?: string[], productImages?: (ids:string[]) => Promise<string[]>, offerImages?: () => Promise<string[]>, rnd?: () => number }} ctx
 *        cartImages: pictures of the customer's cart items, most valuable first.
 * @returns {Promise<string|null>} an https link WhatsApp can use, or null
 */
export async function resolveHeaderImage(src, ctx = {}) {
  if (!src) return null
  const rnd = ctx.rnd ?? Math.random
  let url = null
  switch (src.mode) {
    case 'ONE':
    case 'IMAGES':
      url = pickOne(src.urls ?? [], rnd)
      break
    case 'PRODUCTS':
      url = pickOne(ctx.productImages ? await ctx.productImages(src.productIds ?? []) : [], rnd)
      break
    case 'OFFER_PRODUCTS':
      url = pickOne(ctx.offerImages ? await ctx.offerImages() : [], rnd)
      break
    case 'CART_PRODUCT': {
      const imgs = (ctx.cartImages ?? []).filter(Boolean)
      url = src.pick === 'RANDOM' ? pickOne(imgs, rnd) : imgs[0] ?? null
      break
    }
  }
  return toWhatsappImageUrl(url) ?? toWhatsappImageUrl(src.fallbackUrl)
}
