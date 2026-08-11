import * as vscode from 'vscode'

import { resetCatalogSql, withheldVersionSql } from './catalogStaging'
import {
  assert,
  assertLocalApiUrl,
  type EditorStubs,
  effectivePins,
  installedVersions,
  isRunning,
  type PinMap,
  readSettingsFile,
} from './host'
import type { PickerDriver } from './pickerDriver'
import { pollFor } from './poll'
import type { ScenarioResult } from './results'
import {
  hasLine,
  MANAGED_BANNER,
  parseSettings,
  STRAY_COMMENT,
  stableFingerprint,
} from './settingsText'
import { COMPANION_ID, ESLINT_ID, PERMISSIVE_PLACEHOLDER_PINS, PRETTIER_ID } from './stagePlan'

const SIGN_IN_COMMAND = 'pkgwarden.signIn'
const SIGN_OUT_COMMAND = 'pkgwarden.signOut'
const SYNC_NOW_COMMAND = 'pkgwarden.syncNow'
const INSTALL_EXTENSION_COMMAND = 'pkgwarden.installExtension'

const FAST = { timeoutMs: 30_000, intervalMs: 500 }
const SLOW = { timeoutMs: 90_000, intervalMs: 1_000 }
/** Long enough for the editor to notice an out-of-band settings.json edit. */
const SETTINGS_SETTLE_MS = 2_500

export interface StageContext {
  stubs: EditorStubs
  picker: PickerDriver
  gateUrl: string
  token: string
  extensionsDir: string
  settingsPath: string
  /** Runs a catalog statement without leaving the editor session; see `suite.ts`. */
  stageCatalog: (sql: string) => void
}

async function check(id: string, body: () => Promise<string>): Promise<ScenarioResult> {
  try {
    return { id, status: 'pass', evidence: await body() }
  } catch (error) {
    return { id, status: 'fail', evidence: error instanceof Error ? error.message : String(error) }
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const IN_FLIGHT_MARKER = 'already called gate in the last few minutes'
const CADENCE_MARKER = 'already synced your extension policy today'
/**
 * Skips and failures both mean "no policy was applied", and a failed sync also poisons the
 * 10-minute window, so a scenario that only watched for skips would report the confusing
 * after-effect instead of the cause.
 */
const NO_POLICY_MARKERS = [
  IN_FLIGHT_MARKER,
  CADENCE_MARKER,
  'pins are unchanged',
  'could not write extensions.allowed',
]
/** How long to let a background sync started by the companion itself finish before giving up. */
const IN_FLIGHT_WAIT_MS = 30_000

interface SyncAttempt {
  /** Held behind a sync that is still running: worth waiting out, unlike every other problem. */
  held: boolean
  problem: string | null
}

/** Runs the command once and reports whatever the companion said about not applying a policy. */
async function attemptSync(context: StageContext): Promise<SyncAttempt> {
  const mark = context.stubs.messages.length
  await vscode.commands.executeCommand(SYNC_NOW_COMMAND)
  const problem = context.stubs
    .since(mark)
    .find((message) => NO_POLICY_MARKERS.some((marker) => message.message.includes(marker)))
  return {
    held: problem?.message.includes(IN_FLIGHT_MARKER) === true,
    problem: problem?.message ?? null,
  }
}

/** A sync that applied no policy must not read as a sync that changed nothing. */
async function syncNow(context: StageContext): Promise<void> {
  await signInIfNeeded(context)
  const deadline = Date.now() + IN_FLIGHT_WAIT_MS
  let attempt = await attemptSync(context)
  while (attempt.held && Date.now() < deadline) {
    await wait(2_000)
    attempt = await attemptSync(context)
  }
  assert(
    attempt.problem === null,
    `the sync applied no policy, so this scenario would prove nothing: ${String(attempt.problem)}`,
  )
  assert(context.stubs.signedIn(), 'the companion is signed out, so the sync did nothing')
}

/**
 * The throwaway profile's secret storage does not survive a relaunch, so most stages come up
 * signed out. Signing in again keeps the stage meaningful instead of quietly measuring a
 * signed-out companion; no scenario may depend on a token carrying across launches.
 */
async function signInIfNeeded(context: StageContext): Promise<void> {
  if (context.stubs.signedIn()) {
    return
  }
  await vscode.commands.executeCommand(SIGN_IN_COMMAND)
  assert(
    context.stubs.signedIn(),
    `sign-in did not take: status bar reads ${JSON.stringify(context.stubs.statusText())}`,
  )
}

function versionOf(context: StageContext, extensionId: string): string | undefined {
  return installedVersions(context.extensionsDir).get(extensionId)
}

async function waitForVersion(
  context: StageContext,
  extensionId: string,
  version: string | undefined,
): Promise<string | undefined> {
  const outcome = await pollFor(
    () => versionOf(context, extensionId),
    (observed) => observed === version,
    SLOW,
  )
  return outcome.value
}

function pinsOf(pins: PinMap, extensionId: string): string[] | boolean | undefined {
  return pins[extensionId]
}

function fileSettings(context: StageContext): Record<string, unknown> {
  return parseSettings(readSettingsFile(context.settingsPath))
}

interface PolicyWithheld {
  extension_id: string
  version: string
}

interface ServedPolicy {
  pins: PinMap
  withheld: PolicyWithheld[]
}

/** Asks gate directly, so a scenario can prove the server really staged what it needed. */
async function fetchPolicy(
  context: StageContext,
  inventory: readonly { extension_id: string; current_version: string }[],
): Promise<ServedPolicy> {
  const response = await fetch(`${context.gateUrl}/api/v1/vscode/policy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${context.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inventory }),
  })
  const payload = (await response.json()) as {
    withheld?: PolicyWithheld[]
    'extensions.allowed'?: PinMap
  }
  return { pins: payload['extensions.allowed'] ?? {}, withheld: payload.withheld ?? [] }
}

const currentInventory = (
  context: StageContext,
): { extension_id: string; current_version: string }[] =>
  [...installedVersions(context.extensionsDir)].map(([extension_id, current_version]) => ({
    extension_id,
    current_version,
  }))

const mentions = (stubs: EditorStubs, mark: number, needle: string): boolean =>
  stubs.since(mark).some((message) => message.message.includes(needle))

async function signedOutStage(context: StageContext): Promise<ScenarioResult[]> {
  return [
    await check('P1-commands', async () => {
      const commands = await vscode.commands.getCommands(true)
      const contributed = [
        SIGN_IN_COMMAND,
        SIGN_OUT_COMMAND,
        SYNC_NOW_COMMAND,
        INSTALL_EXTENSION_COMMAND,
      ]
      const missing = contributed.filter((command) => !commands.includes(command))
      assert(missing.length === 0, `commands not registered: ${missing.join(', ')}`)
      return `all four commands registered: ${contributed.join(', ')}`
    }),
    await check('P1-no-pins', async () => {
      const allowed = fileSettings(context)['extensions.allowed']
      assert(
        allowed === undefined,
        `signed out but settings.json already has ${JSON.stringify(allowed)}`,
      )
      return 'settings.json has no extensions.allowed key while signed out'
    }),
  ]
}

async function coreSyncStage(context: StageContext): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = []
  await vscode.commands.executeCommand(SIGN_IN_COMMAND)
  const settled = await pollFor(
    () => effectivePins(),
    (pins) => Object.keys(pins).length > 0,
    FAST,
  )
  const pins = settled.value

  results.push(
    await check('P1-signin-sync', async () => {
      assert(context.stubs.inputBoxCalls === 1, 'the sign-in prompt was not the stubbed one')
      const eslintPin = pinsOf(pins, ESLINT_ID)
      assert(
        Array.isArray(eslintPin) && eslintPin.length === 3,
        `eslint pin is ${JSON.stringify(eslintPin)}`,
      )
      assert(pinsOf(pins, COMPANION_ID) !== undefined, 'the companion self-allow is missing')
      return `extensions.allowed written on sign-in: ${stableFingerprint(pins)}`
    }),
  )

  results.push(
    await check('P1-disabled-inventory', async () => {
      assert(!isRunning(PRETTIER_ID), 'prettier was not disabled, so the scenario proves nothing')
      const prettierPin = pinsOf(pins, PRETTIER_ID)
      assert(
        Array.isArray(prettierPin),
        `prettier is disabled and absent from the pin map: ${JSON.stringify(prettierPin)}`,
      )
      return `prettier is disabled (absent from vscode.extensions.all) yet pinned ${JSON.stringify(prettierPin)}`
    }),
  )

  return results
}

/**
 * The banner is what `pw vscode sync-policy` leaves above the pin map. It is put in place before
 * the editor starts (as the CLI would, between sessions) so this measures the companion's write
 * and not whether the editor noticed an out-of-band edit mid-session.
 */
async function bannerStage(context: StageContext): Promise<ScenarioResult[]> {
  const before = readSettingsFile(context.settingsPath)
  const sentinel = stableFingerprint(PERMISSIVE_PLACEHOLDER_PINS)
  let after = before
  const results: ScenarioResult[] = [
    await check('P1-banner', async () => {
      assert(hasLine(before, MANAGED_BANNER), 'the banner was not staged before this launch')
      assert(
        stableFingerprint(parseSettings(before)['extensions.allowed']) === sentinel,
        'the sentinel pin map was not staged, so a sync that wrote nothing would pass this scenario',
      )
      await syncNow(context)
      after = readSettingsFile(context.settingsPath)
      const written = stableFingerprint(parseSettings(after)['extensions.allowed'])
      assert(
        written !== sentinel,
        'the sync left the staged sentinel in place, so nothing here was written and the comment survived nothing',
      )
      assert(
        hasLine(after, MANAGED_BANNER),
        'the managed banner comment did not survive the sync write',
      )
      return `the sync replaced the staged sentinel with ${written} and the banner comment above it survived`
    }),
  ]
  results.push(
    await check('P1-stray-comment', async () => {
      assert(
        stableFingerprint(parseSettings(after)['extensions.allowed']) !== sentinel,
        'the sync wrote nothing, so this scenario would prove nothing',
      )
      assert(hasLine(after, STRAY_COMMENT), 'the unrelated settings.json comment did not survive')
      return 'an unrelated comment elsewhere in settings.json survived the same write'
    }),
  )
  return results
}

async function selfPinStage(context: StageContext): Promise<ScenarioResult[]> {
  return [
    await check('P1-self-pin-carryover', async () => {
      const before = pinsOf(effectivePins(), COMPANION_ID)
      assert(
        before !== undefined,
        'no companion self-pin to carry over; the previous stage did not sync',
      )
      const served = await fetchPolicy(context, currentInventory(context))
      assert(
        served.pins[COMPANION_ID] === undefined,
        'gate still pins the companion, so nothing had to be carried over and this proves nothing',
      )
      await syncNow(context)
      const after = pinsOf(effectivePins(), COMPANION_ID)
      assert(after !== undefined, 'the companion self-pin was dropped by the replace-write')
      return `server omits pkgwarden.companion (its only version is withheld) and the pre-existing pin ${JSON.stringify(after)} survived`
    }),
  ]
}

async function pickerStage(context: StageContext): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = []
  results.push(
    await check('P2-explicit-install', async () => {
      await drivePicker(context, `${PRETTIER_ID}@12.1.0`)
      const observed = await waitForVersion(context, PRETTIER_ID, '12.1.0')
      assert(
        observed === '12.1.0',
        `prettier is ${String(observed)} after an allowed explicit-ref install`,
      )
      const pin = pinsOf(effectivePins(), PRETTIER_ID)
      assert(Array.isArray(pin) && pin.includes('12.1.0'), `prettier pin is ${JSON.stringify(pin)}`)
      return `explicit ref installed 12.1.0 and the pin union kept ${JSON.stringify(pin)}`
    }),
  )
  await wait(SETTINGS_SETTLE_MS)
  // The picker fires a sync it does not await. Left running, it records a sync start with no
  // success and the next stage's syncNow is held by the 10-minute in-flight window.
  await drainPendingSync()

  results.push(
    await check('P2-blocked-no-override', async () => {
      const before = versionOf(context, ESLINT_ID)
      const mark = context.stubs.messages.length
      await drivePicker(context, `${ESLINT_ID}@3.0.27`)
      const shown = context.stubs.since(mark)
      assert(shown.length > 0, 'the blocked install said nothing at all')
      assert(
        shown.some((message) => message.message.includes('cannot be overridden')),
        `no unambiguous refusal was shown: ${JSON.stringify(shown.map((m) => m.message))}`,
      )
      assert(
        !shown.some((message) => message.modal),
        `a modal override was offered for a scan_verdict block: ${JSON.stringify(shown)}`,
      )
      const after = versionOf(context, ESLINT_ID)
      assert(after === before, `eslint moved from ${String(before)} to ${String(after)}`)
      return `withheld version refused with no modal and no install; eslint stayed at ${String(after)}`
    }),
  )
  return results
}

/** Awaits whatever sync the picker started: the engine coalesces, so this joins the in-flight one. */
async function drainPendingSync(): Promise<void> {
  await runQuietly(async () => {
    await vscode.commands.executeCommand(SYNC_NOW_COMMAND)
  })
}

/** Adds whatever the companion said to a picker failure: "no quick pick" alone is undiagnosable. */
async function drivePicker(context: StageContext, reference: string): Promise<void> {
  await signInIfNeeded(context)
  const mark = context.stubs.messages.length
  try {
    await context.picker.runInstall(reference)
  } catch (error) {
    const said = JSON.stringify(context.stubs.since(mark).map((message) => message.message))
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; companion said ${said}`,
    )
  }
}

async function runQuietly(body: () => Promise<void>): Promise<string | null> {
  try {
    await body()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function trustedPublisherStage(context: StageContext): Promise<ScenarioResult[]> {
  return [
    await check('P2-trusted-publisher', async () => {
      await syncNow(context)
      const pins = effectivePins()
      assert(
        pins.esbenp === true,
        `gate did not send a wholesale publisher allow: ${stableFingerprint(pins)}`,
      )
      const before = stableFingerprint(fileSettings(context)['extensions.allowed'])
      const mark = context.stubs.messages.length
      await drivePicker(context, `${PRETTIER_ID}@12.1.0`)
      await wait(SETTINGS_SETTLE_MS)
      const after = stableFingerprint(fileSettings(context)['extensions.allowed'])
      assert(after === before, `the picker narrowed a wholesale allow: ${before} -> ${after}`)
      assert(
        mentions(context.stubs, mark, 'allowed and installed'),
        `the install itself did not happen: ${JSON.stringify(context.stubs.since(mark).map((message) => message.message))}`,
      )
      return `publisher "esbenp": true covered the install; extensions.allowed unchanged (${after})`
    }),
  ]
}

async function autoRollbackStage(context: StageContext): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = []
  const mark = context.stubs.messages.length
  const syncFailure = await runQuietly(async () => {
    await syncNow(context)
  })
  results.push(
    await check('P3-auto-rollback', async () => {
      assert(syncFailure === null, String(syncFailure))
      const observed = await waitForVersion(context, ESLINT_ID, '3.0.29')
      assert(
        observed === '3.0.29',
        `eslint is ${String(observed)}, expected the rollback to 3.0.29`,
      )
      const pin = pinsOf(effectivePins(), ESLINT_ID)
      assert(
        Array.isArray(pin) && !pin.includes('3.0.31'),
        `the withheld version is still pinned: ${JSON.stringify(pin)}`,
      )
      assert(
        mentions(context.stubs, mark, ESLINT_ID),
        'no notification named the remediated extension',
      )
      return `withheld 3.0.31 rolled back to 3.0.29; pin is ${JSON.stringify(pin)}`
    }),
  )

  results.push(
    await check('P3-dedup', async () => {
      assert(
        mentions(context.stubs, mark, '3.0.31'),
        'the first sync never notified, so a silent second sync proves no deduplication',
      )
      const second = context.stubs.messages.length
      await syncNow(context)
      const repeated = context.stubs
        .since(second)
        .filter((message) => message.message.includes('3.0.31'))
      assert(
        repeated.length === 0,
        `the same withheld version notified again: ${JSON.stringify(repeated)}`,
      )
      return 'a second sync over the same withheld version produced no new notification'
    }),
  )
  return results
}

/** Its result is a dialog, which the test host refuses to render; that refusal is the answer. */
const TEST_DIALOG_REFUSAL = 'refused to show dialog in tests'

/**
 * The id has moved between builds, and the extensions view has to have loaded for the command to
 * be registered at all, so it is discovered rather than hard-coded.
 */
async function runCheckForUpdates(): Promise<string> {
  await runQuietly(async () => {
    await vscode.commands.executeCommand('workbench.view.extensions')
  })
  const commands = await vscode.commands.getCommands(true)
  const command = commands.find((candidate) => candidate.includes('checkForUpdates'))
  if (command === undefined) {
    return 'no checkForUpdates command in this build; relying on the startup auto-update pass'
  }
  const failure = await runQuietly(async () => {
    await vscode.commands.executeCommand(command)
  })
  if (failure === null) {
    return `ran ${command}`
  }
  assert(failure.includes(TEST_DIALOG_REFUSAL), `${command} failed: ${failure}`)
  return `ran ${command}, which reported: ${failure}`
}

/**
 * This stage launches with `extensions.autoUpdate` on, and the editor runs an auto-update pass at
 * startup, so the pin is already under real pressure before the explicit check runs.
 */
async function rv2Stage(context: StageContext): Promise<ScenarioResult[]> {
  return [
    await check('P3-rv2-pin-holds', async () => {
      const before = versionOf(context, ESLINT_ID)
      assert(before === '3.0.29', `expected the rolled-back 3.0.29, found ${String(before)}`)
      const how = await runCheckForUpdates()
      const drift = await pollFor(
        () => versionOf(context, ESLINT_ID),
        (observed) => observed !== before,
        { timeoutMs: 30_000, intervalMs: 2_000 },
      )
      assert(!drift.ok, `the editor updated past the pin to ${String(drift.value)}`)
      return `extensions.autoUpdate is on (${how}); eslint stayed at ${before} for 30s`
    }),
  ]
}

/**
 * A sign-in is itself a sync, so signing in is how this stage takes its rollback sync: taking a
 * second one here would decide the scenario before it starts (see P3-shepherd-across-syncs).
 */
async function rollBackTo(
  context: StageContext,
  extensionId: string,
  rollbackVersion: string,
): Promise<void> {
  if (context.stubs.signedIn()) {
    await syncNow(context)
  } else {
    await signInIfNeeded(context)
  }
  const rolledBack = await waitForVersion(context, extensionId, rollbackVersion)
  assert(
    rolledBack === rollbackVersion,
    `the rollback this scenario builds on did not happen: ${extensionId} is ${String(rolledBack)}`,
  )
}

/**
 * Rollback and advance happen in one editor session: the shepherd tracking lives in the
 * companion's `globalState`, and a throwaway profile is not a place to bet a security scenario on
 * that surviving a relaunch. The verdict is cleared mid-session instead.
 */
async function shepherdStage(context: StageContext): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = []
  results.push(
    await check('P3-shepherd', async () => {
      assert(
        versionOf(context, ESLINT_ID) === '3.0.31',
        `this scenario rolls back before it advances and needs 3.0.31 installed, found ${String(versionOf(context, ESLINT_ID))}`,
      )
      await rollBackTo(context, ESLINT_ID, '3.0.29')
      context.stageCatalog(resetCatalogSql())
      const mark = context.stubs.messages.length
      await syncNow(context)
      const observed = await waitForVersion(context, ESLINT_ID, '3.0.31')
      const said = JSON.stringify(context.stubs.since(mark).map((message) => message.message))
      assert(
        observed === '3.0.31',
        `the shepherd left eslint at ${String(observed)}; pin is ${JSON.stringify(pinsOf(effectivePins(), ESLINT_ID))}; companion said ${said}`,
      )
      return 'the verdict cleared with no sync in between and the shepherd advanced eslint 3.0.29 -> 3.0.31'
    }),
  )

  results.push(
    await check('P3-shepherd-across-syncs', async () => {
      assert(
        versionOf(context, PRETTIER_ID) === '12.3.0',
        `this scenario needs prettier at 12.3.0, found ${String(versionOf(context, PRETTIER_ID))}`,
      )
      context.stageCatalog(withheldVersionSql(PRETTIER_ID, '12.3.0'))
      await rollBackTo(context, PRETTIER_ID, '12.2.0')
      // The sync a user gets the next day, while the verdict still stands and there is nothing to
      // advance to yet. Everything after this depends on the tracking outliving it.
      await syncNow(context)
      context.stageCatalog(resetCatalogSql())
      await syncNow(context)
      const observed = await waitForVersion(context, PRETTIER_ID, '12.3.0')
      assert(
        observed === '12.3.0',
        `one ordinary sync taken while 12.3.0 was still withheld ended the shepherding: after the verdict cleared prettier stayed at ${String(observed)} even though the pin is ${JSON.stringify(pinsOf(effectivePins(), PRETTIER_ID))}`,
      )
      return 'the shepherd survived a sync taken while the version was still withheld and advanced prettier 12.2.0 -> 12.3.0 once it cleared'
    }),
  )
  return results
}

async function notifyStage(context: StageContext): Promise<ScenarioResult[]> {
  return [
    await check('P3-notify', async () => {
      const before = versionOf(context, PRETTIER_ID)
      const mark = context.stubs.messages.length
      await syncNow(context)
      await wait(SETTINGS_SETTLE_MS)
      const warnings = context.stubs
        .since(mark)
        .filter((message) => message.message.includes(PRETTIER_ID))
      assert(warnings.length > 0, 'notify mode said nothing about the withheld version')
      const [first] = warnings
      assert(
        first?.actions.includes('Remove now') === true && first.actions.includes('View details'),
        `notification actions were ${JSON.stringify(first?.actions)}`,
      )
      const after = versionOf(context, PRETTIER_ID)
      assert(
        after === before,
        `notify mode changed the install from ${String(before)} to ${String(after)}`,
      )
      return `warned with ${JSON.stringify(first?.actions)} and left prettier at ${String(after)}`
    }),
  ]
}

async function uninstallFallbackStage(context: StageContext): Promise<ScenarioResult[]> {
  return [
    await check('P3-uninstall-fallback', async () => {
      assert(
        versionOf(context, PRETTIER_ID) !== undefined,
        'prettier was not installed to begin with',
      )
      await syncNow(context)
      const observed = await waitForVersion(context, PRETTIER_ID, undefined)
      assert(
        observed === undefined,
        `prettier survived at ${String(observed)} with no clean version left`,
      )
      return 'no version survived the verdict, so auto remediation uninstalled the extension'
    }),
  ]
}

async function selfGuardStage(context: StageContext): Promise<ScenarioResult[]> {
  return [
    await check('P3-self-guard', async () => {
      const inventory = currentInventory(context)
      assert(
        inventory.some((entry) => entry.extension_id === COMPANION_ID),
        'the companion is not in the editor inventory, so nothing could withhold it',
      )
      const { withheld } = await fetchPolicy(context, inventory)
      assert(
        withheld.some((entry) => entry.extension_id === COMPANION_ID),
        `gate did not withhold the companion, so this stage proves nothing: ${JSON.stringify(withheld)}`,
      )
      const mark = context.stubs.messages.length
      await syncNow(context)
      await wait(SETTINGS_SETTLE_MS)
      assert(
        !mentions(context.stubs, mark, COMPANION_ID),
        `remediation acted on the companion: ${JSON.stringify(context.stubs.since(mark))}`,
      )
      assert(isRunning(COMPANION_ID), 'the companion removed itself')
      return 'gate withheld pkgwarden.companion and remediation skipped it: no notification, no uninstall'
    }),
  ]
}

async function rv5DropStage(context: StageContext): Promise<ScenarioResult[]> {
  return [
    await check('P3-rv5-pin-dropped', async () => {
      await syncNow(context)
      const pin = pinsOf(effectivePins(), ESLINT_ID)
      const dropped = pin === undefined || (Array.isArray(pin) && pin.length === 0)
      assert(
        dropped,
        `eslint is still pinned after every version was withheld: ${JSON.stringify(pin)}`,
      )
      return `every version withheld, so the pin became ${JSON.stringify(pin)}; ${String(versionOf(context, ESLINT_ID))} is still installed and still running in this session: ${isRunning(ESLINT_ID)}`
    }),
  ]
}

async function rv5VerifyStage(context: StageContext): Promise<ScenarioResult[]> {
  return [
    await check('P3-rv5-disabled', async () => {
      assert(
        versionOf(context, ESLINT_ID) !== undefined,
        'eslint was uninstalled, so this measures remediation and not the allowlist',
      )
      assert(!isRunning(ESLINT_ID), 'the unpinned extension is still running after a relaunch')
      return 'after a relaunch the unpinned extension is installed on disk but not loaded: a restart was required'
    }),
  ]
}

async function signOutStage(context: StageContext): Promise<ScenarioResult[]> {
  return [
    await check('P1-signout-keeps-pins', async () => {
      const before = stableFingerprint(fileSettings(context)['extensions.allowed'])
      assert(before !== '{}', 'there were no pins to keep')
      await vscode.commands.executeCommand(SIGN_OUT_COMMAND)
      await wait(SETTINGS_SETTLE_MS)
      const after = stableFingerprint(fileSettings(context)['extensions.allowed'])
      assert(after === before, `sign-out changed the pins: ${before} -> ${after}`)
      return `pins unchanged across sign-out: ${after}`
    }),
  ]
}

const DEAD_GATE_URL = 'http://127.0.0.1:9'

async function inFlightStage(context: StageContext): Promise<ScenarioResult[]> {
  return [
    await check('P1-in-flight', async () => {
      await signInIfNeeded(context)
      // Deliberately raw: this scenario exists to observe a skip, which the strict helper treats
      // as a scenario that proved nothing.
      const configuration = vscode.workspace.getConfiguration('pkgwarden')
      await configuration.update('apiUrl', DEAD_GATE_URL, vscode.ConfigurationTarget.Global)
      const failedMark = context.stubs.messages.length
      await vscode.commands.executeCommand(SYNC_NOW_COMMAND)
      assert(
        mentions(context.stubs, failedMark, 'pins are unchanged'),
        `the unreachable-gate sync did not report a failure: ${JSON.stringify(context.stubs.since(failedMark))}`,
      )
      await configuration.update('apiUrl', context.gateUrl, vscode.ConfigurationTarget.Global)
      const heldMark = context.stubs.messages.length
      await vscode.commands.executeCommand(SYNC_NOW_COMMAND)
      assert(
        mentions(context.stubs, heldMark, 'already called gate in the last few minutes'),
        `the second immediate sync was not held: ${JSON.stringify(context.stubs.since(heldMark))}`,
      )
      return 'a failed sync opened the 10-minute window and the next immediate syncNow was held'
    }),
  ]
}

const STAGE_BODIES: Record<string, (context: StageContext) => Promise<ScenarioResult[]>> = {
  'signed-out': signedOutStage,
  'core-sync': coreSyncStage,
  banner: bannerStage,
  'self-pin': selfPinStage,
  picker: pickerStage,
  'trusted-publisher': trustedPublisherStage,
  'auto-rollback': autoRollbackStage,
  rv2: rv2Stage,
  shepherd: shepherdStage,
  notify: notifyStage,
  'uninstall-fallback': uninstallFallbackStage,
  'self-guard': selfGuardStage,
  'rv5-drop': rv5DropStage,
  'rv5-verify': rv5VerifyStage,
  'sign-out': signOutStage,
  'in-flight': inFlightStage,
}

/**
 * Every stage proves the interaction stubs reach the companion before it runs a scenario: an
 * un-stubbed sign-in would open a real prompt and wait for a human.
 */
export async function runStage(stage: string, context: StageContext): Promise<ScenarioResult[]> {
  const body = STAGE_BODIES[stage]
  if (body === undefined) {
    throw new Error(`unknown stage ${stage}`)
  }
  assertLocalApiUrl(context.gateUrl)
  await context.stubs.proveStubsReachExtension()
  return body(context)
}
