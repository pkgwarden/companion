import { describe, expect, it } from 'vitest'

import { SYNC_CADENCE_MS, SYNC_DEDUP_WINDOW_MS, syncSkipReason } from './syncDecision'

const now = Date.UTC(2026, 6, 28, 12, 0, 0)
const idle = { nowMs: now, lastSuccessAt: null, lastSyncStartedAt: null, force: false }

describe('syncSkipReason', () => {
  it('syncs when nothing has ever been recorded', () => {
    expect(syncSkipReason(idle)).toBeNull()
  })

  it('holds the metered call inside the daily cadence', () => {
    expect(syncSkipReason({ ...idle, lastSuccessAt: now - SYNC_CADENCE_MS + 1 })).toBe(
      'within-daily-cadence',
    )
  })

  it('syncs once the daily cadence has elapsed', () => {
    expect(syncSkipReason({ ...idle, lastSuccessAt: now - SYNC_CADENCE_MS })).toBeNull()
  })

  it('lets an explicit request bypass the cadence', () => {
    expect(syncSkipReason({ ...idle, lastSuccessAt: now - 1000, force: true })).toBeNull()
  })

  it('skips while another window is mid-sync', () => {
    expect(syncSkipReason({ ...idle, lastSyncStartedAt: now - SYNC_DEDUP_WINDOW_MS + 1 })).toBe(
      'another-sync-in-flight',
    )
  })

  it('never lets force bypass the multi-window dedup window', () => {
    expect(
      syncSkipReason({ ...idle, lastSyncStartedAt: now - SYNC_DEDUP_WINDOW_MS + 1, force: true }),
    ).toBe('another-sync-in-flight')
  })

  it('lets an on-demand sync follow a run that already finished', () => {
    expect(
      syncSkipReason({
        ...idle,
        lastSyncStartedAt: now - 60_000,
        lastSuccessAt: now - 60_000,
        force: true,
      }),
    ).toBeNull()
  })

  it('holds off after a recent failure, because failing closed means no retries', () => {
    expect(
      syncSkipReason({
        ...idle,
        lastSyncStartedAt: now - 60_000,
        lastSuccessAt: now - SYNC_CADENCE_MS,
        force: true,
      }),
    ).toBe('another-sync-in-flight')
  })

  it('syncs again once the dedup window has passed', () => {
    expect(
      syncSkipReason({
        ...idle,
        lastSyncStartedAt: now - SYNC_DEDUP_WINDOW_MS,
        lastSuccessAt: now - SYNC_CADENCE_MS,
      }),
    ).toBeNull()
  })

  it('ignores timestamps from the future rather than suppressing protection forever', () => {
    expect(syncSkipReason({ ...idle, lastSuccessAt: now + SYNC_CADENCE_MS })).toBeNull()
    expect(syncSkipReason({ ...idle, lastSyncStartedAt: now + SYNC_DEDUP_WINDOW_MS })).toBeNull()
  })
})
