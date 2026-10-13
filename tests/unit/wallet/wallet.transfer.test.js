// Coverage for WalletService.transfer() — user-to-user wallet transfer
// (2026-07-04). Previously the sender's DEBIT transaction stored the
// recipient's *display name* ("Transfer to Ramesh") and the recipient's
// CREDIT transaction stored no identifying info at all ("Transfer from
// user"). Display names are user-editable and change over time, so neither
// side of the transaction reliably showed who the money actually went
// to/came from — in the customer's wallet history (mobile) or the admin
// dashboard's transaction list, both of which render this description
// string verbatim. The fix always stamps the counterparty's *phone number*
// on both sides.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({
  getClient: vi.fn(),
  // wallet-settings lookups fall back to defaults, except transfers must be
  // explicitly enabled here — the real default is false (see
  // wallet-settings.service.js) so these transfer-path tests would otherwise
  // all short-circuit on the "transfers disabled" guard before ever reaching
  // the logic under test.
  query: vi.fn().mockResolvedValue({ rows: [{ key: 'wallet_transfers_enabled', value: true }] }),
}))
vi.mock('../../../src/config/database.js', () => databaseMock)

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { WalletService } from '../../../src/modules/wallet/wallet.service.js'

const SENDER_ID = 'sender-1'
const SENDER_PHONE = '9876543210'
const RECIPIENT_ID = 'recipient-1'
const RECIPIENT_PHONE = '9123456780'

function makeClientMock() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }
}

function makeRepoMock(overrides = {}) {
  return {
    findUserByPhone: vi.fn().mockResolvedValue({ id: RECIPIENT_ID, name: 'Recipient Name', phone: RECIPIENT_PHONE }),
    findUserById: vi.fn().mockResolvedValue({ id: SENDER_ID, name: 'Sender Name', phone: SENDER_PHONE }),
    getForUpdate: vi.fn().mockImplementation((client, userId) =>
      Promise.resolve(
        userId === RECIPIENT_ID
          ? { id: 'wallet-recipient', balance: 0 }
          : { id: 'wallet-sender', balance: 500 }
      )
    ),
    // No expiring bonus credits -> the whole balance is transferable.
    getExpiringTotal: vi.fn().mockResolvedValue(0),
    debit: vi.fn().mockResolvedValue({
      wallet: { id: 'wallet-sender', balance: 400 },
      transaction: { id: 'wtx-debit', amount: 100 },
    }),
    credit: vi.fn().mockResolvedValue({
      wallet: { id: 'wallet-recipient', balance: 100 },
      transaction: { id: 'wtx-credit', amount: 100 },
    }),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  databaseMock.query.mockResolvedValue({ rows: [{ key: 'wallet_transfers_enabled', value: true }] })
})

describe('WalletService.transfer — counterparty identification by phone number (positive)', () => {
  it("stamps the recipient's phone number (not name) on the sender's DEBIT description", async () => {
    const client = makeClientMock()
    databaseMock.getClient.mockResolvedValue(client)
    const repo = makeRepoMock()
    const service = new WalletService(repo)

    const result = await service.transfer(SENDER_ID, { phone: RECIPIENT_PHONE, amount: 100 })

    expect(result.success).toBe(true)
    expect(repo.debit).toHaveBeenCalledWith(
      client,
      'wallet-sender',
      100,
      `Transfer to ${RECIPIENT_PHONE}`,
      `transfer:${RECIPIENT_ID}`,
      // transfers must only draw on permanent money, never expiring bonus
      { skipLots: true }
    )
  })

  it("stamps the sender's phone number on the recipient's CREDIT description (previously had no identifying info at all)", async () => {
    const client = makeClientMock()
    databaseMock.getClient.mockResolvedValue(client)
    const repo = makeRepoMock()
    const service = new WalletService(repo)

    await service.transfer(SENDER_ID, { phone: RECIPIENT_PHONE, amount: 100 })

    expect(repo.credit).toHaveBeenCalledWith(
      client,
      'wallet-recipient',
      100,
      `Transfer from ${SENDER_PHONE}`,
      `transfer:${SENDER_ID}`,
      expect.any(Object)
    )
  })

  it('honours an explicit caller-supplied description on the DEBIT side without losing the recipient phone on CREDIT (positive)', async () => {
    const client = makeClientMock()
    databaseMock.getClient.mockResolvedValue(client)
    const repo = makeRepoMock()
    const service = new WalletService(repo)

    await service.transfer(SENDER_ID, { phone: RECIPIENT_PHONE, amount: 100, description: 'Rent split' })

    expect(repo.debit).toHaveBeenCalledWith(client, 'wallet-sender', 100, 'Rent split', `transfer:${RECIPIENT_ID}`, { skipLots: true })
    expect(repo.credit).toHaveBeenCalledWith(
      client,
      'wallet-recipient',
      100,
      `Transfer from ${SENDER_PHONE}`,
      `transfer:${SENDER_ID}`,
      expect.any(Object)
    )
  })
})

describe('WalletService.transfer — negative paths unaffected by the description change', () => {
  it('rejects a transfer to a phone number with no matching user', async () => {
    const repo = makeRepoMock({ findUserByPhone: vi.fn().mockResolvedValue(null) })
    const service = new WalletService(repo)

    const result = await service.transfer(SENDER_ID, { phone: '0000000000', amount: 100 })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/not found/i)
  })

  it('rejects a self-transfer', async () => {
    const repo = makeRepoMock({
      findUserByPhone: vi.fn().mockResolvedValue({ id: SENDER_ID, name: 'Self', phone: SENDER_PHONE }),
    })
    const service = new WalletService(repo)

    const result = await service.transfer(SENDER_ID, { phone: SENDER_PHONE, amount: 100 })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/yourself/i)
  })

  it('rejects when the sender balance is insufficient', async () => {
    const client = makeClientMock()
    databaseMock.getClient.mockResolvedValue(client)
    const repo = makeRepoMock({ getForUpdate: vi.fn().mockResolvedValue({ id: 'wallet-sender', balance: 10 }) })
    const service = new WalletService(repo)

    const result = await service.transfer(SENDER_ID, { phone: RECIPIENT_PHONE, amount: 100 })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/insufficient/i)
    expect(repo.debit).not.toHaveBeenCalled()
  })
})

describe('WalletService.transfer — transfersEnabled gate', () => {
  it('rejects every transfer when wallet_transfers_enabled is false, before looking up the recipient', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ key: 'wallet_transfers_enabled', value: false }] })
    const repo = makeRepoMock()
    const service = new WalletService(repo)

    const result = await service.transfer(SENDER_ID, { phone: RECIPIENT_PHONE, amount: 100 })

    expect(result.success).toBe(false)
    expect(result.code).toBe('WALLET_TRANSFERS_DISABLED')
    expect(repo.findUserByPhone).not.toHaveBeenCalled()
  })

  it('defaults to disabled when no wallet_transfers_enabled row exists (safe default)', async () => {
    databaseMock.query.mockResolvedValue({ rows: [] })
    const repo = makeRepoMock()
    const service = new WalletService(repo)

    const result = await service.transfer(SENDER_ID, { phone: RECIPIENT_PHONE, amount: 100 })

    expect(result.success).toBe(false)
    expect(result.code).toBe('WALLET_TRANSFERS_DISABLED')
  })

  it('searchRecipient returns an empty list (not an error) when transfers are disabled', async () => {
    databaseMock.query.mockResolvedValue({ rows: [] })
    const repo = makeRepoMock({ searchUsersByPhonePrefix: vi.fn().mockResolvedValue([{ id: 'x' }]) })
    const service = new WalletService(repo)

    const result = await service.searchRecipient(SENDER_ID, '987')

    expect(result).toEqual([])
    expect(repo.searchUsersByPhonePrefix).not.toHaveBeenCalled()
  })
})
