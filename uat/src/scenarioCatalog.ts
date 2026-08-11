export type CampaignPhase = 1 | 2 | 3

export interface ScenarioSpec {
  id: string
  phase: CampaignPhase
  /** The editor launch this scenario runs in; catalog order is execution order. */
  stage: string
  title: string
  /** The issue #572 checklist line this scenario answers. */
  checklist: string
}

/** Scenarios that need a human at the keyboard; they never run, they print instructions. */
export const MANUAL_STAGE = 'manual'

export const SCENARIO_CATALOG: readonly ScenarioSpec[] = [
  {
    id: 'P1-commands',
    phase: 1,
    stage: 'signed-out',
    title: 'Signed out: the companion contributes its commands',
    checklist: 'Install VSIX in clean profile; status bar signed-out; menu offers only sign-in',
  },
  {
    id: 'P1-no-pins',
    phase: 1,
    stage: 'signed-out',
    title: 'Signed out: no extensions.allowed is written',
    checklist: 'Install VSIX in clean profile; status bar signed-out',
  },
  {
    id: 'P1-signin-sync',
    phase: 1,
    stage: 'core-sync',
    title: 'Sign in triggers an immediate sync that writes the staged pins',
    checklist: 'Sign in (paste token) -> immediate sync -> extensions.allowed written',
  },
  {
    id: 'P1-disabled-inventory',
    phase: 1,
    stage: 'core-sync',
    title: 'A disabled extension still reaches the pin map',
    checklist: 'Disabled extensions appear in the pin map (inventory reads extensions.json)',
  },
  {
    id: 'P1-banner',
    phase: 1,
    stage: 'banner',
    title: 'The managed banner comment survives the replace-write',
    checklist: 'Managed banner comment above extensions.allowed survives the write',
  },
  {
    id: 'P1-stray-comment',
    phase: 1,
    stage: 'banner',
    title: 'An unrelated settings.json comment survives the replace-write',
    checklist: 'Managed banner comment above extensions.allowed survives the write',
  },
  {
    id: 'P1-self-pin-carryover',
    phase: 1,
    stage: 'self-pin',
    title: 'The companion self-pin survives a server response that omits it',
    checklist: 'Companion self-pin survives replace-write when server omits pkgwarden.companion',
  },
  {
    id: 'P2-explicit-install',
    phase: 2,
    stage: 'picker',
    title: 'Explicit publisher.name@version install-check allowed: pin union plus a real install',
    checklist:
      'Explicit publisher.name@version refs; install allowed extension -> pinned + installed',
  },
  {
    id: 'P2-blocked-no-override',
    phase: 2,
    stage: 'picker',
    title: 'A scan_verdict block offers no override modal and installs nothing',
    checklist: 'scan_verdict/known_malware -> blocked, no override path exists (security control)',
  },
  {
    id: 'P2-trusted-publisher',
    phase: 2,
    stage: 'trusted-publisher',
    title: 'A wholesale trusted-publisher allow writes no per-version pin',
    checklist: 'Trusted-publisher wholesale true -> no settings write',
  },
  {
    id: 'P3-auto-rollback',
    phase: 3,
    stage: 'auto-rollback',
    title: 'auto mode rolls the withheld version back to rollback_version',
    checklist:
      'auto: rollback to rollback_version, notification, pin map excludes withheld version',
  },
  {
    id: 'P3-dedup',
    phase: 3,
    stage: 'auto-rollback',
    title: 'A second sync does not re-notify the same withheld version',
    checklist: 'Dedup: re-sync does not re-notify',
  },
  {
    id: 'P3-rv2-pin-holds',
    phase: 3,
    stage: 'rv2',
    title: 'RV2: checkForUpdates does not move an extension past its pin',
    checklist: 'RV2: editor does not auto-update past a pin',
  },
  {
    id: 'P3-shepherd',
    phase: 3,
    stage: 'shepherd',
    title: 'The shepherd advances a rolled-back extension once the verdict clears',
    checklist: 'RV2: shepherd advances rolled-back extension when a newer version clears',
  },
  {
    id: 'P3-shepherd-across-syncs',
    phase: 3,
    stage: 'shepherd',
    title: 'The shepherd still advances after an ordinary sync taken while the version is withheld',
    checklist: 'RV2: shepherd advances rolled-back extension when a newer version clears',
  },
  {
    id: 'P3-notify',
    phase: 3,
    stage: 'notify',
    title: 'notify mode warns and takes no action',
    checklist: 'notify: warning with Remove now / View details; no automatic action',
  },
  {
    id: 'P3-uninstall-fallback',
    phase: 3,
    stage: 'uninstall-fallback',
    title: 'auto mode uninstalls when no version survives',
    checklist: 'auto, no surviving version: uninstall fallback',
  },
  {
    id: 'P3-self-guard',
    phase: 3,
    stage: 'self-guard',
    title: 'A withheld verdict against pkgwarden.companion is never remediated',
    checklist: 'Self-guard: withheld verdict against pkgwarden.companion is never remediated',
  },
  {
    id: 'P3-rv5-pin-dropped',
    phase: 3,
    stage: 'rv5-drop',
    title: 'RV5: the server drops the pin and the sync removes it from extensions.allowed',
    checklist: 'RV5: pin dropped server-side -> installed copy disabled',
  },
  {
    id: 'P3-rv5-disabled',
    phase: 3,
    stage: 'rv5-verify',
    title: 'RV5: after a relaunch the unpinned extension is not running',
    checklist: 'RV5: pin dropped server-side -> installed copy disabled (record if reload needed)',
  },
  {
    id: 'P1-signout-keeps-pins',
    phase: 1,
    stage: 'sign-out',
    title: 'Sign out keeps the pins already in settings',
    checklist: 'Sign out -> signed-out, pins remain',
  },
  {
    id: 'P1-in-flight',
    phase: 1,
    stage: 'in-flight',
    title: 'A second immediate syncNow is held by the in-flight window',
    checklist: 'syncNow works; second immediate attempt held by the 10-min in-flight window',
  },
  {
    id: 'P2-search-flow',
    phase: 2,
    stage: MANUAL_STAGE,
    title: 'Search-as-you-type over the gate catalog',
    checklist: 'Search flow (debounce, trusted-publisher rows)',
  },
  {
    id: 'P2-quarantine-modal',
    phase: 2,
    stage: MANUAL_STAGE,
    title: 'A quarantine block offers a modal override that installs on confirm',
    checklist: 'quarantine/pending_scan -> modal override installs on confirm',
  },
]

export function stageOrder(): string[] {
  const stages: string[] = []
  for (const scenario of SCENARIO_CATALOG) {
    if (scenario.stage !== MANUAL_STAGE && !stages.includes(scenario.stage)) {
      stages.push(scenario.stage)
    }
  }
  return stages
}

export function scenariosForStage(stage: string): ScenarioSpec[] {
  return SCENARIO_CATALOG.filter((scenario) => scenario.stage === stage)
}
