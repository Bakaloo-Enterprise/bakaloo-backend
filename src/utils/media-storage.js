import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

import { query } from '../config/database.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import {
  MEDIA_PROFILES,
  WIDTH_BUCKETS,
  getMediaBaseUrl,
  getMediaFolder,
  getMediaRoot,
  publicIdFromSource,
  resolveMediaPath,
  sanitizePublicId,
} from '../config/media.js'

// Files are rewritten and deleted over time; a stale decode cache would serve or verify old bytes.
sharp.cache(false)

/**
 * Self-hosted image storage. Threat model: anyone who can reach an upload endpoint may send hostile bytes
 * (polyglots, payloads hidden in EXIF or trailing data, decompression bombs, truncated bodies, fake extensions).
 *
 *  1. Size cap while reading; a silently truncated multipart body is refused.
 *  2. Real type from magic bytes (JPEG / PNG / WebP only); the client's MIME type and file name are never trusted.
 *  3. Decode limits (pixels, no animation) before any work.
 *  4. Content disarm & reconstruction: the picture is decoded and RE-ENCODED to new files. EXIF/XMP/ICC, appended
 *     data and polyglot tails do not survive, only pixels. The upload itself is never stored.
 *  5. File names are generated here (random hex); the client controls no part of the path.
 *  6. Bounded concurrency and a free-disk guard so uploads cannot starve the server.
 *
 * Layout under MEDIA_STORAGE_DIR (served/ is what nginx publishes):
 *   served/master/<id>.webp, served/<profile>/<id>.webp, served/wa-jpeg/<id>.jpg, served/raw/<id>
 *   private/<id>.webp          rider KYC, proof photos (never under served/)
 *   trash/<date>/<id>/...      replaced/deleted files, kept MEDIA_TRASH_DAYS then purged
 */

export class MediaUploadError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message)
    this.name = 'MediaUploadError'
    this.code = code
    this.statusCode = statusCode
  }
}

// ─── kinds / ids ────────────────────────────────────────────────────────────
export const MEDIA_KINDS = [
  'products', 'categories', 'banners', 'themes', 'branding', 'spin-scratch', 'nav-buttons',
  'whatsapp', 'campaigns', 'avatars', 'shops', 'reviews', 'general',
]
const PRIVATE_FOLDER = /(^|\/)(riders?\/|documents?(\/|$)|proof|kyc|gst)/i
const WHATSAPP_KINDS = new Set(['whatsapp', 'campaigns'])

export const resolveKind = (kind) => (MEDIA_KINDS.includes(kind) ? kind : 'general')

function buildPublicId({ kind, folder }) {
  const id = crypto.randomBytes(10).toString('hex')
  if (folder) {
    const safe = sanitizePublicId(folder)
    if (!safe) throw new MediaUploadError('Invalid folder', 'INVALID_PATH')
    return { publicId: `${safe}/${id}`, kind: PRIVATE_FOLDER.test(safe) ? 'rider-documents' : kind, isPrivate: PRIVATE_FOLDER.test(safe) }
  }
  return { publicId: `${getMediaFolder()}/${kind}/${id}`, kind, isPrivate: false }
}

// ─── sniffing / reading ─────────────────────────────────────────────────────
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 'jpeg' | 'png' | 'webp' | null, from the first bytes only. */
export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png'
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

export async function streamToBuffer(input, maxBytes = env.MAX_FILE_SIZE) {
  const tooLarge = () => new MediaUploadError(`File too large (max ${Math.floor(maxBytes / 1024 / 1024)} MB)`, 'FILE_TOO_LARGE', 413)
  if (Buffer.isBuffer(input)) {
    if (input.length > maxBytes) throw tooLarge()
    return input
  }
  const chunks = []
  let total = 0
  for await (const chunk of input) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      input.destroy?.()
      throw tooLarge()
    }
    chunks.push(buf)
  }
  if (input.truncated) throw tooLarge()
  return Buffer.concat(chunks)
}

let active = 0
const waiting = []
async function withSlot(task) {
  if (active >= env.MEDIA_MAX_CONCURRENT_PROCESSING) await new Promise((resolve) => waiting.push(resolve))
  active++
  try {
    return await task()
  } finally {
    active--
    waiting.shift()?.()
  }
}

async function assertDiskSpace(bytes) {
  const root = getMediaRoot()
  await fs.mkdir(root, { recursive: true })
  const stats = await fs.statfs(root)
  if (Number(stats.bavail) * Number(stats.bsize) - bytes < env.MEDIA_MIN_FREE_BYTES) {
    throw new MediaUploadError('Server storage is full. Please try again later.', 'STORAGE_FULL', 503)
  }
}

async function writeAtomic(fullPath, buffer) {
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  const tmp = `${fullPath}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    await fs.writeFile(tmp, buffer, { mode: 0o644, flag: 'wx' })
    await fs.rename(tmp, fullPath)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

// ─── compression ────────────────────────────────────────────────────────────
// Same sizes as the Cloudinary profiles the backend used (cover = "fill", inside = "limit").
export const PROFILE_SPECS = {
  icon: { width: 96, height: 96, fit: 'cover', quality: 80 },
  thumb: { width: 240, height: 240, fit: 'cover', quality: 80 },
  card: { width: 640, height: 640, fit: 'cover', quality: 82 },
  banner: { width: 1440, height: 720, fit: 'cover', quality: 82 },
  detail: { width: 1280, height: 1280, fit: 'inside', quality: 85 },
  capped1080: { width: 1080, height: null, fit: 'inside', quality: 85 },
  avatar: { width: 320, height: 320, fit: 'cover', quality: 82, position: 'attention' },
}
// No-crop width buckets (see config/media.js): w160 ... w1280.
for (const w of WIDTH_BUCKETS) PROFILE_SPECS[`w${w}`] = { width: w, height: null, fit: 'inside', quality: w >= 960 ? 85 : 80 }

/** A "fill" crop never upscales a small source: a 500 px photo asked for 1440x720 becomes a 500x250 crop. */
export function targetSize(spec, srcW, srcH) {
  if (spec.fit === 'inside') return { width: spec.width, height: spec.height ?? undefined }
  const k = Math.min(1, srcW / spec.width, srcH / spec.height)
  return { width: Math.max(1, Math.round(spec.width * k)), height: Math.max(1, Math.round(spec.height * k)) }
}

const LADDER = [85, 80, 75, 70]

/**
 * Balanced compression (measured on the real product library: JPEG sources are already compressed, so a high WebP
 * quality makes them BIGGER; q80 saves ~40% with no visible change).
 *  - JPEG/WebP source: highest quality from the ladder that is not larger than the upload.
 *  - PNG / transparent: lossy q90 with a full-quality alpha channel, or lossless when that is barely bigger
 *    (logos, flat art stay crisp).
 */
export async function encodeMaster(pipeline, { needsAlpha, inputBytes, inputType }) {
  const encode = (options) => pipeline.clone().webp({ effort: 4, ...options }).toBuffer({ resolveWithObject: true })

  if (needsAlpha || inputType === 'png') {
    const lossy = await encode({ quality: 90, alphaQuality: 100, smartSubsample: true })
    const lossless = await encode({ lossless: true })
    return lossless.data.length <= lossy.data.length * 1.3 ? lossless : lossy
  }
  let best
  for (const quality of LADDER) {
    best = await encode({ quality })
    if (best.data.length <= inputBytes) break
  }
  return best
}

// ─── registry (media_assets) ────────────────────────────────────────────────
export async function registerAsset(a) {
  await query(
    `INSERT INTO media_assets (public_id, kind, resource_type, is_private, bytes, width, height, format, sha256, source, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (public_id) DO UPDATE SET status = 'active', trashed_at = NULL, purge_after = NULL, trash_dir = NULL,
       released_at = NULL, bytes = EXCLUDED.bytes, width = EXCLUDED.width, height = EXCLUDED.height,
       sha256 = EXCLUDED.sha256, updated_at = NOW()`,
    [a.publicId, a.kind, a.resourceType ?? 'image', a.isPrivate ?? false, a.bytes ?? null, a.width ?? null, a.height ?? null,
      a.format ?? null, a.sha256 ?? null, a.source ?? 'upload', a.uploadedBy ?? null],
  )
}

export async function getAsset(publicId) {
  const { rows } = await query('SELECT * FROM media_assets WHERE public_id = $1', [publicId])
  return rows[0] ?? null
}

// ─── files on disk for one asset ────────────────────────────────────────────
const profileFile = (profile, id) => [profile === 'master' ? 'master' : profile, `${id}.${profile === 'wa-jpeg' ? 'jpg' : 'webp'}`]

/** Every existing file that belongs to an asset, as paths relative to the media root. */
export async function listAssetFiles(asset) {
  const rels = []
  if (asset.resource_type === 'raw') rels.push(path.join('served', 'raw', asset.public_id))
  else if (asset.is_private) rels.push(path.join('private', `${asset.public_id}.webp`))
  else for (const p of ['master', 'wa-jpeg', ...MEDIA_PROFILES]) rels.push(path.join('served', ...profileFile(p, asset.public_id)))
  const found = []
  for (const rel of rels) {
    try {
      await fs.access(path.join(getMediaRoot(), rel))
      found.push(rel)
    } catch { /* variant was never generated */ }
  }
  return found
}

async function removeFiles(rels) {
  for (const rel of rels) await fs.unlink(path.join(getMediaRoot(), rel)).catch(() => {})
}

// ─── saving ─────────────────────────────────────────────────────────────────
/**
 * Validate, compress and store an image (master + every size profile), then register it.
 * @returns {{ publicId, kind, isPrivate, width, height, format, bytes, sha256 }}
 */
export async function saveImage(input, { kind = 'general', folder, uploadedBy = null } = {}) {
  const original = await streamToBuffer(input)
  if (original.length === 0) throw new MediaUploadError('Empty file', 'EMPTY_FILE')
  const sniffed = sniffImageType(original)
  if (!sniffed) throw new MediaUploadError('Only real JPEG, PNG or WebP images are allowed', 'INVALID_FILE_TYPE', 415)

  const decode = { limitInputPixels: env.MEDIA_MAX_INPUT_PIXELS, failOn: 'error', sequentialRead: true }
  const target = buildPublicId({ kind: resolveKind(kind), folder })
  if (!sanitizePublicId(target.publicId)) throw new MediaUploadError('Invalid image path', 'INVALID_PATH')

  let master
  const variants = []
  try {
    await withSlot(async () => {
      const meta = await sharp(original, decode).metadata()
      if (meta.format !== sniffed) throw new MediaUploadError('File content does not match an allowed image type', 'INVALID_FILE_TYPE', 415)
      if ((meta.pages ?? 1) > 1) throw new MediaUploadError('Animated images are not allowed', 'ANIMATED_IMAGE', 415)
      if (!meta.width || !meta.height) throw new MediaUploadError('Image has no dimensions', 'INVALID_IMAGE')

      const swap = (meta.orientation ?? 1) >= 5
      const src = { width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height }
      let pipeline = sharp(original, decode).rotate().resize({
        width: env.MEDIA_MAX_DIMENSION, height: env.MEDIA_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true,
      })
      if (meta.space === 'cmyk') pipeline = pipeline.toColourspace('srgb')
      const needsAlpha = meta.hasAlpha ? !(await sharp(original, decode).stats()).isOpaque : false
      master = await encodeMaster(pipeline, { needsAlpha, inputBytes: original.length, inputType: sniffed })

      if (target.isPrivate) return // KYC/proof: one private master, no public sizes
      for (const [name, spec] of Object.entries(PROFILE_SPECS)) {
        // Already narrower than this bucket: reuse the master instead of re-encoding (never enlarge).
        if (spec.fit === 'inside' && master.info.width <= spec.width && (!spec.height || master.info.height <= spec.height)) {
          variants.push([name, master.data])
          continue
        }
        const out = await sharp(original, decode).rotate()
          .resize({ ...targetSize(spec, src.width, src.height), fit: spec.fit, position: spec.position ?? 'centre', withoutEnlargement: spec.fit === 'inside' })
          .webp({ quality: spec.quality, alphaQuality: 100, effort: 4, smartSubsample: true }).toBuffer()
        variants.push([name, out])
      }
      if (WHATSAPP_KINDS.has(target.kind)) variants.push(['wa-jpeg', await toWhatsappJpeg(original, decode)])
    })
  } catch (err) {
    if (err instanceof MediaUploadError) throw err
    throw new MediaUploadError('The file is not a valid, supported image', 'INVALID_IMAGE', 422)
  }

  const stored = sniffImageType(master.data)
  if (stored !== 'webp') throw new MediaUploadError('Image could not be processed safely', 'INVALID_IMAGE', 422)

  const total = master.data.length + variants.reduce((n, [, b]) => n + b.length, 0)
  await assertDiskSpace(total)

  const written = []
  try {
    const put = async (rel, buf) => {
      const full = resolveMediaPath(rel.split(path.sep)[0], rel.split(path.sep).slice(1).join(path.sep))
      if (!full) throw new MediaUploadError('Invalid image path', 'INVALID_PATH')
      await writeAtomic(full, buf)
      written.push(rel)
    }
    if (target.isPrivate) {
      await put(path.join('private', `${target.publicId}.webp`), master.data)
    } else {
      for (const [name, buf] of variants) await put(path.join('served', ...profileFile(name, target.publicId)), buf)
      await put(path.join('served', ...profileFile('master', target.publicId)), master.data)
    }
    const sha256 = crypto.createHash('sha256').update(master.data).digest('hex')
    await registerAsset({
      publicId: target.publicId, kind: target.kind, isPrivate: target.isPrivate, bytes: master.data.length,
      width: master.info.width, height: master.info.height, format: 'webp', sha256, uploadedBy,
    })
    return { publicId: target.publicId, kind: target.kind, isPrivate: target.isPrivate, width: master.info.width, height: master.info.height, format: 'webp', bytes: master.data.length, sha256 }
  } catch (err) {
    await removeFiles(written) // never leave half an upload behind
    throw err
  }
}

async function toWhatsappJpeg(input, decode) {
  // Meta only accepts JPEG/PNG up to 5 MB, so WhatsApp headers get a flattened JPEG under 4.5 MB.
  let out
  for (const quality of [88, 80, 70, 60]) {
    out = await sharp(input, decode).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer()
    if (out.length <= 4.5 * 1024 * 1024) break
  }
  return out
}

/** Create the WhatsApp JPEG for an existing public image on demand (e.g. a product photo used as a template header). */
export async function ensureWhatsappJpeg(source) {
  const publicId = publicIdFromSource(source)
  if (!publicId) return null
  const dest = resolveMediaPath('served', path.join('wa-jpeg', `${publicId}.jpg`))
  const master = resolveMediaPath('served', path.join('master', `${publicId}.webp`))
  if (!dest || !master) return null
  try {
    await fs.access(dest)
    return publicId
  } catch { /* not generated yet */ }
  try {
    await writeAtomic(dest, await toWhatsappJpeg(await fs.readFile(master), { failOn: 'error' }))
    return publicId
  } catch (err) {
    logger.warn({ err, publicId }, 'Could not create WhatsApp JPEG')
    return null
  }
}

// ─── raw files (Lottie) ─────────────────────────────────────────────────────
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

function assertValidRaw(ext, buffer) {
  if (ext === '.lottie') {
    if (buffer.length < 4 || !buffer.subarray(0, 4).equals(ZIP_MAGIC)) throw new MediaUploadError('Not a valid .lottie file', 'INVALID_FILE_TYPE', 415)
    return
  }
  let parsed
  try {
    parsed = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''))
  } catch {
    throw new MediaUploadError('Not valid JSON', 'INVALID_FILE_TYPE', 415)
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.layers)) throw new MediaUploadError('JSON is not a Lottie animation', 'INVALID_FILE_TYPE', 415)
}

/** Lottie only (.json / .lottie), each checked by content. Served as application/json or application/zip, never HTML. */
export async function saveRawFile(input, filename, { folder = 'theme-assets', uploadedBy = null } = {}) {
  const buffer = await streamToBuffer(input)
  if (buffer.length === 0) throw new MediaUploadError('Empty file', 'EMPTY_FILE')
  const ext = path.extname(`${filename || ''}`).toLowerCase()
  if (ext !== '.json' && ext !== '.lottie') throw new MediaUploadError('Only .json and .lottie animation files are allowed', 'INVALID_FILE_TYPE', 415)
  assertValidRaw(ext, buffer)

  const base = path.basename(`${filename}`, path.extname(`${filename}`)).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'asset'
  const safeFolder = sanitizePublicId(`${getMediaFolder()}/${folder}`)
  if (!safeFolder) throw new MediaUploadError('Invalid file folder', 'INVALID_PATH')
  const publicId = `${safeFolder}/${base}-${crypto.randomBytes(4).toString('hex')}${ext}`
  const full = resolveMediaPath('served', path.join('raw', publicId))
  if (!full) throw new MediaUploadError('Invalid file path', 'INVALID_PATH')

  await assertDiskSpace(buffer.length)
  await writeAtomic(full, buffer)
  try {
    await registerAsset({ publicId, kind: 'lottie', resourceType: 'raw', bytes: buffer.length, format: ext.slice(1), sha256: crypto.createHash('sha256').update(buffer).digest('hex'), uploadedBy })
  } catch (err) {
    await fs.unlink(full).catch(() => {})
    throw err
  }
  return { publicId, url: `${getMediaBaseUrl()}/raw/${publicId}`, bytes: buffer.length }
}

// ─── trash / restore / purge ────────────────────────────────────────────────
/** Move every file of an asset into trash/. Nothing is deleted for good until purgeDue(). */
export async function trashAsset(publicId) {
  const asset = await getAsset(publicId)
  if (!asset || asset.status !== 'active') return false
  const root = getMediaRoot()
  const trashDir = path.join('trash', new Date().toISOString().slice(0, 10), publicId.replaceAll('/', '__'))
  for (const rel of await listAssetFiles(asset)) {
    const dest = path.join(root, trashDir, rel)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.rename(path.join(root, rel), dest)
  }
  await query(
    `UPDATE media_assets SET status = 'trashed', trashed_at = NOW(), purge_after = NOW() + make_interval(days => $2),
       trash_dir = $3, updated_at = NOW() WHERE public_id = $1`,
    [publicId, env.MEDIA_TRASH_DAYS, trashDir],
  )
  return true
}

export async function restoreAsset(publicId) {
  const asset = await getAsset(publicId)
  if (!asset || asset.status !== 'trashed' || !asset.trash_dir) return false
  const root = getMediaRoot()
  const dir = path.join(root, asset.trash_dir)
  for (const sub of ['served', 'private']) {
    const walk = async (d) => {
      let entries
      try { entries = await fs.readdir(d, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const from = path.join(d, e.name)
        if (e.isDirectory()) { await walk(from); continue }
        const to = path.join(root, path.relative(dir, from))
        await fs.mkdir(path.dirname(to), { recursive: true })
        await fs.rename(from, to)
      }
    }
    await walk(path.join(dir, sub))
  }
  await fs.rm(dir, { recursive: true, force: true })
  await query(`UPDATE media_assets SET status = 'active', trashed_at = NULL, purge_after = NULL, trash_dir = NULL, released_at = NULL, updated_at = NOW() WHERE public_id = $1`, [publicId])
  return true
}

/** Permanently delete trash older than MEDIA_TRASH_DAYS. */
export async function purgeDue() {
  const { rows } = await query(`SELECT public_id, trash_dir FROM media_assets WHERE status = 'trashed' AND purge_after < NOW() LIMIT 500`)
  const trashRoot = path.join(getMediaRoot(), 'trash') + path.sep
  let purged = 0
  for (const r of rows) {
    const dir = path.resolve(getMediaRoot(), r.trash_dir ?? '')
    if (r.trash_dir && dir.startsWith(trashRoot)) await fs.rm(dir, { recursive: true, force: true })
    await query(`UPDATE media_assets SET status = 'purged', updated_at = NOW() WHERE public_id = $1`, [r.public_id])
    purged++
  }
  return purged
}

/**
 * An owner replaced or removed this image (new product photo, banner deleted, avatar changed...).
 * It is only marked; the sweeper trashes it once nothing references it, so a page a customer cached a minute ago
 * does not suddenly show a broken image.
 */
export async function releaseMedia(source) {
  const publicId = publicIdFromSource(source)
  if (!publicId) return false
  const { rowCount } = await query(`UPDATE media_assets SET released_at = NOW(), updated_at = NOW() WHERE public_id = $1 AND status = 'active'`, [publicId])
  return rowCount > 0
}

/** Replace: release the old image when the new value points somewhere else. Safe to call with null/identical values. */
export async function replaceMedia(oldSource, newSource) {
  if (!oldSource) return false
  const oldId = publicIdFromSource(oldSource)
  if (!oldId || oldId === publicIdFromSource(newSource)) return false
  return releaseMedia(oldSource)
}
