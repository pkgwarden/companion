import { describe, expect, it } from 'vitest'

import { setVerdictStatusSql, UnsafeSqlTokenError } from './catalogStaging'
import { LOCAL_GATE_URL } from './env'
import { stageOrder } from './scenarioCatalog'
import { PERMISSIVE_PLACEHOLDER_PINS, planForStage, STAGE_PLANS } from './stagePlan'

describe('STAGE_PLANS', () => {
  it('covers every automated stage exactly once, in catalog order', () => {
    expect(STAGE_PLANS.map((plan) => plan.stage)).toEqual(stageOrder())
  })

  it('never leaves the catalog staged: every plan starts from the clean baseline', () => {
    expect(STAGE_PLANS.every((plan) => plan.sql[0]?.includes("status='clean'"))).toBe(true)
  })

  it('builds only SQL the safe-token guard accepts', () => {
    for (const plan of STAGE_PLANS) {
      for (const statement of plan.sql) {
        expect(statement).not.toMatch(/;\s*DROP/i)
      }
    }
    expect(() => setVerdictStatusSql(["uat-vd-x'; DROP TABLE scan_verdicts; --"], 'clean')).toThrow(
      UnsafeSqlTokenError,
    )
  })

  it('never leaves a scenario depending on companion state surviving a relaunch', () => {
    const shepherd = planForStage('shepherd')
    expect(shepherd?.install).toEqual([
      'dbaeumer.vscode-eslint@3.0.31',
      'esbenp.prettier-vscode@12.3.0',
    ])
    expect(shepherd?.sql.at(-1)).toContain("status='malicious'")
  })

  it('stages a pin map gate never serves wherever a scenario has to prove a write happened', () => {
    for (const stage of ['banner', 'shepherd']) {
      expect(planForStage(stage)?.settings['extensions.allowed']).toEqual(
        PERMISSIVE_PLACEHOLDER_PINS,
      )
    }
    expect(Object.values(PERMISSIVE_PLACEHOLDER_PINS)).not.toContain(false)
    expect(PERMISSIVE_PLACEHOLDER_PINS['pkgwarden.companion']).toBe(true)
  })

  it('pins the local gate url in every stage that touches settings', () => {
    for (const plan of STAGE_PLANS) {
      expect(plan.settings['pkgwarden.apiUrl']).toBe(LOCAL_GATE_URL)
    }
  })

  it('keeps auto-update on only for the RV2 stage, which exists to prove a pin outranks it', () => {
    const autoUpdateStages = STAGE_PLANS.filter(
      (plan) => plan.settings['extensions.autoUpdate'] === true,
    ).map((plan) => plan.stage)
    expect(autoUpdateStages).toEqual(['rv2'])
  })

  it('stages the banner only for the banner stage, and after the first sync has written pins', () => {
    const staging = STAGE_PLANS.filter((plan) => plan.stageBanner).map((plan) => plan.stage)
    expect(staging).toEqual(['banner'])
    expect(STAGE_PLANS.findIndex((plan) => plan.stage === 'banner')).toBeGreaterThan(
      STAGE_PLANS.findIndex((plan) => plan.stage === 'core-sync'),
    )
  })

  it('injects the companion into the inventory only for the self-guard stage', () => {
    const injecting = STAGE_PLANS.filter((plan) => plan.injectInventory.length > 0)
    expect(injecting.map((plan) => plan.stage)).toEqual(['self-guard'])
    expect(injecting[0]?.injectInventory).toEqual(['pkgwarden.companion@0.1.0'])
  })
})

describe('planForStage', () => {
  it('finds a stage by name', () => {
    expect(planForStage('signed-out')?.stage).toBe('signed-out')
  })

  it('returns undefined for an unknown stage', () => {
    expect(planForStage('nope')).toBeUndefined()
  })
})
