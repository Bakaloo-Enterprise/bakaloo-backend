import { AdminController } from './admin.controller.js'
import { AdminService } from './admin.service.js'
import { AdminRepository } from './admin.repository.js'
import {
  getAllUsersSchema,
  updateUserRoleSchema,
  blockUserSchema,
  getSettingsSchema,
  updateSettingsSchema,
} from './admin.schema.js'

// New sub-modules
import adminAuthRoutes from './auth/auth.routes.js'
import featuresRoutes from '../features/features.routes.js'
import adminDashboardRoutes from './dashboard/dashboard.routes.js'
import adminOrderRoutes from './orders/orders.routes.js'
import adminRefundRequestsRoutes from './refund-requests/refund-requests.routes.js'
import adminProductRoutes from './products/products.routes.js'
import adminCustomerRoutes from './customers/customers.routes.js'
import adminAbandonedCartsRoutes from './abandoned-carts/abandoned-carts.routes.js'
import adminWhatsappCrmRoutes from './whatsapp-crm/whatsapp-crm.routes.js'
import procurementRoutes from '../procurement/procurement.routes.js'
import catalogBulkRoutes from '../catalog-bulk/catalog-bulk.routes.js'
import businessAnalyticsRoutes from '../business-analytics/business-analytics.routes.js'
import adminTeamChatRoutes from './team-chat/team-chat.routes.js'
import adminCustomerSegmentsRoutes from './customer-segments/customer-segments.routes.js'
import adminAreaSegmentsRoutes from './area-segments/area-segments.routes.js'
import adminRiderRoutes from './riders/riders.routes.js'
import adminNotificationRoutes from './notifications/notifications.routes.js'
import adminAnalyticsRoutes from './analytics/analytics.routes.js'
import adminBannerRoutes from './banners/banners.routes.js'
import adminNavButtonRoutes from './nav-buttons/nav-buttons.routes.js'
import adminTutorialRoutes from './tutorials/tutorials.routes.js'
import adminActivityLogRoutes from './activity-log/activity-log.routes.js'
import adminCustomerActivityRoutes from './customer-activity/customer-activity.routes.js'
import { roleRoutes, teamRoutes } from './team/team.routes.js'
import adminThemeRoutes from './themes/themes.routes.js'
import adminThemeTabRoutes from './theme-tabs/theme-tabs.routes.js'
import adminSectionRoutes from './sections/sections.routes.js'
import adminLegalPagesRoutes from './legal-pages/legal-pages.routes.js'
import adminBrandingRoutes from './branding/branding.routes.js'
import adminBusinessAccountsRoutes from './business-accounts/business-accounts.routes.js'
import adminLedgerRoutes from './ledger/ledger.routes.js'

/**
 * Admin routes plugin
 * Prefix: /api/v1/admin
 * All routes require ADMIN role
 */
export default async function adminRoutes(fastify) {
  const repository = new AdminRepository()
  const service = new AdminService(repository)
  const controller = new AdminController(service)

  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

  // ─── Legacy endpoints (kept for backwards compatibility) ───

  // Users management (not replicated in new sub-modules)
  fastify.get('/users', {
    schema: getAllUsersSchema,
    preHandler: adminAuth,
  }, controller.getAllUsers.bind(controller))

  fastify.patch('/users/:id/role', {
    schema: updateUserRoleSchema,
    preHandler: adminAuth,
  }, controller.updateUserRole.bind(controller))

  fastify.put('/users/:id/block', {
    schema: blockUserSchema,
    preHandler: adminAuth,
  }, controller.blockUser.bind(controller))

  // Settings (not replicated)
  fastify.get('/settings', {
    schema: getSettingsSchema,
    preHandler: adminAuth,
  }, controller.getSettings.bind(controller))

  fastify.put('/settings', {
    preHandler: adminAuth,
  }, controller.updateSettings.bind(controller))

  // ─── New Sub-Modules ────────────────────────────────
  fastify.register(adminAuthRoutes, { prefix: '/auth' })
  fastify.register(featuresRoutes)
  fastify.register(adminDashboardRoutes, { prefix: '/dashboard' })
  fastify.register(adminOrderRoutes, { prefix: '/orders' })
  fastify.register(adminRefundRequestsRoutes, { prefix: '/refund-requests' })
  fastify.register(adminBusinessAccountsRoutes, { prefix: '/business-accounts' })
  fastify.register(adminLedgerRoutes, { prefix: '/ledger' })
  fastify.register(adminProductRoutes, { prefix: '/products' })
  fastify.register(adminCustomerRoutes, { prefix: '/customers' })
  fastify.register(adminAbandonedCartsRoutes, { prefix: '/abandoned-carts' })
  fastify.register(adminWhatsappCrmRoutes, { prefix: '/crm' })
  fastify.register(procurementRoutes, { prefix: '/procurement' })
  fastify.register(catalogBulkRoutes, { prefix: '/catalog-bulk' })
  fastify.register(businessAnalyticsRoutes, { prefix: '/business-analytics' })
  fastify.register(adminTeamChatRoutes, { prefix: '/chat' })
  fastify.register(adminCustomerSegmentsRoutes, { prefix: '/customer-segments' })
  fastify.register(adminAreaSegmentsRoutes, { prefix: '/area-segments' })
  fastify.register(adminRiderRoutes, { prefix: '/riders' })
  fastify.register(adminNotificationRoutes, { prefix: '/notifications' })
  fastify.register(adminAnalyticsRoutes, { prefix: '/analytics' })
  fastify.register(adminBannerRoutes, { prefix: '/banners' })
  fastify.register(adminNavButtonRoutes, { prefix: '/nav-buttons' })
  fastify.register(adminTutorialRoutes, { prefix: '/tutorials' })
  fastify.register(adminActivityLogRoutes, { prefix: '/activity-log' })
  fastify.register(adminCustomerActivityRoutes, { prefix: '/customer-activity' })
  fastify.register(roleRoutes, { prefix: '/roles' })
  fastify.register(teamRoutes, { prefix: '/team' })
  fastify.register(adminThemeRoutes, { prefix: '/themes' })
  fastify.register(adminThemeTabRoutes, { prefix: '/theme-tabs' })
  fastify.register(adminSectionRoutes, { prefix: '/sections' })
  fastify.register(adminLegalPagesRoutes, { prefix: '/legal-pages' })
  fastify.register(adminBrandingRoutes, { prefix: '/branding' })
}
