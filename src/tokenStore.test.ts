import { describe, expect, it } from 'vitest'

import { InMemorySecretStore } from '../test/doubles'
import { GATE_TOKEN_SECRET_KEY } from './constants'
import { GateTokenStore, normalizeToken } from './tokenStore'

describe('normalizeToken', () => {
  it('trims surrounding whitespace picked up from a paste', () => {
    expect(normalizeToken('  gate-token  \n')).toBe('gate-token')
  })

  it('rejects a blank paste', () => {
    expect(normalizeToken('   ')).toBeNull()
  })
})

describe('GateTokenStore', () => {
  it('reports no token before sign-in', async () => {
    const store = new GateTokenStore(new InMemorySecretStore())

    expect(await store.read()).toBeUndefined()
  })

  it('stores a pasted token under the single secret-storage key', async () => {
    const secrets = new InMemorySecretStore()
    const store = new GateTokenStore(secrets)

    await store.save('gate-token')

    expect(secrets.keys()).toEqual([GATE_TOKEN_SECRET_KEY])
    expect(await store.read()).toBe('gate-token')
  })

  it('clears the token on sign-out', async () => {
    const secrets = new InMemorySecretStore()
    const store = new GateTokenStore(secrets)
    await store.save('gate-token')

    await store.clear()

    expect(secrets.keys()).toEqual([])
    expect(await store.read()).toBeUndefined()
  })
})
