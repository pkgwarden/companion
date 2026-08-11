import {
  INSTALL_EXTENSION_COMMAND,
  INSTALL_EXTENSION_TITLE,
  SIGN_IN_COMMAND,
  SIGN_OUT_COMMAND,
  SYNC_NOW_COMMAND,
} from './constants'
import { formatUtcDate } from './utcDate'

export type CompanionStatus = 'signed-out' | 'ok' | 'stale' | 'policy-managed' | 'quota'

export interface CompanionState {
  hasToken: boolean
  pinnedCount: number
  /** Epoch milliseconds of the last successful sync; null until one lands. */
  lastSuccessAt: number | null
  /** Something outranks our `extensions.allowed` write, so we cannot claim enforcement. */
  policyManaged: boolean
  quotaExhausted: boolean
  /** The extensions directory could not be read, so gate saw enabled extensions only. */
  partialInventory: boolean
}

export interface CompanionMenuItem {
  label: string
  command: string
}

export const STALE_SYNC_THRESHOLD_MS = 48 * 60 * 60 * 1000

export function initialCompanionState(): CompanionState {
  return {
    hasToken: false,
    pinnedCount: 0,
    lastSuccessAt: null,
    policyManaged: false,
    quotaExhausted: false,
    partialInventory: false,
  }
}

/** Most to least urgent: unusable, metered out, outranked, out of date, healthy. */
export function companionStatus(state: CompanionState, nowMs: number): CompanionStatus {
  if (!state.hasToken) {
    return 'signed-out'
  }
  if (state.quotaExhausted) {
    return 'quota'
  }
  if (state.policyManaged) {
    return 'policy-managed'
  }
  const staleSince = state.lastSuccessAt
  if (staleSince === null || nowMs - staleSince > STALE_SYNC_THRESHOLD_MS) {
    return 'stale'
  }
  return 'ok'
}

export function statusBarText(status: CompanionStatus, state: CompanionState): string {
  switch (status) {
    case 'signed-out':
      return '$(shield) pkgwarden: sign in'
    case 'ok':
      return `$(shield) pkgwarden: ${state.pinnedCount} pinned`
    case 'stale':
      return '$(warning) pkgwarden: sync stale'
    case 'policy-managed':
      return '$(warning) pkgwarden: policy managed'
    case 'quota':
      return '$(warning) pkgwarden: quota reached'
  }
}

const PARTIAL_INVENTORY_NOTE =
  'pkgwarden could not read the full extension list, so disabled extensions may be missing from these pins.'

function tooltipForStatus(status: CompanionStatus, state: CompanionState): string {
  switch (status) {
    case 'signed-out':
      return 'Sign in with a pkgwarden gate token to keep your extensions on cleared versions.'
    case 'ok':
      return `pkgwarden is pinning ${state.pinnedCount} extensions to versions gate has cleared.`
    case 'stale': {
      const lastSuccess = state.lastSuccessAt === null ? null : formatUtcDate(state.lastSuccessAt)
      return lastSuccess === null
        ? 'pkgwarden has not synced your extension policy yet.'
        : `pkgwarden last synced your extension policy on ${lastSuccess}.`
    }
    case 'policy-managed':
      return 'Another policy layer owns extensions.allowed, so pkgwarden cannot enforce its pins here.'
    case 'quota':
      return 'pkgwarden gate declined the last sync for quota reasons; the next scheduled sync will try again.'
  }
}

export function statusBarTooltip(status: CompanionStatus, state: CompanionState): string {
  const tooltip = tooltipForStatus(status, state)
  return state.partialInventory ? `${tooltip} ${PARTIAL_INVENTORY_NOTE}` : tooltip
}

/**
 * Installing is the menu's headline action, but only once a token is stored: the picker cannot
 * search the catalog without one, so a signed-out menu offers signing in and nothing else.
 */
export function menuItemsForStatus(status: CompanionStatus): CompanionMenuItem[] {
  return status === 'signed-out'
    ? [{ label: 'Sign in with a gate token', command: SIGN_IN_COMMAND }]
    : [
        { label: INSTALL_EXTENSION_TITLE, command: INSTALL_EXTENSION_COMMAND },
        { label: 'Sync policy now', command: SYNC_NOW_COMMAND },
        { label: 'Sign out', command: SIGN_OUT_COMMAND },
      ]
}
