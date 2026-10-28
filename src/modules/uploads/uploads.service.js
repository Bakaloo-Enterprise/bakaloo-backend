import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import {
  buildCloudinaryUrl,
  buildCloudinaryVariants,
  cloudinary,
} from '../../config/cloudinary.js'
import { buildMediaUrl, buildMediaVariants, getMediaBaseUrl, isSelfProvider, publicIdFromSource } from '../../config/media.js'
import { uploadImageWithCloudinaryFallback } from '../../utils/cloudinary-upload.js'
import { releaseMedia, saveImage, saveRawFile } from '../../utils/media-storage.js'

/**
 * Uploads service. MEDIA_PROVIDER=cloudinary keeps the old Cloudinary behaviour; MEDIA_PROVIDER=self stores
 * everything on our own disk (see utils/media-storage.js).
 */
export class UploadsService {
  /**
   * Upload a single image.
   * @param {ReadableStream|Buffer} fileStream
   * @param {object} options - { folder, publicId, kind, uploadedBy }
   */
  async uploadImage(fileStream, { folder, publicId, kind, uploadedBy } = {}) {
    if (isSelfProvider()) return this._uploadImageSelf(fileStream, { folder, kind, uploadedBy })

    try {
      const result = await uploadImageWithCloudinaryFallback(fileStream, {
        folder: folder || `${env.CLOUDINARY_FOLDER}/products`,
        public_id: publicId,
        resource_type: 'image',
        transformation: [
          { quality: 'auto', fetch_format: 'auto' },
        ],
      })

      const asset = {
        publicId: result.public_id,
        version: result.version,
      }

      return {
        url: buildCloudinaryUrl(asset, 'default'),
        originalUrl: result.secure_url,
        publicId: result.public_id,
        width: result.width,
        height: result.height,
        format: result.format,
        bytes: result.bytes,
        variants: buildCloudinaryVariants(asset),
      }
    } catch (error) {
      logger.error({ err: error }, 'Cloudinary upload failed')
      throw error
    }
  }

  async _uploadImageSelf(fileStream, { folder, kind, uploadedBy }) {
    const saved = await saveImage(fileStream, { kind, folder, uploadedBy })
    if (saved.isPrivate) {
      // KYC / proof photos: not part of the public tree. The long random id is the capability, as it was on Cloudinary.
      const url = `${getMediaBaseUrl()}/private/${saved.publicId}.webp`
      return { url, originalUrl: url, publicId: saved.publicId, width: saved.width, height: saved.height, format: saved.format, bytes: saved.bytes, variants: {}, private: true }
    }
    const url = buildMediaUrl(saved.publicId, 'default')
    return {
      url,
      originalUrl: url,
      publicId: saved.publicId,
      width: saved.width,
      height: saved.height,
      format: saved.format,
      bytes: saved.bytes,
      variants: buildMediaVariants(saved.publicId),
    }
  }

  /**
   * Upload multiple images
   * @param {Array<{ file: ReadableStream, filename: string }>} files
   * @param {{ kind?: string, uploadedBy?: string }} options
   */
  async uploadMultipleImages(files, { kind, uploadedBy } = {}) {
    const results = []
    for (const file of files) {
      const result = await this.uploadImage(file.file, {
        folder: isSelfProvider() ? undefined : `${env.CLOUDINARY_FOLDER}/products`,
        kind: kind || 'products',
        uploadedBy,
      })
      results.push(result)
    }
    return results
  }

  async uploadFile(fileBuffer, filename, folder = 'bakaloo/theme-assets', { uploadedBy } = {}) {
    if (isSelfProvider()) return saveRawFile(fileBuffer, filename, { folder: 'theme-assets', uploadedBy })

    const safeFilename = `${filename || 'asset'}`
      .trim()
      .replace(/[^\w.-]+/g, '_')

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          folder,
          public_id: safeFilename,
        },
        (err, result) => {
          if (err) reject(err)
          else resolve({ url: result.secure_url, publicId: result.public_id })
        }
      )
      stream.end(fileBuffer)
    })
  }

  /**
   * Delete an image by public id (or URL).
   * Self-hosted: the file is released, then moved to a 30-day trash by the sweeper as soon as nothing references it
   * (an image still used by a saved product is never removed, even if an admin clicks delete in a form).
   */
  async deleteImage(publicId) {
    if (isSelfProvider()) {
      const id = publicIdFromSource(publicId)
      const released = id ? await releaseMedia(id) : false
      logger.info({ publicId: id, released }, 'Image released for cleanup')
      return { success: released }
    }
    try {
      const result = await cloudinary.uploader.destroy(publicId)
      logger.info({ publicId, result: result.result }, 'Image deleted from Cloudinary')
      return { success: result.result === 'ok' }
    } catch (err) {
      logger.error({ err, publicId }, 'Failed to delete image from Cloudinary')
      throw err
    }
  }
}
