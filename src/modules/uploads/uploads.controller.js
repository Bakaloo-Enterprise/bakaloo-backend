import http from 'node:http'
import https from 'node:https'

import { success, error } from '../../utils/apiResponse.js'
import { env } from '../../config/env.js'
import { isOwnMediaUrl } from '../../config/media.js'
import { MediaUploadError } from '../../utils/media-storage.js'
import { sweepOrphans } from '../../utils/media-sweeper.js'

/** Hostile or invalid uploads get their own clear message; everything else stays a generic upload failure. */
function uploadFailure(reply, err, fallback) {
  if (err instanceof MediaUploadError) return reply.code(err.statusCode).send(error(err.message, err.code))
  return reply.code(400).send(error(fallback, 'UPLOAD_FAILED'))
}

/**
 * Uploads controller
 */
export class UploadsController {
  constructor(service) {
    this.service = service
  }

  /**
   * POST /image — Upload single image
   */
  async uploadImage(request, reply) {
    const file = await request.file()

    if (!file) {
      return reply.code(400).send(error('No file uploaded', 'NO_FILE'))
    }

    const allowed = env.ALLOWED_IMAGE_TYPES.split(',')
    if (!allowed.includes(file.mimetype)) {
      return reply.code(400).send(error('Invalid file type. Allowed: JPEG, PNG, WebP', 'INVALID_FILE_TYPE'))
    }

    try {
      const result = await this.service.uploadImage(file.file, { kind: request.query?.kind, uploadedBy: request.user?.id })
      return reply.code(200).send(success(result, 'Image uploaded'))
    } catch (err) {
      request.log.error({ err }, 'Image upload failed in controller')
      return uploadFailure(reply, err, 'Failed to upload image. Check cloud provider credentials.')
    }
  }

  /**
   * POST /images — Upload multiple images [ADMIN]
   */
  async uploadMultipleImages(request, reply) {
    const parts = request.files()
    const files = []
    const allowed = env.ALLOWED_IMAGE_TYPES.split(',')

    for await (const part of parts) {
      if (!allowed.includes(part.mimetype)) {
        return reply.code(400).send(error(`Invalid file type: ${part.filename}`, 'INVALID_FILE_TYPE'))
      }
      files.push(part)
    }

    if (files.length === 0) {
      return reply.code(400).send(error('No files uploaded', 'NO_FILE'))
    }

    try {
      const results = await this.service.uploadMultipleImages(files, { kind: request.query?.kind, uploadedBy: request.user?.id })
      return reply.code(200).send(success(results, `${results.length} image(s) uploaded`))
    } catch (err) {
      request.log.error({ err }, 'Multiple image upload failed in controller')
      return uploadFailure(reply, err, 'Failed to upload images. Check cloud provider credentials.')
    }
  }

  async uploadFile(request, reply) {
    const data = await request.file()
    if (!data) {
      return reply.code(400).send(error('No file provided'))
    }
    try {
      const buffer = await data.toBuffer()
      const result = await this.service.uploadFile(buffer, data.filename, undefined, { uploadedBy: request.user?.id })
      return reply.code(200).send(success(result, 'File uploaded'))
    } catch (err) {
      request.log.error({ err }, 'File upload failed in controller')
      return uploadFailure(reply, err, 'Failed to upload file.')
    }
  }

  /** POST /cleanup — find unused images and move them to trash [ADMIN]. ?dryRun=true only reports. */
  async cleanup(request, reply) {
    const result = await sweepOrphans({ dryRun: `${request.query?.dryRun}` === 'true' })
    return reply.code(200).send(success({ ...result, orphans: result.orphans.slice(0, 200) }, 'Cleanup finished'))
  }

  /**
   * GET /proxy — Proxy a Cloudinary raw file (for emulator/mobile clients
   * that may have DNS issues reaching res.cloudinary.com directly).
   * Only allows proxying from Cloudinary domains.
   */
  async proxyFile(request, reply) {
    const { url, encoding } = request.query

    if (!url) {
      return reply.code(400).send(error('Missing "url" query parameter', 'MISSING_URL'))
    }

    // Security: only proxy from Cloudinary
    try {
      const parsed = new URL(url)
      if (!parsed.hostname.endsWith('cloudinary.com') && !isOwnMediaUrl(url)) {
        return reply.code(403).send(error('Only Cloudinary or our own media URLs are allowed', 'FORBIDDEN_DOMAIN'))
      }
    } catch {
      return reply.code(400).send(error('Invalid URL', 'INVALID_URL'))
    }

    try {
      const candidates = buildProxyCandidates(url)
      let lastStatus = null

      for (const candidateUrl of candidates) {
        try {
          const response = await downloadProxyCandidate(candidateUrl)
          lastStatus = response.statusCode
          if (response.statusCode < 200 || response.statusCode >= 300) {
            continue
          }

          const contentType = response.headers['content-type'] || 'application/octet-stream'
          const buffer = response.buffer

          if (buffer.length === 0) {
            request.log.warn({ candidateUrl }, 'Proxy candidate returned empty body')
            continue
          }

          if (`${encoding || ''}`.toLowerCase() === 'base64') {
            return reply.code(200).send(
              success(
                {
                  contentType,
                  base64: buffer.toString('base64'),
                },
                'Proxy file'
              )
            )
          }

          reply
            .code(200)
            .header('Content-Type', contentType)
            .header('Cache-Control', 'public, max-age=86400, immutable')
            .send(buffer)
          return
        } catch (fetchError) {
          request.log.warn({ err: fetchError, candidateUrl }, 'Proxy candidate fetch failed')
          continue
        }
      }

      return reply.code(502).send(
        error(
          lastStatus ? `Upstream returned ${lastStatus}` : 'Failed to fetch upstream file',
          'UPSTREAM_ERROR'
        )
      )
    } catch (err) {
      request.log.error({ err, url }, 'Proxy fetch failed')
      return reply.code(502).send(error('Failed to fetch upstream file', 'PROXY_FAILED'))
    }
  }

  /**
   * DELETE /image — Delete image from Cloudinary [ADMIN]
   */
  async deleteImage(request, reply) {
    const { publicId } = request.body

    if (!publicId) {
      return reply.code(400).send(error('publicId is required', 'MISSING_FIELD'))
    }

    const result = await this.service.deleteImage(publicId)

    if (!result.success) {
      return reply.code(400).send(error('Image not found or already deleted', 'DELETE_FAILED'))
    }

    return reply.code(200).send(success(null, 'Image deleted'))
  }
}

function buildProxyCandidates(rawUrl) {
  const candidates = new Set([rawUrl])

  try {
    const parsed = new URL(rawUrl)
    const pathname = parsed.pathname.toLowerCase()
    const isCloudinaryRaw = pathname.includes('/raw/upload/')
    const hasKnownExtension =
      pathname.endsWith('.lottie') || pathname.endsWith('.json')

    if (isCloudinaryRaw && !hasKnownExtension) {
      candidates.add(`${rawUrl}.lottie`)
      candidates.add(`${rawUrl}.json`)
    }
  } catch {
    return [rawUrl]
  }

  return Array.from(candidates)
}

function downloadProxyCandidate(rawUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch (error) {
      reject(error)
      return
    }

    const client = parsed.protocol === 'http:' ? http : https
    const request = client.get(
      parsed,
      {
        headers: {
          'User-Agent': 'BakalooProxy/1.0',
        },
      },
      (response) => {
        const statusCode = response.statusCode ?? 0
        const location = response.headers.location

        if (statusCode >= 300 && statusCode < 400 && location) {
          response.resume()
          if (redirectCount >= 5) {
            reject(new Error(`Too many redirects while fetching ${rawUrl}`))
            return
          }

          const nextUrl = new URL(location, parsed).toString()
          downloadProxyCandidate(nextUrl, redirectCount + 1)
            .then(resolve)
            .catch(reject)
          return
        }

        const chunks = []
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        response.on('end', () => {
          resolve({
            statusCode,
            headers: response.headers,
            buffer: Buffer.concat(chunks),
          })
        })
        response.on('error', reject)
      }
    )

    request.setTimeout(8000, () => {
      request.destroy(new Error(`Timed out while fetching ${rawUrl}`))
    })

    request.on('error', reject)
  })
}
