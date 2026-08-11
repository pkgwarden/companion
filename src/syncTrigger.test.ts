import { describe, expect, it, vi } from 'vitest'

import { registerSyncTrigger, requestImmediateSync } from './syncTrigger'

describe('requestImmediateSync', () => {
  it('does nothing while no sync engine has registered', () => {
    expect(requestImmediateSync()).toEqual({ kind: 'no-trigger' })
  })

  it('invokes the registered trigger', () => {
    const trigger = vi.fn()
    const registration = registerSyncTrigger(trigger)

    expect(requestImmediateSync()).toEqual({ kind: 'requested' })

    expect(trigger).toHaveBeenCalledTimes(1)
    registration.dispose()
  })

  it('reports a trigger that threw instead of letting it escape the caller', () => {
    const failure = new Error('sync scheduler is not ready')
    const registration = registerSyncTrigger(() => {
      throw failure
    })

    expect(requestImmediateSync()).toEqual({ kind: 'failed', error: failure })
    registration.dispose()
  })

  it('stops invoking a trigger that has been disposed', () => {
    const trigger = vi.fn()

    registerSyncTrigger(trigger).dispose()
    requestImmediateSync()

    expect(trigger).not.toHaveBeenCalled()
  })

  it('replaces an earlier trigger so a reloaded sync engine wins', () => {
    const first = vi.fn()
    const second = vi.fn()
    const firstRegistration = registerSyncTrigger(first)
    const secondRegistration = registerSyncTrigger(second)

    requestImmediateSync()

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    firstRegistration.dispose()
    secondRegistration.dispose()
  })

  it('keeps the live trigger when a superseded registration is disposed', () => {
    const superseded = vi.fn()
    const live = vi.fn()
    const supersededRegistration = registerSyncTrigger(superseded)
    const liveRegistration = registerSyncTrigger(live)

    supersededRegistration.dispose()
    requestImmediateSync()

    expect(live).toHaveBeenCalledTimes(1)
    liveRegistration.dispose()
  })
})
