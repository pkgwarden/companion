import * as vscode from 'vscode'

import type { VscodeInventoryEntry, VscodePinMap, VscodeWithheldVersion } from './gateClient'
import type { CompanionLog } from './log'
import {
  decideRemediationDispatch,
  decideShepherdDispatch,
  isCompanionExtension,
  type RemediationMode,
  shepherdCandidates,
  withheldDedupKey,
} from './remediationDecision'
import {
  extensionDetailUrl,
  REMEDIATION_REMOVE_NOW,
  REMEDIATION_VIEW_DETAILS,
  remediationNotificationActions,
  remediationResultActions,
  remediationResultMessage,
  withheldWarningMessage,
} from './remediationMessages'
import type { RemediationStateStore } from './remediationState'

const INSTALL_COMMAND = 'workbench.extensions.installExtension'
const UNINSTALL_COMMAND = 'workbench.extensions.uninstallExtension'

/** When false, remediation skips install/uninstall side effects (e.g. sign-out mid-flight). */
export type SignedInGuard = () => Promise<boolean>

export interface RemediationPorts {
  readMode(): RemediationMode
  installExtension(idAtVersion: string): Promise<void>
  uninstallExtension(extensionId: string): Promise<void>
  showWarning(message: string, ...actions: string[]): Promise<string | undefined>
  openExternal(url: string): Promise<boolean>
}

function configuredRemediationMode(): RemediationMode {
  const configured = vscode.workspace.getConfiguration('pkgwarden').get<string>('remediation')
  return configured === 'notify' ? 'notify' : 'auto'
}

export function createRemediationPorts(): RemediationPorts {
  return {
    readMode: configuredRemediationMode,
    installExtension: async (idAtVersion) => {
      await vscode.commands.executeCommand(INSTALL_COMMAND, idAtVersion)
    },
    uninstallExtension: async (extensionId) => {
      await vscode.commands.executeCommand(UNINSTALL_COMMAND, extensionId)
    },
    showWarning: async (message, ...actions) =>
      vscode.window.showWarningMessage(message, ...actions),
    openExternal: async (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
  }
}

async function showNotificationWithDetails(
  ports: RemediationPorts,
  message: string,
  extensionId: string,
  actions: readonly string[],
): Promise<string | undefined> {
  const choice = await ports.showWarning(message, ...actions)
  if (choice === REMEDIATION_VIEW_DETAILS) {
    await ports.openExternal(extensionDetailUrl(extensionId))
  }
  return choice
}

async function autoRemediateEntry(
  entry: VscodeWithheldVersion,
  rollbackVersion: string | null,
  ports: RemediationPorts,
  state: RemediationStateStore,
  log: CompanionLog,
  signedInGuard: SignedInGuard,
): Promise<void> {
  if (!(await signedInGuard())) {
    return
  }
  let outcome: 'rolled-back' | 'removed' = 'removed'
  let appliedRollback: string | null = null

  if (rollbackVersion !== null) {
    try {
      if (!(await signedInGuard())) {
        return
      }
      await ports.installExtension(`${entry.extensionId}@${rollbackVersion}`)
      outcome = 'rolled-back'
      appliedRollback = rollbackVersion
      if (!(await state.trackShepherd(entry.extensionId, rollbackVersion))) {
        log.append(
          `could not record shepherd tracking for ${entry.extensionId}@${rollbackVersion}; it will not be advanced automatically once the verdict clears.`,
        )
      }
    } catch (error) {
      log.append(
        `rollback install failed for ${entry.extensionId}@${rollbackVersion}: ${error instanceof Error ? error.message : String(error)}; uninstalling instead.`,
      )
      if (!(await signedInGuard())) {
        return
      }
      await ports.uninstallExtension(entry.extensionId)
    }
  } else {
    await ports.uninstallExtension(entry.extensionId)
  }

  await showNotificationWithDetails(
    ports,
    remediationResultMessage(entry, outcome, appliedRollback),
    entry.extensionId,
    remediationResultActions,
  )
}

async function notifyOnlyEntry(
  entry: VscodeWithheldVersion,
  ports: RemediationPorts,
  signedInGuard: SignedInGuard,
): Promise<void> {
  const choice = await showNotificationWithDetails(
    ports,
    withheldWarningMessage(entry),
    entry.extensionId,
    remediationNotificationActions,
  )
  if (choice === REMEDIATION_REMOVE_NOW && !isCompanionExtension(entry.extensionId)) {
    if (!(await signedInGuard())) {
      return
    }
    await ports.uninstallExtension(entry.extensionId)
  }
}

export async function remediateWithheld(
  withheld: readonly VscodeWithheldVersion[],
  ports: RemediationPorts,
  state: RemediationStateStore,
  log: CompanionLog,
  signedInGuard: SignedInGuard = async () => true,
): Promise<void> {
  const mode = ports.readMode()
  const handledKeys = state.handledSet()

  for (const entry of withheld) {
    const dispatch = decideRemediationDispatch(entry, mode, handledKeys)
    if (dispatch.kind === 'skip') {
      continue
    }

    const key = withheldDedupKey(entry)
    await state.markHandled(key)
    handledKeys.add(key)

    if (dispatch.kind === 'notify-only') {
      await notifyOnlyEntry(entry, ports, signedInGuard)
      continue
    }

    if (dispatch.kind === 'rollback') {
      await autoRemediateEntry(entry, dispatch.rollbackVersion, ports, state, log, signedInGuard)
    } else {
      await autoRemediateEntry(entry, null, ports, state, log, signedInGuard)
    }
  }
}

/** Drops against the target the decision was taken on, so a racing rollback survives it. */
async function dropTracking(
  state: RemediationStateStore,
  tracking: Map<string, string | null>,
  extensionId: string,
): Promise<void> {
  await state.dropShepherd(extensionId, tracking.get(extensionId) ?? null)
  tracking.delete(extensionId)
}

export async function shepherdTrackedExtensions(
  pins: VscodePinMap,
  installedById: ReadonlyMap<string, string>,
  ports: RemediationPorts,
  state: RemediationStateStore,
  signedInGuard: SignedInGuard = async () => true,
): Promise<void> {
  const tracking = state.shepherdTracking()
  for (const extensionId of shepherdCandidates(pins, tracking)) {
    const dispatch = decideShepherdDispatch(
      extensionId,
      installedById.get(extensionId) ?? null,
      pins[extensionId],
      tracking,
    )
    if (dispatch.kind === 'skip') {
      continue
    }
    if (dispatch.kind === 'drop-tracking') {
      await dropTracking(state, tracking, dispatch.extensionId)
      continue
    }
    if (!(await signedInGuard())) {
      continue
    }
    await ports.installExtension(`${dispatch.extensionId}@${dispatch.targetVersion}`)
    const caughtUp = decideShepherdDispatch(
      extensionId,
      dispatch.targetVersion,
      pins[extensionId],
      tracking,
    )
    if (caughtUp.kind === 'drop-tracking') {
      await dropTracking(state, tracking, dispatch.extensionId)
    }
  }
}

export function installedVersionsById(
  entries: readonly VscodeInventoryEntry[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of entries) {
    map.set(entry.extensionId.toLowerCase(), entry.currentVersion)
  }
  return map
}

export async function runPostSyncRemediation(
  withheld: readonly VscodeWithheldVersion[],
  pins: VscodePinMap,
  inventoryEntries: readonly VscodeInventoryEntry[],
  state: RemediationStateStore,
  log: CompanionLog,
  signedInGuard: SignedInGuard = async () => true,
  ports: RemediationPorts = createRemediationPorts(),
): Promise<void> {
  await shepherdTrackedExtensions(
    pins,
    installedVersionsById(inventoryEntries),
    ports,
    state,
    signedInGuard,
  )
  await remediateWithheld(withheld, ports, state, log, signedInGuard)
}
