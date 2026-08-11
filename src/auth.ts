import * as vscode from 'vscode'

import type { CompanionStatusBar } from './statusBar'
import { initialCompanionState } from './statusBarState'
import {
  type GateTokenStore,
  normalizeToken,
  secretReadFailureMessage,
  secretWriteFailureMessage,
} from './tokenStore'

/**
 * Bumped by every successful sign-in / sign-out so an in-flight startup SecretStorage read
 * cannot overwrite the status bar with a stale hasToken result.
 */
export class AuthGeneration {
  private value = 0

  bump(): void {
    this.value += 1
  }

  current(): number {
    return this.value
  }
}

/**
 * Paste-a-token is the v1 flow: forks round-trip `vscode://` callbacks unreliably, so browser
 * OAuth is out of scope. The token goes straight into SecretStorage and is never logged.
 * Never rejects — command handlers leave the returned promise unhandled. Returns whether a
 * token was stored, so the caller can sync immediately instead of waiting for the next tick.
 */
export async function signIn(
  tokenStore: GateTokenStore,
  statusBar: CompanionStatusBar,
  generation: AuthGeneration,
): Promise<boolean> {
  const entered = await vscode.window.showInputBox({
    password: true,
    ignoreFocusOut: true,
    title: 'pkgwarden',
    prompt: 'Paste a pkgwarden gate API token',
    placeHolder: 'gate API token',
  })
  if (entered === undefined) {
    return false
  }
  const token = normalizeToken(entered)
  if (token === null) {
    void vscode.window.showWarningMessage('No token entered — pkgwarden is still signed out.')
    return false
  }
  try {
    await tokenStore.save(token)
  } catch (error) {
    void vscode.window.showWarningMessage(secretWriteFailureMessage(error, 'save'))
    return false
  }
  generation.bump()
  statusBar.update({ hasToken: true })
  void vscode.window.showInformationMessage('Signed in to pkgwarden gate.')
  return true
}

/** Never rejects — see signIn. */
export async function signOut(
  tokenStore: GateTokenStore,
  statusBar: CompanionStatusBar,
  generation: AuthGeneration,
): Promise<void> {
  try {
    await tokenStore.clear()
  } catch (error) {
    void vscode.window.showWarningMessage(secretWriteFailureMessage(error, 'clear'))
    return
  }
  generation.bump()
  statusBar.update(initialCompanionState())
  void vscode.window.showInformationMessage('Signed out of pkgwarden gate.')
}

/**
 * Never rejects: activation calls this without awaiting, so a keyring failure has to surface
 * here instead of becoming an unhandled rejection that leaves the status bar quietly wrong.
 * A bump from sign-in / sign-out while the read is in flight discards this result.
 */
export async function refreshSignedInState(
  tokenStore: GateTokenStore,
  statusBar: CompanionStatusBar,
  generation: AuthGeneration,
): Promise<void> {
  const started = generation.current()
  try {
    const hasToken = (await tokenStore.read()) !== undefined
    if (started !== generation.current()) {
      return
    }
    statusBar.update({ hasToken })
  } catch (error) {
    if (started !== generation.current()) {
      return
    }
    statusBar.update({ hasToken: false })
    void vscode.window.showWarningMessage(secretReadFailureMessage(error))
  }
}
