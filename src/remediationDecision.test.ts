import { describe, expect, it } from 'vitest'

import { COMPANION_EXTENSION_ID } from './constants'
import type { VscodeWithheldVersion } from './gateClient'
import {
  decideRemediationDispatch,
  decideShepherdDispatch,
  shepherdCandidates,
  withheldDedupKey,
} from './remediationDecision'
import type { ShepherdTracking } from './remediationState'

const LINTER_ID = 'contoso.linter-pro'

/** Tracking as auto-remediation records it: the id, plus the version it was rolled back to. */
const trackingOf = (rolledBackTo: string | null): ShepherdTracking =>
  new Map([[LINTER_ID, rolledBackTo]])

const withheld: VscodeWithheldVersion = {
  extensionId: 'contoso.linter-pro',
  version: '4.2.1',
  reason: 'scan_verdict',
  rollbackVersion: '4.1.9',
}

describe('withheldDedupKey', () => {
  it('lowercases the extension id before keying handled pairs', () => {
    expect(
      withheldDedupKey({
        ...withheld,
        extensionId: 'Contoso.Linter-Pro',
      }),
    ).toBe('contoso.linter-pro@4.2.1')
  })
})

describe('remediation dispatch matrix', () => {
  it('notify mode warns without planning an install or uninstall', () => {
    expect(decideRemediationDispatch(withheld, 'notify', new Set())).toEqual({
      kind: 'notify-only',
      entry: withheld,
    })
  })

  it('auto mode rolls back when gate supplied a rollback version', () => {
    expect(decideRemediationDispatch(withheld, 'auto', new Set())).toEqual({
      kind: 'rollback',
      entry: withheld,
      rollbackVersion: '4.1.9',
    })
  })

  it('auto mode uninstalls when no rollback version remains', () => {
    expect(
      decideRemediationDispatch({ ...withheld, rollbackVersion: null }, 'auto', new Set()),
    ).toEqual({
      kind: 'uninstall',
      entry: { ...withheld, rollbackVersion: null },
    })
  })

  it('suppresses repeats once the withheld pair is already handled', () => {
    const key = withheldDedupKey(withheld)

    expect(decideRemediationDispatch(withheld, 'auto', new Set([key]))).toEqual({
      kind: 'skip',
      reason: 'already-handled',
    })
    expect(decideRemediationDispatch(withheld, 'notify', new Set([key]))).toEqual({
      kind: 'skip',
      reason: 'already-handled',
    })
  })

  it('never uninstalls, rolls back, or notifies for pkgwarden.companion itself', () => {
    const companionWithheld: VscodeWithheldVersion = {
      extensionId: COMPANION_EXTENSION_ID,
      version: '0.1.0',
      reason: 'known_malware',
      rollbackVersion: null,
    }

    expect(decideRemediationDispatch(companionWithheld, 'auto', new Set())).toEqual({
      kind: 'skip',
      reason: 'self-guard',
    })
    expect(decideRemediationDispatch(companionWithheld, 'notify', new Set())).toEqual({
      kind: 'skip',
      reason: 'self-guard',
    })
  })
})

describe('shepherd decision', () => {
  it('installs the newest pinned version when the installed copy lags', () => {
    expect(
      decideShepherdDispatch(LINTER_ID, '4.1.9', ['4.1.9', '4.2.2'], trackingOf('4.1.9')),
    ).toEqual({
      kind: 'install',
      extensionId: LINTER_ID,
      targetVersion: '4.2.2',
    })
  })

  it('keeps tracking while the rollback target is still the newest pinned version', () => {
    expect(
      decideShepherdDispatch(LINTER_ID, '4.1.9', ['4.1.8', '4.1.9'], trackingOf('4.1.9')),
    ).toEqual({
      kind: 'skip',
      reason: 'still-withheld',
    })
  })

  it('drops tracking once the installed version advances past the rollback target', () => {
    expect(
      decideShepherdDispatch(LINTER_ID, '4.2.2', ['4.1.9', '4.2.2'], trackingOf('4.1.9')),
    ).toEqual({
      kind: 'drop-tracking',
      extensionId: LINTER_ID,
    })
  })

  it('drops tracking when the extension is no longer installed', () => {
    expect(
      decideShepherdDispatch(LINTER_ID, null, ['4.1.9', '4.2.2'], trackingOf('4.1.9')),
    ).toEqual({
      kind: 'drop-tracking',
      extensionId: LINTER_ID,
    })
  })

  it('drops tracking when the id no longer appears in the pin map', () => {
    expect(decideShepherdDispatch(LINTER_ID, '4.1.9', undefined, trackingOf('4.1.9'))).toEqual({
      kind: 'drop-tracking',
      extensionId: LINTER_ID,
    })
  })

  it('treats a legacy entry with no recorded rollback target as caught up at the newest pin', () => {
    expect(
      decideShepherdDispatch(LINTER_ID, '4.2.2', ['4.1.9', '4.2.2'], trackingOf(null)),
    ).toEqual({
      kind: 'drop-tracking',
      extensionId: LINTER_ID,
    })
  })

  it('ignores extensions that are not being shepherded yet', () => {
    expect(decideShepherdDispatch(LINTER_ID, '4.1.9', ['4.1.9', '4.2.2'], new Map())).toEqual({
      kind: 'skip',
      reason: 'not-tracked',
    })
  })

  it('never shepherds pkgwarden.companion', () => {
    expect(
      decideShepherdDispatch(
        COMPANION_EXTENSION_ID,
        '0.1.0',
        ['0.1.0', '0.2.0'],
        new Map([[COMPANION_EXTENSION_ID, '0.1.0']]),
      ),
    ).toEqual({
      kind: 'skip',
      reason: 'self-guard',
    })
  })
})

/** Issue #575: an ordinary sync taken while the withhold stands must not end the shepherding. */
describe('shepherd timeline across syncs while a version stays withheld', () => {
  const rolledBackTracking = trackingOf('4.1.9')

  it('keeps tracking on the sync taken while the withheld version is still withheld', () => {
    expect(
      decideShepherdDispatch(LINTER_ID, '4.1.9', ['4.1.8', '4.1.9'], rolledBackTracking),
    ).toEqual({ kind: 'skip', reason: 'still-withheld' })
  })

  it('installs the newest pin on the sync after the verdict clears', () => {
    expect(
      decideShepherdDispatch(LINTER_ID, '4.1.9', ['4.1.8', '4.1.9', '4.2.1'], rolledBackTracking),
    ).toEqual({ kind: 'install', extensionId: LINTER_ID, targetVersion: '4.2.1' })
  })

  it('drops tracking once that install lands', () => {
    expect(
      decideShepherdDispatch(LINTER_ID, '4.2.1', ['4.1.8', '4.1.9', '4.2.1'], rolledBackTracking),
    ).toEqual({ kind: 'drop-tracking', extensionId: LINTER_ID })
  })

  it('starts fresh tracking when a later version is withheld and rolled back again', () => {
    expect(
      decideShepherdDispatch(LINTER_ID, '4.2.1', ['4.1.8', '4.1.9', '4.2.1'], trackingOf('4.2.1')),
    ).toEqual({ kind: 'skip', reason: 'still-withheld' })
  })
})

describe('shepherdCandidates', () => {
  it('only considers tracked ids that still appear in the pin map', () => {
    expect(
      shepherdCandidates(
        {
          'contoso.linter-pro': ['4.1.9', '4.2.2'],
          'redhat.java': ['1.45.0'],
        },
        new Map([
          [LINTER_ID, '4.1.9'],
          ['missing.extension', '1.0.0'],
        ]),
      ),
    ).toEqual([LINTER_ID])
  })
})

describe('test_withheld_only_for_grandfather_exclusions', () => {
  it('documents that remediation dispatch never runs from pin-map absence alone', () => {
    expect(decideRemediationDispatch(withheld, 'auto', new Set()).kind).not.toBe('skip')
    expect(decideShepherdDispatch(LINTER_ID, '9.9.9', undefined, trackingOf('4.1.9')).kind).toBe(
      'drop-tracking',
    )
  })
})
