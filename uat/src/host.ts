import { readFileSync } from 'node:fs'
import * as vscode from 'vscode'

import { COMPANION_ID } from './stagePlan'

export interface RecordedMessage {
  kind: 'info' | 'warning'
  message: string
  modal: boolean
  actions: string[]
}

interface MessageOptions {
  modal?: boolean
}

function isMessageOptions(value: unknown): value is MessageOptions {
  return typeof value === 'object' && value !== null && 'modal' in value
}

/**
 * Replaces every interaction the companion can start with a recorded, scripted answer.
 *
 * This is also the harness's safety interlock. `require('vscode')` resolves to a per-extension
 * API object chosen by the *path of the requiring file*, so these patches only reach the
 * companion because this bundle is written into the extension-development folder. If that ever
 * stops being true the stubs are inert, `pkgwarden.signIn` opens a real input box, and a human
 * gets prompted for a token -- which is why `proveStubsReachExtension` runs before any scenario
 * and aborts the stage instead.
 */
export class EditorStubs {
  readonly messages: RecordedMessage[] = []
  inputBoxCalls = 0
  private statusBarCalls = 0
  private statusBarItem: vscode.StatusBarItem | undefined
  private readonly token: string
  /** Scenario-supplied click: return the label of the notification action to press. */
  answer: (message: RecordedMessage) => string | undefined = () => undefined

  constructor(token: string) {
    this.token = token
  }

  install(): void {
    const window = vscode.window
    const createStatusBarItem = window.createStatusBarItem.bind(window)
    window.createStatusBarItem = ((...args: unknown[]) => {
      this.statusBarCalls += 1
      const item = (createStatusBarItem as (...inner: unknown[]) => vscode.StatusBarItem)(...args)
      this.statusBarItem = item
      return item
    }) as typeof window.createStatusBarItem
    window.showInputBox = (async () => {
      this.inputBoxCalls += 1
      return this.token
    }) as typeof window.showInputBox
    window.showInformationMessage = this.recorder('info') as typeof window.showInformationMessage
    window.showWarningMessage = this.recorder('warning') as typeof window.showWarningMessage
    window.showErrorMessage = this.recorder('warning') as typeof window.showErrorMessage
    vscode.env.openExternal = (async () => true) as typeof vscode.env.openExternal
  }

  private recorder(kind: RecordedMessage['kind']) {
    return async (message: string, ...rest: unknown[]): Promise<string | undefined> => {
      const [first] = rest
      const modal = isMessageOptions(first) && first.modal === true
      const actions = (isMessageOptions(first) ? rest.slice(1) : rest).map(String)
      const recorded: RecordedMessage = { kind, message, modal, actions }
      this.messages.push(recorded)
      return this.answer(recorded)
    }
  }

  /** Activates the companion and proves the patches above are the ones it will call. */
  async proveStubsReachExtension(): Promise<void> {
    const companion = vscode.extensions.getExtension(COMPANION_ID)
    if (companion === undefined) {
      throw new Error(`${COMPANION_ID} is not loaded; check extensionDevelopmentPath`)
    }
    if (companion.isActive) {
      throw new Error(
        'the companion activated before the harness could stub the editor API, so a sign-in would prompt a human; stage aborted',
      )
    }
    await companion.activate()
    if (this.statusBarCalls === 0) {
      throw new Error(
        'the companion activated without calling the patched vscode API: this stage would prompt a human for a token, so it is aborted',
      )
    }
  }

  since(count: number): RecordedMessage[] {
    return this.messages.slice(count)
  }

  /**
   * The companion's own status bar text. It is the only signed-in signal a client can observe --
   * SecretStorage is private to the extension -- and stages use it to refuse to run blind.
   */
  statusText(): string {
    return this.statusBarItem?.text ?? ''
  }

  /** `$(shield) pkgwarden: sign in` is the signed-out text; anything else means a stored token. */
  signedIn(): boolean {
    const text = this.statusText()
    return text !== '' && !text.includes('pkgwarden: sign in')
  }
}

export function assertLocalApiUrl(expected: string): void {
  const configured = vscode.workspace.getConfiguration('pkgwarden').get<string>('apiUrl')
  if (configured !== expected) {
    throw new Error(
      `pkgwarden.apiUrl is ${String(configured)}, not the local stack ${expected}; refusing to sync`,
    )
  }
}

export type PinMap = Record<string, string[] | boolean>

export function effectivePins(): PinMap {
  const value = vscode.workspace.getConfiguration('extensions').get<unknown>('allowed')
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as PinMap)
    : {}
}

/**
 * Reads the editor's own install record. Deliberately not the companion's parser: evidence that
 * comes from the code under test cannot contradict it.
 */
export function installedVersions(extensionsDir: string): Map<string, string> {
  const newest = new Map<string, { version: string; installedAt: number }>()
  let entries: unknown
  try {
    entries = JSON.parse(readFileSync(`${extensionsDir}/extensions.json`, 'utf8'))
  } catch {
    return new Map()
  }
  if (!Array.isArray(entries)) {
    return new Map()
  }
  for (const entry of entries as Record<string, never>[]) {
    const identifier = entry.identifier as { id?: string } | undefined
    const version = entry.version as string | undefined
    const metadata = entry.metadata as { installedTimestamp?: number } | undefined
    if (typeof identifier?.id !== 'string' || typeof version !== 'string') {
      continue
    }
    const id = identifier.id.toLowerCase()
    const installedAt = metadata?.installedTimestamp ?? 0
    const known = newest.get(id)
    if (known === undefined || installedAt >= known.installedAt) {
      newest.set(id, { version, installedAt })
    }
  }
  return new Map([...newest].map(([id, record]) => [id, record.version]))
}

export function readSettingsFile(settingsPath: string): string {
  return readFileSync(settingsPath, 'utf8')
}

export function isRunning(extensionId: string): boolean {
  return vscode.extensions.all.some(
    (extension) => extension.id.toLowerCase() === extensionId.toLowerCase(),
  )
}

export function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}
