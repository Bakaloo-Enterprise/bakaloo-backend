/** Domain error the controller translates into an HTTP response. */
export class ChatError extends Error {
  constructor(message, statusCode = 400, code = 'CHAT_ERROR', details = undefined) {
    super(message)
    this.name = 'ChatError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}
