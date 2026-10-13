import { success, error } from '../../utils/apiResponse.js'

/**
 * Wallet controller — thin HTTP layer
 */
export class WalletController {
  constructor(service) {
    this.service = service
  }

  /**
   * Get wallet balance
   */
  async getWallet(request, reply) {
    const wallet = await this.service.getWallet(request.user.id)
    return reply.send(success(wallet, 'Wallet fetched'))
  }

  /**
   * Get the customer's expiring credits and when each expires
   */
  async getExpiry(request, reply) {
    const data = await this.service.getExpiryDetails(request.user.id)
    return reply.send(success(data, 'Wallet expiry fetched'))
  }

  /**
   * Get wallet transactions
   */
  async getTransactions(request, reply) {
    const { transactions, pagination } = await this.service.getTransactions(
      request.user.id,
      request.query
    )
    return reply.send(success(transactions, 'Transactions fetched', { pagination }))
  }

  /**
   * Create a Razorpay order for wallet top-up
   */
  async createTopUp(request, reply) {
    const result = await this.service.createTopUp(request.user.id, request.body.amount)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'TOPUP_CREATE_FAILED'))
    }
    return reply.send(success(result.data, 'Top-up order created'))
  }

  /**
   * Verify top-up payment and credit wallet
   */
  async verifyTopUp(request, reply) {
    const result = await this.service.verifyTopUp(request.user.id, request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'TOPUP_VERIFY_FAILED'))
    }
    return reply.send(
      success({ wallet: result.wallet, transaction: result.transaction }, 'Wallet credited')
    )
  }

  /**
   * Admin/internal only: add money to wallet directly
   */
  async addMoney(request, reply) {
    const result = await this.service.addMoney(request.user.id, request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'WALLET_FAILED'))
    }
    return reply.send(
      success({ wallet: result.wallet, transaction: result.transaction }, 'Money added')
    )
  }

  /**
   * Pay for order from wallet
   */
  async payFromWallet(request, reply) {
    const result = await this.service.payFromWallet(request.user.id, request.body.orderId)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'WALLET_PAY_FAILED'))
    }
    return reply.send(
      success({ wallet: result.wallet, transaction: result.transaction }, 'Payment successful')
    )
  }

  /**
   * Search users by phone number prefix (recipient picker)
   */
  async searchRecipient(request, reply) {
    const results = await this.service.searchRecipient(request.user.id, request.query.q)
    return reply.send(success(results, 'Recipients fetched'))
  }

  /**
   * Transfer money to another user
   */
  async transfer(request, reply) {
    const result = await this.service.transfer(request.user.id, request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'TRANSFER_FAILED'))
    }
    return reply.send(
      success({ wallet: result.wallet, transaction: result.transaction }, 'Transfer successful')
    )
  }

  /**
   * Admin: credit user wallet
   */
  async adminCredit(request, reply) {
    const result = await this.service.adminCredit(request.params.userId, request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'CREDIT_FAILED'))
    }
    return reply.send(
      success({ wallet: result.wallet, transaction: result.transaction }, 'Wallet credited')
    )
  }

  /**
   * Admin: resolve a User ID or phone number to the matching user's
   * name/phone, for the Credit/Debit dialogs' confirmation caption.
   */
  async resolveUser(request, reply) {
    const user = await this.service.resolveUser(request.query.query)
    if (!user) {
      return reply.code(404).send(error('No user found', 'USER_NOT_FOUND'))
    }
    return reply.send(success(user, 'User found'))
  }

  /**
   * Admin: debit user wallet
   */
  async adminDebit(request, reply) {
    const result = await this.service.adminDebit(request.params.userId, request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'DEBIT_FAILED'))
    }
    return reply.send(
      success({ wallet: result.wallet, transaction: result.transaction }, 'Wallet debited')
    )
  }
}
