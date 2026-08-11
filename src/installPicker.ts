import * as vscode from 'vscode'

import { catalogPickItems, explicitRefPickItem, type InstallPickItem } from './catalogItems'
import { DEFAULT_GATE_API_URL } from './constants'
import { CATALOG_SEARCH_DEBOUNCE_MS, Debouncer } from './debounce'
import { classifyPickerInput } from './extensionRef'
import {
  CATALOG_MIN_QUERY_LENGTH,
  GateClient,
  isMeteredOut,
  type VscodeInstallCheckResult,
  type VscodePinMap,
} from './gateClient'
import { type InstallAction, OVERRIDE_CONFIRM_LABEL, planInstall } from './installPolicy'
import {
  catalogSearchFailureMessage,
  extensionReference,
  installCheckFailureMessage,
  installedMessage,
  installFailureMessage,
  malformedRefMessage,
  pinWriteFailureMessage,
  SIGN_IN_REQUIRED_MESSAGE,
  syncTriggerFailureMessage,
} from './messages'
import { planPinUpdate } from './pinMerge'
import type { CompanionStatusBar } from './statusBar'
import { requestImmediateSync } from './syncTrigger'
import { type GateTokenStore, secretReadFailureMessage } from './tokenStore'

/** The built-in that installs a gallery extension, version-pinned via the `@` suffix. */
export const INSTALL_EXTENSION_VSCODE_COMMAND = 'workbench.extensions.installExtension'

const PICKER_TITLE = 'pkgwarden: install extension'
const PICKER_PLACEHOLDER = 'Search the pkgwarden catalog, or type publisher.name@version'

interface InstallTarget {
  extensionId: string
  version: string | null
}

function configuredApiUrl(): string {
  const configured = vscode.workspace.getConfiguration('pkgwarden').get<string>('apiUrl')
  return configured === undefined || configured.trim() === '' ? DEFAULT_GATE_API_URL : configured
}

async function readToken(tokenStore: GateTokenStore): Promise<string | null> {
  try {
    const token = await tokenStore.read()
    if (token === undefined) {
      void vscode.window.showWarningMessage(SIGN_IN_REQUIRED_MESSAGE)
      return null
    }
    return token
  } catch (error) {
    void vscode.window.showWarningMessage(secretReadFailureMessage(error))
    return null
  }
}

/**
 * Search-as-you-type over the gate catalog. Only the newest search may render, so a slow response
 * for an abandoned query cannot repopulate the list behind the user.
 */
class InstallPickerSession {
  private readonly client: GateClient
  private readonly statusBar: CompanionStatusBar
  private readonly quickPick = vscode.window.createQuickPick<InstallPickItem>()
  private readonly debouncer = new Debouncer(CATALOG_SEARCH_DEBOUNCE_MS)
  private searchGeneration = 0
  private closed = false
  private settle: ((target: InstallTarget | null) => void) | null = null

  constructor(client: GateClient, statusBar: CompanionStatusBar) {
    this.client = client
    this.statusBar = statusBar
  }

  pick(): Promise<InstallTarget | null> {
    return new Promise((resolve) => {
      this.settle = resolve
      this.quickPick.title = PICKER_TITLE
      this.quickPick.placeholder = PICKER_PLACEHOLDER
      // VS Code filters the item list against the typed value, so matching is widened for
      // server-side hits whose display name does not contain the query.
      this.quickPick.matchOnDescription = true
      this.quickPick.matchOnDetail = true
      this.quickPick.onDidChangeValue((value) => this.handleValue(value))
      this.quickPick.onDidAccept(() => this.handleAccept())
      this.quickPick.onDidHide(() => this.handleHide())
      this.quickPick.show()
    })
  }

  private handleValue(value: string): void {
    const input = classifyPickerInput(value)
    this.invalidateSearch()
    if (input.kind === 'search' && input.query.length >= CATALOG_MIN_QUERY_LENGTH) {
      this.quickPick.busy = true
      this.debouncer.schedule(() => void this.search(input.query))
      return
    }
    this.debouncer.cancel()
    this.quickPick.busy = false
    this.quickPick.items =
      input.kind === 'explicit' ? [explicitRefPickItem(input.extensionId, input.version)] : []
  }

  private async search(query: string): Promise<void> {
    const generation = this.searchGeneration
    try {
      const page = await this.client.searchCatalog(query)
      if (!this.searchStillActive(generation)) {
        return
      }
      this.quickPick.items = catalogPickItems(page)
    } catch (error) {
      if (!this.searchStillActive(generation)) {
        return
      }
      this.quickPick.items = []
      this.reportQuota(error)
      void vscode.window.showWarningMessage(catalogSearchFailureMessage(error))
    } finally {
      if (this.searchStillActive(generation)) {
        this.quickPick.busy = false
      }
    }
  }

  private searchStillActive(generation: number): boolean {
    return !this.closed && generation === this.searchGeneration
  }

  private invalidateSearch(): void {
    this.searchGeneration += 1
  }

  private handleAccept(): void {
    this.invalidateSearch()
    this.finish(this.acceptedTarget())
    this.quickPick.hide()
  }

  private handleHide(): void {
    this.invalidateSearch()
    this.debouncer.cancel()
    this.closed = true
    this.quickPick.dispose()
    this.finish(null)
  }

  private acceptedTarget(): InstallTarget | null {
    const [selected] = this.quickPick.selectedItems
    if (selected !== undefined) {
      return { extensionId: selected.extensionId, version: selected.version }
    }
    const input = classifyPickerInput(this.quickPick.value)
    if (input.kind === 'explicit') {
      return { extensionId: input.extensionId, version: input.version }
    }
    if (input.kind === 'malformed') {
      void vscode.window.showWarningMessage(malformedRefMessage(input.raw))
    }
    return null
  }

  private finish(target: InstallTarget | null): void {
    const settle = this.settle
    if (settle === null) {
      return
    }
    this.settle = null
    settle(target)
  }

  private reportQuota(error: unknown): void {
    if (isMeteredOut(error)) {
      this.statusBar.update({ quotaExhausted: true })
    }
  }
}

/** Pin first, then install: the allowlist has to admit the version before the editor asks for it. */
async function pinThenInstall(action: InstallAction): Promise<void> {
  const reference = extensionReference(action.extensionId, action.version)
  const configuration = vscode.workspace.getConfiguration('extensions')
  const globalPins =
    configuration.inspect<VscodePinMap>('allowed')?.globalValue ?? ({} as VscodePinMap)
  const decision = planPinUpdate(globalPins, action.extensionId, action.pinVersions)
  if (decision.kind === 'write') {
    try {
      await configuration.update('allowed', decision.pinMap, vscode.ConfigurationTarget.Global)
    } catch (error) {
      void vscode.window.showWarningMessage(pinWriteFailureMessage(reference, error))
      return
    }
  }
  try {
    await vscode.commands.executeCommand(INSTALL_EXTENSION_VSCODE_COMMAND, reference)
  } catch (error) {
    void vscode.window.showWarningMessage(installFailureMessage(reference, error))
    return
  }
  void vscode.window.showInformationMessage(installedMessage(reference))
  const sync = requestImmediateSync()
  if (sync.kind === 'failed') {
    void vscode.window.showWarningMessage(syncTriggerFailureMessage(reference, sync.error))
  }
}

/** Exactly one metered install-check per attempt, and no retries: a failure installs nothing. */
async function attemptInstall(
  client: GateClient,
  statusBar: CompanionStatusBar,
  target: InstallTarget,
): Promise<void> {
  let result: VscodeInstallCheckResult
  try {
    result = await client.installCheck(target.extensionId, target.version)
  } catch (error) {
    if (isMeteredOut(error)) {
      statusBar.update({ quotaExhausted: true })
    }
    void vscode.window.showWarningMessage(
      installCheckFailureMessage(error, extensionReference(target.extensionId, target.version)),
    )
    return
  }
  const plan = planInstall(result, target.version)
  if (plan.kind === 'install') {
    await pinThenInstall(plan.action)
    return
  }
  if (plan.override === null) {
    void vscode.window.showWarningMessage(plan.message)
    return
  }
  const confirmed = await vscode.window.showWarningMessage(
    plan.message,
    { modal: true },
    OVERRIDE_CONFIRM_LABEL,
  )
  if (confirmed === OVERRIDE_CONFIRM_LABEL) {
    await pinThenInstall(plan.override)
  }
}

export async function runInstallExtensionPicker(
  tokenStore: GateTokenStore,
  statusBar: CompanionStatusBar,
): Promise<void> {
  const token = await readToken(tokenStore)
  if (token === null) {
    return
  }
  const client = new GateClient({ apiUrl: configuredApiUrl(), token })
  const target = await new InstallPickerSession(client, statusBar).pick()
  if (target !== null) {
    await attemptInstall(client, statusBar, target)
  }
}
