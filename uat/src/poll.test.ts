import { describe, expect, it } from 'vitest'

import { pollFor } from './poll'

const immediateSleep = async (): Promise<void> => undefined

describe('pollFor', () => {
  it('returns as soon as the probe is accepted', async () => {
    let calls = 0
    const outcome = await pollFor(
      () => {
        calls += 1
        return calls
      },
      (value) => value === 3,
      { timeoutMs: 1000, intervalMs: 10, sleep: immediateSleep },
    )
    expect(outcome).toEqual({ ok: true, value: 3, attempts: 3 })
  })

  it('gives up with the last observed value once the budget is spent', async () => {
    const outcome = await pollFor(
      () => 'never',
      () => false,
      { timeoutMs: 30, intervalMs: 10, sleep: immediateSleep },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.value).toBe('never')
    expect(outcome.attempts).toBeGreaterThan(1)
  })

  it('awaits an async probe', async () => {
    const outcome = await pollFor(
      async () => 'ready',
      (value) => value === 'ready',
      { timeoutMs: 100, intervalMs: 10, sleep: immediateSleep },
    )
    expect(outcome.ok).toBe(true)
  })
})
