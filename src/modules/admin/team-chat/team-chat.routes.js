import { TeamChatController } from './team-chat.controller.js'
import { CHAT_PERM } from '../../team-chat/chat.js'
import * as S from './team-chat.schema.js'

const ctrl = new TeamChatController()

/**
 * Internal team chat — mounted at /api/v1/admin/chat.
 *
 * Open to every active dashboard user (chat.use is implicit). What each person may do inside a chat
 * (rename, add people, archive…) and whether a chat exists for them at all is decided in
 * team-chat/chat.service.js from their membership.
 */
export default async function adminTeamChatRoutes(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  const route = (method, url, schema, handler) =>
    fastify[method](url, { schema, config: { requiredPermission: CHAT_PERM.USE } }, handler.bind(ctrl))

  route('get', '/me', undefined, ctrl.me)
  route('get', '/people', S.peopleSchema, ctrl.people)
  route('get', '/unread', undefined, ctrl.unread)
  route('get', '/refs', S.refsSchema, ctrl.refs)

  route('get', '/channels', S.listChannelsSchema, ctrl.list)
  route('post', '/channels', S.createChannelSchema, ctrl.create)
  route('get', '/channels/:id', S.channelIdSchema, ctrl.get)
  route('patch', '/channels/:id', S.updateChannelSchema, ctrl.update)
  route('post', '/channels/:id/members', S.addMembersSchema, ctrl.addMembers)
  route('delete', '/channels/:id/members/:userId', S.removeMemberSchema, ctrl.removeMember)
  route('post', '/channels/:id/archive', S.channelIdSchema, ctrl.archive)
  route('post', '/channels/:id/unarchive', S.channelIdSchema, ctrl.unarchive)
  route('post', '/channels/:id/refresh-audience', S.channelIdSchema, ctrl.refreshAudience)

  route('get', '/channels/:id/messages', S.listMessagesSchema, ctrl.messages)
  route('post', '/channels/:id/messages', S.sendMessageSchema, ctrl.send)
  route('delete', '/channels/:id/messages/:messageId', S.messageIdSchema, ctrl.deleteMessage)
  route('post', '/channels/:id/read', S.channelIdSchema, ctrl.markRead)
}
