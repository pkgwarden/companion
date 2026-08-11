import * as vscode from 'vscode'

import { SHOW_MENU_COMMAND } from './constants'
import {
  type CompanionState,
  type CompanionStatus,
  companionStatus,
  initialCompanionState,
  menuItemsForStatus,
  statusBarText,
  statusBarTooltip,
} from './statusBarState'

export class CompanionStatusBar {
  private readonly item: vscode.StatusBarItem
  private state: CompanionState = initialCompanionState()

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.item.command = SHOW_MENU_COMMAND
    this.render()
    this.item.show()
  }

  get status(): CompanionStatus {
    return companionStatus(this.state, Date.now())
  }

  update(change: Partial<CompanionState>): void {
    this.state = { ...this.state, ...change }
    this.render()
  }

  dispose(): void {
    this.item.dispose()
  }

  private render(): void {
    const status = this.status
    this.item.text = statusBarText(status, this.state)
    this.item.tooltip = statusBarTooltip(status, this.state)
  }
}

export async function showCompanionMenu(statusBar: CompanionStatusBar): Promise<void> {
  const picked = await vscode.window.showQuickPick(menuItemsForStatus(statusBar.status), {
    placeHolder: 'pkgwarden',
  })
  if (picked !== undefined) {
    await vscode.commands.executeCommand(picked.command)
  }
}
