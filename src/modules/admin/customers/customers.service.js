import { AdminCustomersRepository } from './customers.repository.js'
import { WalletService } from '../../wallet/wallet.service.js'
import { WalletRepository } from '../../wallet/wallet.repository.js'
import { NotificationsRepository } from '../../notifications/notifications.repository.js'
import { NotificationsService } from '../../notifications/notifications.service.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { ADDRESS_RETENTION_DAYS } from '../../addresses/addresses.service.js'
import ExcelJS from 'exceljs'

const repo = new AdminCustomersRepository()
const walletService = new WalletService(new WalletRepository())
const MS_PER_DAY = 24 * 60 * 60 * 1000

export class AdminCustomersService {
  async list({ page = 1, limit = 20, search, status, segment, sortBy, sortOrder }) {
    const offset = (page - 1) * limit
    return repo.findAll({ offset, limit, search, status, segment, sortBy, sortOrder })
  }

  async getDetail(id) {
    return repo.findById(id)
  }

  async getOrders(customerId, { page = 1, limit = 20 }) {
    const offset = (page - 1) * limit
    return repo.getCustomerOrders(customerId, { offset, limit })
  }

  async getAddresses(customerId) {
    const rows = await repo.getCustomerAddresses(customerId)
    return rows.map((row) => {
      const deletedAt = row.deleted_at
      let purgeAt = null
      let daysUntilPurge = null
      if (deletedAt) {
        purgeAt = new Date(new Date(deletedAt).getTime() + ADDRESS_RETENTION_DAYS * MS_PER_DAY)
        daysUntilPurge = Math.max(0, Math.ceil((purgeAt.getTime() - Date.now()) / MS_PER_DAY))
      }
      return {
        id: row.id,
        label: row.label,
        addressLine1: row.address_line1,
        addressLine2: row.address_line2,
        landmark: row.landmark,
        city: row.city,
        state: row.state,
        pincode: row.pincode,
        lat: row.lat != null ? parseFloat(row.lat) : null,
        lng: row.lng != null ? parseFloat(row.lng) : null,
        isDefault: row.is_default,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt,
        purgeAt,
        daysUntilPurge,
      }
    })
  }

  async getLTV() {
    return repo.getLTV()
  }

  async getChurned(days) {
    return repo.getChurned(days)
  }

  async getVIP(minOrders) {
    return repo.getVIP(minOrders)
  }

  async creditWallet(userId, amount, description, adminId, ip) {
    const result = await walletService.addMoney(userId, { amount, description })
    if (result.success) {
      logAdminActivity(adminId, 'CREDIT_WALLET', 'user', userId, null, { amount, description }, ip)
      try {
        const notifService = new NotificationsService(new NotificationsRepository(), null)
        await notifService.sendNotification(userId, {
          title: '💰 Wallet credited',
          body: `₹${amount} has been added to your wallet${description ? ` — ${description}` : ''}.`,
          type: 'WALLET',
          data: { type: 'WALLET', amount, description: description || '' },
        })
      } catch (err) {
        console.error('Wallet-credit notification failed (non-blocking):', err?.message || err)
      }
    }
    return result
  }

  async debitWallet(userId, amount, description, adminId, ip) {
    const result = await walletService.adminDebit(userId, { amount, description })
    if (result.success) {
      logAdminActivity(adminId, 'DEBIT_WALLET', 'user', userId, null, { amount, description }, ip)
      try {
        const notifService = new NotificationsService(new NotificationsRepository(), null)
        const note = description || 'Amount deducted by company'
        await notifService.sendNotification(userId, {
          title: '💸 Wallet debited',
          body: `₹${amount} has been deducted from your wallet — ${note}.`,
          type: 'WALLET',
          data: { type: 'WALLET', amount, description: description || '' },
        })
      } catch (err) {
        console.error('Wallet-debit notification failed (non-blocking):', err?.message || err)
      }
    }
    return result
  }

  async toggleBlock(userId, blocked, adminId, ip) {
    const user = await repo.toggleBlock(userId, blocked)
    logAdminActivity(adminId, blocked ? 'BLOCK_USER' : 'UNBLOCK_USER', 'user', userId, null, null, ip)
    return user
  }

  async exportCustomers() {
    const customers = await repo.getAllForExport()
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Customers')
    ws.columns = [
      { header: 'ID', key: 'id', width: 36 },
      { header: 'Name', key: 'name', width: 20 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'Email', key: 'email', width: 25 },
      { header: 'Active', key: 'is_active', width: 8 },
      { header: 'Loyalty Points', key: 'loyalty_points', width: 15 },
      { header: 'Wallet', key: 'wallet_balance', width: 10 },
      { header: 'Orders', key: 'order_count', width: 10 },
      { header: 'Total Spent', key: 'total_spent', width: 12 },
      { header: 'Joined', key: 'created_at', width: 20 },
    ]
    customers.forEach(c => ws.addRow(c))
    const buffer = await wb.csv.writeBuffer()
    return { buffer, filename: `customers-${Date.now()}.csv` }
  }

  /**
   * A message from staff to ONE customer. It is saved (so it shows in the customer's in-app inbox and in the profile's
   * history), shown live if the app is open, and sent as a phone push to every device the customer registered.
   */
  async sendPersonalNotification(userId, title, body, fastify, sender = {}) {
    const target = await repo.findById(userId)
    if (!target) throw Object.assign(new Error('Customer not found'), { statusCode: 404 })
    const svc = new NotificationsService(new NotificationsRepository(), fastify ?? null)
    const sentByName = sender.name ?? (sender.id ? await repo.userName(sender.id) : null)
    const notification = await svc.sendNotification(userId, {
      title, body, type: 'ADMIN_MESSAGE', data: { sentBy: sender.id ?? null, sentByName },
    })
    return notification
  }

  /** Notifications this customer received. `personal` = only the ones staff sent to them by hand. */
  async notificationHistory(userId, { personal = true, limit = 50 } = {}) {
    const rows = await repo.notificationHistory(userId, { personal, limit })
    return rows.map((n) => ({
      id: n.id, title: n.title, body: n.body, type: n.type, personal: n.type === 'ADMIN_MESSAGE', isRead: n.is_read, readAt: n.read_at, createdAt: n.created_at,
      sentByName: n.data?.sentByName ?? null,
    }))
  }
}
