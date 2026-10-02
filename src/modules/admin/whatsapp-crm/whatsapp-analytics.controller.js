import { success, error } from '../../../utils/apiResponse.js'
import { CrmError } from '../../whatsapp-crm/errors.js'
import { getWhatsappServices } from '../../whatsapp-crm/whatsapp.factory.js'

function fail(reply, err) {
  if (err instanceof CrmError) {
    const body = error(err.message, err.code)
    return reply.code(err.statusCode).send(err.details !== undefined ? { ...body, details: err.details } : body)
  }
  throw err
}

const run = (message, fn) =>
  async function handler(request, reply) {
    try {
      return success(await fn(getWhatsappServices().analytics, request), message)
    } catch (err) {
      return fail(reply, err)
    }
  }

export class AdminWhatsappAnalyticsController {
  overview = run('Overview fetched', (a, r) => a.overview(r.query))
  breakdown = run('Report fetched', (a, r) => a.breakdown(r.params.by, r.query))
  inbox = run('Inbox report fetched', (a, r) => a.inbox(r.query))
  rateCards = run('Prices fetched', (a) => a.rateCards())
  addRateCard = run('Price saved', (a, r) => a.addRateCard(r.body, r.user.id))
  removeRateCard = run('Price removed', (a, r) => a.removeRateCard(r.params.id))
}
