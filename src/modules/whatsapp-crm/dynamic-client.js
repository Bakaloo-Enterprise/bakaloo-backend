import { createMetaClient } from './meta-client.js'
import { clientKey } from './settings.js'

/**
 * A Meta client whose credentials are looked up on every call (through the settings service's short cache), so a token
 * saved in the dashboard is used by the API and the worker within seconds. Same methods as createMetaClient.
 * @param {() => Promise<object>} getConfig
 * @param {(cfg: object) => object} [make] injectable for tests
 */
export function createLazyMetaClient(getConfig, make = (c) => createMetaClient(c)) {
  let current = null // { key, client }
  const real = async () => {
    const cfg = await getConfig()
    const key = clientKey(cfg)
    if (!current || current.key !== key) {
      current = { key, client: make({ accessToken: cfg.accessToken, phoneNumberId: cfg.phoneNumberId, wabaId: cfg.wabaId, appId: cfg.appId, apiVersion: cfg.apiVersion, baseUrl: cfg.baseUrl }) }
    }
    return current.client
  }
  // Method names come from a client built with placeholder values, so new client methods are picked up automatically.
  const names = Object.keys(make({ accessToken: 'x', phoneNumberId: 'x' })).filter((k) => typeof make({ accessToken: 'x', phoneNumberId: 'x' })[k] === 'function')
  return Object.fromEntries(names.map((n) => [n, async (...args) => (await real())[n](...args)]))
}
