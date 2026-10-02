import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ShopOrdersRepository } from '../../../src/modules/shop-orders/repository.js'

/**
 * The service's unit tests mock the repository, which hid a real bug: the service called `this.repo.getClient()`
 * but the real class had no such method, so status changes, rider assignment, cancel and refund all failed with
 * "this.repo.getClient is not a function" in production. This contract test checks the REAL class has every
 * method the service calls on it.
 */
describe('ShopOrdersService ↔ ShopOrdersRepository contract', () => {
  const src = readFileSync(new URL('../../../src/modules/shop-orders/service.js', import.meta.url), 'utf8')
  const used = [...new Set([...src.matchAll(/this\.repo\.(\w+)\(/g)].map((m) => m[1]))]

  it('the service does call the repository (the check is not vacuous)', () => {
    expect(used.length).toBeGreaterThan(5)
    expect(used).toContain('getClient')
  })

  it.each(used)('the real repository implements %s()', (name) => {
    expect(typeof new ShopOrdersRepository()[name]).toBe('function')
  })
})
