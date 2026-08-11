import type { ScenarioSpec } from './scenarioCatalog'

export type ScenarioStatus = 'pass' | 'fail' | 'manual' | 'not-run'

export interface ScenarioResult {
  id: string
  status: ScenarioStatus
  evidence: string
}

export interface ScenarioSummary {
  total: number
  pass: number
  fail: number
  manual: number
  notRun: number
}

const NOT_RUN_EVIDENCE = 'stage did not report a result'

export function fillMissingResults(
  catalog: readonly ScenarioSpec[],
  results: readonly ScenarioResult[],
): ScenarioResult[] {
  return catalog.map(
    (scenario) =>
      results.find((result) => result.id === scenario.id) ?? {
        id: scenario.id,
        status: 'not-run',
        evidence: NOT_RUN_EVIDENCE,
      },
  )
}

export function summarize(results: readonly ScenarioResult[]): ScenarioSummary {
  const count = (status: ScenarioStatus): number =>
    results.filter((result) => result.status === status).length
  return {
    total: results.length,
    pass: count('pass'),
    fail: count('fail'),
    manual: count('manual'),
    notRun: count('not-run'),
  }
}

/**
 * A FAIL is the harness working: it found a product bug and said so. Only a scenario that never
 * produced a verdict means the harness itself did not do its job.
 */
export function harnessExitCode(summary: ScenarioSummary): number {
  return summary.notRun > 0 ? 1 : 0
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function renderResultsTable(
  catalog: readonly ScenarioSpec[],
  results: readonly ScenarioResult[],
): string {
  const byId = new Map(catalog.map((scenario) => [scenario.id, scenario]))
  const rows = results.map((result) => {
    const scenario = byId.get(result.id)
    return `| ${result.id} | ${scenario?.phase ?? '?'} | ${cell(scenario?.title ?? '')} | ${result.status.toUpperCase()} | ${cell(result.evidence)} |`
  })
  return [
    '| Scenario | Phase | What it proves | Result | Evidence |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}
