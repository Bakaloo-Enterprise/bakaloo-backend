/** Domain error for the business-operations modules (procurement, bulk catalog, business analytics). */
export class BusinessError extends Error {
  constructor(message, statusCode = 400, code = 'BUSINESS_ERROR', details = undefined) {
    super(message)
    this.name = 'BusinessError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}
