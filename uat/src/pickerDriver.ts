import * as vscode from 'vscode'

type Handler<T> = (value: T) => void

/**
 * A scriptable stand-in for the QuickPick the install picker creates. It exercises the real
 * `InstallPickerSession` (input classification, item building, accept handling) without a human
 * typing; the visual list itself stays a manual scenario.
 */
class ScriptedQuickPick {
  readonly buttons: readonly never[] = []
  readonly activeItems: readonly vscode.QuickPickItem[] = []
  title = ''
  placeholder = ''
  matchOnDescription = false
  matchOnDetail = false
  busy = false
  value = ''
  items: readonly vscode.QuickPickItem[] = []
  selectedItems: readonly vscode.QuickPickItem[] = []
  private readonly changeHandlers: Handler<string>[] = []
  private readonly acceptHandlers: Handler<void>[] = []
  private readonly hideHandlers: Handler<void>[] = []

  onDidChangeValue(handler: Handler<string>): vscode.Disposable {
    this.changeHandlers.push(handler)
    return { dispose: () => undefined }
  }

  onDidAccept(handler: Handler<void>): vscode.Disposable {
    this.acceptHandlers.push(handler)
    return { dispose: () => undefined }
  }

  onDidHide(handler: Handler<void>): vscode.Disposable {
    this.hideHandlers.push(handler)
    return { dispose: () => undefined }
  }

  show(): void {}
  dispose(): void {}

  hide(): void {
    for (const handler of [...this.hideHandlers]) {
      handler(undefined)
    }
  }

  type(value: string): void {
    this.value = value
    for (const handler of this.changeHandlers) {
      handler(value)
    }
  }

  accept(): void {
    for (const handler of [...this.acceptHandlers]) {
      handler(undefined)
    }
  }
}

export class PickerDriver {
  private latest: ScriptedQuickPick | null = null

  install(): void {
    vscode.window.createQuickPick = (() => {
      const quickPick = new ScriptedQuickPick()
      this.latest = quickPick
      return quickPick as unknown
    }) as typeof vscode.window.createQuickPick
  }

  private async waitForQuickPick(deadline: number): Promise<ScriptedQuickPick> {
    while (Date.now() <= deadline) {
      const created = this.latest
      if (created !== null) {
        return created
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('the install picker never created a quick pick')
  }

  /** Runs the install command, types the reference and accepts it; resolves when it settles. */
  async runInstall(reference: string, waitForPickerMs = 5_000): Promise<void> {
    this.latest = null
    const finished = vscode.commands.executeCommand('pkgwarden.installExtension')
    const quickPick = await this.waitForQuickPick(Date.now() + waitForPickerMs)
    quickPick.type(reference)
    quickPick.accept()
    await finished
  }
}
