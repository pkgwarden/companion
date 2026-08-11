import { COMPANION_EXTENSION_ID } from './constants'
import type { VscodePinMap, VscodeWithheldVersion } from './gateClient'
import type { ShepherdTracking } from './remediationState'

export type RemediationMode = 'auto' | 'notify'

export type RemediationSkipReason = 'self-guard' | 'already-handled'

export type RemediationDispatch =
  | { kind: 'skip'; reason: RemediationSkipReason }
  | { kind: 'notify-only'; entry: VscodeWithheldVersion }
  | { kind: 'rollback'; entry: VscodeWithheldVersion; rollbackVersion: string }
  | { kind: 'uninstall'; entry: VscodeWithheldVersion }

export type RemediationOutcome = 'rolled-back' | 'removed' | 'notify-only'

export type ShepherdSkipReason = 'self-guard' | 'not-tracked' | 'still-withheld'

export type ShepherdDispatch =
  | { kind: 'skip'; reason: ShepherdSkipReason }
  | { kind: 'install'; extensionId: string; targetVersion: string }
  | { kind: 'drop-tracking'; extensionId: string }

export function withheldDedupKey(entry: VscodeWithheldVersion): string {
  return `${entry.extensionId.toLowerCase()}@${entry.version}`
}

export function isCompanionExtension(extensionId: string): boolean {
  return extensionId.toLowerCase() === COMPANION_EXTENSION_ID
}

export function decideRemediationDispatch(
  entry: VscodeWithheldVersion,
  mode: RemediationMode,
  handledKeys: ReadonlySet<string>,
): RemediationDispatch {
  if (isCompanionExtension(entry.extensionId)) {
    return { kind: 'skip', reason: 'self-guard' }
  }
  const key = withheldDedupKey(entry)
  if (handledKeys.has(key)) {
    return { kind: 'skip', reason: 'already-handled' }
  }
  if (mode === 'notify') {
    return { kind: 'notify-only', entry }
  }
  if (entry.rollbackVersion !== null) {
    return { kind: 'rollback', entry, rollbackVersion: entry.rollbackVersion }
  }
  return { kind: 'uninstall', entry }
}

export function newestPinnedVersion(pinnedVersions: string[] | boolean | undefined): string | null {
  if (!Array.isArray(pinnedVersions) || pinnedVersions.length === 0) {
    return null
  }
  return pinnedVersions[pinnedVersions.length - 1] ?? null
}

/**
 * Rolling back version-pins the extension in the editor and suppresses its auto-update, so the
 * shepherd is the only forward path. Tracking therefore survives every sync taken while the editor
 * still sits on the rollback target, and ends only once it has moved on (#575).
 */
export function decideShepherdDispatch(
  extensionId: string,
  installedVersion: string | null,
  pinnedVersions: string[] | boolean | undefined,
  tracking: ShepherdTracking,
): ShepherdDispatch {
  const normalized = extensionId.toLowerCase()
  if (isCompanionExtension(normalized)) {
    return { kind: 'skip', reason: 'self-guard' }
  }
  if (!tracking.has(normalized)) {
    return { kind: 'skip', reason: 'not-tracked' }
  }
  const newestPinned = newestPinnedVersion(pinnedVersions)
  if (newestPinned === null || installedVersion === null) {
    return { kind: 'drop-tracking', extensionId: normalized }
  }
  if (installedVersion !== newestPinned) {
    return { kind: 'install', extensionId: normalized, targetVersion: newestPinned }
  }
  if (tracking.get(normalized) === installedVersion) {
    return { kind: 'skip', reason: 'still-withheld' }
  }
  return { kind: 'drop-tracking', extensionId: normalized }
}

/** Shepherd runs only for ids already tracked; withheld remediation never acts on pin-map absence. */
export function shepherdCandidates(pins: VscodePinMap, tracking: ShepherdTracking): string[] {
  return [...tracking.keys()].filter((extensionId) => pins[extensionId] !== undefined)
}
