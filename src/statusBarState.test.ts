import { describe, expect, it } from 'vitest'

import {
  INSTALL_EXTENSION_COMMAND,
  SIGN_IN_COMMAND,
  SIGN_OUT_COMMAND,
  SYNC_NOW_COMMAND,
} from './constants'
import {
  companionStatus,
  initialCompanionState,
  menuItemsForStatus,
  STALE_SYNC_THRESHOLD_MS,
  statusBarText,
  statusBarTooltip,
} from './statusBarState'

const now = Date.UTC(2026, 6, 28, 12, 0, 0)
const signedIn = { ...initialCompanionState(), hasToken: true, lastSuccessAt: now, pinnedCount: 43 }

describe('companionStatus', () => {
  it('starts signed-out', () => {
    expect(companionStatus(initialCompanionState(), now)).toBe('signed-out')
  })

  it('stays signed-out even when other trouble is recorded', () => {
    expect(companionStatus({ ...signedIn, hasToken: false, quotaExhausted: true }, now)).toBe(
      'signed-out',
    )
  })

  it('is ok right after a successful sync', () => {
    expect(companionStatus(signedIn, now)).toBe('ok')
  })

  it('goes stale once the last success is older than the threshold', () => {
    expect(
      companionStatus({ ...signedIn, lastSuccessAt: now - STALE_SYNC_THRESHOLD_MS - 1 }, now),
    ).toBe('stale')
  })

  it('is stale when signed in but never synced', () => {
    expect(companionStatus({ ...signedIn, lastSuccessAt: null }, now)).toBe('stale')
  })

  it('reports policy-managed ahead of staleness because enforcement is not ours', () => {
    expect(companionStatus({ ...signedIn, lastSuccessAt: null, policyManaged: true }, now)).toBe(
      'policy-managed',
    )
  })

  it('reports quota ahead of every state except signed-out', () => {
    expect(companionStatus({ ...signedIn, policyManaged: true, quotaExhausted: true }, now)).toBe(
      'quota',
    )
  })
})

describe('statusBarText', () => {
  it('counts pinned extensions when healthy', () => {
    expect(statusBarText('ok', signedIn)).toBe('$(shield) pkgwarden: 43 pinned')
  })

  it('asks for a token when signed out', () => {
    expect(statusBarText('signed-out', initialCompanionState())).toBe(
      '$(shield) pkgwarden: sign in',
    )
  })

  it('warns on every degraded state', () => {
    expect(statusBarText('stale', signedIn)).toBe('$(warning) pkgwarden: sync stale')
    expect(statusBarText('policy-managed', signedIn)).toBe('$(warning) pkgwarden: policy managed')
    expect(statusBarText('quota', signedIn)).toBe('$(warning) pkgwarden: quota reached')
  })
})

describe('statusBarTooltip', () => {
  it('explains each steady state', () => {
    expect(statusBarTooltip('signed-out', initialCompanionState())).toBe(
      'Sign in with a pkgwarden gate token to keep your extensions on cleared versions.',
    )
    expect(statusBarTooltip('ok', signedIn)).toBe(
      'pkgwarden is pinning 43 extensions to versions gate has cleared.',
    )
    expect(statusBarTooltip('policy-managed', signedIn)).toBe(
      'Another policy layer owns extensions.allowed, so pkgwarden cannot enforce its pins here.',
    )
    expect(statusBarTooltip('quota', signedIn)).toBe(
      'pkgwarden gate declined the last sync for quota reasons; the next scheduled sync will try again.',
    )
  })

  it('explains staleness with the last success time', () => {
    expect(statusBarTooltip('stale', { ...signedIn, lastSuccessAt: Date.UTC(2026, 6, 20) })).toBe(
      'pkgwarden last synced your extension policy on 2026-07-20.',
    )
  })

  it('explains that nothing has synced yet', () => {
    expect(statusBarTooltip('stale', { ...signedIn, lastSuccessAt: null })).toBe(
      'pkgwarden has not synced your extension policy yet.',
    )
  })

  it('admits when the inventory it sent was incomplete', () => {
    expect(statusBarTooltip('ok', { ...signedIn, partialInventory: true })).toBe(
      'pkgwarden is pinning 43 extensions to versions gate has cleared. pkgwarden could not read the full extension list, so disabled extensions may be missing from these pins.',
    )
  })
})

describe('menuItemsForStatus', () => {
  it('offers sign-in only while signed out', () => {
    expect(menuItemsForStatus('signed-out').map((item) => item.command)).toEqual([SIGN_IN_COMMAND])
  })

  it('offers install, on-demand sync and sign-out once a token is stored', () => {
    expect(menuItemsForStatus('ok')).toEqual([
      { label: 'Install extension…', command: INSTALL_EXTENSION_COMMAND },
      { label: 'Sync policy now', command: SYNC_NOW_COMMAND },
      { label: 'Sign out', command: SIGN_OUT_COMMAND },
    ])
  })

  it('offers the picker in every signed-in state, including the degraded ones', () => {
    for (const status of ['stale', 'policy-managed', 'quota'] as const) {
      expect(menuItemsForStatus(status)[0]?.command).toBe(INSTALL_EXTENSION_COMMAND)
    }
  })
})
