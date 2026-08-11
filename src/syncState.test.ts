import { describe, expect, it } from 'vitest'

import { InMemoryGlobalState } from '../test/doubles'
import { parseSyncState, SYNC_STATE_KEY, SyncStateStore } from './syncState'

describe('parseSyncState', () => {
  it('starts empty when nothing has been stored yet', () => {
    expect(parseSyncState(undefined)).toEqual({
      lastSyncStartedAt: null,
      lastSuccessAt: null,
      pinnedCount: 0,
      syncClaimId: null,
    })
  })

  it('ignores stored values of the wrong shape instead of trusting them', () => {
    expect(parseSyncState({ lastSuccessAt: 'yesterday', pinnedCount: null, extra: 1 })).toEqual({
      lastSyncStartedAt: null,
      lastSuccessAt: null,
      pinnedCount: 0,
      syncClaimId: null,
    })
  })

  it('reads back what a previous session wrote', () => {
    expect(parseSyncState({ lastSyncStartedAt: 10, lastSuccessAt: 20, pinnedCount: 43 })).toEqual({
      lastSyncStartedAt: 10,
      lastSuccessAt: 20,
      pinnedCount: 43,
      syncClaimId: null,
    })
  })
})

describe('SyncStateStore', () => {
  it('keeps every field under one namespaced key', async () => {
    const globalState = new InMemoryGlobalState()
    const store = new SyncStateStore(globalState)

    await store.merge({ lastSyncStartedAt: 10 })
    await store.merge({ lastSuccessAt: 20, pinnedCount: 43 })

    expect(globalState.keys()).toEqual([SYNC_STATE_KEY])
    expect(store.read()).toEqual({
      lastSyncStartedAt: 10,
      lastSuccessAt: 20,
      pinnedCount: 43,
      syncClaimId: null,
    })
  })

  it('sees what another window recorded, which is what makes dedup work', () => {
    const globalState = new InMemoryGlobalState()
    const otherWindow = new SyncStateStore(globalState)
    const thisWindow = new SyncStateStore(globalState)

    void otherWindow.merge({ lastSyncStartedAt: 99 })

    expect(thisWindow.read().lastSyncStartedAt).toBe(99)
  })
})
