import { describe, expect, it } from 'vitest'

import { GATE_WEBAPP_URL } from './constants'
import { GateClientError } from './gateClient'
import {
  blockedMessage,
  catalogSearchFailureMessage,
  extensionReference,
  installCheckFailureMessage,
  installedMessage,
  installFailureMessage,
  malformedRefMessage,
  pinWriteFailureMessage,
  syncFailureMessage,
  syncTriggerFailureMessage,
  unresolvedVersionMessage,
} from './messages'

const baseContext = {
  extensionId: 'contoso.linter-pro',
  version: '4.2.1',
  quarantineCutoffUtc: null,
  verdictSummary: null,
  explicitVersionRequested: false,
  allowedVersions: [],
}

describe('blockedMessage', () => {
  it('renders the pending_scan template', () => {
    expect(blockedMessage({ ...baseContext, reason: 'pending_scan' })).toBe(
      'contoso.linter-pro@4.2.1 is pending a security scan; a scan has been queued — retry in a few minutes.',
    )
  })

  it('renders the quarantine template with the cutoff date', () => {
    expect(
      blockedMessage({
        ...baseContext,
        reason: 'quarantine',
        quarantineCutoffUtc: '2026-08-11T09:30:00Z',
      }),
    ).toBe('contoso.linter-pro@4.2.1 is in quarantine until 2026-08-11 (published too recently).')
  })

  it('drops the cutoff clause when the server did not send one', () => {
    expect(blockedMessage({ ...baseContext, reason: 'quarantine' })).toBe(
      'contoso.linter-pro@4.2.1 is in quarantine (published too recently).',
    )
  })

  it('drops the cutoff clause when the server date cannot be read', () => {
    expect(
      blockedMessage({ ...baseContext, reason: 'quarantine', quarantineCutoffUtc: 'not-a-date' }),
    ).toBe('contoso.linter-pro@4.2.1 is in quarantine (published too recently).')
  })

  it('renders the scan_verdict template with the verdict summary', () => {
    expect(
      blockedMessage({
        ...baseContext,
        reason: 'scan_verdict',
        verdictSummary: 'credential exfiltration',
      }),
    ).toBe(
      "contoso.linter-pro@4.2.1 was withheld by pkgwarden's security scan (credential exfiltration); this cannot be overridden.",
    )
  })

  it('renders known_malware with the same never-overridable wording', () => {
    expect(blockedMessage({ ...baseContext, reason: 'known_malware' })).toBe(
      "contoso.linter-pro@4.2.1 was withheld by pkgwarden's security scan; this cannot be overridden.",
    )
  })

  it('renders the not_in_catalog template pointing at the gate webapp', () => {
    expect(blockedMessage({ ...baseContext, reason: 'not_in_catalog' })).toBe(
      `contoso.linter-pro@4.2.1 not found in the gate catalog — check the id on ${GATE_WEBAPP_URL}/extensions (the catalog is crawled nightly; very new versions may not be indexed yet).`,
    )
  })

  it('appends the latest allowed version when an explicit version was blocked', () => {
    expect(
      blockedMessage({
        ...baseContext,
        reason: 'pending_scan',
        explicitVersionRequested: true,
        allowedVersions: ['4.1.7', '4.1.9'],
      }),
    ).toBe(
      'contoso.linter-pro@4.2.1 is pending a security scan; a scan has been queued — retry in a few minutes. latest allowed version: 4.1.9.',
    )
  })

  it('does not append an allowed version when none was requested explicitly', () => {
    expect(
      blockedMessage({ ...baseContext, reason: 'pending_scan', allowedVersions: ['4.1.9'] }),
    ).not.toContain('latest allowed version')
  })

  it('does not append anything when the server sent no allowed versions', () => {
    expect(
      blockedMessage({ ...baseContext, reason: 'quarantine', explicitVersionRequested: true }),
    ).not.toContain('latest allowed version')
  })

  it('falls back to a generic line for reasons without a normative template', () => {
    expect(blockedMessage({ ...baseContext, reason: 'ms_lookup_capped' })).toBe(
      'contoso.linter-pro@4.2.1 is not allowed by pkgwarden policy (ms_lookup_capped).',
    )
  })

  it('falls back to a generic line when the server sent no reason', () => {
    expect(blockedMessage({ ...baseContext, reason: null })).toBe(
      'contoso.linter-pro@4.2.1 is not allowed by pkgwarden policy.',
    )
  })

  it('names the extension alone when gate resolved no version to speak about', () => {
    expect(blockedMessage({ ...baseContext, version: null, reason: 'not_in_catalog' })).toContain(
      'contoso.linter-pro not found in the gate catalog',
    )
  })
})

describe('extensionReference', () => {
  it('is the id@version form the editor installs by', () => {
    expect(extensionReference('contoso.linter-pro', '4.1.9')).toBe('contoso.linter-pro@4.1.9')
  })

  it('is the bare id when no version was resolved', () => {
    expect(extensionReference('contoso.linter-pro', null)).toBe('contoso.linter-pro')
  })
})

describe('installCheckFailureMessage', () => {
  it('states that nothing was installed for every failure kind', () => {
    const kinds = ['unauthenticated', 'metered-out', 'network', 'server'] as const

    for (const kind of kinds) {
      expect(
        installCheckFailureMessage(new GateClientError(kind, 'detail'), 'contoso.linter-pro@4.1.9'),
      ).toContain('Nothing was installed.')
    }
  })

  it('tells the user to sign in again when gate rejected the token', () => {
    expect(
      installCheckFailureMessage(
        new GateClientError('unauthenticated', 'HTTP 401'),
        'contoso.linter-pro@4.1.9',
      ),
    ).toBe(
      'pkgwarden could not check contoso.linter-pro@4.1.9: gate rejected your token — sign in again. Nothing was installed.',
    )
  })

  it('names the quota when gate metered the request out', () => {
    expect(
      installCheckFailureMessage(
        new GateClientError('metered-out', 'HTTP 429'),
        'contoso.ext@1.0.0',
      ),
    ).toBe(
      'pkgwarden could not check contoso.ext@1.0.0: your gate resolution quota is used up. Nothing was installed.',
    )
  })

  it('surfaces an unexpected failure instead of swallowing it', () => {
    expect(installCheckFailureMessage(new Error('boom'), 'contoso.ext@1.0.0')).toBe(
      'pkgwarden could not check contoso.ext@1.0.0: unexpected failure (boom). Nothing was installed.',
    )
  })
})

describe('catalogSearchFailureMessage', () => {
  it('explains why the catalog list is empty', () => {
    expect(catalogSearchFailureMessage(new GateClientError('network', 'ENOTFOUND'))).toBe(
      'pkgwarden could not search the extension catalog: gate is unreachable.',
    )
  })

  it('reports a server failure as one', () => {
    expect(catalogSearchFailureMessage(new GateClientError('server', 'HTTP 503'))).toBe(
      'pkgwarden could not search the extension catalog: gate returned an error.',
    )
  })
})

describe('pinWriteFailureMessage', () => {
  it('fails closed and says so', () => {
    expect(
      pinWriteFailureMessage(
        'contoso.linter-pro@4.1.9',
        new Error('settings.json is not writable'),
      ),
    ).toBe(
      'pkgwarden could not add contoso.linter-pro@4.1.9 to extensions.allowed (settings.json is not writable). Nothing was installed.',
    )
  })
})

describe('installFailureMessage', () => {
  it('says the pin was kept, because the policy statement stands', () => {
    expect(installFailureMessage('contoso.linter-pro@4.1.9', new Error('offline'))).toBe(
      'pkgwarden allowed contoso.linter-pro@4.1.9 but the editor could not install it (offline). The pin was kept, so the next sync can reconcile it.',
    )
  })
})

describe('installedMessage', () => {
  it('confirms both halves of the operation', () => {
    expect(installedMessage('contoso.linter-pro@4.1.9')).toBe(
      'pkgwarden allowed and installed contoso.linter-pro@4.1.9.',
    )
  })
})

describe('syncTriggerFailureMessage', () => {
  it('keeps the install a success and points at the next scheduled sync', () => {
    expect(
      syncTriggerFailureMessage('contoso.linter-pro@4.1.9', new Error('scheduler is not ready')),
    ).toBe(
      'pkgwarden installed contoso.linter-pro@4.1.9 but could not start an immediate policy sync (scheduler is not ready). The next scheduled sync will reconcile it.',
    )
  })
})

describe('unresolvedVersionMessage', () => {
  it('reports an extension with nothing installable', () => {
    expect(unresolvedVersionMessage('contoso.linter-pro')).toBe(
      'pkgwarden found no installable version of contoso.linter-pro in the gate catalog.',
    )
  })
})

describe('malformedRefMessage', () => {
  it('shows both accepted forms', () => {
    expect(malformedRefMessage('contoso@4.2.1')).toBe(
      '"contoso@4.2.1" is not an extension reference — use publisher.name or publisher.name@version.',
    )
  })
})

describe('syncFailureMessage', () => {
  it('asks for a fresh token when gate rejected the one we sent', () => {
    expect(syncFailureMessage('unauthenticated')).toBe(
      'pkgwarden gate rejected this token, so your extension pins are unchanged — sign in again with a current gate API token.',
    )
  })

  it('names the quota case and says the pins still stand', () => {
    expect(syncFailureMessage('metered-out')).toBe(
      'pkgwarden gate declined this sync for quota reasons, so your extension pins are unchanged.',
    )
  })

  it('points at the output channel for the failures only a log can explain', () => {
    expect(syncFailureMessage('network')).toBe(
      'pkgwarden could not reach gate, so your extension pins are unchanged — the pkgwarden output channel has the details.',
    )
    expect(syncFailureMessage('server')).toBe(
      'pkgwarden gate could not produce a policy, so your extension pins are unchanged — the pkgwarden output channel has the details.',
    )
    expect(syncFailureMessage('local')).toBe(
      'pkgwarden could not write extensions.allowed, so your extension pins are unchanged — the pkgwarden output channel has the details.',
    )
  })

  it('never leaves a failure kind without something to say', () => {
    for (const kind of ['unauthenticated', 'metered-out', 'network', 'server', 'local'] as const) {
      expect(syncFailureMessage(kind)).toContain('pins are unchanged')
    }
  })
})
