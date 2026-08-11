import { describe, expect, it } from 'vitest'

import type { VscodeInstallCheckResult } from './gateClient'
import { isOverridableBlock, pinVersionsForInstall, planInstall } from './installPolicy'

function checkResult(overrides: Partial<VscodeInstallCheckResult> = {}): VscodeInstallCheckResult {
  return {
    extensionId: 'contoso.linter-pro',
    extensionExists: true,
    resolvedVersion: '4.1.9',
    whyBlocked: { blocked: false, reason: null, verdictSummary: null, quarantineCutoffUtc: null },
    allowedVersions: ['4.1.7', '4.1.9'],
    ...overrides,
  }
}

function blockedResult(
  reason: VscodeInstallCheckResult['whyBlocked']['reason'],
  overrides: Partial<VscodeInstallCheckResult> = {},
): VscodeInstallCheckResult {
  return checkResult({
    resolvedVersion: '4.2.1',
    whyBlocked: { blocked: true, reason, verdictSummary: null, quarantineCutoffUtc: null },
    ...overrides,
  })
}

describe('isOverridableBlock', () => {
  it('allows an override for the transient reasons only', () => {
    expect(isOverridableBlock('pending_scan')).toBe(true)
    expect(isOverridableBlock('quarantine')).toBe(true)
  })

  it('never allows an override for a withheld or malicious verdict', () => {
    expect(isOverridableBlock('scan_verdict')).toBe(false)
    expect(isOverridableBlock('known_malware')).toBe(false)
  })

  it('never allows an override for an extension gate cannot see', () => {
    expect(isOverridableBlock('not_in_catalog')).toBe(false)
    expect(isOverridableBlock('ms_lookup_capped')).toBe(false)
    expect(isOverridableBlock(null)).toBe(false)
  })
})

describe('pinVersionsForInstall', () => {
  it('keeps the versions gate sent when the target is already among them', () => {
    expect(pinVersionsForInstall(['4.1.7', '4.1.9'], '4.1.9')).toEqual(['4.1.7', '4.1.9'])
  })

  it('adds an overridden version so the editor is not blocked by our own pin', () => {
    expect(pinVersionsForInstall(['4.1.7', '4.1.9'], '4.2.1')).toEqual(['4.1.7', '4.1.9', '4.2.1'])
  })
})

describe('planInstall', () => {
  it('installs the version gate resolved and pins the versions gate allows', () => {
    expect(planInstall(checkResult(), null)).toEqual({
      kind: 'install',
      action: {
        extensionId: 'contoso.linter-pro',
        version: '4.1.9',
        pinVersions: ['4.1.7', '4.1.9'],
      },
    })
  })

  it('installs an explicitly named version that gate cleared', () => {
    expect(planInstall(checkResult({ resolvedVersion: '4.1.7' }), '4.1.7')).toMatchObject({
      kind: 'install',
      action: { version: '4.1.7' },
    })
  })

  it('offers an override for a pending scan the user named explicitly', () => {
    const plan = planInstall(blockedResult('pending_scan'), '4.2.1')

    expect(plan.kind).toBe('blocked')
    expect(plan).toMatchObject({
      message:
        'contoso.linter-pro@4.2.1 is pending a security scan; a scan has been queued — retry in a few minutes. latest allowed version: 4.1.9.',
      override: {
        extensionId: 'contoso.linter-pro',
        version: '4.2.1',
        pinVersions: ['4.1.7', '4.1.9', '4.2.1'],
      },
    })
  })

  it('offers an override for a quarantined version the user named explicitly', () => {
    expect(
      planInstall(
        blockedResult('quarantine', {
          whyBlocked: {
            blocked: true,
            reason: 'quarantine',
            verdictSummary: null,
            quarantineCutoffUtc: '2026-08-11T09:30:00Z',
          },
        }),
        '4.2.1',
      ),
    ).toMatchObject({
      kind: 'blocked',
      message:
        'contoso.linter-pro@4.2.1 is in quarantine until 2026-08-11 (published too recently). latest allowed version: 4.1.9.',
      override: { version: '4.2.1' },
    })
  })

  it('never offers an override for a scan verdict', () => {
    expect(
      planInstall(
        blockedResult('scan_verdict', {
          whyBlocked: {
            blocked: true,
            reason: 'scan_verdict',
            verdictSummary: 'credential exfiltration',
            quarantineCutoffUtc: null,
          },
        }),
        '4.2.1',
      ),
    ).toEqual({
      kind: 'blocked',
      message:
        "contoso.linter-pro@4.2.1 was withheld by pkgwarden's security scan (credential exfiltration); this cannot be overridden. latest allowed version: 4.1.9.",
      override: null,
    })
  })

  it('never offers an override for known malware', () => {
    expect(planInstall(blockedResult('known_malware'), '4.2.1')).toMatchObject({
      kind: 'blocked',
      override: null,
    })
  })

  it('does not offer an override when no version was named, so a force cannot change resolution', () => {
    expect(planInstall(blockedResult('pending_scan', { resolvedVersion: null }), null)).toEqual({
      kind: 'blocked',
      message:
        'contoso.linter-pro is pending a security scan; a scan has been queued — retry in a few minutes.',
      override: null,
    })
  })

  it('reports an extension gate has never seen', () => {
    expect(
      planInstall(
        blockedResult('not_in_catalog', {
          extensionExists: false,
          resolvedVersion: null,
          allowedVersions: [],
        }),
        null,
      ),
    ).toMatchObject({ kind: 'blocked', override: null })
  })

  it('refuses to install when gate allows the extension but resolves no version', () => {
    expect(planInstall(checkResult({ resolvedVersion: null, allowedVersions: [] }), null)).toEqual({
      kind: 'blocked',
      message: 'pkgwarden found no installable version of contoso.linter-pro in the gate catalog.',
      override: null,
    })
  })
})
