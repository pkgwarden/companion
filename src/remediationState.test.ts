import { describe, expect, it, vi } from 'vitest'

import {
  ControllableGlobalState,
  DiscardingGlobalState,
  InMemoryGlobalState,
} from '../test/doubles'
import {
  parseRemediationState,
  REMEDIATION_STATE_KEY,
  RemediationStateStore,
} from './remediationState'

describe('parseRemediationState', () => {
  it('defaults to empty lists when nothing is stored yet', () => {
    expect(parseRemediationState(undefined)).toEqual({
      handledKeys: [],
      shepherded: [],
    })
  })

  it('ignores malformed entries in stored lists', () => {
    expect(
      parseRemediationState({
        handledKeys: ['contoso.linter-pro@4.2.1', 42, ''],
        shepherded: [
          null,
          { extensionId: '', rolledBackTo: '4.1.9' },
          { extensionId: 'Contoso.Linter-Pro', rolledBackTo: '4.1.9' },
          { extensionId: 'redhat.java', rolledBackTo: 7 },
        ],
      }),
    ).toEqual({
      handledKeys: ['contoso.linter-pro@4.2.1'],
      shepherded: [
        { extensionId: 'contoso.linter-pro', rolledBackTo: '4.1.9' },
        { extensionId: 'redhat.java', rolledBackTo: null },
      ],
    })
  })

  it('ignores stored lists that are not lists at all', () => {
    expect(parseRemediationState({ handledKeys: 'garbage', shepherded: 'garbage' })).toEqual({
      handledKeys: [],
      shepherded: [],
    })
  })

  it('reads a pre-#575 state entry as tracking with no recorded rollback target', () => {
    expect(
      parseRemediationState({
        handledKeys: [],
        shepherdedExtensionIds: [null, 'Contoso.Linter-Pro'],
      }),
    ).toEqual({
      handledKeys: [],
      shepherded: [{ extensionId: 'contoso.linter-pro', rolledBackTo: null }],
    })
  })
})

describe('RemediationStateStore', () => {
  it('persists handled keys and shepherd tracking under one globalState key', async () => {
    const globalState = new InMemoryGlobalState()
    const store = new RemediationStateStore(globalState)

    await store.markHandled('contoso.linter-pro@4.2.1')
    await store.trackShepherd('Contoso.Linter-Pro', '4.1.9')

    expect(globalState.get(REMEDIATION_STATE_KEY)).toEqual({
      handledKeys: ['contoso.linter-pro@4.2.1'],
      shepherded: [{ extensionId: 'contoso.linter-pro', rolledBackTo: '4.1.9' }],
    })
  })

  it('deduplicates handled keys and shepherd ids on merge', async () => {
    const store = new RemediationStateStore(new InMemoryGlobalState())

    await store.markHandled('contoso.linter-pro@4.2.1')
    await store.markHandled('contoso.linter-pro@4.2.1')
    await store.trackShepherd('contoso.linter-pro', '4.1.9')
    await store.trackShepherd('contoso.linter-pro', '4.1.9')

    expect(store.read()).toEqual({
      handledKeys: ['contoso.linter-pro@4.2.1'],
      shepherded: [{ extensionId: 'contoso.linter-pro', rolledBackTo: '4.1.9' }],
    })
  })

  it('replaces the rollback target when the same id is rolled back again', async () => {
    const store = new RemediationStateStore(new InMemoryGlobalState())
    await store.trackShepherd('contoso.linter-pro', '4.1.9')

    await store.trackShepherd('contoso.linter-pro', '4.1.8')

    expect(store.shepherdTracking()).toEqual(new Map([['contoso.linter-pro', '4.1.8']]))
  })

  it('exposes shepherd tracking as an id-to-rollback-target map', async () => {
    const store = new RemediationStateStore(new InMemoryGlobalState())
    await store.trackShepherd('contoso.linter-pro', '4.1.9')
    await store.trackShepherd('redhat.java', null)

    expect(store.shepherdTracking()).toEqual(
      new Map([
        ['contoso.linter-pro', '4.1.9'],
        ['redhat.java', null],
      ]),
    )
  })

  it('drops shepherd tracking without touching handled keys', async () => {
    const store = new RemediationStateStore(new InMemoryGlobalState())
    await store.markHandled('contoso.linter-pro@4.2.1')
    await store.trackShepherd('contoso.linter-pro', '4.1.9')

    await store.dropShepherd('contoso.linter-pro', '4.1.9')

    expect(store.read()).toEqual({
      handledKeys: ['contoso.linter-pro@4.2.1'],
      shepherded: [],
    })
  })

  it('leaves a fresher rollback target alone when the drop was decided against an older one', async () => {
    const store = new RemediationStateStore(new InMemoryGlobalState())
    await store.trackShepherd('contoso.linter-pro', '4.1.8')

    await store.dropShepherd('contoso.linter-pro', '4.1.9')

    expect(store.shepherdTracking()).toEqual(new Map([['contoso.linter-pro', '4.1.8']]))
  })

  it('drops a legacy entry whose rollback target was never recorded', async () => {
    const store = new RemediationStateStore(new InMemoryGlobalState())
    await store.trackShepherd('contoso.linter-pro', null)

    await store.dropShepherd('contoso.linter-pro', null)

    expect(store.shepherdTracking().size).toBe(0)
  })

  it('reports whether the rollback target actually reached globalState', async () => {
    expect(
      await new RemediationStateStore(new InMemoryGlobalState()).trackShepherd(
        'contoso.linter-pro',
        '4.1.9',
      ),
    ).toBe(true)
    expect(
      await new RemediationStateStore(new DiscardingGlobalState()).trackShepherd(
        'contoso.linter-pro',
        '4.1.9',
      ),
    ).toBe(false)
  })

  it('preserves concurrent handled keys written from two windows on shared globalState', async () => {
    const globalState = new ControllableGlobalState(2)
    const windowA = new RemediationStateStore(globalState)
    const windowB = new RemediationStateStore(globalState)

    const markA = windowA.markHandled('contoso.linter-pro@4.2.1')
    const markB = windowB.markHandled('redhat.java@1.45.0')
    await vi.waitUntil(() => globalState.pendingUpdateCount() === 2)
    globalState.releaseUpdates(2)
    await Promise.all([markA, markB])

    expect(globalState.get(REMEDIATION_STATE_KEY)).toEqual({
      handledKeys: expect.arrayContaining(['contoso.linter-pro@4.2.1', 'redhat.java@1.45.0']),
      shepherded: [],
    })
    expect(
      (globalState.get<{ handledKeys: string[] }>(REMEDIATION_STATE_KEY)?.handledKeys ?? []).length,
    ).toBe(2)
  })
})
