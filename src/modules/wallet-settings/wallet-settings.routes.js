import { WalletSettingsController } from './wallet-settings.controller.js'
import { WalletSettingsService } from './wallet-settings.service.js'
import { WalletSettingsRepository } from './wallet-settings.repository.js'

/**
 * Wallet Settings admin routes plugin.
 * Prefix: /api/v1/admin/wallet-settings
 *
 *   GET  /  — fetch effective wallet balance/transfer limits
 *   PUT  /  — update the global limits
 */
export default async function walletSettingsRoutes(fastify) {
  const repository = new WalletSettingsRepository()
  const service = new WalletSettingsService(repository)
  const controller = new WalletSettingsController(service)
  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  fastify.get('/', {
    schema: { tags: ['Wallet Settings'], summary: 'Get wallet balance/transfer limits' },
    preHandler: adminAuth,
  }, controller.get.bind(controller))

  fastify.put('/', {
    schema: {
      tags: ['Wallet Settings'],
      summary: 'Update wallet balance/transfer limits',
      body: {
        type: 'object',
        properties: {
          maxWalletBalance: { type: 'number', minimum: 1 },
          maxTransferAmount: { type: 'number', minimum: 1 },
          minTransferAmount: { type: 'number', minimum: 1 },
          transfersEnabled: { type: 'boolean' },
          topupEnabled: { type: 'boolean' },
          expiryEnabled: { type: 'boolean' },
          expirySpinDays: { type: 'integer', minimum: 0, maximum: 3650 },
          expiryScratchDays: { type: 'integer', minimum: 0, maximum: 3650 },
          expiryCouponDays: { type: 'integer', minimum: 0, maximum: 3650 },
          expiryOfferDays: { type: 'integer', minimum: 0, maximum: 3650 },
          expiryAdminDays: { type: 'integer', minimum: 0, maximum: 3650 },
          expiryReminderDays: { type: 'integer', minimum: 0, maximum: 3650 },
        },
      },
    },
    preHandler: adminAuth,
  }, controller.update.bind(controller))
}
