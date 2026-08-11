import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CATALOG_SEARCH_DEBOUNCE_MS, Debouncer } from './debounce'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Debouncer', () => {
  it('runs the action once the delay has passed', () => {
    const action = vi.fn()
    new Debouncer(10).schedule(action)

    vi.advanceTimersByTime(10)

    expect(action).toHaveBeenCalledTimes(1)
  })

  it('does not run the action before the delay has passed', () => {
    const action = vi.fn()
    new Debouncer(10).schedule(action)

    vi.advanceTimersByTime(9)

    expect(action).not.toHaveBeenCalled()
  })

  it('collapses a burst of keystrokes into the last one', () => {
    const debouncer = new Debouncer(10)
    const first = vi.fn()
    const last = vi.fn()

    debouncer.schedule(first)
    vi.advanceTimersByTime(9)
    debouncer.schedule(last)
    vi.advanceTimersByTime(10)

    expect(first).not.toHaveBeenCalled()
    expect(last).toHaveBeenCalledTimes(1)
  })

  it('drops a pending action when cancelled', () => {
    const debouncer = new Debouncer(10)
    const action = vi.fn()

    debouncer.schedule(action)
    debouncer.cancel()
    vi.advanceTimersByTime(10)

    expect(action).not.toHaveBeenCalled()
  })

  it('debounces catalog searches slowly enough to be worth doing', () => {
    expect(CATALOG_SEARCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(150)
  })
})
