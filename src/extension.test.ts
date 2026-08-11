import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from 'vscode'

import { createExtensionContextDouble, createUnreadableSecretsContextDouble } from '../test/doubles'
import { recorder, resetVscodeDouble } from '../test/vscodeDouble'
import {
  GATE_TOKEN_SECRET_KEY,
  INSTALL_EXTENSION_COMMAND,
  SHOW_MENU_COMMAND,
  SIGN_IN_COMMAND,
  SIGN_OUT_COMMAND,
  SYNC_NOW_COMMAND,
} from './constants'
import { activate } from './extension'
import { syncFailureMessage } from './messages'
import { SYNC_DEDUP_WINDOW_MS, SYNC_TICK_INTERVAL_MS } from './syncDecision'
import { SYNC_STATE_KEY } from './syncState'

function policyResponse() {
  return {
    status: 200,
    json: async () => ({
      'extensions.allowed': { 'redhat.java': ['1.45.0'] },
      generated_at: '2026-07-28T12:00:00Z',
      withheld: [],
    }),
  }
}

function activateWithDouble(): ReturnType<typeof createExtensionContextDouble> {
  const context = createExtensionContextDouble()
  activate(context as unknown as ExtensionContext)
  return context
}

async function activateSignedIn(): Promise<ReturnType<typeof createExtensionContextDouble>> {
  const context = createExtensionContextDouble()
  await context.secrets.store(GATE_TOKEN_SECRET_KEY, 'gate-token')
  activate(context as unknown as ExtensionContext)
  return context
}

beforeEach(() => {
  resetVscodeDouble()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => policyResponse()),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('activate', () => {
  it('contributes sign-in, sign-out, sync-now, install and the status-bar menu', () => {
    activateWithDouble()

    expect([...recorder.commandHandlers.keys()].sort()).toEqual(
      [
        INSTALL_EXTENSION_COMMAND,
        SHOW_MENU_COMMAND,
        SIGN_IN_COMMAND,
        SIGN_OUT_COMMAND,
        SYNC_NOW_COMMAND,
      ].sort(),
    )
  })

  it('shows a status bar item that opens the menu', () => {
    activateWithDouble()

    const [item] = recorder.statusBarItems
    expect(item?.visible).toBe(true)
    expect(item?.command).toBe(SHOW_MENU_COMMAND)
    expect(item?.text).toBe('$(shield) pkgwarden: sign in')
  })

  it('registers everything for disposal', () => {
    const context = activateWithDouble()

    expect(context.subscriptions.length).toBe(9)
  })

  it('makes no network call while signed out', async () => {
    activateWithDouble()
    await vi.waitFor(() => expect(recorder.statusBarItems[0]?.text).toBeDefined())

    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows the last session pinned count before any new sync lands', async () => {
    const context = createExtensionContextDouble()
    await context.secrets.store(GATE_TOKEN_SECRET_KEY, 'gate-token')
    await context.globalState.update(SYNC_STATE_KEY, {
      lastSyncStartedAt: Date.now() - 1000,
      lastSuccessAt: Date.now() - 1000,
      pinnedCount: 43,
    })

    activate(context as unknown as ExtensionContext)

    await vi.waitFor(() =>
      expect(recorder.statusBarItems[0]?.text).toBe('$(shield) pkgwarden: 43 pinned'),
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('syncs on activation once the daily cadence has elapsed', async () => {
    await activateSignedIn()

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  })

  it('ticks hourly but meters itself to one call a day', async () => {
    vi.useFakeTimers()
    await activateSignedIn()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(23 * SYNC_TICK_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2 * SYNC_TICK_INTERVAL_MS)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })

  it('releases the status bar, the log channel, the timer and the commands on deactivation', () => {
    vi.useFakeTimers()
    const context = activateWithDouble()

    for (const subscription of context.subscriptions) {
      subscription.dispose()
    }

    expect(recorder.statusBarItems[0]?.disposed).toBe(true)
    expect(recorder.outputChannels[0]?.disposed).toBe(true)
    expect(recorder.commandHandlers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('warns and stays signed out when the editor cannot read secret storage', async () => {
    activate(createUnreadableSecretsContextDouble() as unknown as ExtensionContext)

    await vi.waitFor(() => expect(recorder.warningMessages).toHaveLength(1))
    expect(recorder.warningMessages[0]).toContain('keyring unavailable')
    expect(recorder.statusBarItems[0]?.text).toBe('$(shield) pkgwarden: sign in')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('pkgwarden.signIn', () => {
  it('stores a pasted token in secret storage without echoing it anywhere', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const context = activateWithDouble()
    recorder.inputBoxResponses.push('gate-token')

    await recorder.commandHandlers.get(SIGN_IN_COMMAND)?.()

    expect(recorder.inputBoxOptions[0]?.password).toBe(true)
    expect(context.secrets.keys()).toEqual([GATE_TOKEN_SECRET_KEY])
    expect(await context.secrets.get(GATE_TOKEN_SECRET_KEY)).toBe('gate-token')
    expect(consoleLog).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
    expect([...recorder.informationMessages, ...recorder.warningMessages].join(' ')).not.toContain(
      'gate-token',
    )
    expect(recorder.outputChannels[0]?.lines.join('\n')).not.toContain('gate-token')
  })

  it('syncs immediately after a successful sign-in instead of waiting for the next tick', async () => {
    activateWithDouble()
    recorder.inputBoxResponses.push('gate-token')

    await recorder.commandHandlers.get(SIGN_IN_COMMAND)?.()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(recorder.statusBarItems[0]?.text).toBe('$(shield) pkgwarden: 1 pinned')
  })

  it('says the token was rejected when the sync it triggers comes back unauthorized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 401, json: async () => ({}) })),
    )
    activateWithDouble()
    recorder.inputBoxResponses.push('expired-token')

    await recorder.commandHandlers.get(SIGN_IN_COMMAND)?.()

    expect(recorder.warningMessages).toEqual([syncFailureMessage('unauthenticated')])
  })

  it('stores nothing and syncs nothing when the paste is cancelled', async () => {
    const context = activateWithDouble()
    recorder.inputBoxResponses.push(undefined)

    await recorder.commandHandlers.get(SIGN_IN_COMMAND)?.()

    expect(context.secrets.keys()).toEqual([])
    expect(recorder.warningMessages).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('warns and stores nothing when the paste is blank', async () => {
    const context = activateWithDouble()
    recorder.inputBoxResponses.push('   ')

    await recorder.commandHandlers.get(SIGN_IN_COMMAND)?.()

    expect(context.secrets.keys()).toEqual([])
    expect(recorder.warningMessages).toHaveLength(1)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('pkgwarden.syncNow', () => {
  it('syncs on demand even though the daily cadence has not elapsed', async () => {
    const context = await activateSignedIn()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(context.globalState.get(SYNC_STATE_KEY)).toBeDefined()

    await recorder.commandHandlers.get(SYNC_NOW_COMMAND)?.()

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('says so rather than doing nothing quietly when the sync is held back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 503, json: async () => ({}) })),
    )
    await activateSignedIn()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

    await recorder.commandHandlers.get(SYNC_NOW_COMMAND)?.()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(recorder.informationMessages[0]).toContain('will not call again')
  })

  it('warns when the sync it ran failed, rather than looking like it worked', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 503, json: async () => ({}) })),
    )
    await activateSignedIn()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(SYNC_DEDUP_WINDOW_MS)

    await recorder.commandHandlers.get(SYNC_NOW_COMMAND)?.()

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(recorder.warningMessages).toEqual([syncFailureMessage('server')])
  })
})

describe('pkgwarden.signOut', () => {
  it('clears the token and returns the status bar to signed-out', async () => {
    const context = activateWithDouble()
    recorder.inputBoxResponses.push('gate-token')
    await recorder.commandHandlers.get(SIGN_IN_COMMAND)?.()

    await recorder.commandHandlers.get(SIGN_OUT_COMMAND)?.()

    expect(context.secrets.keys()).toEqual([])
    expect(recorder.statusBarItems[0]?.text).toBe('$(shield) pkgwarden: sign in')
  })
})

describe('the status-bar menu', () => {
  it('runs the command the user picked', async () => {
    const context = activateWithDouble()
    recorder.inputBoxResponses.push('gate-token')
    await recorder.commandHandlers.get(SIGN_IN_COMMAND)?.()
    recorder.quickPickSelection = 2

    await recorder.commandHandlers.get(SHOW_MENU_COMMAND)?.()

    expect(recorder.quickPickItems[0]?.map((item) => item.label)).toEqual([
      'Install extension…',
      'Sync policy now',
      'Sign out',
    ])
    expect(context.secrets.keys()).toEqual([])
  })

  it('opens the install picker from its first entry', async () => {
    activateWithDouble()
    recorder.inputBoxResponses.push('gate-token')
    await recorder.commandHandlers.get(SIGN_IN_COMMAND)?.()
    recorder.quickPickSelection = 0

    const menu = recorder.commandHandlers.get(SHOW_MENU_COMMAND)?.()
    await vi.waitFor(() => expect(recorder.quickPicks).toHaveLength(1))
    recorder.quickPicks[0]?.hide()
    await menu

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the menu is dismissed', async () => {
    activateWithDouble()

    await recorder.commandHandlers.get(SHOW_MENU_COMMAND)?.()

    expect(recorder.inputBoxOptions).toEqual([])
  })
})
