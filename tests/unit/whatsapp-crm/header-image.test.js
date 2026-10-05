import { describe, expect, it } from 'vitest'
import { resolveHeaderImage, toWhatsappImageUrl, validateImageSource } from '../../../src/modules/whatsapp-crm/header-image.js'

const ID = '11111111-1111-1111-1111-111111111111'
const first = () => 0
const last = () => 0.999

describe('validateImageSource', () => {
  it('accepts every mode with the right data', () => {
    expect(validateImageSource({ mode: 'ONE', urls: ['https://a.com/1.jpg'] }).value).toEqual({ mode: 'ONE', urls: ['https://a.com/1.jpg'] })
    expect(validateImageSource({ mode: 'IMAGES', urls: ['https://a.com/1.jpg', 'https://a.com/1.jpg', 'https://a.com/2.jpg'] }).value.urls).toHaveLength(2)
    expect(validateImageSource({ mode: 'PRODUCTS', productIds: [ID] }).value).toEqual({ mode: 'PRODUCTS', productIds: [ID] })
    expect(validateImageSource({ mode: 'OFFER_PRODUCTS' }).value).toEqual({ mode: 'OFFER_PRODUCTS' })
    expect(validateImageSource({ mode: 'CART_PRODUCT', pick: 'RANDOM', fallbackUrl: 'https://a.com/f.jpg' }, { allowCart: true }).value).toEqual({ mode: 'CART_PRODUCT', pick: 'RANDOM', fallbackUrl: 'https://a.com/f.jpg' })
  })
  it('rejects bad input in plain words', () => {
    expect(validateImageSource({ mode: 'ONE', urls: [] }).error).toMatch(/Add the picture/)
    expect(validateImageSource({ mode: 'IMAGES', urls: ['http://a.com/1.jpg'] }).error).toMatch(/https/)
    expect(validateImageSource({ mode: 'PRODUCTS', productIds: [] }).error).toMatch(/product/)
    expect(validateImageSource({ mode: 'CART_PRODUCT' }).error).toMatch(/cart reminders/)
    expect(validateImageSource({ mode: 'NOPE' }).error).toBeTruthy()
  })
  it('treats empty as no source', () => {
    expect(validateImageSource(null).value).toBeNull()
  })
})

describe('resolveHeaderImage', () => {
  it('picks randomly from a list of uploaded pictures', async () => {
    const src = { mode: 'IMAGES', urls: ['https://a.com/1.jpg', 'https://a.com/2.jpg'] }
    expect(await resolveHeaderImage(src, { rnd: first })).toBe('https://a.com/1.jpg')
    expect(await resolveHeaderImage(src, { rnd: last })).toBe('https://a.com/2.jpg')
  })
  it('uses the cart item pictures: most valuable by default, random on request', async () => {
    const cartImages = ['https://a.com/top.jpg', 'https://a.com/second.jpg']
    expect(await resolveHeaderImage({ mode: 'CART_PRODUCT', pick: 'TOP' }, { cartImages, rnd: last })).toBe('https://a.com/top.jpg')
    expect(await resolveHeaderImage({ mode: 'CART_PRODUCT', pick: 'RANDOM' }, { cartImages, rnd: last })).toBe('https://a.com/second.jpg')
  })
  it('uses product and offer pictures', async () => {
    expect(await resolveHeaderImage({ mode: 'PRODUCTS', productIds: [ID] }, { productImages: async () => ['https://a.com/p.jpg'], rnd: first })).toBe('https://a.com/p.jpg')
    expect(await resolveHeaderImage({ mode: 'OFFER_PRODUCTS' }, { offerImages: async () => ['https://a.com/o.jpg'], rnd: first })).toBe('https://a.com/o.jpg')
  })
  it('falls back to the backup picture, or null', async () => {
    expect(await resolveHeaderImage({ mode: 'CART_PRODUCT', pick: 'TOP', fallbackUrl: 'https://a.com/f.jpg' }, { cartImages: [] })).toBe('https://a.com/f.jpg')
    expect(await resolveHeaderImage({ mode: 'CART_PRODUCT', pick: 'TOP' }, { cartImages: [] })).toBeNull()
    expect(await resolveHeaderImage(null)).toBeNull()
  })
})

describe('toWhatsappImageUrl', () => {
  it('makes Cloudinary pictures JPEG and a safe size', () => {
    expect(toWhatsappImageUrl('https://res.cloudinary.com/x/image/upload/v1/p/a.webp')).toBe('https://res.cloudinary.com/x/image/upload/f_jpg,q_auto,w_1200,c_limit/v1/p/a.webp')
  })
  it('leaves other links and already converted links alone, and refuses non-https', () => {
    expect(toWhatsappImageUrl('https://cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg')
    expect(toWhatsappImageUrl('https://res.cloudinary.com/x/image/upload/f_jpg,w_500/v1/a.png')).toBe('https://res.cloudinary.com/x/image/upload/f_jpg,w_500/v1/a.png')
    expect(toWhatsappImageUrl('http://a.com/a.jpg')).toBeNull()
  })
})
