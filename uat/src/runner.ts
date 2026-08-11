import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron'

import { psqlArgs, resetCatalogSql } from './catalogStaging'
import { type HarnessEnv, readHarnessEnv } from './env'
import { withInjectedEntries, withoutInjectedEntries } from './inventoryEntries'
import {
  fillMissingResults,
  harnessExitCode,
  renderResultsTable,
  type ScenarioResult,
  summarize,
} from './results'
import { MANUAL_STAGE, SCENARIO_CATALOG, scenariosForStage, stageOrder } from './scenarioCatalog'
import {
  insertCommentAbove,
  MANAGED_BANNER,
  parseSettings,
  renderSeedSettings,
} from './settingsText'
import { planForStage, type StagePlan } from './stagePlan'

/** The versions the campaign starts from: both are real marketplace builds, both are in the seed. */
const BASELINE_EXTENSIONS = ['dbaeumer.vscode-eslint@3.0.31', 'esbenp.prettier-vscode@12.3.0']

const MANUAL_INSTRUCTIONS: Record<string, string> = {
  'P2-search-flow':
    'Run "pkgwarden: Install extension…", type "prettier" and watch the debounced catalog list render, including trusted-publisher rows. The harness drives the picker programmatically, so the rendered list is not machine-checked.',
  'P2-quarantine-modal':
    'Move a catalog version inside the quarantine window (see the runbook), run the picker against it and confirm the modal offers "Install anyway"; pressing it must install. A modal cannot be dismissed programmatically without stubbing away the very dialog under test.',
}

const packageRoot = resolve(__dirname, '..', '..')

interface Profile {
  userDataDir: string
  extensionsDir: string
  settingsPath: string
  developmentPath: string
  suitePath: string
  resultFile: string
}

function makeProfile(env: HarnessEnv): Profile {
  const userDataDir = join(env.profileRoot, 'ud')
  const extensionsDir = join(env.profileRoot, 'ext')
  const developmentPath = join(extensionsDir, '.companion-dev')
  return {
    userDataDir,
    extensionsDir,
    settingsPath: join(userDataDir, 'User', 'settings.json'),
    developmentPath,
    // The suite has to live inside the development folder: the extension host picks the `vscode`
    // API instance by the requiring file's path, and stubs only reach the companion from there.
    suitePath: join(developmentPath, 'uat-suite.cjs'),
    resultFile: join(env.profileRoot, 'stage-result.json'),
  }
}

function stageCatalog(env: HarnessEnv, statements: readonly string[]): void {
  for (const statement of statements) {
    const result = spawnSync('docker', psqlArgs(env.catalogDatabase, statement), {
      encoding: 'utf8',
    })
    if (result.status !== 0) {
      throw new Error(`psql failed: ${result.stderr || result.stdout}`)
    }
  }
}

function applySettings(profile: Profile, values: Record<string, unknown>): void {
  let existing: Record<string, unknown> = {}
  try {
    existing = parseSettings(readFileSync(profile.settingsPath, 'utf8'))
  } catch {
    existing = {}
  }
  writeFileSync(profile.settingsPath, renderSeedSettings({ ...existing, ...values }), 'utf8')
}

function runEditorCli(cliPath: string, profile: Profile, args: readonly string[]): void {
  const result = spawnSync(
    cliPath,
    ['--user-data-dir', profile.userDataDir, '--extensions-dir', profile.extensionsDir, ...args],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`editor cli failed (${args.join(' ')}): ${result.stderr || result.stdout}`)
  }
}

function stageBanner(profile: Profile): void {
  const text = readFileSync(profile.settingsPath, 'utf8')
  writeFileSync(
    profile.settingsPath,
    insertCommentAbove(text, 'extensions.allowed', MANAGED_BANNER),
    'utf8',
  )
}

function rewriteInventory(
  profile: Profile,
  rewrite: (entries: readonly unknown[]) => unknown[],
): void {
  const path = join(profile.extensionsDir, 'extensions.json')
  const entries = JSON.parse(readFileSync(path, 'utf8')) as unknown[]
  writeFileSync(path, JSON.stringify(rewrite(entries)), 'utf8')
}

function prepareProfile(env: HarnessEnv, profile: Profile): void {
  rmSync(env.profileRoot, { recursive: true, force: true })
  mkdirSync(join(profile.userDataDir, 'User'), { recursive: true })
  mkdirSync(join(profile.developmentPath, 'dist'), { recursive: true })
  copyFileSync(join(packageRoot, 'package.json'), join(profile.developmentPath, 'package.json'))
  copyFileSync(
    join(packageRoot, 'dist', 'extension.js'),
    join(profile.developmentPath, 'dist', 'extension.js'),
  )
  copyFileSync(join(__dirname, 'suite.cjs'), profile.suitePath)
}

async function runStageInEditor(
  env: HarnessEnv,
  profile: Profile,
  executablePath: string,
  plan: StagePlan,
): Promise<ScenarioResult[]> {
  rmSync(profile.resultFile, { force: true })
  await runTests({
    vscodeExecutablePath: executablePath,
    extensionDevelopmentPath: profile.developmentPath,
    extensionTestsPath: profile.suitePath,
    launchArgs: [
      '--user-data-dir',
      profile.userDataDir,
      '--extensions-dir',
      profile.extensionsDir,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      ...plan.launchArgs,
    ],
    extensionTestsEnv: {
      PKGWARDEN_UAT_STAGE: plan.stage,
      PKGWARDEN_UAT_RESULT_FILE: profile.resultFile,
      PKGWARDEN_UAT_GATE_URL: env.gateUrl,
      PKGWARDEN_UAT_GATE_TOKEN: env.gateToken,
      PKGWARDEN_UAT_EXTENSIONS_DIR: profile.extensionsDir,
      PKGWARDEN_UAT_SETTINGS_PATH: profile.settingsPath,
      // A stage that has to change a verdict without an editor restart stages it itself.
      PKGWARDEN_UAT_DB_CONTAINER: env.catalogDatabase.container,
      PKGWARDEN_UAT_DB_USER: env.catalogDatabase.user,
      PKGWARDEN_UAT_CATALOG_DB: env.catalogDatabase.database,
    },
  })
  return JSON.parse(readFileSync(profile.resultFile, 'utf8')) as ScenarioResult[]
}

function manualResults(): ScenarioResult[] {
  return scenariosForStage(MANUAL_STAGE).map((scenario) => ({
    id: scenario.id,
    status: 'manual' as const,
    evidence: MANUAL_INSTRUCTIONS[scenario.id] ?? 'run this one by hand',
  }))
}

function writeReport(env: HarnessEnv, results: ScenarioResult[]): string {
  const filled = fillMissingResults(SCENARIO_CATALOG, results)
  const summary = summarize(filled)
  const table = renderResultsTable(SCENARIO_CATALOG, filled)
  const report = [
    '# pkgwarden companion live-editor UAT',
    '',
    `Run at ${new Date().toISOString()} against ${env.gateUrl}.`,
    `${summary.pass} pass, ${summary.fail} fail, ${summary.manual} manual, ${summary.notRun} not run.`,
    '',
    table,
    '',
  ].join('\n')
  const directory = join(packageRoot, 'uat', 'results')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'latest.md'), report, 'utf8')
  writeFileSync(join(directory, 'latest.json'), JSON.stringify(filled, null, 2), 'utf8')
  return report
}

async function main(): Promise<void> {
  const env = readHarnessEnv(process.env)
  const profile = makeProfile(env)
  const executablePath = await downloadAndUnzipVSCode('stable')
  const [cliPath] = resolveCliArgsFromVSCodeExecutablePath(executablePath)
  if (cliPath === undefined) {
    throw new Error('could not resolve the editor cli path')
  }
  prepareProfile(env, profile)
  applySettings(profile, {})
  for (const reference of BASELINE_EXTENSIONS) {
    runEditorCli(cliPath, profile, ['--install-extension', reference, '--force'])
  }

  const results: ScenarioResult[] = [...manualResults()]
  try {
    for (const stage of stageOrder()) {
      const plan = planForStage(stage)
      if (plan === undefined) {
        throw new Error(`no plan for stage ${stage}`)
      }
      const startedAt = Date.now()
      process.stdout.write(`\n=== stage ${stage} ===\n`)
      stageCatalog(env, plan.sql)
      applySettings(profile, plan.settings)
      for (const reference of plan.install) {
        runEditorCli(cliPath, profile, ['--install-extension', reference, '--force'])
      }
      if (plan.stageBanner) {
        stageBanner(profile)
      }
      if (plan.injectInventory.length > 0) {
        rewriteInventory(profile, (entries) =>
          withInjectedEntries(entries, plan.injectInventory, profile.extensionsDir),
        )
      }
      try {
        results.push(...(await runStageInEditor(env, profile, executablePath, plan)))
      } finally {
        if (plan.injectInventory.length > 0) {
          rewriteInventory(profile, (entries) =>
            withoutInjectedEntries(entries, plan.injectInventory),
          )
        }
      }
      process.stdout.write(
        `--- stage ${stage} took ${Math.round((Date.now() - startedAt) / 1000)}s\n`,
      )
    }
  } finally {
    stageCatalog(env, [resetCatalogSql()])
  }

  const report = writeReport(env, results)
  process.stdout.write(`\n${report}\n`)
  process.stdout.write(`results written to ${join(packageRoot, 'uat', 'results')}\n`)
  process.exitCode = harnessExitCode(summarize(fillMissingResults(SCENARIO_CATALOG, results)))
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
