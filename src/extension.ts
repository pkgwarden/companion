import * as vscode from 'vscode'

import { AuthGeneration, refreshSignedInState, signIn, signOut } from './auth'
import {
  INSTALL_EXTENSION_COMMAND,
  SHOW_MENU_COMMAND,
  SIGN_IN_COMMAND,
  SIGN_OUT_COMMAND,
  SYNC_NOW_COMMAND,
} from './constants'
import { runInstallExtensionPicker } from './installPicker'
import { OutputChannelLog } from './log'
import { syncFailureMessage } from './messages'
import { RemediationStateStore } from './remediationState'
import { CompanionStatusBar, showCompanionMenu } from './statusBar'
import { SyncEngine, type SyncTrigger } from './sync'
import { SYNC_TICK_INTERVAL_MS, syncSkipMessage } from './syncDecision'
import { SyncStateStore } from './syncState'
import { registerSyncTrigger } from './syncTrigger'
import { GateTokenStore } from './tokenStore'

/**
 * A sync the user asked for — the command, or the one that follows a paste — has to say what
 * happened. The scheduled runs stay quiet and leave their evidence in the status bar and the log.
 */
async function runRequestedSync(engine: SyncEngine, trigger: SyncTrigger): Promise<void> {
  const outcome = await engine.run(trigger)
  if (outcome.status === 'skipped') {
    void vscode.window.showInformationMessage(syncSkipMessage(outcome.reason))
  }
  if (outcome.status === 'failed') {
    void vscode.window.showWarningMessage(syncFailureMessage(outcome.kind))
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const tokenStore = new GateTokenStore(context.secrets)
  const statusBar = new CompanionStatusBar()
  const generation = new AuthGeneration()
  const log = new OutputChannelLog()
  const syncState = new SyncStateStore(context.globalState)
  const remediationState = new RemediationStateStore(context.globalState)
  const engine = new SyncEngine({
    tokenStore,
    statusBar,
    syncState,
    remediationState,
    log,
    extensionPath: context.extensionPath,
  })
  const tick = setInterval(() => void engine.run('scheduled'), SYNC_TICK_INTERVAL_MS)
  context.subscriptions.push(
    statusBar,
    log,
    { dispose: () => clearInterval(tick) },
    registerSyncTrigger(() => {
      void engine.run('command')
    }),
    vscode.commands.registerCommand(SIGN_IN_COMMAND, async () => {
      if (await signIn(tokenStore, statusBar, generation)) {
        await runRequestedSync(engine, 'sign-in')
      }
    }),
    vscode.commands.registerCommand(SIGN_OUT_COMMAND, () =>
      signOut(tokenStore, statusBar, generation),
    ),
    vscode.commands.registerCommand(SYNC_NOW_COMMAND, () => runRequestedSync(engine, 'command')),
    vscode.commands.registerCommand(INSTALL_EXTENSION_COMMAND, () =>
      runInstallExtensionPicker(tokenStore, statusBar),
    ),
    vscode.commands.registerCommand(SHOW_MENU_COMMAND, () => showCompanionMenu(statusBar)),
  )
  // Last session's numbers keep the status bar honest until the first sync of this one lands.
  const { pinnedCount, lastSuccessAt } = syncState.read()
  statusBar.update({ pinnedCount, lastSuccessAt })
  // Activation itself only wires up: the SecretStorage read and the cadence-gated first sync
  // both run off this stack.
  void refreshSignedInState(tokenStore, statusBar, generation).then(() => engine.run('activation'))
}
