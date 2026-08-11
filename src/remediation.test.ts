import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DiscardingGlobalState, InMemoryGlobalState, RecordingLog } from '../test/doubles'
import { recorder, resetVscodeDouble } from '../test/vscodeDouble'
import { COMPANION_EXTENSION_ID, GATE_WEBAPP_URL } from './constants'
import type { VscodeWithheldVersion } from './gateClient'
import {
  createRemediationPorts,
  installedVersionsById,
  type RemediationPorts,
  remediateWithheld,
  runPostSyncRemediation,
  shepherdTrackedExtensions,
} from './remediation'
import { REMEDIATION_REMOVE_NOW, REMEDIATION_VIEW_DETAILS } from './remediationMessages'
import { RemediationStateStore } from './remediationState'

const withheld: VscodeWithheldVersion = {
  extensionId: 'contoso.linter-pro',
  version: '4.2.1',
  reason: 'scan_verdict',
  rollbackVersion: '4.1.9',
}

function createPorts(overrides: Partial<RemediationPorts> = {}): RemediationPorts {
  return {
    readMode: () => 'auto',
    installExtension: vi.fn(async () => undefined),
    uninstallExtension: vi.fn(async () => undefined),
    showWarning: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => true),
    ...overrides,
  }
}

beforeEach(() => {
  resetVscodeDouble()
})

describe('remediateWithheld glue', () => {
  it('notify mode warns with remove-now and view-details without auto install or uninstall', async () => {
    const ports = createPorts({ readMode: () => 'notify' })
    const state = new RemediationStateStore(new InMemoryGlobalState())

    await remediateWithheld([withheld], ports, state, new RecordingLog())

    expect(ports.installExtension).not.toHaveBeenCalled()
    expect(ports.uninstallExtension).not.toHaveBeenCalled()
    expect(ports.showWarning).toHaveBeenCalledWith(
      'pkgwarden withheld contoso.linter-pro@4.2.1 (scan_verdict).',
      REMEDIATION_REMOVE_NOW,
      REMEDIATION_VIEW_DETAILS,
    )
    expect(state.handledSet().has('contoso.linter-pro@4.2.1')).toBe(true)
  })

  it('auto mode rolls back then notifies with the restored version', async () => {
    const ports = createPorts()
    const state = new RemediationStateStore(new InMemoryGlobalState())

    await remediateWithheld([withheld], ports, state, new RecordingLog())

    expect(ports.installExtension).toHaveBeenCalledWith('contoso.linter-pro@4.1.9')
    expect(ports.uninstallExtension).not.toHaveBeenCalled()
    expect(ports.showWarning).toHaveBeenCalledWith(
      'pkgwarden removed a malicious update to contoso.linter-pro@4.2.1 and restored 4.1.9.',
      REMEDIATION_VIEW_DETAILS,
    )
    expect(state.shepherdTracking()).toEqual(new Map([['contoso.linter-pro', '4.1.9']]))
  })

  it('logs when the rollback happened but its shepherd tracking could not be persisted', async () => {
    const log = new RecordingLog()

    await remediateWithheld(
      [withheld],
      createPorts(),
      new RemediationStateStore(new DiscardingGlobalState()),
      log,
    )

    expect(log.lines.join('\n')).toContain(
      'could not record shepherd tracking for contoso.linter-pro@4.1.9',
    )
  })

  it('auto mode uninstalls when gate left no rollback version', async () => {
    const ports = createPorts()
    const state = new RemediationStateStore(new InMemoryGlobalState())

    await remediateWithheld(
      [{ ...withheld, rollbackVersion: null }],
      ports,
      state,
      new RecordingLog(),
    )

    expect(ports.installExtension).not.toHaveBeenCalled()
    expect(ports.uninstallExtension).toHaveBeenCalledWith('contoso.linter-pro')
    expect(ports.showWarning).toHaveBeenCalledWith(
      'pkgwarden removed contoso.linter-pro@4.2.1 because gate withheld that version.',
      REMEDIATION_VIEW_DETAILS,
    )
  })

  it('auto mode falls back to uninstall when rollback install throws', async () => {
    const ports = createPorts({
      installExtension: vi.fn(async () => {
        throw new Error('install rejected')
      }),
    })
    const log = new RecordingLog()
    const state = new RemediationStateStore(new InMemoryGlobalState())

    await remediateWithheld([withheld], ports, state, log)

    expect(ports.uninstallExtension).toHaveBeenCalledWith('contoso.linter-pro')
    expect(ports.showWarning).toHaveBeenCalledWith(
      'pkgwarden removed contoso.linter-pro@4.2.1 because gate withheld that version.',
      REMEDIATION_VIEW_DETAILS,
    )
    expect(log.lines.join('\n')).toContain('install rejected')
  })

  it('suppresses repeats once a withheld pair is already handled', async () => {
    const ports = createPorts()
    const state = new RemediationStateStore(new InMemoryGlobalState())
    await state.markHandled('contoso.linter-pro@4.2.1')

    await remediateWithheld([withheld], ports, state, new RecordingLog())

    expect(ports.installExtension).not.toHaveBeenCalled()
    expect(ports.showWarning).not.toHaveBeenCalled()
  })

  it('never uninstalls or rolls back pkgwarden.companion', async () => {
    const ports = createPorts()
    const companionWithheld: VscodeWithheldVersion = {
      extensionId: COMPANION_EXTENSION_ID,
      version: '0.1.0',
      reason: 'known_malware',
      rollbackVersion: null,
    }

    await remediateWithheld(
      [companionWithheld],
      ports,
      new RemediationStateStore(new InMemoryGlobalState()),
      new RecordingLog(),
    )

    expect(ports.installExtension).not.toHaveBeenCalled()
    expect(ports.uninstallExtension).not.toHaveBeenCalled()
    expect(ports.showWarning).not.toHaveBeenCalled()
  })

  it('uninstalls when notify mode user chooses remove now', async () => {
    const ports = createPorts({
      readMode: () => 'notify',
      showWarning: vi.fn(async () => REMEDIATION_REMOVE_NOW),
    })

    await remediateWithheld(
      [withheld],
      ports,
      new RemediationStateStore(new InMemoryGlobalState()),
      new RecordingLog(),
    )

    expect(ports.uninstallExtension).toHaveBeenCalledWith('contoso.linter-pro')
  })

  it('claims handled before acting so a second pass skips even mid-notification', async () => {
    let releaseNotification: (() => void) | undefined
    const ports = createPorts({
      readMode: () => 'notify',
      showWarning: vi.fn(
        async () =>
          new Promise<string | undefined>((resolve) => {
            releaseNotification = () => resolve(undefined)
          }),
      ),
    })
    const state = new RemediationStateStore(new InMemoryGlobalState())

    const firstPass = remediateWithheld([withheld], ports, state, new RecordingLog())
    await vi.waitUntil(() => vi.mocked(ports.showWarning).mock.calls.length === 1)
    expect(state.handledSet().has('contoso.linter-pro@4.2.1')).toBe(true)

    await remediateWithheld([withheld], ports, state, new RecordingLog())
    expect(ports.showWarning).toHaveBeenCalledTimes(1)

    releaseNotification?.()
    await firstPass
  })

  it('skips install and uninstall when sign-out clears the token mid-remediation', async () => {
    let guardCalls = 0
    const ports = createPorts()

    await remediateWithheld(
      [withheld],
      ports,
      new RemediationStateStore(new InMemoryGlobalState()),
      new RecordingLog(),
      async () => {
        guardCalls += 1
        return guardCalls <= 1
      },
    )

    expect(ports.installExtension).not.toHaveBeenCalled()
    expect(ports.uninstallExtension).not.toHaveBeenCalled()
  })

  it('opens the gate webapp when view details is chosen', async () => {
    const ports = createPorts({
      showWarning: vi.fn(async () => REMEDIATION_VIEW_DETAILS),
    })

    await remediateWithheld(
      [withheld],
      ports,
      new RemediationStateStore(new InMemoryGlobalState()),
      new RecordingLog(),
    )

    expect(ports.openExternal).toHaveBeenCalledWith(
      `${GATE_WEBAPP_URL}/extensions/contoso.linter-pro`,
    )
  })
})

describe('shepherdTrackedExtensions glue', () => {
  it('installs the newest pinned version for tracked extensions on later syncs', async () => {
    const ports = createPorts()
    const state = new RemediationStateStore(new InMemoryGlobalState())
    await state.trackShepherd('contoso.linter-pro', '4.1.9')

    await shepherdTrackedExtensions(
      { 'contoso.linter-pro': ['4.1.9', '4.2.2'] },
      new Map([['contoso.linter-pro', '4.1.9']]),
      ports,
      state,
    )

    expect(ports.installExtension).toHaveBeenCalledWith('contoso.linter-pro@4.2.2')
    expect(state.shepherdTracking().has('contoso.linter-pro')).toBe(false)
  })

  it('keeps tracking across a sync taken while the withheld version still stands', async () => {
    const ports = createPorts()
    const state = new RemediationStateStore(new InMemoryGlobalState())
    await state.trackShepherd('contoso.linter-pro', '4.1.9')

    await shepherdTrackedExtensions(
      { 'contoso.linter-pro': ['4.1.8', '4.1.9'] },
      new Map([['contoso.linter-pro', '4.1.9']]),
      ports,
      state,
    )

    expect(ports.installExtension).not.toHaveBeenCalled()
    expect(state.shepherdTracking()).toEqual(new Map([['contoso.linter-pro', '4.1.9']]))
  })

  it('drops tracking once the installed copy is past the rollback target', async () => {
    const ports = createPorts()
    const state = new RemediationStateStore(new InMemoryGlobalState())
    await state.trackShepherd('contoso.linter-pro', '4.1.9')

    await shepherdTrackedExtensions(
      { 'contoso.linter-pro': ['4.1.9', '4.2.2'] },
      new Map([['contoso.linter-pro', '4.2.2']]),
      ports,
      state,
    )

    expect(ports.installExtension).not.toHaveBeenCalled()
    expect(state.shepherdTracking().has('contoso.linter-pro')).toBe(false)
  })

  it('keeps a rollback another window recorded while the shepherd install was in flight', async () => {
    const state = new RemediationStateStore(new InMemoryGlobalState())
    await state.trackShepherd('contoso.linter-pro', '4.1.9')
    const ports = createPorts({
      installExtension: vi.fn(async () => {
        await state.trackShepherd('contoso.linter-pro', '4.1.8')
      }),
    })

    await shepherdTrackedExtensions(
      { 'contoso.linter-pro': ['4.1.8', '4.1.9', '4.2.2'] },
      new Map([['contoso.linter-pro', '4.1.9']]),
      ports,
      state,
    )

    expect(state.shepherdTracking()).toEqual(new Map([['contoso.linter-pro', '4.1.8']]))
  })

  it('never shepherds pkgwarden.companion', async () => {
    const ports = createPorts()
    const state = new RemediationStateStore(new InMemoryGlobalState())
    await state.trackShepherd(COMPANION_EXTENSION_ID, '0.1.0')

    await shepherdTrackedExtensions(
      { [COMPANION_EXTENSION_ID]: ['0.1.0', '0.2.0'] },
      new Map([[COMPANION_EXTENSION_ID, '0.1.0']]),
      ports,
      state,
    )

    expect(ports.installExtension).not.toHaveBeenCalled()
  })
})

describe('runPostSyncRemediation', () => {
  it('shepherds previously tracked extensions before handling new withheld entries', async () => {
    const ports = createPorts()
    const state = new RemediationStateStore(new InMemoryGlobalState())
    await state.trackShepherd('contoso.linter-pro', '4.1.9')

    await runPostSyncRemediation(
      [],
      { 'contoso.linter-pro': ['4.1.9', '4.2.2'] },
      [{ extensionId: 'contoso.linter-pro', currentVersion: '4.1.9' }],
      state,
      new RecordingLog(),
      async () => true,
      ports,
    )

    expect(ports.installExtension).toHaveBeenCalledWith('contoso.linter-pro@4.2.2')
    expect(state.shepherdTracking().has('contoso.linter-pro')).toBe(false)
  })

  it('tracks shepherd ids during rollback without advancing them on the same sync', async () => {
    const ports = createPorts()
    const state = new RemediationStateStore(new InMemoryGlobalState())

    await runPostSyncRemediation(
      [withheld],
      { 'contoso.linter-pro': ['4.1.9'] },
      [{ extensionId: 'contoso.linter-pro', currentVersion: '4.2.1' }],
      state,
      new RecordingLog(),
      async () => true,
      ports,
    )

    expect(ports.installExtension).toHaveBeenCalledTimes(1)
    expect(ports.installExtension).toHaveBeenCalledWith('contoso.linter-pro@4.1.9')
    expect(state.shepherdTracking()).toEqual(new Map([['contoso.linter-pro', '4.1.9']]))
  })

  it('advances a rollback only after the verdict clears, not on the syncs in between', async () => {
    const ports = createPorts()
    const state = new RemediationStateStore(new InMemoryGlobalState())
    const withheldPins = { 'contoso.linter-pro': ['4.1.9'] }
    const log = new RecordingLog()

    await runPostSyncRemediation(
      [withheld],
      withheldPins,
      [{ extensionId: 'contoso.linter-pro', currentVersion: '4.2.1' }],
      state,
      log,
      async () => true,
      ports,
    )
    await runPostSyncRemediation(
      [withheld],
      withheldPins,
      [{ extensionId: 'contoso.linter-pro', currentVersion: '4.1.9' }],
      state,
      log,
      async () => true,
      ports,
    )
    expect(ports.installExtension).toHaveBeenCalledTimes(1)

    await runPostSyncRemediation(
      [],
      { 'contoso.linter-pro': ['4.1.9', '4.2.1'] },
      [{ extensionId: 'contoso.linter-pro', currentVersion: '4.1.9' }],
      state,
      log,
      async () => true,
      ports,
    )

    expect(ports.installExtension).toHaveBeenLastCalledWith('contoso.linter-pro@4.2.1')
    expect(state.shepherdTracking().has('contoso.linter-pro')).toBe(false)
  })
})

describe('installedVersionsById', () => {
  it('lowercases extension ids from inventory entries', () => {
    expect(
      installedVersionsById([{ extensionId: 'Contoso.Linter-Pro', currentVersion: '4.2.1' }]),
    ).toEqual(new Map([['contoso.linter-pro', '4.2.1']]))
  })
})

describe('createRemediationPorts', () => {
  it('defaults remediation mode to auto', async () => {
    recorder.configuration.values.set('pkgwarden.remediation', undefined)
    const ports = createRemediationPorts()

    await remediateWithheld(
      [withheld],
      ports,
      new RemediationStateStore(new InMemoryGlobalState()),
      new RecordingLog(),
    )

    expect(recorder.executedCommands[0]).toEqual({
      command: 'workbench.extensions.installExtension',
      args: ['contoso.linter-pro@4.1.9'],
    })
  })

  it('honors notify mode from settings', async () => {
    recorder.configuration.values.set('pkgwarden.remediation', 'notify')
    const ports = createRemediationPorts()

    await remediateWithheld(
      [withheld],
      ports,
      new RemediationStateStore(new InMemoryGlobalState()),
      new RecordingLog(),
    )

    expect(recorder.executedCommands).toEqual([])
    expect(recorder.warningMessageActions[0]?.actions).toEqual([
      REMEDIATION_REMOVE_NOW,
      REMEDIATION_VIEW_DETAILS,
    ])
  })
})
