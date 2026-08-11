import { describe, expect, it } from 'vitest'

import {
  fillMissingResults,
  harnessExitCode,
  renderResultsTable,
  type ScenarioResult,
  summarize,
} from './results'
import type { ScenarioSpec } from './scenarioCatalog'

const catalog: readonly ScenarioSpec[] = [
  { id: 'A1', phase: 1, stage: 'first', title: 'signed out', checklist: 'status bar signed-out' },
  { id: 'A2', phase: 1, stage: 'first', title: 'pins written', checklist: 'extensions.allowed' },
  { id: 'M1', phase: 2, stage: 'manual', title: 'modal override', checklist: 'confirm modal' },
]

const passed: ScenarioResult = { id: 'A1', status: 'pass', evidence: 'no pins on disk' }
const failed: ScenarioResult = { id: 'A2', status: 'fail', evidence: 'key missing' }
const manual: ScenarioResult = { id: 'M1', status: 'manual', evidence: 'click Install anyway' }

describe('fillMissingResults', () => {
  it('marks catalog scenarios the run never reached as not-run', () => {
    expect(fillMissingResults(catalog, [passed])).toEqual([
      passed,
      { id: 'A2', status: 'not-run', evidence: 'stage did not report a result' },
      { id: 'M1', status: 'not-run', evidence: 'stage did not report a result' },
    ])
  })

  it('keeps catalog order regardless of the order results arrived in', () => {
    expect(fillMissingResults(catalog, [manual, failed, passed]).map((r) => r.id)).toEqual([
      'A1',
      'A2',
      'M1',
    ])
  })
})

describe('summarize', () => {
  it('counts every status', () => {
    expect(summarize(fillMissingResults(catalog, [passed, failed, manual]))).toEqual({
      total: 3,
      pass: 1,
      fail: 1,
      manual: 1,
      notRun: 0,
    })
  })
})

describe('harnessExitCode', () => {
  it('is zero when a product bug was found: a FAIL is a result, not a harness error', () => {
    expect(harnessExitCode(summarize(fillMissingResults(catalog, [passed, failed, manual])))).toBe(
      0,
    )
  })

  it('is non-zero when a scenario never ran, because that is a harness error', () => {
    expect(harnessExitCode(summarize(fillMissingResults(catalog, [passed])))).toBe(1)
  })
})

describe('renderResultsTable', () => {
  it('renders one markdown row per scenario with its status and evidence', () => {
    const table = renderResultsTable(catalog, fillMissingResults(catalog, [passed, failed, manual]))
    expect(table).toContain('| A1 | 1 | signed out | PASS | no pins on disk |')
    expect(table).toContain('| A2 | 1 | pins written | FAIL | key missing |')
    expect(table).toContain('| M1 | 2 | modal override | MANUAL | click Install anyway |')
  })

  it('escapes pipes in evidence so one row cannot break the table', () => {
    const table = renderResultsTable(catalog, [{ id: 'A1', status: 'pass', evidence: 'a | b' }])
    expect(table).toContain('a \\| b')
  })
})
