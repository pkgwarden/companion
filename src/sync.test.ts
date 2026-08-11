import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ControllableGlobalState,
  ControllableSecretStore,
  FlipAfterReadSecretStore,
  InMemoryGlobalState,
  InMemorySecretStore,
  RecordingLog,
} from '../test/doubles'
import { ConfigurationTarget, recorder, resetVscodeDouble } from '../test/vscodeDouble'
import { COMPANION_EXTENSION_ID, GATE_TOKEN_SECRET_KEY } from './constants'
import { ALLOWED_EXTENSIONS_SECTION, ALLOWED_EXTENSIONS_SETTING } from './pinMap'
import { RemediationStateStore } from './remediationState'
import { CompanionStatusBar } from './statusBar'
import { SyncEngine } from './sync'
import { SYNC_CADENCE_MS, SYNC_DEDUP_WINDOW_MS } from './syncDecision'
import { SyncStateStore } from './syncState'
import { GateTokenStore } from './tokenStore'

// Real "now" rather than a fixed date: the status bar reads its own clock to age a sync out.
const now = Date.now()
const settingKey = `${ALLOWED_EXTENSIONS_SECTION}.${ALLOWED_EXTENSIONS_SETTING}`
const serverPins = {
  'redhat.java': ['1.45.0'],
  'eriklynd.json-tools': ['1.0.2'],
  [COMPANION_EXTENSION_ID]: ['0.1.0'],
}

function jsonResponse(body: unknown, status = 200) {
  return { status, json: async () => body }
}

function policyBody(overrides: Record<string, unknown> = {}) {
  return {
    'extensions.allowed': serverPins,
    generated_at: '2026-07-28T12:00:00Z',
    withheld: [],
    ...overrides,
  }
}

interface Harness {
  engine: SyncEngine
  statusBar: CompanionStatusBar
  syncState: SyncStateStore
  remediationState: RemediationStateStore
  log: RecordingLog
  fetchMock: ReturnType<typeof vi.fn>
  advance: (milliseconds: number) => void
}

async function createHarness(
  options: {
    signedIn?: boolean
    response?: unknown
    secrets?: ControllableSecretStore | InMemorySecretStore | FlipAfterReadSecretStore
    globalState?: InMemoryGlobalState | ControllableGlobalState
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'pkgwarden-companion-'))
  await writeFile(
    join(directory, 'extensions.json'),
    JSON.stringify([
      { identifier: { id: 'redhat.java' }, version: '1.45.0' },
      { identifier: { id: 'eriklynd.json-tools' }, version: '1.0.2' },
    ]),
  )
  const secrets = options.secrets ?? new InMemorySecretStore()
  if (options.signedIn !== false && !(secrets instanceof ControllableSecretStore)) {
    await secrets.store(GATE_TOKEN_SECRET_KEY, 'gate-token')
  }
  if (options.signedIn !== false && secrets instanceof ControllableSecretStore) {
    await secrets.store(GATE_TOKEN_SECRET_KEY, 'gate-token')
  }
  const fetchMock = vi.fn(
    async (_url: string, _init: { body: string }) => options.response ?? jsonResponse(policyBody()),
  )
  vi.stubGlobal('fetch', fetchMock)
  const statusBar = new CompanionStatusBar()
  const globalState = options.globalState ?? new InMemoryGlobalState()
  const syncState = new SyncStateStore(globalState)
  const remediationState = new RemediationStateStore(globalState)
  const log = new RecordingLog()
  let clock = now
  const engine = new SyncEngine({
    tokenStore: new GateTokenStore(secrets),
    statusBar,
    syncState,
    remediationState,
    log,
    extensionPath: join(directory, 'pkgwarden.companion-0.1.0'),
    now: () => clock,
  })
  const advance = (milliseconds: number) => {
    clock += milliseconds
  }
  return {
    engine,
    statusBar,
    syncState,
    remediationState,
    log,
    fetchMock,
    advance,
  } satisfies Harness
}

beforeEach(() => {
  resetVscodeDouble()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a successful sync', () => {
  it('sends every installed extension, disabled ones included, in exactly one policy call', async () => {
    const { engine, fetchMock } = await createHarness()

    await engine.run('activation')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    expect(url).toBe('https://index.pkgwarden.com/api/v1/vscode/policy')
    expect(JSON.parse(init.body)).toEqual({
      inventory: [
        { extension_id: 'redhat.java', current_version: '1.45.0' },
        { extension_id: 'eriklynd.json-tools', current_version: '1.0.2' },
      ],
    })
  })

  it('honors a self-hosted gate url from settings', async () => {
    const { engine, fetchMock } = await createHarness()
    recorder.configuration.values.set('pkgwarden.apiUrl', 'https://gate.contoso.example')

    await engine.run('activation')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gate.contoso.example/api/v1/vscode/policy')
  })

  it('writes the server map verbatim and reports the pinned count', async () => {
    const { engine, statusBar, syncState } = await createHarness()
    recorder.configuration.values.set(settingKey, { 'gone.by-next-sync': ['9.9.9'] })

    const outcome = await engine.run('activation')

    expect(outcome).toEqual({ status: 'synced', pinnedCount: 3, overridden: false })
    expect(recorder.configuration.values.get(settingKey)).toEqual(serverPins)
    expect(syncState.read()).toEqual({
      lastSyncStartedAt: now,
      lastSuccessAt: now,
      pinnedCount: 3,
      syncClaimId: expect.any(String),
    })
    expect(statusBar.status).toBe('ok')
  })

  it('touches settings exactly once, replacing the value and nothing else', async () => {
    // The contract behind RV3's comment survival: one value-range update through the settings
    // API, so the editor's own JSONC edit keeps the #551 managed banner. We never rewrite the file.
    const { engine } = await createHarness()

    await engine.run('activation')

    expect(recorder.configuration.globalUpdates).toEqual([
      {
        section: ALLOWED_EXTENSIONS_SECTION,
        key: ALLOWED_EXTENSIONS_SETTING,
        value: serverPins,
        target: ConfigurationTarget.Global,
      },
    ])
  })

  it('keeps its own pin when the server response omits it', async () => {
    const { engine } = await createHarness({
      response: jsonResponse(policyBody({ 'extensions.allowed': { 'redhat.java': ['1.45.0'] } })),
    })
    recorder.configuration.values.set(settingKey, { [COMPANION_EXTENSION_ID]: ['0.1.0'] })

    await engine.run('activation')

    expect(recorder.configuration.values.get(settingKey)).toEqual({
      'redhat.java': ['1.45.0'],
      [COMPANION_EXTENSION_ID]: ['0.1.0'],
    })
  })

  it('records the sync start before the call so another window skips it', async () => {
    const { engine, syncState } = await createHarness({
      response: jsonResponse(policyBody(), 500),
    })

    await engine.run('activation')

    expect(syncState.read().lastSyncStartedAt).toBe(now)
    expect(syncState.read().lastSuccessAt).toBeNull()
  })

  it('auto-remediates withheld entries after the pin map is in place', async () => {
    const { engine, remediationState } = await createHarness({
      response: jsonResponse(
        policyBody({
          withheld: [
            {
              extension_id: 'contoso.linter-pro',
              version: '4.2.1',
              reason: 'scan_verdict',
              rollback_version: '4.1.9',
            },
          ],
        }),
      ),
    })

    await engine.run('activation')

    expect(recorder.executedCommands).toEqual([
      {
        command: 'workbench.extensions.installExtension',
        args: ['contoso.linter-pro@4.1.9'],
      },
    ])
    expect(recorder.warningMessages.join('\n')).toContain('contoso.linter-pro@4.2.1')
    expect(recorder.warningMessages.join('\n')).toContain('restored 4.1.9')
    expect(remediationState.handledSet().has('contoso.linter-pro@4.2.1')).toBe(true)
    expect(remediationState.shepherdTracking().has('contoso.linter-pro')).toBe(true)
  })

  it('skips remediation side effects when sign-out clears the token after pins are written', async () => {
    const secrets = new FlipAfterReadSecretStore('gate-token', 4)
    const { engine } = await createHarness({
      secrets,
      response: jsonResponse(
        policyBody({
          withheld: [
            {
              extension_id: 'contoso.linter-pro',
              version: '4.2.1',
              reason: 'scan_verdict',
              rollback_version: '4.1.9',
            },
          ],
        }),
      ),
    })

    const outcome = await engine.run('activation')

    expect(outcome).toEqual({ status: 'synced', pinnedCount: 3, overridden: false })
    expect(recorder.executedCommands).toEqual([])
  })
})

describe('a sync whose pins are outranked', () => {
  it('goes policy-managed but still records the success', async () => {
    const { engine, statusBar, syncState } = await createHarness()
    recorder.configuration.overrides.set(settingKey, { 'redhat.java': true })

    const outcome = await engine.run('activation')

    expect(outcome).toEqual({ status: 'synced', pinnedCount: 3, overridden: true })
    expect(statusBar.status).toBe('policy-managed')
    expect(syncState.read().lastSuccessAt).toBe(now)
  })
})

describe('a failing sync', () => {
  it('keeps the pins already in settings when gate is unreachable', async () => {
    const { engine, statusBar, syncState, log } = await createHarness()
    recorder.configuration.values.set(settingKey, { 'redhat.java': ['1.44.0'] })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND')
      }),
    )

    const outcome = await engine.run('activation')

    expect(outcome).toEqual({ status: 'failed', kind: 'network' })
    expect(recorder.configuration.values.get(settingKey)).toEqual({ 'redhat.java': ['1.44.0'] })
    expect(syncState.read().lastSuccessAt).toBeNull()
    expect(statusBar.status).toBe('stale')
    expect(log.lines.join('\n')).toContain('ENOTFOUND')
  })

  it('shows the quota state and never retries a 429', async () => {
    const { engine, statusBar, fetchMock } = await createHarness({
      response: jsonResponse({}, 429),
    })

    const outcome = await engine.run('activation')

    expect(outcome).toEqual({ status: 'failed', kind: 'metered-out' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(statusBar.status).toBe('quota')
  })

  it('reports a settings write the editor refuses instead of throwing at the caller', async () => {
    const { engine, log, syncState } = await createHarness()
    recorder.configuration.updateError = new Error('settings.json is read-only')

    const outcome = await engine.run('activation')

    expect(outcome).toEqual({ status: 'failed', kind: 'local' })
    expect(syncState.read().lastSuccessAt).toBeNull()
    expect(log.lines.join('\n')).toContain('settings.json is read-only')
  })

  it('refuses an empty pin map instead of writing an allowlist that blocks every extension', async () => {
    const { engine, syncState, log } = await createHarness({
      response: jsonResponse(policyBody({ 'extensions.allowed': {} })),
    })
    recorder.configuration.values.set(settingKey, { 'redhat.java': ['1.44.0'] })

    const outcome = await engine.run('activation')

    expect(outcome).toEqual({ status: 'failed', kind: 'server' })
    expect(recorder.configuration.values.get(settingKey)).toEqual({ 'redhat.java': ['1.44.0'] })
    expect(syncState.read().lastSuccessAt).toBeNull()
    expect(log.lines.join('\n')).toContain('empty extensions.allowed')
  })

  it('refreshes the status bar on the way through, so an aged-out success shows as stale', async () => {
    const { engine, statusBar } = await createHarness({ response: jsonResponse({}, 500) })
    statusBar.update({ pinnedCount: 43, lastSuccessAt: now - 3 * 24 * 60 * 60 * 1000 })

    await engine.run('activation')

    expect(recorder.statusBarItems[0]?.text).toBe('$(warning) pkgwarden: sync stale')
  })

  it('will not call gate again straight after a failure, even on demand', async () => {
    const { engine, fetchMock } = await createHarness({ response: jsonResponse({}, 429) })
    await engine.run('activation')

    const outcome = await engine.run('command')

    expect(outcome).toEqual({ status: 'skipped', reason: 'another-sync-in-flight' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('leaves the quota state behind once the hold expires and a sync succeeds', async () => {
    const { engine, statusBar, fetchMock, advance } = await createHarness({
      response: jsonResponse({}, 429),
    })
    await engine.run('activation')
    fetchMock.mockResolvedValue(jsonResponse(policyBody()))
    advance(SYNC_DEDUP_WINDOW_MS)

    await engine.run('command')

    expect(statusBar.status).toBe('ok')
  })
})

describe('sync cadence', () => {
  it('makes no metered call inside the daily cadence', async () => {
    const { engine, syncState, fetchMock } = await createHarness()
    await syncState.merge({ lastSuccessAt: now - SYNC_CADENCE_MS + 1 })

    const outcome = await engine.run('scheduled')

    expect(outcome).toEqual({ status: 'skipped', reason: 'within-daily-cadence' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('syncs on command even inside the cadence', async () => {
    const { engine, syncState, fetchMock } = await createHarness()
    await syncState.merge({ lastSuccessAt: now - 1000 })

    await engine.run('command')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('syncs on sign-in even inside the cadence, so protection starts at the paste', async () => {
    const { engine, syncState, fetchMock } = await createHarness()
    await syncState.merge({ lastSuccessAt: now - 1000 })

    await engine.run('sign-in')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('collapses concurrent runs in one window into a single policy call', async () => {
    const { engine, fetchMock } = await createHarness()

    const outcomes = await Promise.all([engine.run('command'), engine.run('command')])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(outcomes[0]).toEqual(outcomes[1])
  })

  it('honors a force trigger that arrives while a non-force sync is waiting on the token', async () => {
    const secrets = new ControllableSecretStore(1)
    await secrets.store(GATE_TOKEN_SECRET_KEY, 'gate-token')
    const { engine, syncState, fetchMock } = await createHarness({ secrets })
    await syncState.merge({ lastSuccessAt: now - 1000 })

    const activation = engine.run('activation')
    await Promise.resolve()
    const command = engine.run('command')
    secrets.releaseGets(1)
    const [activationOutcome, commandOutcome] = await Promise.all([activation, command])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(activationOutcome).toEqual({ status: 'synced', pinnedCount: 3, overridden: false })
    expect(commandOutcome).toEqual(activationOutcome)
  })
})

describe('a signed-out sync', () => {
  it('never calls gate and leaves the status bar asking for a token', async () => {
    const { engine, statusBar, fetchMock } = await createHarness({ signedIn: false })

    const outcome = await engine.run('activation')

    expect(outcome).toEqual({ status: 'signed-out' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(statusBar.status).toBe('signed-out')
  })

  it('aborts in flight when sign-out clears the token before gate is called', async () => {
    const secrets = new ControllableSecretStore(1)
    await secrets.store(GATE_TOKEN_SECRET_KEY, 'gate-token')
    const { engine, syncState, fetchMock } = await createHarness({ secrets })
    recorder.configuration.values.set(settingKey, { 'redhat.java': ['1.44.0'] })

    const sync = engine.run('activation')
    await Promise.resolve()
    await secrets.delete(GATE_TOKEN_SECRET_KEY)
    secrets.releaseGets(1)

    const outcome = await sync

    expect(outcome).toEqual({ status: 'signed-out' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(recorder.configuration.values.get(settingKey)).toEqual({ 'redhat.java': ['1.44.0'] })
    expect(syncState.read().lastSuccessAt).toBeNull()
  })

  it('aborts in flight when sign-out clears the token after gate responds', async () => {
    const secrets = new ControllableSecretStore(1)
    await secrets.store(GATE_TOKEN_SECRET_KEY, 'gate-token')
    let releaseFetch: (() => void) | undefined
    const fetchMock = vi.fn(
      async () =>
        new Promise<Awaited<ReturnType<typeof jsonResponse>>>((resolve) => {
          releaseFetch = () => resolve(jsonResponse(policyBody()))
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const directory = await mkdtemp(join(tmpdir(), 'pkgwarden-companion-'))
    await writeFile(
      join(directory, 'extensions.json'),
      JSON.stringify([{ identifier: { id: 'redhat.java' }, version: '1.45.0' }]),
    )
    const globalState = new InMemoryGlobalState()
    const syncState = new SyncStateStore(globalState)
    const remediationState = new RemediationStateStore(globalState)
    const engine = new SyncEngine({
      tokenStore: new GateTokenStore(secrets),
      statusBar: new CompanionStatusBar(),
      syncState,
      remediationState,
      log: new RecordingLog(),
      extensionPath: join(directory, 'pkgwarden.companion-0.1.0'),
      now: () => now,
    })
    recorder.configuration.values.set(settingKey, { 'redhat.java': ['1.44.0'] })

    const sync = engine.run('activation')
    secrets.releaseGets(1)
    await vi.waitUntil(() => fetchMock.mock.calls.length === 1)
    await secrets.delete(GATE_TOKEN_SECRET_KEY)
    releaseFetch?.()

    const outcome = await sync

    expect(outcome).toEqual({ status: 'signed-out' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(recorder.configuration.values.get(settingKey)).toEqual({ 'redhat.java': ['1.44.0'] })
    expect(syncState.read().lastSuccessAt).toBeNull()
  })
})

describe('cross-window dedup', () => {
  it('lets only one window call gate when both claim the sync slot at once', async () => {
    const globalState = new ControllableGlobalState(2)
    const directory = await mkdtemp(join(tmpdir(), 'pkgwarden-companion-'))
    await writeFile(
      join(directory, 'extensions.json'),
      JSON.stringify([{ identifier: { id: 'redhat.java' }, version: '1.45.0' }]),
    )
    const fetchMock = vi.fn(async () => jsonResponse(policyBody()))
    vi.stubGlobal('fetch', fetchMock)
    const secrets = new InMemorySecretStore()
    await secrets.store(GATE_TOKEN_SECRET_KEY, 'gate-token')
    const makeEngine = () =>
      new SyncEngine({
        tokenStore: new GateTokenStore(secrets),
        statusBar: new CompanionStatusBar(),
        syncState: new SyncStateStore(globalState),
        remediationState: new RemediationStateStore(globalState),
        log: new RecordingLog(),
        extensionPath: join(directory, 'pkgwarden.companion-0.1.0'),
        now: () => now,
      })
    const windowA = makeEngine()
    const windowB = makeEngine()

    const syncA = windowA.run('activation')
    const syncB = windowB.run('activation')
    await vi.waitUntil(() => globalState.pendingUpdateCount() === 2)
    globalState.releaseUpdates(2)

    const [outcomeA, outcomeB] = await Promise.all([syncA, syncB])
    const outcomes = [outcomeA, outcomeB]
    const synced = outcomes.filter((outcome) => outcome.status === 'synced')
    const skipped = outcomes.filter(
      (outcome) => outcome.status === 'skipped' && outcome.reason === 'another-sync-in-flight',
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(synced).toHaveLength(1)
    expect(skipped).toHaveLength(1)
  })
})

describe('a partial inventory', () => {
  it('still syncs and surfaces the gap in the status bar tooltip', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pkgwarden-companion-'))
    const secrets = new InMemorySecretStore()
    await secrets.store(GATE_TOKEN_SECRET_KEY, 'gate-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(policyBody())),
    )
    recorder.installedExtensions = [{ id: 'redhat.java', packageJSON: { version: '1.45.0' } }]
    const statusBar = new CompanionStatusBar()
    const globalState = new InMemoryGlobalState()
    const engine = new SyncEngine({
      tokenStore: new GateTokenStore(secrets),
      statusBar,
      syncState: new SyncStateStore(globalState),
      remediationState: new RemediationStateStore(globalState),
      log: new RecordingLog(),
      extensionPath: join(directory, 'pkgwarden.companion-0.1.0'),
      now: () => now,
    })

    const outcome = await engine.run('activation')

    expect(outcome.status).toBe('synced')
    expect(recorder.statusBarItems[0]?.tooltip).toContain('could not read the full extension list')
  })
})
