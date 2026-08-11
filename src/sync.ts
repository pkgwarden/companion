import * as vscode from 'vscode'

import { DEFAULT_GATE_API_URL } from './constants'
import {
  GateClient,
  GateClientError,
  type VscodeInventoryEntry,
  type VscodePinMap,
  type VscodeWithheldVersion,
} from './gateClient'
import { collectInventory } from './inventory'
import type { CompanionLog } from './log'
import type { SyncFailureKind } from './messages'
import { countPinnedExtensions, readEffectivePins, withSelfPinPreserved, writePins } from './pinMap'
import { runPostSyncRemediation } from './remediation'
import type { RemediationStateStore } from './remediationState'
import type { CompanionStatusBar } from './statusBar'
import { type SyncSkipReason, syncSkipReason } from './syncDecision'
import type { SyncStateStore } from './syncState'
import type { GateTokenStore } from './tokenStore'

export type SyncTrigger = 'activation' | 'scheduled' | 'command' | 'sign-in'

/** The set-and-forget promise starts at the paste, so neither of these waits for the next tick. */
const CADENCE_BYPASSING_TRIGGERS: readonly SyncTrigger[] = ['command', 'sign-in']

function cadenceBypassed(trigger: SyncTrigger, pendingForce: boolean): boolean {
  return CADENCE_BYPASSING_TRIGGERS.includes(trigger) || pendingForce
}

function newSyncClaimId(): string {
  return crypto.randomUUID()
}

export type SyncOutcome =
  | { status: 'synced'; pinnedCount: number; overridden: boolean }
  | { status: 'skipped'; reason: SyncSkipReason }
  | { status: 'signed-out' }
  | { status: 'failed'; kind: SyncFailureKind }

export interface SyncEngineOptions {
  tokenStore: GateTokenStore
  statusBar: CompanionStatusBar
  syncState: SyncStateStore
  remediationState: RemediationStateStore
  log: CompanionLog
  extensionPath: string
  now?: () => number
}

function configuredApiUrl(): string {
  const configured = vscode.workspace.getConfiguration('pkgwarden').get<string>('apiUrl')
  return configured === undefined || configured.trim() === '' ? DEFAULT_GATE_API_URL : configured
}

function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One metered `POST /vscode/policy` per sync, no retries: a failure keeps the pins already in
 * settings and surfaces itself in the status bar and the log rather than leaving the user
 * believing in enforcement that did not happen.
 */
export class SyncEngine {
  private readonly tokenStore: GateTokenStore
  private readonly statusBar: CompanionStatusBar
  private readonly syncState: SyncStateStore
  private readonly remediationState: RemediationStateStore
  private readonly log: CompanionLog
  private readonly extensionPath: string
  private readonly now: () => number
  private inFlight: Promise<SyncOutcome> | null = null
  /** True once any coalesced caller asked for a cadence-bypassing trigger. */
  private pendingForce = false

  constructor(options: SyncEngineOptions) {
    this.tokenStore = options.tokenStore
    this.statusBar = options.statusBar
    this.syncState = options.syncState
    this.remediationState = options.remediationState
    this.log = options.log
    this.extensionPath = options.extensionPath
    this.now = options.now ?? Date.now
  }

  /** Never rejects: callers fire this from command handlers and timers without awaiting. */
  run(trigger: SyncTrigger): Promise<SyncOutcome> {
    if (CADENCE_BYPASSING_TRIGGERS.includes(trigger)) {
      this.pendingForce = true
    }
    if (this.inFlight === null) {
      this.inFlight = this.attempt(trigger).finally(() => {
        this.inFlight = null
        this.pendingForce = false
      })
    }
    return this.inFlight
  }

  private async attempt(trigger: SyncTrigger): Promise<SyncOutcome> {
    try {
      return await this.synchronize(trigger)
    } catch (error) {
      const kind = error instanceof GateClientError ? error.kind : 'local'
      this.log.append(`${trigger} sync failed (${kind}): ${failureDetail(error)}`)
      if (kind === 'metered-out') {
        this.statusBar.update({ quotaExhausted: true })
      }
      return { status: 'failed', kind }
    }
  }

  private async synchronize(trigger: SyncTrigger): Promise<SyncOutcome> {
    const token = await this.tokenStore.read()
    if (token === undefined) {
      this.statusBar.update({ hasToken: false })
      return { status: 'signed-out' }
    }
    this.statusBar.update({ hasToken: true })
    const skipReason = syncSkipReason({
      ...this.syncState.read(),
      nowMs: this.now(),
      force: cadenceBypassed(trigger, this.pendingForce),
    })
    if (skipReason !== null) {
      return { status: 'skipped', reason: skipReason }
    }
    const claimId = newSyncClaimId()
    const claimTime = this.now()
    await this.syncState.merge({ lastSyncStartedAt: claimTime, syncClaimId: claimId })
    const confirmed = this.syncState.read()
    if (confirmed.syncClaimId !== claimId || confirmed.lastSyncStartedAt !== claimTime) {
      return { status: 'skipped', reason: 'another-sync-in-flight' }
    }
    const inventory = await collectInventory(this.extensionPath)
    this.statusBar.update({ partialInventory: inventory.partial })
    const tokenBeforeFetch = await this.tokenStore.read()
    if (tokenBeforeFetch === undefined) {
      this.statusBar.update({ hasToken: false })
      return { status: 'signed-out' }
    }
    const policy = await new GateClient({
      apiUrl: configuredApiUrl(),
      token: tokenBeforeFetch,
    }).fetchPolicy(inventory.entries)
    // VS Code reads `{}` as "allow nothing", which would disable every installed extension,
    // this one included. Gate emits a key per inventoried extension, so an empty map is a
    // server-side fault, not a policy: fail closed and leave the pins already in settings.
    if (countPinnedExtensions(policy.extensionsAllowed) === 0) {
      throw new GateClientError(
        'server',
        'gate returned an empty extensions.allowed; refusing to write an allowlist that would disable every extension',
      )
    }
    return this.applyPolicy(policy.extensionsAllowed, policy.withheld, inventory.entries)
  }

  private async applyPolicy(
    serverPins: VscodePinMap,
    withheld: readonly VscodeWithheldVersion[],
    inventoryEntries: readonly VscodeInventoryEntry[],
  ): Promise<SyncOutcome> {
    if ((await this.tokenStore.read()) === undefined) {
      this.statusBar.update({ hasToken: false })
      return { status: 'signed-out' }
    }
    const pins = withSelfPinPreserved(serverPins, readEffectivePins())
    const overridden = await writePins(pins)
    const pinnedCount = countPinnedExtensions(pins)
    const syncedAt = this.now()
    await this.syncState.merge({ lastSuccessAt: syncedAt, pinnedCount })
    this.statusBar.update({
      pinnedCount,
      lastSuccessAt: syncedAt,
      policyManaged: overridden,
      quotaExhausted: false,
    })
    if (overridden) {
      this.log.append(
        'extensions.allowed reads back differently than pkgwarden wrote it: a device or MDM policy layer outranks these pins.',
      )
    }
    await runPostSyncRemediation(
      withheld,
      pins,
      inventoryEntries,
      this.remediationState,
      this.log,
      async () => (await this.tokenStore.read()) !== undefined,
    )
    return { status: 'synced', pinnedCount, overridden }
  }
}
