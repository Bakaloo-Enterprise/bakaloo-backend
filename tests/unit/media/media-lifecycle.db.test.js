/**
 * Delete / replace / trash / restore / purge against a REAL Postgres (opt-in, throwaway database only):
 *   DB_NAME=mm_media_test MEDIA_DB_TEST=1 npx vitest run tests/unit/media/media-lifecycle.db.test.js
 * It creates its own small tables; it never touches real data.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'

const enabled = process.env.MEDIA_DB_TEST === '1'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-life-test-'))
process.env.MEDIA_PROVIDER = 'self'
process.env.MEDIA_STORAGE_DIR = root
process.env.MEDIA_PUBLIC_BASE_URL = 'http://127.0.0.1:58090'
process.env.MEDIA_MIN_FREE_BYTES = '1000'

describe.skipIf(!enabled)('media lifecycle on real Postgres', () => {
  let query, closePool, storage, sweeper, media, UploadsService
  const jpeg = (seed) => sharp({ create: { width: 400, height: 300, channels: 3, background: { r: seed % 255, g: 90, b: 150 } } }).jpeg().toBuffer()
  const up = async (seed = 1, opts = { kind: 'products' }) => (await storage.saveImage(await jpeg(seed), opts)).publicId
  const url = (id, p = 'card') => `http://127.0.0.1:58090/${p}/${id}.webp`
  const file = (...p) => path.join(root, ...p)
  const status = async (id) => (await query('SELECT status, released_at FROM media_assets WHERE public_id = $1', [id])).rows[0]
  const age = (id, { hours = 0, releasedMinutes = null } = {}) =>
    query(`UPDATE media_assets SET created_at = NOW() - make_interval(hours => $2),
           released_at = CASE WHEN $3::int IS NULL THEN released_at ELSE NOW() - make_interval(mins => $3::int) END WHERE public_id = $1`, [id, hours, releasedMinutes])

  beforeAll(async () => {
    ;({ query, closePool } = await import('../../../src/config/database.js'))
    storage = await import('../../../src/utils/media-storage.js')
    sweeper = await import('../../../src/utils/media-sweeper.js')
    media = await import('../../../src/config/media.js')
    ;({ UploadsService } = await import('../../../src/modules/uploads/uploads.service.js'))
    const sql = fs.readFileSync(path.resolve('src/database/migrations/172_media_assets.sql'), 'utf8')
    await query(sql)
    await query('CREATE TABLE IF NOT EXISTS t_products (id serial PRIMARY KEY, name text, thumbnail_url text, images jsonb)')
    await query('CREATE TABLE IF NOT EXISTS t_themes (id serial PRIMARY KEY, theme_data jsonb)')
    await query('CREATE TABLE IF NOT EXISTS t_riders (id serial PRIMARY KEY, aadhar_url text)')
    await query('CREATE TABLE IF NOT EXISTS media_url_rewrite_log (id serial PRIMARY KEY, old_value text, new_value text)')
  })
  beforeEach(async () => {
    await query('TRUNCATE t_products, t_themes, t_riders, media_url_rewrite_log; TRUNCATE media_assets')
  })
  afterAll(async () => {
    await query('DROP TABLE IF EXISTS t_products, t_themes, t_riders, media_url_rewrite_log')
    await closePool?.()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('an image a saved product uses is never trashed, however old', async () => {
    const id = await up()
    await query('INSERT INTO t_products (name, thumbnail_url) VALUES ($1, $2)', ['Butter', url(id)])
    await age(id, { hours: 100 })
    const r = await sweeper.sweepOrphans()
    expect(r.trashed).toBe(0)
    expect((await status(id)).status).toBe('active')
    expect(fs.existsSync(file('served', 'card', `${id}.webp`))).toBe(true)
  })

  it('REPLACE: the old product image goes to trash, the new one stays', async () => {
    const oldId = await up(1)
    const newId = await up(2)
    await query('INSERT INTO t_products (name, thumbnail_url) VALUES ($1, $2)', ['Butter', url(oldId)])
    await query('UPDATE t_products SET thumbnail_url = $1', [url(newId)]) // admin saves a new photo
    expect(await storage.replaceMedia(url(oldId), url(newId))).toBe(true)
    expect(await storage.replaceMedia(url(newId), url(newId))).toBe(false) // same image: nothing released
    await age(oldId, { releasedMinutes: 120 })

    const r = await sweeper.sweepOrphans()
    expect(r.trashed).toBe(1)
    expect((await status(oldId)).status).toBe('trashed')
    expect((await status(newId)).status).toBe('active')
    expect(fs.existsSync(file('served', 'master', `${oldId}.webp`))).toBe(false) // gone from the public tree
    expect(fs.existsSync(file('served', 'master', `${newId}.webp`))).toBe(true)
    const { trash_dir } = (await query('SELECT trash_dir FROM media_assets WHERE public_id = $1', [oldId])).rows[0]
    expect(fs.existsSync(file(trash_dir, 'served', 'master', `${oldId}.webp`))).toBe(true) // recoverable
  })

  it('the migrator undo log (which stores every URL) does not keep an image alive', async () => {
    const id = await up()
    await query('INSERT INTO media_url_rewrite_log (old_value, new_value) VALUES ($1, $2)', ['https://res.cloudinary.com/x', url(id)])
    await age(id, { hours: 30 })
    expect((await sweeper.sweepOrphans()).trashed).toBe(1)
  })

  it('a just-released image survives until the release grace has passed (cached pages keep working)', async () => {
    const id = await up()
    await storage.releaseMedia(url(id))
    await age(id, { releasedMinutes: 1 })
    expect((await sweeper.sweepOrphans()).trashed).toBe(0)
    expect((await status(id)).status).toBe('active')
  })

  it('an upload nobody saved yet is left alone for 24h, then trashed', async () => {
    const id = await up()
    expect((await sweeper.sweepOrphans()).trashed).toBe(0)
    await age(id, { hours: 30 })
    expect((await sweeper.sweepOrphans()).trashed).toBe(1)
    expect((await status(id)).status).toBe('trashed')
  })

  it('DELETE: removing a product frees its image; a still-used image is kept', async () => {
    const a = await up(1), b = await up(2)
    await query('INSERT INTO t_products (thumbnail_url, images) VALUES ($1, $2)', [url(a), JSON.stringify([url(b, 'detail')])])
    await query('DELETE FROM t_products')
    await query('INSERT INTO t_products (thumbnail_url) VALUES ($1)', [url(b)]) // b is still used by another product
    const svc = new UploadsService()
    await svc.deleteImage(url(a))
    await svc.deleteImage(url(b))
    await age(a, { releasedMinutes: 90 }); await age(b, { releasedMinutes: 90 })
    await sweeper.sweepOrphans()
    expect((await status(a)).status).toBe('trashed')
    expect((await status(b)).status).toBe('active')
  })

  it('finds images referenced inside JSON (theme data) and Lottie files by URL', async () => {
    const img = await up(3, { kind: 'themes' })
    const lottie = await storage.saveRawFile(Buffer.from('{"layers":[]}'), 'summer.json')
    await query('INSERT INTO t_themes (theme_data) VALUES ($1)', [JSON.stringify({ sections: { searchZone: { promoBoxImageUrl: url(img, 'master') }, bannerAnimation: { lottieUrl: lottie.url } } })])
    await age(img, { hours: 100 }); await age(lottie.publicId, { hours: 100 })
    const r = await sweeper.sweepOrphans()
    expect(r.trashed).toBe(0)
    expect(fs.existsSync(file('served', 'raw', lottie.publicId))).toBe(true)
  })

  it('self-heals: a trashed image that something points at again is restored', async () => {
    const id = await up()
    await age(id, { hours: 30 })
    await sweeper.sweepOrphans()
    expect((await status(id)).status).toBe('trashed')
    await query('INSERT INTO t_products (thumbnail_url) VALUES ($1)', [url(id)]) // an old form saved late
    const r = await sweeper.sweepOrphans()
    expect(r.restored).toBe(1)
    expect((await status(id)).status).toBe('active')
    expect(fs.existsSync(file('served', 'card', `${id}.webp`))).toBe(true)
  })

  it('purges trash after the retention period and only then deletes for good', async () => {
    const id = await up()
    await age(id, { hours: 30 })
    await sweeper.sweepOrphans()
    const { trash_dir } = (await query('SELECT trash_dir FROM media_assets WHERE public_id = $1', [id])).rows[0]
    expect(await storage.purgeDue()).toBe(0) // not due yet
    expect(fs.existsSync(file(trash_dir))).toBe(true)
    await query(`UPDATE media_assets SET purge_after = NOW() - INTERVAL '1 day' WHERE public_id = $1`, [id])
    expect(await storage.purgeDue()).toBe(1)
    expect(fs.existsSync(file(trash_dir))).toBe(false)
    expect((await status(id)).status).toBe('purged')
  })

  it('private rider documents move to trash from private/ and are protected while referenced', async () => {
    const doc = await up(5, { folder: 'grocery-app/riders/abc/documents' })
    await query('INSERT INTO t_riders (aadhar_url) VALUES ($1)', [`http://127.0.0.1:58090/private/${doc}.webp`])
    await age(doc, { hours: 100 })
    expect((await sweeper.sweepOrphans()).trashed).toBe(0)
    await query('DELETE FROM t_riders')
    expect((await sweeper.sweepOrphans()).trashed).toBe(1)
    expect(fs.existsSync(file('private', `${doc}.webp`))).toBe(false)
  })

  it('safety brake: a sweep that would trash most files aborts instead', async () => {
    const ids = []
    for (let i = 0; i < 25; i++) ids.push(await up(i))
    for (const id of ids) await age(id, { hours: 100 })
    const r = await sweeper.sweepOrphans()
    expect(r.aborted).toBe('too-many-orphans')
    expect(r.trashed).toBe(0)
    expect(media.isSelfProvider()).toBe(true)
  }, 120000)
})
