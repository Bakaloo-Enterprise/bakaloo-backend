import { success, error } from '../../../utils/apiResponse.js'
import { ChatError } from '../../team-chat/errors.js'
import { getChatService } from '../../team-chat/chat.factory.js'

function fail(reply, err) {
  if (err instanceof ChatError) {
    const body = error(err.message, err.code)
    return reply.code(err.statusCode).send(err.details !== undefined ? { ...body, details: err.details } : body)
  }
  throw err
}

/** Wrap a service call: the signed-in user is always the first argument. */
const run = (message, fn) =>
  async function handler(request, reply) {
    try {
      return success(await fn(getChatService(), request, request.user.id), message)
    } catch (err) {
      return fail(reply, err)
    }
  }

export class TeamChatController {
  me = run('Chat access', (s, _r, u) => s.me(u))
  people = run('People fetched', (s, r, u) => s.people(u, r.query))
  unread = run('Unread fetched', (s, _r, u) => s.unread(u))
  refs = run('Results fetched', (s, r, u) => s.searchRefs(u, r.query))
  list = run('Chats fetched', (s, r, u) => s.list(u, r.query))
  create = run('Chat created', (s, r, u) => s.create(u, r.body))
  get = run('Chat fetched', (s, r, u) => s.get(u, r.params.id))
  update = run('Chat updated', (s, r, u) => s.update(u, r.params.id, r.body ?? {}))
  addMembers = run('People added', (s, r, u) => s.addMembers(u, r.params.id, r.body.userIds))
  removeMember = run('Removed', (s, r, u) => s.removeMember(u, r.params.id, r.params.userId))
  archive = run('Chat archived', (s, r, u) => s.setArchived(u, r.params.id, true))
  unarchive = run('Chat restored', (s, r, u) => s.setArchived(u, r.params.id, false))
  refreshAudience = run('Channel refreshed', (s, r, u) => s.refreshAudience(u, r.params.id))
  messages = run('Messages fetched', (s, r, u) => s.messages(u, r.params.id, r.query))
  send = run('Message sent', (s, r, u) => s.send(u, r.params.id, r.body ?? {}))
  deleteMessage = run('Message deleted', (s, r, u) => s.deleteMessage(u, r.params.id, r.params.messageId))
  markRead = run('Marked read', (s, r, u) => s.markRead(u, r.params.id))
}
