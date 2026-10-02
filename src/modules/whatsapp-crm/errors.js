/** Domain error the controllers translate into an HTTP response. */
export class CrmError extends Error {
  /**
   * @param {string} message human readable
   * @param {number} statusCode HTTP status
   * @param {string} code stable machine code the dashboard can switch on
   * @param {unknown} [details] optional structured detail (e.g. the list of form errors)
   */
  constructor(message, statusCode = 400, code = 'CRM_ERROR', details = undefined) {
    super(message)
    this.details = details
    this.name = 'CrmError'
    this.statusCode = statusCode
    this.code = code
  }
}

/**
 * Thrown by the webhook processor when an event cannot be fully applied YET
 * (e.g. a delivery status that raced ahead of our own "message sent" write).
 * BullMQ retries the job with backoff; the processing is idempotent.
 */
export class RetryLaterError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RetryLaterError'
  }
}
