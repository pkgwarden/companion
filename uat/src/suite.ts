import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

import { psqlArgs } from './catalogStaging'
import { EditorStubs } from './host'
import { PickerDriver } from './pickerDriver'
import type { ScenarioResult } from './results'
import { scenariosForStage } from './scenarioCatalog'
import { runStage, type StageContext } from './stages'

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} was not passed into the extension host`)
  }
  return value
}

/**
 * Restaging a verdict from inside the extension host is what lets a scenario measure two
 * different server answers in one editor session, instead of depending on companion state
 * surviving a relaunch of a throwaway profile.
 */
function stageCatalog(sql: string): void {
  const target = {
    container: required('PKGWARDEN_UAT_DB_CONTAINER'),
    user: required('PKGWARDEN_UAT_DB_USER'),
    database: required('PKGWARDEN_UAT_CATALOG_DB'),
  }
  const result = spawnSync('docker', psqlArgs(target, sql), { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`psql failed inside the extension host: ${result.stderr || result.stdout}`)
  }
}

/**
 * The entry point `@vscode/test-electron` loads inside the extension host. It never rejects: a
 * stage that blows up is a stage whose scenarios all failed, and the run should carry on to the
 * next one rather than losing the results collected so far.
 */
export async function run(): Promise<void> {
  const stage = required('PKGWARDEN_UAT_STAGE')
  const resultFile = required('PKGWARDEN_UAT_RESULT_FILE')
  const stubs = new EditorStubs(required('PKGWARDEN_UAT_GATE_TOKEN'))
  stubs.install()
  const picker = new PickerDriver()
  picker.install()
  const context: StageContext = {
    stubs,
    picker,
    gateUrl: required('PKGWARDEN_UAT_GATE_URL'),
    token: required('PKGWARDEN_UAT_GATE_TOKEN'),
    extensionsDir: required('PKGWARDEN_UAT_EXTENSIONS_DIR'),
    settingsPath: required('PKGWARDEN_UAT_SETTINGS_PATH'),
    stageCatalog,
  }
  let results: ScenarioResult[]
  try {
    results = await runStage(stage, context)
  } catch (error) {
    const evidence = `stage aborted: ${error instanceof Error ? error.message : String(error)}`
    results = scenariosForStage(stage).map((scenario) => ({
      id: scenario.id,
      status: 'fail',
      evidence,
    }))
  }
  writeFileSync(resultFile, JSON.stringify(results), 'utf8')
}
