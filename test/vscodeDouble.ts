/**
 * Stand-in for the `vscode` module under vitest (wired up in vitest.config.ts). It records
 * what the glue layer did so tests can assert on it; only the API surface the companion
 * actually uses is modelled.
 */

export interface StatusBarItemDouble {
  text: string
  tooltip: string | undefined
  command: string | undefined
  visible: boolean
  disposed: boolean
  show(): void
  dispose(): void
}

export interface InputBoxOptionsDouble {
  password?: boolean
  prompt?: string
  title?: string
  placeHolder?: string
  ignoreFocusOut?: boolean
}

export interface QuickPickItemDouble {
  label: string
  description?: string
  detail?: string
}

export interface DisposableDouble {
  dispose(): void
}

/**
 * `vscode.QuickPick`, plus the `type` / `selectItem` / `accept` drivers a test needs to stand in
 * for a user (the real API has no way to script interaction).
 */
export interface QuickPickDouble {
  title: string | undefined
  placeholder: string | undefined
  value: string
  busy: boolean
  items: QuickPickItemDouble[]
  selectedItems: QuickPickItemDouble[]
  matchOnDescription: boolean
  matchOnDetail: boolean
  visible: boolean
  disposed: boolean
  onDidChangeValue(handler: (value: string) => void): DisposableDouble
  onDidAccept(handler: () => void): DisposableDouble
  onDidHide(handler: () => void): DisposableDouble
  show(): void
  hide(): void
  dispose(): void
  type(value: string): void
  selectItem(index: number): void
  accept(): void
}

export interface MessageOptionsDouble {
  modal?: boolean
}

export interface ModalWarningDouble {
  message: string
  modal: boolean
  items: string[]
}

export interface ExecutedCommandDouble {
  command: string
  args: unknown[]
}

export interface ConfigurationUpdateDouble {
  section: string | undefined
  key: string
  value: unknown
  target: number | undefined
}

export interface OutputChannelDouble {
  name: string
  lines: string[]
  disposed: boolean
  appendLine(line: string): void
  dispose(): void
}

export interface ExtensionDouble {
  id: string
  packageJSON: { version?: string }
}

export interface ConfigurationInspectDouble<T = unknown> {
  globalValue?: T
  workspaceValue?: T
}

/**
 * `values` is the default layer; `globalValues` / `workspaceValues` model inspect/update targets;
 * `overrides` stands in for the higher-precedence device/MDM policy layer that wins on read.
 */
export interface ConfigurationDouble {
  values: Map<string, unknown>
  globalValues: Map<string, unknown>
  workspaceValues: Map<string, unknown>
  overrides: Map<string, unknown>
  globalUpdates: ConfigurationUpdateDouble[]
  updateError: Error | null
}

export interface WarningMessageDouble {
  message: string
  actions: string[]
}

export interface VscodeRecorder {
  statusBarItems: StatusBarItemDouble[]
  commandHandlers: Map<string, (...args: unknown[]) => unknown>
  executedCommands: ExecutedCommandDouble[]
  informationMessages: string[]
  warningMessages: string[]
  warningMessageActions: WarningMessageDouble[]
  warningResponses: (string | undefined)[]
  openedExternalUrls: string[]
  modalWarnings: ModalWarningDouble[]
  modalResponses: (string | undefined)[]
  inputBoxOptions: InputBoxOptionsDouble[]
  inputBoxResponses: (string | undefined)[]
  quickPickItems: QuickPickItemDouble[][]
  quickPickSelection: number | null
  quickPicks: QuickPickDouble[]
  outputChannels: OutputChannelDouble[]
  installedExtensions: ExtensionDouble[]
  configuration: ConfigurationDouble
}

function emptyConfiguration(): ConfigurationDouble {
  return {
    values: new Map(),
    globalValues: new Map(),
    workspaceValues: new Map(),
    overrides: new Map(),
    globalUpdates: [],
    updateError: null,
  }
}

export const recorder: VscodeRecorder = {
  statusBarItems: [],
  commandHandlers: new Map(),
  executedCommands: [],
  informationMessages: [],
  warningMessages: [],
  warningMessageActions: [],
  warningResponses: [],
  openedExternalUrls: [],
  modalWarnings: [],
  modalResponses: [],
  inputBoxOptions: [],
  inputBoxResponses: [],
  quickPickItems: [],
  quickPickSelection: null,
  quickPicks: [],
  outputChannels: [],
  installedExtensions: [],
  configuration: emptyConfiguration(),
}

export function resetVscodeDouble(): void {
  recorder.statusBarItems = []
  recorder.commandHandlers = new Map()
  recorder.executedCommands = []
  recorder.informationMessages = []
  recorder.warningMessages = []
  recorder.warningMessageActions = []
  recorder.warningResponses = []
  recorder.openedExternalUrls = []
  recorder.modalWarnings = []
  recorder.modalResponses = []
  recorder.inputBoxOptions = []
  recorder.inputBoxResponses = []
  recorder.quickPickItems = []
  recorder.quickPickSelection = null
  recorder.quickPicks = []
  recorder.outputChannels = []
  recorder.installedExtensions = []
  recorder.configuration = emptyConfiguration()
}

export const StatusBarAlignment = { Left: 1, Right: 2 } as const

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const

function createStatusBarItem(): StatusBarItemDouble {
  const item: StatusBarItemDouble = {
    text: '',
    tooltip: undefined,
    command: undefined,
    visible: false,
    disposed: false,
    show: () => {
      item.visible = true
    },
    dispose: () => {
      item.disposed = true
    },
  }
  recorder.statusBarItems.push(item)
  return item
}

function createQuickPick(): QuickPickDouble {
  const valueHandlers: ((value: string) => void)[] = []
  const acceptHandlers: (() => void)[] = []
  const hideHandlers: (() => void)[] = []
  const quickPick: QuickPickDouble = {
    title: undefined,
    placeholder: undefined,
    value: '',
    busy: false,
    items: [],
    selectedItems: [],
    matchOnDescription: false,
    matchOnDetail: false,
    visible: false,
    disposed: false,
    onDidChangeValue: (handler) => {
      valueHandlers.push(handler)
      return { dispose: () => undefined }
    },
    onDidAccept: (handler) => {
      acceptHandlers.push(handler)
      return { dispose: () => undefined }
    },
    onDidHide: (handler) => {
      hideHandlers.push(handler)
      return { dispose: () => undefined }
    },
    show: () => {
      quickPick.visible = true
    },
    hide: () => {
      quickPick.visible = false
      for (const handler of [...hideHandlers]) {
        handler()
      }
    },
    dispose: () => {
      quickPick.disposed = true
    },
    type: (value) => {
      quickPick.value = value
      quickPick.selectedItems = []
      for (const handler of [...valueHandlers]) {
        handler(value)
      }
    },
    selectItem: (index) => {
      const item = quickPick.items[index]
      if (item === undefined) {
        throw new Error(`no quick-pick item at index ${index}`)
      }
      quickPick.selectedItems = [item]
    },
    accept: () => {
      for (const handler of [...acceptHandlers]) {
        handler()
      }
    },
  }
  recorder.quickPicks.push(quickPick)
  return quickPick
}

export const window = {
  createStatusBarItem,
  createQuickPick,
  showInformationMessage: async (message: string): Promise<undefined> => {
    recorder.informationMessages.push(message)
    return undefined
  },
  showWarningMessage: async (
    message: string,
    ...rest: (string | MessageOptionsDouble)[]
  ): Promise<string | undefined> => {
    recorder.warningMessages.push(message)
    const options =
      typeof rest[0] === 'object' && rest[0] !== null && !Array.isArray(rest[0])
        ? (rest.shift() as MessageOptionsDouble)
        : undefined
    const actions = rest.filter((item): item is string => typeof item === 'string')
    if (actions.length > 0) {
      recorder.warningMessageActions.push({ message, actions })
    }
    if (options?.modal === true) {
      recorder.modalWarnings.push({ message, modal: true, items: actions })
      return recorder.modalResponses.shift()
    }
    return recorder.warningResponses.shift()
  },
  showInputBox: async (options: InputBoxOptionsDouble): Promise<string | undefined> => {
    recorder.inputBoxOptions.push(options)
    return recorder.inputBoxResponses.shift()
  },
  showQuickPick: async <T extends QuickPickItemDouble>(items: T[]): Promise<T | undefined> => {
    recorder.quickPickItems.push(items)
    return recorder.quickPickSelection === null ? undefined : items[recorder.quickPickSelection]
  },
  createOutputChannel: (name: string): OutputChannelDouble => {
    const channel: OutputChannelDouble = {
      name,
      lines: [],
      disposed: false,
      appendLine: (line: string) => {
        channel.lines.push(line)
      },
      dispose: () => {
        channel.disposed = true
      },
    }
    recorder.outputChannels.push(channel)
    return channel
  },
}

export const commands = {
  registerCommand: (
    command: string,
    handler: (...args: unknown[]) => unknown,
  ): DisposableDouble => {
    recorder.commandHandlers.set(command, handler)
    return { dispose: () => recorder.commandHandlers.delete(command) }
  },
  executeCommand: async (command: string, ...args: unknown[]): Promise<unknown> => {
    recorder.executedCommands.push({ command, args })
    const handler = recorder.commandHandlers.get(command)
    if (handler !== undefined) {
      return handler(...args)
    }
    if (
      command === 'workbench.extensions.installExtension' ||
      command === 'workbench.extensions.uninstallExtension'
    ) {
      return undefined
    }
    throw new Error(`command not registered: ${command}`)
  },
}

export const extensions = {
  get all(): ExtensionDouble[] {
    return recorder.installedExtensions
  },
}

function configurationKey(section: string | undefined, key: string): string {
  return section === undefined ? key : `${section}.${key}`
}

function effectiveConfigurationValue(section: string | undefined, key: string): unknown {
  const fullKey = configurationKey(section, key)
  if (recorder.configuration.overrides.has(fullKey)) {
    return recorder.configuration.overrides.get(fullKey)
  }
  if (recorder.configuration.workspaceValues.has(fullKey)) {
    return recorder.configuration.workspaceValues.get(fullKey)
  }
  if (recorder.configuration.globalValues.has(fullKey)) {
    return recorder.configuration.globalValues.get(fullKey)
  }
  return recorder.configuration.values.get(fullKey)
}

export const env = {
  openExternal: async (uri: { toString(): string }): Promise<boolean> => {
    recorder.openedExternalUrls.push(uri.toString())
    return true
  },
}

export const Uri = {
  parse: (value: string): { toString(): string } => ({
    toString: () => value,
  }),
}

export const workspace = {
  getConfiguration: (section?: string) => ({
    get: <T>(key: string): T | undefined =>
      effectiveConfigurationValue(section, key) as T | undefined,
    inspect: <T>(key: string): ConfigurationInspectDouble<T> | undefined => {
      const fullKey = configurationKey(section, key)
      const globalValue = recorder.configuration.globalValues.get(fullKey) as T | undefined
      const workspaceValue = recorder.configuration.workspaceValues.get(fullKey) as T | undefined
      if (globalValue === undefined && workspaceValue === undefined) {
        const legacy = recorder.configuration.values.get(fullKey)
        if (legacy === undefined) {
          return undefined
        }
        return { globalValue: legacy as T }
      }
      const inspected: ConfigurationInspectDouble<T> = {}
      if (globalValue !== undefined) {
        inspected.globalValue = globalValue
      }
      if (workspaceValue !== undefined) {
        inspected.workspaceValue = workspaceValue
      }
      return inspected
    },
    update: async (key: string, value: unknown, target?: number): Promise<void> => {
      if (recorder.configuration.updateError !== null) {
        throw recorder.configuration.updateError
      }
      const fullKey = configurationKey(section, key)
      recorder.configuration.globalUpdates.push({ section, key, value, target })
      if (target === ConfigurationTarget.Global) {
        recorder.configuration.globalValues.set(fullKey, value)
        recorder.configuration.values.set(fullKey, value)
      } else if (target === ConfigurationTarget.Workspace) {
        recorder.configuration.workspaceValues.set(fullKey, value)
      } else {
        recorder.configuration.values.set(fullKey, value)
      }
    },
  }),
}
