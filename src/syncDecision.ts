/** JP decision: at most one metered policy call per machine per day. */
export const SYNC_CADENCE_MS = 24 * 60 * 60 * 1000

/** Other windows of the same editor share `globalState`, so a recent start means one is running. */
export const SYNC_DEDUP_WINDOW_MS = 10 * 60 * 1000

export const SYNC_TICK_INTERVAL_MS = 60 * 60 * 1000

export type SyncSkipReason = 'another-sync-in-flight' | 'within-daily-cadence'

export interface SyncTiming {
  nowMs: number
  lastSuccessAt: number | null
  lastSyncStartedAt: number | null
  /** Set by `pkgwarden.syncNow` and by a successful sign-in; never bypasses the dedup window. */
  force: boolean
}

/** A timestamp from the future (clock skew, restored backup) is no evidence, so it never blocks. */
function elapsedSince(timestamp: number | null, nowMs: number): number | null {
  if (timestamp === null) {
    return null
  }
  const elapsed = nowMs - timestamp
  return elapsed < 0 ? null : elapsed
}

/**
 * A start with no success recorded after it is either still running in another window or a
 * failure we promised not to retry; either way, nothing to gain from a second metered call.
 */
function isSyncInFlight(timing: SyncTiming): boolean {
  const sinceStart = elapsedSince(timing.lastSyncStartedAt, timing.nowMs)
  if (timing.lastSyncStartedAt === null || sinceStart === null) {
    return false
  }
  if (sinceStart >= SYNC_DEDUP_WINDOW_MS) {
    return false
  }
  return timing.lastSuccessAt === null || timing.lastSuccessAt < timing.lastSyncStartedAt
}

/** What to tell someone who asked for a sync by hand and did not get one. */
export function syncSkipMessage(reason: SyncSkipReason): string {
  return reason === 'another-sync-in-flight'
    ? 'pkgwarden already called gate in the last few minutes and will not call again until that attempt ages out — the pkgwarden output channel has the result.'
    : 'pkgwarden already synced your extension policy today.'
}

export function syncSkipReason(timing: SyncTiming): SyncSkipReason | null {
  if (isSyncInFlight(timing)) {
    return 'another-sync-in-flight'
  }
  if (timing.force) {
    return null
  }
  const sinceSuccess = elapsedSince(timing.lastSuccessAt, timing.nowMs)
  return sinceSuccess !== null && sinceSuccess < SYNC_CADENCE_MS ? 'within-daily-cadence' : null
}
