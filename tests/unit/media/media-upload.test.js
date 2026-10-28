import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

/**
 * Self-hosted upload pipeline: hostile files are refused, real images are re-encoded (never stored as sent),
 * compressed without growing, and every size profile is written. No database needed: the registry is faked.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-upload-test-'))
process.env.MEDIA_PROVIDER = 'self'
process.env.MEDIA_STORAGE_DIR = root
process.env.MEDIA_PUBLIC_BASE_URL = 'http://127.0.0.1:58090'
process.env.MEDIA_MIN_FREE_BYTES = '1000'
process.env.MEDIA_MAX_INPUT_PIXELS = '4000000'
process.env.MAX_FILE_SIZE = String(2 * 1024 * 1024)

const queryMock = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
vi.mock('../../../src/config/database.js', () => ({ query: (...a) => queryMock(...a), pool: {} }))

let storage
beforeAll(async () => {
  storage = await import('../../../src/utils/media-storage.js')
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const noise = (w, h, channels = 3) => {
  const data = Buffer.alloc(w * h * channels)
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + ((i / 7) | 0) * 17) & 0xff
  return sharp(data, { raw: { width: w, height: h, channels } })
}
const exists = (...p) => fs.existsSync(path.join(root, ...p))
const rejects = async (input, code, status) => {
  const err = await storage.saveImage(input, { kind: 'products' }).catch((e) => e)
  expect(err).toBeInstanceOf(storage.MediaUploadError)
  expect(err.code).toBe(code)
  if (status) expect(err.statusCode).toBe(status)
}

describe('hostile uploads are refused', () => {
  it('rejects a script renamed to .jpg (content, not name, decides)', async () => {
    await rejects(Buffer.from('<?php system($_GET["c"]); ?>'), 'INVALID_FILE_TYPE', 415)
  })
  it('rejects SVG, GIF and PDF by magic bytes', async () => {
    await rejects(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'INVALID_FILE_TYPE')
    await rejects(Buffer.from('GIF89a\x01\x00\x01\x00'), 'INVALID_FILE_TYPE')
    await rejects(Buffer.from('%PDF-1.7 ...'), 'INVALID_FILE_TYPE')
  })
  it('rejects empty and oversize files', async () => {
    await rejects(Buffer.alloc(0), 'EMPTY_FILE')
    await rejects(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024)]), 'FILE_TOO_LARGE', 413)
  })
  it('rejects a truncated JPEG', async () => {
    const jpeg = await noise(800, 600).jpeg({ quality: 90 }).toBuffer()
    await rejects(jpeg.subarray(0, Math.floor(jpeg.length / 3)), 'INVALID_IMAGE', 422)
  })
  it('rejects a decompression bomb (too many pixels)', async () => {
    const big = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: '#fff' } }).png().toBuffer() // 9 Mpx > 4 Mpx limit
    await rejects(big, 'INVALID_IMAGE', 422)
  })
  it('rejects path traversal in a client-supplied folder', async () => {
    const jpeg = await noise(100, 100).jpeg().toBuffer()
    const err = await storage.saveImage(jpeg, { folder: '../../etc' }).catch((e) => e)
    expect(err.code).toBe('INVALID_PATH')
  })
  it('rejects a Lottie that is really HTML, and non-animation extensions', async () => {
    await expect(storage.saveRawFile(Buffer.from('<html><script>1</script></html>'), 'x.json')).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' })
    await expect(storage.saveRawFile(Buffer.from('{"layers":[]}'), 'x.svg')).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' })
    await expect(storage.saveRawFile(Buffer.from('{"nope":1}'), 'x.json')).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' })
  })
})

describe('real uploads are re-encoded, compressed and sized', () => {
  it('drops a payload appended to a valid JPEG and strips EXIF text', async () => {
    const jpeg = await noise(600, 400).jpeg({ quality: 85 }).withExif({ IFD0: { Copyright: 'SECRET-OWNER-NAME' } }).toBuffer()
    const polyglot = Buffer.concat([jpeg, Buffer.from('<?php system($_GET["c"]); ?>')])
    const saved = await storage.saveImage(polyglot, { kind: 'products' })
    const master = fs.readFileSync(path.join(root, 'served', 'master', `${saved.publicId}.webp`))
    expect(master.toString('latin1')).not.toContain('system(')
    expect(master.toString('latin1')).not.toContain('SECRET-OWNER-NAME')
    expect(storage.sniffImageType(master)).toBe('webp')
  })

  it('never makes a JPEG upload bigger, and writes master + every profile', async () => {
    const jpeg = await noise(1600, 1200).jpeg({ quality: 92 }).toBuffer()
    const saved = await storage.saveImage(jpeg, { kind: 'products' })
    expect(saved.publicId).toMatch(/^grocery-app\/products\/[0-9a-f]{20}$/)
    expect(saved.bytes).toBeLessThanOrEqual(jpeg.length)
    for (const p of ['master', 'icon', 'thumb', 'card', 'banner', 'detail', 'capped1080', 'avatar', 'w160', 'w320', 'w480', 'w640', 'w960', 'w1280']) {
      expect(exists('served', p, `${saved.publicId}.webp`), p).toBe(true)
    }
    // width buckets keep the 4:3 shape (no square crop) and never enlarge
    const b320 = await sharp(path.join(root, 'served', 'w320', `${saved.publicId}.webp`)).metadata()
    expect([b320.width, b320.height]).toEqual([320, 240])
    const b1280 = await sharp(path.join(root, 'served', 'w1280', `${saved.publicId}.webp`)).metadata()
    expect([b1280.width, b1280.height]).toEqual([1280, 960])
    expect(exists('served', 'wa-jpeg', `${saved.publicId}.jpg`)).toBe(false) // only for WhatsApp kinds
    expect(queryMock.mock.calls.at(-1)[0]).toContain('INSERT INTO media_assets')
  })

  it('a picture narrower than a bucket reuses the master instead of being enlarged', async () => {
    const jpeg = await noise(300, 200).jpeg().toBuffer()
    const saved = await storage.saveImage(jpeg, { kind: 'products' })
    const w1280 = await sharp(path.join(root, 'served', 'w1280', `${saved.publicId}.webp`)).metadata()
    const master = await sharp(path.join(root, 'served', 'master', `${saved.publicId}.webp`)).metadata()
    expect([w1280.width, w1280.height]).toEqual([master.width, master.height])
    expect(fs.statSync(path.join(root, 'served', 'w1280', `${saved.publicId}.webp`)).size)
      .toBe(fs.statSync(path.join(root, 'served', 'master', `${saved.publicId}.webp`)).size)
  })

  it('applies EXIF rotation and never upscales a small crop', async () => {
    const jpeg = await noise(300, 200).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const saved = await storage.saveImage(jpeg, { kind: 'banners' })
    expect([saved.width, saved.height]).toEqual([200, 300])
    const banner = await sharp(path.join(root, 'served', 'banner', `${saved.publicId}.webp`)).metadata()
    expect(banner.width).toBeLessThanOrEqual(200) // 1440x720 asked, source is 200 wide: not enlarged
  })

  it('keeps transparency for a transparent PNG', async () => {
    const png = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.3 } } }).png().toBuffer()
    const saved = await storage.saveImage(png, { kind: 'categories' })
    const meta = await sharp(path.join(root, 'served', 'master', `${saved.publicId}.webp`)).metadata()
    expect(meta.hasAlpha).toBe(true)
  })

  it('makes a JPEG copy under 5 MB for WhatsApp kinds only', async () => {
    const jpeg = await noise(900, 900).jpeg().toBuffer()
    const saved = await storage.saveImage(jpeg, { kind: 'whatsapp' })
    const wa = fs.statSync(path.join(root, 'served', 'wa-jpeg', `${saved.publicId}.jpg`))
    expect(wa.size).toBeLessThan(5 * 1024 * 1024)
  })

  it('stores rider documents privately: one file, never under served/', async () => {
    const jpeg = await noise(500, 500).jpeg().toBuffer()
    const saved = await storage.saveImage(jpeg, { folder: 'grocery-app/riders/abc/documents' })
    expect(saved.isPrivate).toBe(true)
    expect(exists('private', `${saved.publicId}.webp`)).toBe(true)
    expect(exists('served', 'master', `${saved.publicId}.webp`)).toBe(false)
    expect(exists('served', 'thumb', `${saved.publicId}.webp`)).toBe(false)
  })

  it('cleans up completely when the registry write fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'))
    const jpeg = await noise(300, 300).jpeg().toBuffer()
    const before = fs.readdirSync(path.join(root, 'served', 'master', 'grocery-app', 'products')).length
    await expect(storage.saveImage(jpeg, { kind: 'products' })).rejects.toThrow('db down')
    expect(fs.readdirSync(path.join(root, 'served', 'master', 'grocery-app', 'products')).length).toBe(before)
  })

  it('stores a valid Lottie with a generated name', async () => {
    const saved = await storage.saveRawFile(Buffer.from('{"v":"5","layers":[]}'), '../../evil name.json')
    expect(saved.publicId).toMatch(/^grocery-app\/theme-assets\/evil_name-[0-9a-f]{8}\.json$/)
    expect(saved.url).toBe(`http://127.0.0.1:58090/raw/${saved.publicId}`)
    expect(exists('served', 'raw', saved.publicId)).toBe(true)
  })
})
