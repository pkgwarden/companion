import { GATE_WEBAPP_URL } from './constants'
import type { VscodeWithheldVersion } from './gateClient'
import type { RemediationOutcome } from './remediationDecision'

export const REMEDIATION_REMOVE_NOW = 'Remove now'
export const REMEDIATION_VIEW_DETAILS = 'View details'

export function extensionDetailUrl(extensionId: string): string {
  return `${GATE_WEBAPP_URL}/extensions/${encodeURIComponent(extensionId.toLowerCase())}`
}

export function withheldWarningMessage(entry: VscodeWithheldVersion): string {
  return `pkgwarden withheld ${entry.extensionId}@${entry.version} (${entry.reason}).`
}

export function remediationResultMessage(
  entry: VscodeWithheldVersion,
  outcome: Exclude<RemediationOutcome, 'notify-only'>,
  rollbackVersion: string | null,
): string {
  if (outcome === 'rolled-back' && rollbackVersion !== null) {
    return `pkgwarden removed a malicious update to ${entry.extensionId}@${entry.version} and restored ${rollbackVersion}.`
  }
  return `pkgwarden removed ${entry.extensionId}@${entry.version} because gate withheld that version.`
}

export const remediationNotificationActions = [
  REMEDIATION_REMOVE_NOW,
  REMEDIATION_VIEW_DETAILS,
] as const

export const remediationResultActions = [REMEDIATION_VIEW_DETAILS] as const
