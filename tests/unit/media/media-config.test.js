import { beforeAll, describe, expect, it } from 'vitest'

process.env.MEDIA_PUBLIC_BASE_URL = 'http://127.0.0.1:58090'
process.env.MEDIA_PROVIDER = 'self'

let media
beforeAll(async () => {
  media = await import('../../../src/config/media.js')
})

const LEGACY = 'https://res.cloudinary.com/da7zjvpey/image/upload/dpr_auto,f_auto,q_auto/v1774083031/grocery-app/products/detbhz56apipxwvrfd4b?_a=BAMAOGWQ0'
const ID = 'grocery-app/products/detbhz56apipxwvrfd4b'

describe('self-hosted media URLs', () => {
  it('maps a legacy Cloudinary URL to the same file on our server', () => {
    expect(media.normalizeMediaDeliveryUrl(LEGACY)).toBe(`http://127.0.0.1:58090/master/${ID}.webp`)
    expect(media.normalizeMediaDeliveryUrl(LEGACY, 'thumb')).toBe(`http://127.0.0.1:58090/thumb/${ID}.webp`)
    expect(media.normalizeMediaDeliveryUrl(LEGACY, 'capped1080')).toBe(`http://127.0.0.1:58090/capped1080/${ID}.webp`)
  })
  it('serves width buckets and picks the smallest one that is big enough', () => {
    expect(media.buildMediaUrl(ID, 'w640')).toBe(`http://127.0.0.1:58090/w640/${ID}.webp`)
    expect(media.normalizeMediaDeliveryUrl(LEGACY, 'w1280')).toBe(`http://127.0.0.1:58090/w1280/${ID}.webp`)
    expect(media.publicIdFromSource(`http://127.0.0.1:58090/w320/${ID}.webp`)).toBe(ID)
    expect(media.bucketForWidth(1)).toBe('w160')
    expect(media.bucketForWidth(160)).toBe('w160')
    expect(media.bucketForWidth(264)).toBe('w320')   // homeProduct 132 dp x2
    expect(media.bucketForWidth(640)).toBe('w640')   // listProduct 320 dp x2
    expect(media.bucketForWidth(1040)).toBe('w1280') // detailGallery 520 dp x2
    expect(media.bucketForWidth(5000)).toBe('master')
  })
  it('accepts a bare public id and a {publicId} object', () => {
    expect(media.buildMediaUrl(ID, 'card')).toBe(`http://127.0.0.1:58090/card/${ID}.webp`)
    expect(media.buildMediaUrl({ publicId: ID }, 'icon')).toBe(`http://127.0.0.1:58090/icon/${ID}.webp`)
  })
  it('recognises our own URLs and can re-size them', () => {
    const own = `http://127.0.0.1:58090/card/${ID}.webp`
    expect(media.publicIdFromSource(own)).toBe(ID)
    expect(media.normalizeMediaDeliveryUrl(own, 'thumb')).toBe(`http://127.0.0.1:58090/thumb/${ID}.webp`)
    expect(media.isOwnMediaUrl(own)).toBe(true)
    expect(media.isOwnMediaUrl('http://evil.example/card/x.webp')).toBe(false)
  })
  it('leaves unrelated external URLs alone', () => {
    expect(media.normalizeMediaDeliveryUrl('https://cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg')
    expect(media.normalizeMediaDeliveryUrl(null)).toBeNull()
  })
  it('maps Cloudinary Lottie (raw) files to /raw/ with the extension kept', () => {
    expect(media.normalizeMediaDeliveryUrl('https://res.cloudinary.com/da7zjvpey/raw/upload/v5/grocery-app/lottie/summer.json'))
      .toBe('http://127.0.0.1:58090/raw/grocery-app/lottie/summer.json')
  })
  it('maps WhatsApp JPEG and private URLs', () => {
    expect(media.buildMediaUrl(ID, 'wa-jpeg')).toBe(`http://127.0.0.1:58090/wa-jpeg/${ID}.jpg`)
    expect(media.publicIdFromSource(`http://127.0.0.1:58090/private/${ID}.webp`)).toBe(ID)
  })
  it('refuses unsafe ids', () => {
    expect(media.sanitizePublicId('../etc/passwd')).toBeNull()
    expect(media.sanitizePublicId('a/../b')).toBeNull()
    expect(media.sanitizePublicId('a/b c')).toBeNull()
    expect(media.sanitizePublicId('grocery-app/products/abc')).toBe('grocery-app/products/abc')
    expect(media.resolveMediaPath('served', '../private/x')).toBeNull()
  })
})
