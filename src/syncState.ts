/** One namespaced key holds every sync bookkeeping field, so nothing else lands in globalState. */
export const SYNC_STATE_KEY = 'pkgwarden.sync'

export interface SyncStateSnapshot {
  lastSyncStartedAt: number | null
  lastSuccessAt: number | null
  pinnedCount: number
  /** Unique id of the window that claimed the in-flight sync; losers abort before gate. */
  syncClaimId: string | null
}

/** The slice of `vscode.Memento` (`context.globalState`) the companion uses. */
export interface GlobalStateStore {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): PromiseLike<void>
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function parseSyncState(raw: unknown): SyncStateSnapshot {
  const stored = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const syncClaimId = stored.syncClaimId
  return {
    lastSyncStartedAt: asNumber(stored.lastSyncStartedAt),
    lastSuccessAt: asNumber(stored.lastSuccessAt),
    pinnedCount: asNumber(stored.pinnedCount) ?? 0,
    syncClaimId: typeof syncClaimId === 'string' && syncClaimId !== '' ? syncClaimId : null,
  }
}

/**
 * Reads go straight to `globalState`, which the editor shares across windows — that sharing is
 * what makes the multi-window dedup work, so this never caches.
 */
export class SyncStateStore {
  private readonly globalState: GlobalStateStore

  constructor(globalState: GlobalStateStore) {
    this.globalState = globalState
  }

  read(): SyncStateSnapshot {
    return parseSyncState(this.globalState.get(SYNC_STATE_KEY))
  }

  async merge(patch: Partial<SyncStateSnapshot>): Promise<SyncStateSnapshot> {
    const merged = { ...this.read(), ...patch }
    await this.globalState.update(SYNC_STATE_KEY, merged)
    return merged
  }
}
