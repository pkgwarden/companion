import {
  resetCatalogSql,
  setVerdictStatusSql,
  trustPublisherSql,
  verdictIdsFor,
  withheldVersionSql,
} from './catalogStaging'
import { LOCAL_GATE_URL } from './env'

export const ESLINT_ID = 'dbaeumer.vscode-eslint'
export const PRETTIER_ID = 'esbenp.prettier-vscode'
export const COMPANION_ID = 'pkgwarden.companion'

export interface StagePlan {
  stage: string
  /** Applied in order before the editor launches; every plan resets to the clean baseline first. */
  sql: string[]
  /** Merged into the profile's settings.json before launch, never after activation. */
  settings: Record<string, unknown>
  /** `id@version` refs installed through the editor CLI before launch. */
  install: string[]
  /**
   * `id@version` rows appended to the editor's extensions.json so gate sees them as installed.
   * Removed again after the stage: a row pointing at a directory the editor never installed
   * stops the companion from loading on the next launch.
   */
  injectInventory: string[]
  /** Writes the managed banner above `extensions.allowed` before the editor starts. */
  stageBanner: boolean
  launchArgs: string[]
}

const BASE_SETTINGS: Record<string, unknown> = {
  'pkgwarden.apiUrl': LOCAL_GATE_URL,
  'pkgwarden.remediation': 'auto',
  'extensions.autoUpdate': false,
}

function plan(stage: string, overrides: Partial<Omit<StagePlan, 'stage'>> = {}): StagePlan {
  return {
    stage,
    sql: [resetCatalogSql(), ...(overrides.sql ?? [])],
    settings: { ...BASE_SETTINGS, ...overrides.settings },
    install: overrides.install ?? [],
    injectInventory: overrides.injectInventory ?? [],
    stageBanner: overrides.stageBanner ?? false,
    launchArgs: overrides.launchArgs ?? [],
  }
}

/**
 * Deliberately not what gate serves, so a sync that writes nothing cannot pass the banner
 * scenario. Wholesale `true` keeps every extension — the companion included — enabled meanwhile.
 */
export const PERMISSIVE_PLACEHOLDER_PINS: Record<string, boolean> = {
  [ESLINT_ID]: true,
  [PRETTIER_ID]: true,
  [COMPANION_ID]: true,
}

const allVersionsWithheld = (extensionId: string): string =>
  setVerdictStatusSql(verdictIdsFor(extensionId), 'malicious')

/**
 * One entry per automated stage, in the order the campaign runs them. Each stage is a separate
 * editor launch sharing one profile, so settings and installed extensions carry forward as they
 * would for a user across restarts. Companion state (the stored token, the remediation dedup
 * set, shepherd tracking) does not: the test profile's storage is in-memory, so every stage
 * signs in again and no scenario may depend on that state surviving a relaunch.
 */
export const STAGE_PLANS: readonly StagePlan[] = [
  plan('signed-out'),
  // The disabled extension is the whole point: it is absent from vscode.extensions.all but must
  // still reach gate, which only happens if the inventory came from extensions.json.
  plan('core-sync', { launchArgs: ['--disable-extension', PRETTIER_ID] }),
  plan('banner', {
    stageBanner: true,
    settings: { 'extensions.allowed': PERMISSIVE_PLACEHOLDER_PINS },
  }),
  plan('self-pin', { sql: [withheldVersionSql(COMPANION_ID, '0.1.0')] }),
  plan('picker', { sql: [withheldVersionSql(ESLINT_ID, '3.0.27')] }),
  plan('trusted-publisher', { sql: [trustPublisherSql('esbenp')] }),
  plan('auto-rollback', {
    sql: [withheldVersionSql(ESLINT_ID, '3.0.31')],
    install: [`${ESLINT_ID}@3.0.31`],
  }),
  plan('rv2', {
    sql: [withheldVersionSql(ESLINT_ID, '3.0.31')],
    settings: { 'extensions.autoUpdate': true },
  }),
  // Self-contained: it rolls 3.0.31 back and then advances again in the same session, so it never
  // depends on shepherd tracking surviving a relaunch. The wholesale pin lets the editor CLI
  // install 3.0.31 while the previous stage's narrower pin map is still in settings.
  plan('shepherd', {
    sql: [withheldVersionSql(ESLINT_ID, '3.0.31')],
    settings: { 'extensions.allowed': PERMISSIVE_PLACEHOLDER_PINS },
    install: [`${ESLINT_ID}@3.0.31`, `${PRETTIER_ID}@12.3.0`],
  }),
  plan('notify', {
    sql: [withheldVersionSql(PRETTIER_ID, '12.3.0')],
    settings: { 'pkgwarden.remediation': 'notify' },
    install: [`${PRETTIER_ID}@12.3.0`],
  }),
  plan('uninstall-fallback', {
    sql: [allVersionsWithheld(PRETTIER_ID)],
    install: [`${PRETTIER_ID}@12.2.0`],
  }),
  // The companion runs from a development folder, so it is not in extensions.json on its own;
  // the injected row is what puts it into the inventory gate answers.
  plan('self-guard', {
    sql: [withheldVersionSql(COMPANION_ID, '0.1.0')],
    injectInventory: [`${COMPANION_ID}@0.1.0`],
  }),
  plan('rv5-drop', {
    sql: [allVersionsWithheld(ESLINT_ID)],
    settings: { 'pkgwarden.remediation': 'notify' },
  }),
  plan('rv5-verify', {
    sql: [allVersionsWithheld(ESLINT_ID)],
    settings: { 'pkgwarden.remediation': 'notify' },
  }),
  plan('sign-out'),
  plan('in-flight'),
]

export function planForStage(stage: string): StagePlan | undefined {
  return STAGE_PLANS.find((candidate) => candidate.stage === stage)
}
