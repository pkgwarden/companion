import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { InMemorySecretStore } from '../test/doubles'
import { type QuickPickDouble, recorder, resetVscodeDouble } from '../test/vscodeDouble'
import { DEFAULT_GATE_API_URL, GATE_TOKEN_SECRET_KEY } from './constants'
import { CATALOG_SEARCH_DEBOUNCE_MS } from './debounce'
import { INSTALL_EXTENSION_VSCODE_COMMAND, runInstallExtensionPicker } from './installPicker'
import { OVERRIDE_CONFIRM_LABEL } from './installPolicy'
import { CompanionStatusBar } from './statusBar'
import { registerSyncTrigger } from './syncTrigger'
import { GateTokenStore } from './tokenStore'

interface GateCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function catalogPage(...items: Record<string, unknown>[]): Record<string, unknown> {
  return { items, total: items.length, page: 1, limit: 25, has_more: false }
}

const linterProItem = {
  extension_id: 'contoso.linter-pro',
  display_name: 'Linter Pro',
  description: 'Lints everything',
  latest_version: '4.2.1',
  trusted_publisher: false,
}

function installCheckPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    extension_id: 'contoso.linter-pro',
    extension_exists: true,
    resolved_version: '4.1.9',
    why_blocked: { blocked: false, reason: null, quarantine_cutoff_utc: null },
    allowed_versions: ['4.1.7', '4.1.9'],
    ...overrides,
  }
}

function blockedPayload(
  reason: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return installCheckPayload({
    resolved_version: '4.2.1',
    why_blocked: { blocked: true, reason, ...overrides },
  })
}

/** Routes the two gate calls the picker can make and lets a test stall the catalog ones. */
class GateStub {
  readonly calls: GateCall[] = []
  catalogStatus = 200
  installCheckStatus = 200
  transportError: Error | null = null
  installCheckPayload: unknown = installCheckPayload()
  private readonly catalogPayloads: unknown[] = []
  private readonly heldCatalogResponses: (() => void)[] = []
  holdCatalogResponses = false

  queueCatalogPage(payload: unknown): void {
    this.catalogPayloads.push(payload)
  }

  /** Newest first, so a superseded response lands last — the case latest-wins has to survive. */
  releaseCatalogResponses(): void {
    for (const release of this.heldCatalogResponses.splice(0).reverse()) {
      release()
    }
  }

  get catalogCalls(): GateCall[] {
    return this.calls.filter((call) => call.url.includes('/catalog/vscode/extensions'))
  }

  get installCheckCalls(): GateCall[] {
    return this.calls.filter((call) => call.url.includes('/vscode/install-check'))
  }

  readonly handle = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; json: () => Promise<unknown> }> => {
    this.calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? null : JSON.parse(init.body),
    })
    if (this.transportError !== null) {
      throw this.transportError
    }
    if (!url.includes('/catalog/vscode/extensions')) {
      return { status: this.installCheckStatus, json: async () => this.installCheckPayload }
    }
    // Bound to the call, not to the resumption, so a held response keeps its own page.
    const payload = this.catalogPayloads.shift() ?? catalogPage(linterProItem)
    if (this.holdCatalogResponses) {
      await new Promise<void>((resolve) => {
        this.heldCatalogResponses.push(resolve)
      })
    }
    return { status: this.catalogStatus, json: async () => payload }
  }
}

let stub: GateStub

async function settle(): Promise<void> {
  for (let step = 0; step < 6; step += 1) {
    await vi.advanceTimersByTimeAsync(0)
  }
}

async function settleSearch(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CATALOG_SEARCH_DEBOUNCE_MS)
  await settle()
}

interface RunningPicker {
  pending: Promise<void>
  statusBar: CompanionStatusBar
}

interface OpenPicker extends RunningPicker {
  quickPick: QuickPickDouble
}

async function runPicker(token: string | null): Promise<RunningPicker> {
  const secrets = new InMemorySecretStore()
  if (token !== null) {
    await secrets.store(GATE_TOKEN_SECRET_KEY, token)
  }
  const statusBar = new CompanionStatusBar()
  statusBar.update({ hasToken: token !== null })
  return { pending: runInstallExtensionPicker(new GateTokenStore(secrets), statusBar), statusBar }
}

async function openPicker(): Promise<OpenPicker> {
  const running = await runPicker('gate-token')
  await settle()
  const quickPick = recorder.quickPicks[0]
  if (quickPick === undefined) {
    throw new Error('the install picker did not open')
  }
  return { ...running, quickPick }
}

function allowInstallCommand(): void {
  recorder.commandHandlers.set(INSTALL_EXTENSION_VSCODE_COMMAND, () => undefined)
}

function failInstallCommand(detail: string): void {
  recorder.commandHandlers.set(INSTALL_EXTENSION_VSCODE_COMMAND, () => {
    throw new Error(detail)
  })
}

function installCommandArguments(): unknown[] {
  return recorder.executedCommands
    .filter((entry) => entry.command === INSTALL_EXTENSION_VSCODE_COMMAND)
    .map((entry) => entry.args[0])
}

beforeEach(() => {
  resetVscodeDouble()
  vi.useFakeTimers()
  stub = new GateStub()
  vi.stubGlobal('fetch', stub.handle)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the install picker before it opens', () => {
  it('asks the user to sign in instead of opening a picker it cannot use', async () => {
    await (await runPicker(null)).pending

    expect(recorder.quickPicks).toEqual([])
    expect(recorder.warningMessages[0]).toContain('Sign in')
    expect(stub.calls).toEqual([])
  })
})

describe('catalog search', () => {
  it('searches the catalog once the typing settles', async () => {
    const { pending, quickPick } = await openPicker()

    quickPick.type('linter')
    await settleSearch()

    expect(stub.catalogCalls).toHaveLength(1)
    expect(stub.catalogCalls[0]?.url).toContain('q=linter')
    expect(stub.catalogCalls[0]?.headers.Authorization).toBe('Bearer gate-token')
    expect(quickPick.items.map((item) => item.label)).toEqual(['Linter Pro'])
    expect(quickPick.busy).toBe(false)
    quickPick.hide()
    await pending
  })

  it('collapses a burst of keystrokes into one catalog call', async () => {
    const { pending, quickPick } = await openPicker()

    quickPick.type('l')
    quickPick.type('li')
    quickPick.type('lint')
    await settleSearch()

    expect(stub.catalogCalls).toHaveLength(1)
    expect(stub.catalogCalls[0]?.url).toContain('q=lint')
    quickPick.hide()
    await pending
  })

  it('does not search when the user names an explicit version', async () => {
    const { pending, quickPick } = await openPicker()

    quickPick.type('contoso.linter-pro@4.2.1')
    await settleSearch()

    expect(stub.calls).toEqual([])
    expect(quickPick.items.map((item) => item.label)).toEqual(['Install contoso.linter-pro@4.2.1'])
    quickPick.hide()
    await pending
  })

  it('does not spend a catalog search on a query the route answers empty', async () => {
    const { pending, quickPick } = await openPicker()

    quickPick.type('l')
    await settleSearch()

    expect(stub.catalogCalls).toEqual([])
    expect(quickPick.items).toEqual([])
    expect(quickPick.busy).toBe(false)
    quickPick.hide()
    await pending
  })

  it('clears the list without searching when the box is emptied', async () => {
    const { pending, quickPick } = await openPicker()
    quickPick.type('linter')
    await settleSearch()

    quickPick.type('')
    await settleSearch()

    expect(stub.catalogCalls).toHaveLength(1)
    expect(quickPick.items).toEqual([])
    quickPick.hide()
    await pending
  })

  it('ignores a catalog response a newer keystroke has superseded', async () => {
    const { pending, quickPick } = await openPicker()
    stub.holdCatalogResponses = true
    stub.queueCatalogPage(catalogPage({ ...linterProItem, display_name: 'Stale Result' }))
    stub.queueCatalogPage(catalogPage({ ...linterProItem, display_name: 'Fresh Result' }))

    quickPick.type('lint')
    await settleSearch()
    quickPick.type('linter')
    await settleSearch()
    stub.releaseCatalogResponses()
    await settle()

    expect(stub.catalogCalls).toHaveLength(2)
    expect(quickPick.items.map((item) => item.label)).toEqual(['Fresh Result'])
    quickPick.hide()
    await pending
  })

  it('says why the list is empty when the catalog search fails', async () => {
    const { pending, quickPick } = await openPicker()
    stub.catalogStatus = 503

    quickPick.type('linter')
    await settleSearch()

    expect(quickPick.items).toEqual([])
    expect(recorder.warningMessages[0]).toContain('could not search the extension catalog')
    expect(quickPick.busy).toBe(false)
    quickPick.hide()
    await pending
  })

  it('records a metered-out search in the status bar', async () => {
    const { pending, quickPick, statusBar } = await openPicker()
    stub.catalogStatus = 429

    quickPick.type('linter')
    await settleSearch()

    expect(statusBar.status).toBe('quota')
    quickPick.hide()
    await pending
  })

  it('sends the api url the user configured', async () => {
    recorder.configuration.values.set('pkgwarden.apiUrl', 'https://gate.example.com')
    const { pending, quickPick } = await openPicker()

    quickPick.type('linter')
    await settleSearch()

    expect(stub.catalogCalls[0]?.url).toContain('https://gate.example.com/api/v1/')
    quickPick.hide()
    await pending
  })

  it('falls back to the packaged gate url when the setting is blank', async () => {
    recorder.configuration.values.set('pkgwarden.apiUrl', '   ')
    const { pending, quickPick } = await openPicker()

    quickPick.type('linter')
    await settleSearch()

    expect(stub.catalogCalls[0]?.url).toContain(`${DEFAULT_GATE_API_URL}/api/v1/`)
    quickPick.hide()
    await pending
  })

  it('ignores a catalog response that arrives after the picker is dismissed', async () => {
    const { pending, quickPick, statusBar } = await openPicker()
    stub.holdCatalogResponses = true
    stub.catalogStatus = 429
    stub.queueCatalogPage(catalogPage({ ...linterProItem, display_name: 'Late Result' }))

    quickPick.type('linter')
    await settleSearch()
    quickPick.hide()
    stub.releaseCatalogResponses()
    await settle()

    expect(recorder.warningMessages).toEqual([])
    expect(statusBar.status).not.toBe('quota')
    expect(quickPick.items).toEqual([])
    await pending
  })

  it('ignores a catalog response that arrives after the user accepts a selection', async () => {
    allowInstallCommand()
    const { pending, quickPick, statusBar } = await openPicker()

    quickPick.type('lint')
    await settleSearch()
    stub.holdCatalogResponses = true
    stub.catalogStatus = 429
    stub.queueCatalogPage(catalogPage({ ...linterProItem, display_name: 'Late Result' }))

    quickPick.type('linter')
    await settleSearch()
    quickPick.selectItem(0)
    quickPick.accept()
    stub.releaseCatalogResponses()
    await settle()
    await pending

    expect(
      recorder.warningMessages.filter((message) => message.includes('extension catalog')),
    ).toEqual([])
    expect(statusBar.status).not.toBe('quota')
  })
})

describe('installing an allowed extension', () => {
  it('checks policy exactly once per attempt and never retries', async () => {
    allowInstallCommand()
    const { pending, quickPick } = await openPicker()
    quickPick.type('linter')
    await settleSearch()

    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(stub.installCheckCalls).toHaveLength(1)
    expect(stub.installCheckCalls[0]?.body).toEqual({ extension_id: 'contoso.linter-pro' })
  })

  it('pins the resolved version before asking the editor to install it', async () => {
    allowInstallCommand()
    const { pending, quickPick } = await openPicker()
    quickPick.type('linter')
    await settleSearch()

    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(recorder.configuration.globalUpdates).toEqual([
      {
        section: 'extensions',
        key: 'allowed',
        value: { 'contoso.linter-pro': ['4.1.7', '4.1.9'] },
        target: 1,
      },
    ])
    expect(installCommandArguments()).toEqual(['contoso.linter-pro@4.1.9'])
    expect(recorder.informationMessages[0]).toContain('contoso.linter-pro@4.1.9')
  })

  it('preserves pins it did not come to write', async () => {
    allowInstallCommand()
    recorder.configuration.values.set('extensions.allowed', {
      'other.ext': ['1.0.0'],
      'contoso.linter-pro': ['4.1.0'],
    })
    const { pending, quickPick } = await openPicker()
    quickPick.type('linter')
    await settleSearch()

    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(recorder.configuration.globalUpdates[0]?.value).toEqual({
      'other.ext': ['1.0.0'],
      'contoso.linter-pro': ['4.1.0', '4.1.7', '4.1.9'],
    })
  })

  it('merges install pins into global settings without copying workspace-only keys', async () => {
    allowInstallCommand()
    recorder.configuration.globalValues.set('extensions.allowed', { 'global.ext': ['1.0.0'] })
    recorder.configuration.workspaceValues.set('extensions.allowed', {
      'global.ext': ['1.0.0'],
      'workspace-only.ext': ['2.0.0'],
    })
    const { pending, quickPick } = await openPicker()
    quickPick.type('linter')
    await settleSearch()

    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(recorder.configuration.globalUpdates).toEqual([
      {
        section: 'extensions',
        key: 'allowed',
        value: {
          'global.ext': ['1.0.0'],
          'contoso.linter-pro': ['4.1.7', '4.1.9'],
        },
        target: 1,
      },
    ])
  })

  it('installs under a trusted publisher-wide allow without narrowing it to versions', async () => {
    allowInstallCommand()
    recorder.configuration.values.set('extensions.allowed', { contoso: true })
    const { pending, quickPick } = await openPicker()
    quickPick.type('linter')
    await settleSearch()

    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(recorder.configuration.globalUpdates).toEqual([])
    expect(installCommandArguments()).toEqual(['contoso.linter-pro@4.1.9'])
  })

  it('asks for an immediate sync so inventory-scoped pins catch up', async () => {
    allowInstallCommand()
    const trigger = vi.fn()
    const registration = registerSyncTrigger(trigger)
    const { pending, quickPick } = await openPicker()
    quickPick.type('linter')
    await settleSearch()

    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(trigger).toHaveBeenCalledTimes(1)
    registration.dispose()
  })

  it('installs the version the user named explicitly', async () => {
    allowInstallCommand()
    stub.installCheckPayload = installCheckPayload({
      resolved_version: '4.1.7',
      allowed_versions: ['4.1.7', '4.1.9'],
    })
    const { pending, quickPick } = await openPicker()

    quickPick.type('contoso.linter-pro@4.1.7')
    await settle()
    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(stub.installCheckCalls[0]?.body).toEqual({
      extension_id: 'contoso.linter-pro',
      version: '4.1.7',
    })
    expect(installCommandArguments()).toEqual(['contoso.linter-pro@4.1.7'])
  })
})

describe('when the post-install sync cannot start', () => {
  it('stands by the install that already succeeded and says the next sync will reconcile', async () => {
    allowInstallCommand()
    const registration = registerSyncTrigger(() => {
      throw new Error('sync scheduler is not ready')
    })
    const { pending, quickPick } = await openPicker()
    quickPick.type('linter')
    await settleSearch()

    quickPick.selectItem(0)
    quickPick.accept()
    await expect(pending).resolves.toBeUndefined()

    expect(installCommandArguments()).toEqual(['contoso.linter-pro@4.1.9'])
    expect(recorder.informationMessages[0]).toContain('installed contoso.linter-pro@4.1.9')
    expect(recorder.warningMessages[0]).toContain('could not start an immediate policy sync')
    registration.dispose()
  })
})

describe('when the install itself fails', () => {
  it('keeps the pin, because the policy statement it makes is still true', async () => {
    failInstallCommand('ECONNRESET')
    const trigger = vi.fn()
    const registration = registerSyncTrigger(trigger)
    const { pending, quickPick } = await openPicker()
    quickPick.type('linter')
    await settleSearch()

    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(recorder.configuration.globalUpdates).toHaveLength(1)
    expect(recorder.warningMessages[0]).toContain('The pin was kept')
    expect(trigger).not.toHaveBeenCalled()
    registration.dispose()
  })

  it('does not install anything when the pin cannot be written', async () => {
    allowInstallCommand()
    recorder.configuration.updateError = new Error('settings.json is read-only')
    const { pending, quickPick } = await openPicker()
    quickPick.type('linter')
    await settleSearch()

    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(recorder.configuration.globalUpdates).toEqual([])
    expect(installCommandArguments()).toEqual([])
    expect(recorder.warningMessages[0]).toContain('Nothing was installed.')
  })
})

describe('the force matrix', () => {
  it('offers an override for a quarantined version and installs it when confirmed', async () => {
    allowInstallCommand()
    stub.installCheckPayload = blockedPayload('quarantine', {
      quarantine_cutoff_utc: '2026-08-11T09:30:00Z',
    })
    recorder.modalResponses.push(OVERRIDE_CONFIRM_LABEL)
    const { pending, quickPick } = await openPicker()

    quickPick.type('contoso.linter-pro@4.2.1')
    await settle()
    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(recorder.modalWarnings).toEqual([
      {
        message:
          'contoso.linter-pro@4.2.1 is in quarantine until 2026-08-11 (published too recently). latest allowed version: 4.1.9.',
        modal: true,
        items: [OVERRIDE_CONFIRM_LABEL],
      },
    ])
    expect(recorder.configuration.globalUpdates[0]?.value).toEqual({
      'contoso.linter-pro': ['4.1.7', '4.1.9', '4.2.1'],
    })
    expect(installCommandArguments()).toEqual(['contoso.linter-pro@4.2.1'])
  })

  it('offers an override for a version pending a scan', async () => {
    allowInstallCommand()
    stub.installCheckPayload = blockedPayload('pending_scan')
    recorder.modalResponses.push(OVERRIDE_CONFIRM_LABEL)
    const { pending, quickPick } = await openPicker()

    quickPick.type('contoso.linter-pro@4.2.1')
    await settle()
    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(recorder.modalWarnings).toHaveLength(1)
    expect(installCommandArguments()).toEqual(['contoso.linter-pro@4.2.1'])
  })

  it('never offers an override for a version the scan withheld', async () => {
    allowInstallCommand()
    stub.installCheckPayload = blockedPayload('scan_verdict', {
      details: { status: 'completed', risk_score: 90, summary: 'credential exfiltration' },
    })
    const { pending, quickPick } = await openPicker()

    quickPick.type('contoso.linter-pro@4.2.1')
    await settle()
    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(recorder.modalWarnings).toEqual([])
    expect(recorder.warningMessages[0]).toContain('this cannot be overridden')
    expect(recorder.configuration.globalUpdates).toEqual([])
    expect(installCommandArguments()).toEqual([])
  })

  it('never offers an override for known malware', async () => {
    allowInstallCommand()
    stub.installCheckPayload = blockedPayload('known_malware')
    const { pending, quickPick } = await openPicker()

    quickPick.type('contoso.linter-pro@4.2.1')
    await settle()
    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(recorder.modalWarnings).toEqual([])
    expect(installCommandArguments()).toEqual([])
  })

  it('installs nothing when the override modal is dismissed', async () => {
    allowInstallCommand()
    stub.installCheckPayload = blockedPayload('pending_scan')
    recorder.modalResponses.push(undefined)
    const { pending, quickPick } = await openPicker()

    quickPick.type('contoso.linter-pro@4.2.1')
    await settle()
    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(recorder.modalWarnings).toHaveLength(1)
    expect(recorder.configuration.globalUpdates).toEqual([])
    expect(installCommandArguments()).toEqual([])
  })

  it('does not offer an override when no version was named, so nothing changes resolution', async () => {
    allowInstallCommand()
    stub.installCheckPayload = installCheckPayload({
      resolved_version: null,
      why_blocked: { blocked: true, reason: 'pending_scan' },
    })
    const { pending, quickPick } = await openPicker()
    quickPick.type('linter')
    await settleSearch()

    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(recorder.modalWarnings).toEqual([])
    expect(recorder.warningMessages[0]).toContain('is pending a security scan')
    expect(installCommandArguments()).toEqual([])
  })
})

describe('when the policy check fails', () => {
  it('fails closed on a transport failure and keeps the pins alone', async () => {
    allowInstallCommand()
    const { pending, quickPick } = await openPicker()
    quickPick.type('linter')
    await settleSearch()
    stub.transportError = new Error('getaddrinfo ENOTFOUND')

    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(recorder.configuration.globalUpdates).toEqual([])
    expect(installCommandArguments()).toEqual([])
    expect(recorder.warningMessages[0]).toContain('Nothing was installed.')
  })

  it('records a metered-out check in the status bar', async () => {
    allowInstallCommand()
    const { pending, quickPick, statusBar } = await openPicker()
    quickPick.type('linter')
    await settleSearch()
    stub.installCheckStatus = 429

    quickPick.selectItem(0)
    quickPick.accept()
    await pending

    expect(statusBar.status).toBe('quota')
    expect(installCommandArguments()).toEqual([])
  })
})

describe('what the picker refuses to do', () => {
  it('warns about a reference it cannot parse instead of checking policy', async () => {
    const { pending, quickPick } = await openPicker()

    quickPick.type('contoso@4.2.1')
    await settle()
    quickPick.accept()
    await pending

    expect(stub.installCheckCalls).toEqual([])
    expect(recorder.warningMessages[0]).toContain('is not an extension reference')
  })

  it('does nothing when the picker is dismissed', async () => {
    const { pending, quickPick } = await openPicker()

    quickPick.hide()
    await pending

    expect(stub.calls).toEqual([])
    expect(recorder.configuration.globalUpdates).toEqual([])
    expect(quickPick.disposed).toBe(true)
  })

  it('does nothing when an empty box is accepted', async () => {
    const { pending, quickPick } = await openPicker()

    quickPick.accept()
    await pending

    expect(stub.calls).toEqual([])
    expect(recorder.warningMessages).toEqual([])
  })
})
