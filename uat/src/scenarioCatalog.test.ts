import { describe, expect, it } from 'vitest'

import { MANUAL_STAGE, SCENARIO_CATALOG, scenariosForStage, stageOrder } from './scenarioCatalog'

describe('SCENARIO_CATALOG', () => {
  it('has unique scenario ids', () => {
    const ids = SCENARIO_CATALOG.map((scenario) => scenario.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers all three phases of the campaign', () => {
    expect(new Set(SCENARIO_CATALOG.map((scenario) => scenario.phase))).toEqual(new Set([1, 2, 3]))
  })

  it('names the issue checklist line each scenario answers', () => {
    expect(SCENARIO_CATALOG.every((scenario) => scenario.checklist.length > 0)).toBe(true)
  })
})

describe('stageOrder', () => {
  it('lists automated stages in catalog order and excludes the manual bucket', () => {
    const stages = stageOrder()
    expect(stages).not.toContain(MANUAL_STAGE)
    expect(new Set(stages).size).toBe(stages.length)
    expect(stages[0]).toBe(SCENARIO_CATALOG[0]?.stage)
  })

  it('runs the in-flight scenario last, since it leaves a poisoned sync window behind', () => {
    expect(stageOrder().at(-1)).toBe('in-flight')
  })
})

describe('scenariosForStage', () => {
  it('returns the scenarios of one stage', () => {
    const stage = stageOrder()[0] as string
    expect(scenariosForStage(stage).every((scenario) => scenario.stage === stage)).toBe(true)
    expect(scenariosForStage(stage).length).toBeGreaterThan(0)
  })

  it('returns nothing for an unknown stage', () => {
    expect(scenariosForStage('nope')).toEqual([])
  })
})
