import { logger } from '../../config/logger.js'
import { getSocketEmitter } from '../../plugins/socket-emitter.js'
import { ChatRepository } from './chat.repository.js'
import { ChatService } from './chat.service.js'

let cached = null

/** Realtime fan-out to the personal room of each person involved (never a broadcast room). */
export function emitToUsers(userIds, event, payload) {
  try {
    let target = getSocketEmitter()
    for (const id of new Set(userIds)) target = target.to(`user:${id}`)
    target.emit(event, payload)
  } catch (err) {
    logger.warn({ err: err.message, event }, 'Could not emit chat realtime event')
  }
}

export function getChatService() {
  if (!cached) cached = new ChatService({ repo: new ChatRepository(), emit: emitToUsers, logger })
  return cached
}
