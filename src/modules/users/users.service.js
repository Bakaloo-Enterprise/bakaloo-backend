import { logger } from '../../config/logger.js'
import { env } from '../../config/env.js'
import { buildMediaUrl, isSelfProvider, normalizeMediaDeliveryUrl } from '../../config/media.js'
import { uploadImageWithCloudinaryFallback } from '../../utils/cloudinary-upload.js'
import { replaceMedia, saveImage } from '../../utils/media-storage.js'

/**
 * Users service — business logic for user management
 */
export class UsersService {
  constructor(repository) {
    this.repo = repository
  }

  /**
   * Get user profile
   */
  async getProfile(userId) {
    const user = await this.repo.findById(userId)
    if (!user) return null
    return this._normalizeUserMedia(user)
  }

  /**
   * Update user profile (name, email, birthday)
   */
  async updateProfile(userId, data) {
    // Reject a name that's present but blank/whitespace-only. The route
    // schema's minLength:2 counts raw characters, so "  " (two spaces)
    // would otherwise pass validation and then satisfy every "has a name"
    // check downstream (they all trim before testing) — a loophole around
    // the name-mandatory gates in orders/bulk-orders/scheduled-orders/spin.
    if (data.name !== undefined) {
      const trimmedName = data.name.trim()
      if (trimmedName.length < 2) {
        return { success: false, message: 'Name must be at least 2 characters', code: 'INVALID_NAME' }
      }
      data = { ...data, name: trimmedName }
    }

    // Check email uniqueness if email is being updated
    if (data.email) {
      const taken = await this.repo.isEmailTaken(data.email, userId)
      if (taken) {
        return { success: false, message: 'Email is already in use', code: 'EMAIL_TAKEN' }
      }
    }

    const updated = await this.repo.updateProfile(userId, data)
    return { success: true, user: this._normalizeUserMedia(updated) }
  }

  /**
   * Upload avatar to Cloudinary and update user
   */
  async uploadAvatar(userId, fileStream) {
    if (isSelfProvider()) return this._uploadAvatarSelf(userId, fileStream)
    try {
      const result = await uploadImageWithCloudinaryFallback(fileStream, {
        folder: `${env.CLOUDINARY_FOLDER}/avatars`,
        public_id: `user_${userId}`,
        overwrite: true,
        transformation: [
          { width: 300, height: 300, crop: 'fill', gravity: 'face' },
          { quality: 'auto', fetch_format: 'auto' },
        ],
      })

      const avatarUrl = buildMediaUrl(
        {
          publicId: result.public_id,
          version: result.version,
        },
        'default'
      )

      const user = await this.repo.updateAvatar(userId, avatarUrl)
      return { success: true, avatar_url: this._normalizeUserMedia(user).avatar_url }
    } catch (error) {
      logger.error({ err: error }, 'Avatar upload to Cloudinary failed')
      throw error
    }
  }

  /**
   * Self-hosted avatar. Every upload gets a fresh id (so phones and CDNs never show a stale picture), and the
   * previous avatar is released for cleanup.
   */
  async _uploadAvatarSelf(userId, fileStream) {
    const previous = (await this.repo.findById(userId))?.avatar_url
    const saved = await saveImage(fileStream, { kind: 'avatars', uploadedBy: userId })
    const avatarUrl = buildMediaUrl(saved.publicId, 'avatar')
    const user = await this.repo.updateAvatar(userId, avatarUrl)
    await replaceMedia(previous, avatarUrl).catch((err) => logger.warn({ err }, 'Could not release the old avatar'))
    return { success: true, avatar_url: this._normalizeUserMedia(user).avatar_url }
  }

  /**
   * Get user stats
   */
  async getStats(userId) {
    return this.repo.getStats(userId)
  }

  _normalizeUserMedia(user) {
    if (!user) return user

    return {
      ...user,
      avatar_url: normalizeMediaDeliveryUrl(user.avatar_url, isSelfProvider() ? 'avatar' : 'default'),
    }
  }
}
