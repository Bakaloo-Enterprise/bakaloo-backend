import { WalletController } from './wallet.controller.js'
import { WalletService } from './wallet.service.js'
import { WalletRepository } from './wallet.repository.js'
import {
  getWalletSchema,
  getTransactionsSchema,
  addMoneySchema,
  createTopUpSchema,
  verifyTopUpSchema,
  payFromWalletSchema,
  searchRecipientSchema,
  transferSchema,
  adminCreditSchema,
  adminDebitSchema,
} from './wallet.schema.js'

/**
 * Wallet routes plugin
 * Prefix: /api/v1/wallet
 */
export default async function walletRoutes(fastify) {
  const repository = new WalletRepository()
  const service = new WalletService(repository, fastify)
  const controller = new WalletController(service)

  // ─── Customer routes (AUTH) ─────────────────────────────

  // GET / — Get wallet balance
  fastify.get('/', {
    schema: getWalletSchema,
    preHandler: [fastify.authenticate],
  }, controller.getWallet.bind(controller))

  // GET /expiry — Expiring credits and their expiry dates
  fastify.get('/expiry', {
    schema: { tags: ['Wallet'], summary: 'Get expiring wallet credits' },
    preHandler: [fastify.authenticate],
  }, controller.getExpiry.bind(controller))

  // GET /transactions — Transaction history
  fastify.get('/transactions', {
    schema: getTransactionsSchema,
    preHandler: [fastify.authenticate],
  }, controller.getTransactions.bind(controller))

  // POST /topup — Create wallet top-up payment order
  fastify.post('/topup', {
    schema: createTopUpSchema,
    preHandler: [fastify.authenticate],
  }, controller.createTopUp.bind(controller))

  // POST /topup/verify — Verify wallet top-up payment
  fastify.post('/topup/verify', {
    schema: verifyTopUpSchema,
    preHandler: [fastify.authenticate],
  }, controller.verifyTopUp.bind(controller))

  // POST /add-money — Admin/internal only direct credit
  fastify.post('/add-money', {
    schema: addMoneySchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.addMoney.bind(controller))

  // POST /pay — Pay for an order from wallet
  fastify.post('/pay', {
    schema: payFromWalletSchema,
    preHandler: [fastify.authenticate],
  }, controller.payFromWallet.bind(controller))

  // GET /recipient/search — Search recipients by phone prefix
  fastify.get('/recipient/search', {
    schema: searchRecipientSchema,
    preHandler: [fastify.authenticate],
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
      },
    },
  }, controller.searchRecipient.bind(controller))

  // POST /transfer — Transfer to another user
  fastify.post('/transfer', {
    schema: transferSchema,
    preHandler: [fastify.authenticate],
  }, controller.transfer.bind(controller))

  // ─── Admin routes ───────────────────────────────────────

  // GET /admin/transactions — All wallet transactions [ADMIN]
  fastify.get('/admin/transactions', {
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          type: { type: 'string', enum: ['CREDIT', 'DEBIT'] },
          userId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { transactions, pagination } = await service.getAdminTransactions(request.query)
    return reply.send({
      success: true,
      message: 'Transactions fetched',
      data: transactions,
      pagination,
    })
  })

  // GET /admin/stats — Wallet overview stats [ADMIN]
  fastify.get('/admin/stats', {
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, async (request, reply) => {
    const stats = await service.getAdminStats()
    return reply.send({ success: true, message: 'Wallet stats', data: stats })
  })

  // GET /admin/resolve-user — Resolve a User ID or phone to name/phone [ADMIN]
  fastify.get('/admin/resolve-user', {
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
    schema: {
      querystring: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
    },
  }, controller.resolveUser.bind(controller))

  // POST /admin/:userId/credit — Credit a user's wallet [ADMIN]
  fastify.post('/admin/:userId/credit', {
    schema: adminCreditSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.adminCredit.bind(controller))

  // POST /admin/:userId/debit — Debit a user's wallet [ADMIN]
  fastify.post('/admin/:userId/debit', {
    schema: adminDebitSchema,
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.adminDebit.bind(controller))
}
