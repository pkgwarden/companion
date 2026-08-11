import { describe, expect, it } from 'vitest'

import { GATE_WEBAPP_URL } from './constants'
import {
  extensionDetailUrl,
  REMEDIATION_REMOVE_NOW,
  REMEDIATION_VIEW_DETAILS,
  remediationNotificationActions,
  remediationResultActions,
  remediationResultMessage,
  withheldWarningMessage,
} from './remediationMessages'

const withheld = {
  extensionId: 'contoso.linter-pro',
  version: '4.2.1',
  reason: 'scan_verdict' as const,
  rollbackVersion: '4.1.9',
}

describe('extensionDetailUrl', () => {
  it('points at the gate webapp extension page', () => {
    expect(extensionDetailUrl('Contoso.Linter-Pro')).toBe(
      `${GATE_WEBAPP_URL}/extensions/contoso.linter-pro`,
    )
  })
})

describe('withheldWarningMessage', () => {
  it('includes the extension id, version, and reason', () => {
    expect(withheldWarningMessage(withheld)).toBe(
      'pkgwarden withheld contoso.linter-pro@4.2.1 (scan_verdict).',
    )
  })
})

describe('remediationResultMessage', () => {
  it('names the rollback target after auto-remediation restores a version', () => {
    expect(remediationResultMessage(withheld, 'rolled-back', '4.1.9')).toBe(
      'pkgwarden removed a malicious update to contoso.linter-pro@4.2.1 and restored 4.1.9.',
    )
  })

  it('names the removed extension after uninstall fallback', () => {
    expect(remediationResultMessage(withheld, 'removed', null)).toBe(
      'pkgwarden removed contoso.linter-pro@4.2.1 because gate withheld that version.',
    )
  })
})

describe('remediation notification actions', () => {
  it('offers remove-now and view-details in notify mode', () => {
    expect(remediationNotificationActions).toEqual([
      REMEDIATION_REMOVE_NOW,
      REMEDIATION_VIEW_DETAILS,
    ])
  })

  it('offers view-details after auto remediation completes', () => {
    expect(remediationResultActions).toEqual([REMEDIATION_VIEW_DETAILS])
  })
})
