import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ControllableSecretStore,
  InMemorySecretStore,
  UnavailableSecretStore,
} from '../test/doubles'
import { recorder, resetVscodeDouble } from '../test/vscodeDouble'
import { AuthGeneration, refreshSignedInState, signIn, signOut } from './auth'
import { GATE_TOKEN_SECRET_KEY } from './constants'
import { CompanionStatusBar } from './statusBar'
import { GateTokenStore } from './tokenStore'

beforeEach(() => {
  resetVscodeDouble()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('refreshSignedInState vs sign-in / sign-out', () => {
  it('ignores a startup refresh that finishes after sign-out cleared the token', async () => {
    const secrets = new ControllableSecretStore()
    await secrets.store(GATE_TOKEN_SECRET_KEY, 'gate-token')
    const tokenStore = new GateTokenStore(secrets)
    const statusBar = new CompanionStatusBar()
    const generation = new AuthGeneration()

    const refresh = refreshSignedInState(tokenStore, statusBar, generation)
    await Promise.resolve()
    await signOut(tokenStore, statusBar, generation)
    expect(recorder.statusBarItems[0]?.text).toBe('$(shield) pkgwarden: sign in')

    secrets.releaseGets()
    await refresh

    expect(recorder.statusBarItems[0]?.text).toBe('$(shield) pkgwarden: sign in')
  })

  it('ignores a startup refresh that finishes after a successful sign-in', async () => {
    const secrets = new ControllableSecretStore()
    const tokenStore = new GateTokenStore(secrets)
    const statusBar = new CompanionStatusBar()
    const generation = new AuthGeneration()

    const refresh = refreshSignedInState(tokenStore, statusBar, generation)
    await Promise.resolve()
    recorder.inputBoxResponses.push('gate-token')
    await signIn(tokenStore, statusBar, generation)
    expect(recorder.statusBarItems[0]?.text).toBe('$(warning) pkgwarden: sync stale')

    secrets.releaseGets()
    await refresh

    expect(recorder.statusBarItems[0]?.text).toBe('$(warning) pkgwarden: sync stale')
  })
})

describe('signIn reporting', () => {
  it('reports a stored token so the caller can sync before the next tick', async () => {
    const tokenStore = new GateTokenStore(new InMemorySecretStore())
    recorder.inputBoxResponses.push('gate-token')

    const signedIn = await signIn(tokenStore, new CompanionStatusBar(), new AuthGeneration())

    expect(signedIn).toBe(true)
  })

  it('reports nothing stored when the paste is cancelled or the keyring rejects', async () => {
    recorder.inputBoxResponses.push(undefined, 'gate-token')

    const cancelled = await signIn(
      new GateTokenStore(new InMemorySecretStore()),
      new CompanionStatusBar(),
      new AuthGeneration(),
    )
    const rejected = await signIn(
      new GateTokenStore(new UnavailableSecretStore()),
      new CompanionStatusBar(),
      new AuthGeneration(),
    )

    expect([cancelled, rejected]).toEqual([false, false])
  })
})

describe('signIn / signOut secret-storage failures', () => {
  it('warns and stays signed out when secret storage rejects a save', async () => {
    const tokenStore = new GateTokenStore(new UnavailableSecretStore())
    const statusBar = new CompanionStatusBar()
    recorder.inputBoxResponses.push('gate-token')

    await signIn(tokenStore, statusBar, new AuthGeneration())

    expect(recorder.warningMessages).toHaveLength(1)
    expect(recorder.warningMessages[0]).toContain('keyring unavailable')
    expect(recorder.informationMessages).toEqual([])
    expect(recorder.statusBarItems[0]?.text).toBe('$(shield) pkgwarden: sign in')
  })

  it('warns and keeps the signed-in status when secret storage rejects a clear', async () => {
    const secrets: InMemorySecretStore = Object.assign(new InMemorySecretStore(), {
      delete: async () => {
        throw new Error('keyring unavailable')
      },
    })
    await secrets.store(GATE_TOKEN_SECRET_KEY, 'gate-token')
    const tokenStore = new GateTokenStore(secrets)
    const statusBar = new CompanionStatusBar()
    statusBar.update({ hasToken: true })

    await signOut(tokenStore, statusBar, new AuthGeneration())

    expect(recorder.warningMessages).toHaveLength(1)
    expect(recorder.warningMessages[0]).toContain('keyring unavailable')
    expect(recorder.informationMessages).toEqual([])
    expect(recorder.statusBarItems[0]?.text).toBe('$(warning) pkgwarden: sync stale')
  })
})
