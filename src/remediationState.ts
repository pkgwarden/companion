/** One namespaced key holds handled withheld pairs and shepherd tracking ids. */
export const REMEDIATION_STATE_KEY = 'pkgwarden.remediation'

export interface ShepherdEntry {
  extensionId: string
  /**
   * The version auto-remediation rolled the extension back to. The shepherd keeps tracking while
   * the editor still sits on it, so an ordinary sync taken while the withhold stands cannot end
   * the shepherding (#575). `null` for entries written before that target was recorded.
   */
  rolledBackTo: string | null
}

/** Tracked extension id to the version it was rolled back to. */
export type ShepherdTracking = ReadonlyMap<string, string | null>

export interface RemediationStateSnapshot {
  /** Lowercased `extensionId@version` pairs already remediated or notified. */
  handledKeys: string[]
  /** Extensions rolled back by auto-remediation; shepherd advances them on later syncs. */
  shepherded: ShepherdEntry[]
}

export interface GlobalStateStore {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): PromiseLike<void>
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

function asShepherdEntry(value: unknown): ShepherdEntry | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { extensionId, rolledBackTo } = value as Record<string, unknown>
  if (typeof extensionId !== 'string' || extensionId === '') {
    return null
  }
  return {
    extensionId: extensionId.toLowerCase(),
    rolledBackTo: typeof rolledBackTo === 'string' && rolledBackTo !== '' ? rolledBackTo : null,
  }
}

/** Pre-#575 state stored bare ids; they read as tracked with no known rollback target. */
function asShepherdEntries(stored: Record<string, unknown>): ShepherdEntry[] {
  if (Array.isArray(stored.shepherded)) {
    return stored.shepherded
      .map(asShepherdEntry)
      .filter((entry): entry is ShepherdEntry => entry !== null)
  }
  return asStringList(stored.shepherdedExtensionIds).map((extensionId) => ({
    extensionId: extensionId.toLowerCase(),
    rolledBackTo: null,
  }))
}

const withoutId = (entries: readonly ShepherdEntry[], extensionId: string): ShepherdEntry[] =>
  entries.filter((entry) => entry.extensionId !== extensionId)

export function parseRemediationState(raw: unknown): RemediationStateSnapshot {
  const stored = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    handledKeys: asStringList(stored.handledKeys),
    shepherded: asShepherdEntries(stored),
  }
}

export class RemediationStateStore {
  private readonly globalState: GlobalStateStore
  private updateChain: Promise<void> = Promise.resolve()

  constructor(globalState: GlobalStateStore) {
    this.globalState = globalState
  }

  read(): RemediationStateSnapshot {
    return parseRemediationState(this.globalState.get(REMEDIATION_STATE_KEY))
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.updateChain.then(operation, operation)
    this.updateChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async merge(patch: Partial<RemediationStateSnapshot>): Promise<RemediationStateSnapshot> {
    return this.runExclusive(async () => {
      const current = this.read()
      const merged: RemediationStateSnapshot = {
        handledKeys: patch.handledKeys ?? current.handledKeys,
        shepherded: patch.shepherded ?? current.shepherded,
      }
      await this.globalState.update(REMEDIATION_STATE_KEY, merged)
      return merged
    })
  }

  handledSet(): Set<string> {
    return new Set(this.read().handledKeys)
  }

  shepherdTracking(): Map<string, string | null> {
    return new Map(this.read().shepherded.map((entry) => [entry.extensionId, entry.rolledBackTo]))
  }

  async markHandled(key: string): Promise<void> {
    await this.runExclusive(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = this.read()
        if (current.handledKeys.includes(key)) {
          return
        }
        await this.globalState.update(REMEDIATION_STATE_KEY, {
          ...current,
          handledKeys: [...current.handledKeys, key],
        })
        if (this.read().handledKeys.includes(key)) {
          return
        }
      }
    })
  }

  /**
   * A fresh rollback of an already-tracked id replaces its target rather than keeping the old one.
   * Returns whether the target actually reached globalState: losing it strands the extension on
   * the rollback with no forward path, so the caller has to be able to say so.
   */
  async trackShepherd(extensionId: string, rolledBackTo: string | null): Promise<boolean> {
    const entry: ShepherdEntry = { extensionId: extensionId.toLowerCase(), rolledBackTo }
    return this.runExclusive(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = this.read()
        await this.globalState.update(REMEDIATION_STATE_KEY, {
          ...current,
          shepherded: [...withoutId(current.shepherded, entry.extensionId), entry],
        })
        if (this.shepherdTracking().get(entry.extensionId) === rolledBackTo) {
          return true
        }
      }
      return false
    })
  }

  /**
   * Compare-and-set on the rollback target: a drop decided against the target one sync observed
   * must not erase a fresher rollback another window recorded in the meantime (#575).
   */
  async dropShepherd(extensionId: string, expectedRolledBackTo: string | null): Promise<void> {
    const normalized = extensionId.toLowerCase()
    await this.runExclusive(async () => {
      const current = this.read()
      const entry = current.shepherded.find((candidate) => candidate.extensionId === normalized)
      if (entry === undefined || entry.rolledBackTo !== expectedRolledBackTo) {
        return
      }
      await this.globalState.update(REMEDIATION_STATE_KEY, {
        ...current,
        shepherded: withoutId(current.shepherded, normalized),
      })
    })
  }
}
