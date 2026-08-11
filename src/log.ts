import * as vscode from 'vscode'

export const LOG_CHANNEL_NAME = 'pkgwarden'

/** Where the companion explains itself when it fails closed; never carries the gate token. */
export interface CompanionLog {
  append(message: string): void
}

export class OutputChannelLog implements CompanionLog {
  private readonly channel: vscode.OutputChannel

  constructor() {
    this.channel = vscode.window.createOutputChannel(LOG_CHANNEL_NAME)
  }

  append(message: string): void {
    this.channel.appendLine(`${new Date().toISOString()} ${message}`)
  }

  dispose(): void {
    this.channel.dispose()
  }
}
