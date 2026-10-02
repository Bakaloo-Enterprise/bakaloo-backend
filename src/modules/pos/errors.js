/** Domain error the POS controller turns into an HTTP response. */
export class PosError extends Error {
  constructor(message, statusCode = 400, code = 'POS_ERROR', details = undefined) {
    super(message)
    this.name = 'PosError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}
