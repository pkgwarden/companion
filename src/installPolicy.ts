import type { VscodeInstallCheckResult, VscodePolicyReason } from './gateClient'
import { blockedMessage, unresolvedVersionMessage } from './messages'

export const OVERRIDE_CONFIRM_LABEL =
  'Install anyway — this version has not cleared pkgwarden policy'

export interface InstallAction {
  extensionId: string
  version: string
  pinVersions: string[]
}

export type InstallPlan =
  | { kind: 'install'; action: InstallAction }
  | { kind: 'blocked'; message: string; override: InstallAction | null }

/**
 * The force matrix, identical to the CLI's `--force`: the transient reasons may be overridden by
 * explicit confirmation, a withheld or malicious verdict never can — no button, no setting.
 */
export function isOverridableBlock(reason: VscodePolicyReason | null): boolean {
  return reason === 'pending_scan' || reason === 'quarantine'
}

/** An overridden version is not in `allowed_versions`, so pin it too or our own pin blocks it. */
export function pinVersionsForInstall(
  allowedVersions: readonly string[],
  version: string,
): string[] {
  return allowedVersions.includes(version) ? [...allowedVersions] : [...allowedVersions, version]
}

function actionFor(result: VscodeInstallCheckResult, version: string): InstallAction {
  return {
    extensionId: result.extensionId,
    version,
    pinVersions: pinVersionsForInstall(result.allowedVersions, version),
  }
}

/**
 * Turns one install-check into what the picker may do. Gate leaves `resolved_version` null unless
 * the user named a version, so a blocked-and-overridable outcome can only be reached by naming it —
 * that is how "a force never changes version resolution" is enforced client-side too.
 */
export function planInstall(
  result: VscodeInstallCheckResult,
  requestedVersion: string | null,
): InstallPlan {
  const version = result.resolvedVersion
  if (!result.whyBlocked.blocked) {
    return version === null
      ? { kind: 'blocked', message: unresolvedVersionMessage(result.extensionId), override: null }
      : { kind: 'install', action: actionFor(result, version) }
  }
  const message = blockedMessage({
    extensionId: result.extensionId,
    version: version ?? requestedVersion,
    reason: result.whyBlocked.reason,
    quarantineCutoffUtc: result.whyBlocked.quarantineCutoffUtc,
    verdictSummary: result.whyBlocked.verdictSummary,
    explicitVersionRequested: requestedVersion !== null,
    allowedVersions: result.allowedVersions,
  })
  if (version !== null && isOverridableBlock(result.whyBlocked.reason)) {
    return { kind: 'blocked', message, override: actionFor(result, version) }
  }
  return { kind: 'blocked', message, override: null }
}
