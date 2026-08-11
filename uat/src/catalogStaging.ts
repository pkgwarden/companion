import type { CatalogDatabaseTarget } from './env'

export type VerdictStatus = 'clean' | 'malicious'

export interface StagedVersion {
  extensionId: string
  version: string
  verdictId: string
}

/** Mirrors the runbook's seed_catalog.sql; the harness only ever flips these rows. */
export const STAGED_CATALOG: readonly StagedVersion[] = [
  { extensionId: 'dbaeumer.vscode-eslint', version: '3.0.27', verdictId: 'uat-vd-eslint-27' },
  { extensionId: 'dbaeumer.vscode-eslint', version: '3.0.29', verdictId: 'uat-vd-eslint-29' },
  { extensionId: 'dbaeumer.vscode-eslint', version: '3.0.31', verdictId: 'uat-vd-eslint-31' },
  { extensionId: 'esbenp.prettier-vscode', version: '12.1.0', verdictId: 'uat-vd-prettier-121' },
  { extensionId: 'esbenp.prettier-vscode', version: '12.2.0', verdictId: 'uat-vd-prettier-122' },
  { extensionId: 'esbenp.prettier-vscode', version: '12.3.0', verdictId: 'uat-vd-prettier-123' },
  { extensionId: 'pkgwarden.companion', version: '0.1.0', verdictId: 'uat-vd-companion-010' },
]

export const HARNESS_TRUST_NOTE = 'pkgwarden UAT harness'

export class UnsafeSqlTokenError extends Error {}

const SAFE_TOKEN = /^[a-z0-9._-]+$/

function safe(token: string): string {
  if (!SAFE_TOKEN.test(token)) {
    throw new UnsafeSqlTokenError(`refusing to interpolate ${JSON.stringify(token)} into SQL`)
  }
  return token
}

export function verdictIdFor(extensionId: string, version: string): string {
  const match = STAGED_CATALOG.find(
    (entry) => entry.extensionId === extensionId && entry.version === version,
  )
  if (match === undefined) {
    throw new Error(`the runbook seed has no verdict row for ${extensionId}@${version}`)
  }
  return match.verdictId
}

export function verdictIdsFor(extensionId: string): string[] {
  return STAGED_CATALOG.filter((entry) => entry.extensionId === extensionId).map(
    (entry) => entry.verdictId,
  )
}

export function setVerdictStatusSql(verdictIds: readonly string[], status: VerdictStatus): string {
  if (verdictIds.length === 0) {
    throw new Error('no verdict ids given; an unfiltered UPDATE would restage the whole catalog')
  }
  const list = verdictIds.map((id) => `'${safe(id)}'`).join(', ')
  const summary = status === 'clean' ? 'UAT seed: clean' : 'UAT seed: withheld test'
  const riskScore = status === 'clean' ? 0 : 95
  return `UPDATE scan_verdicts SET status='${status}', risk_score=${riskScore}, summary='${summary}' WHERE id IN (${list});`
}

/** Marks exactly one seeded version withheld; the stage plans and the stages both need it. */
export function withheldVersionSql(extensionId: string, version: string): string {
  return setVerdictStatusSql([verdictIdFor(extensionId, version)], 'malicious')
}

export function trustPublisherSql(publisher: string): string {
  return `INSERT INTO vscode_trusted_publishers (publisher, note) VALUES ('${safe(publisher)}', '${HARNESS_TRUST_NOTE}') ON CONFLICT DO NOTHING;`
}

/** The baseline the runbook promises to leave behind: every seeded verdict clean, no extra trust. */
export function resetCatalogSql(): string {
  return [
    "UPDATE scan_verdicts SET status='clean', risk_score=0, summary='UAT seed: clean' WHERE id LIKE 'uat-vd-%';",
    `DELETE FROM vscode_trusted_publishers WHERE note = '${HARNESS_TRUST_NOTE}';`,
  ].join(' ')
}

export function psqlArgs(target: CatalogDatabaseTarget, sql: string): string[] {
  return [
    'exec',
    '-i',
    target.container,
    'psql',
    '-U',
    target.user,
    '-d',
    target.database,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ]
}
