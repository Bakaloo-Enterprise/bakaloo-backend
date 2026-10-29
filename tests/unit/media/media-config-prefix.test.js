import { beforeAll, describe, expect, it } from 'vitest'

// Images served from a path on the API host (no new domain): https://api.bakaloo.in/media/...
process.env.MEDIA_PUBLIC_BASE_URL = 'https://api.bakaloo.in/media'
process.env.MEDIA_PROVIDER = 'self'

let media
beforeAll(async () => {
  media = await import('../../../src/config/media.js')
})

const LEGACY = 'https://res.cloudinary.com/da7zjvpey/image/upload/dpr_auto,f_auto,q_auto/v1774083031/grocery-app/products/detbhz56apipxwvrfd4b?_a=BAMAOGWQ0'
const ID = 'grocery-app/products/detbhz56apipxwvrfd4b'

describe('media base with a path prefix (api.bakaloo.in/media)', () => {
  it('builds URLs under /media', () => {
    expect(media.normalizeMediaDeliveryUrl(LEGACY, 'w640')).toBe(`https://api.bakaloo.in/media/w640/${ID}.webp`)
    expect(media.buildMediaUrl(ID, 'master')).toBe(`https://api.bakaloo.in/media/master/${ID}.webp`)
    expect(media.buildMediaUrl({ publicId: 'grocery-app/lottie/a.json', raw: true })).toBe('https://api.bakaloo.in/media/raw/grocery-app/lottie/a.json')
  })
  it('reads its own URLs back (resize, replace, delete)', () => {
    const own = `https://api.bakaloo.in/media/card/${ID}.webp`
    expect(media.publicIdFromSource(own)).toBe(ID)
    expect(media.normalizeMediaDeliveryUrl(own, 'w320')).toBe(`https://api.bakaloo.in/media/w320/${ID}.webp`)
    expect(media.publicIdFromSource(`https://api.bakaloo.in/media/private/${ID}.webp`)).toBe(ID)
  })
  it('does NOT treat other API URLs as media (no proxying of the API itself)', () => {
    expect(media.isOwnMediaUrl(`https://api.bakaloo.in/media/card/${ID}.webp`)).toBe(true)
    expect(media.isOwnMediaUrl('https://api.bakaloo.in/api/v1/orders')).toBe(false)
    expect(media.isOwnMediaUrl('https://api.bakaloo.in/mediaX/card/a.webp')).toBe(false)
    expect(media.publicIdFromSource('https://api.bakaloo.in/api/v1/orders/123')).toBeNull()
    expect(media.normalizeMediaDeliveryUrl('https://api.bakaloo.in/api/v1/x.png')).toBe('https://api.bakaloo.in/api/v1/x.png')
  })
})
