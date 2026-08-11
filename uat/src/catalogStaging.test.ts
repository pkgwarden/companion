import { describe, expect, it } from 'vitest'

import {
  psqlArgs,
  resetCatalogSql,
  STAGED_CATALOG,
  setVerdictStatusSql,
  trustPublisherSql,
  UnsafeSqlTokenError,
  verdictIdFor,
  verdictIdsFor,
} from './catalogStaging'

const target = {
  container: 'backend-postgres-global-1',
  user: 'postgres',
  database: 'pkgwarden_global',
}

describe('STAGED_CATALOG', () => {
  it('matches the runbook seed ids', () => {
    expect(verdictIdFor('dbaeumer.vscode-eslint', '3.0.31')).toBe('uat-vd-eslint-31')
    expect(verdictIdFor('esbenp.prettier-vscode', '12.3.0')).toBe('uat-vd-prettier-123')
    expect(verdictIdFor('pkgwarden.companion', '0.1.0')).toBe('uat-vd-companion-010')
  })

  it('throws for a version the runbook never seeded', () => {
    expect(() => verdictIdFor('dbaeumer.vscode-eslint', '9.9.9')).toThrow(/9\.9\.9/)
  })

  it('lists every seeded version of an extension', () => {
    expect(verdictIdsFor('esbenp.prettier-vscode')).toEqual([
      'uat-vd-prettier-121',
      'uat-vd-prettier-122',
      'uat-vd-prettier-123',
    ])
  })

  it('has no duplicate verdict ids', () => {
    const ids = STAGED_CATALOG.map((entry) => entry.verdictId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('setVerdictStatusSql', () => {
  it('marks the named verdicts withheld', () => {
    expect(setVerdictStatusSql(['uat-vd-eslint-31'], 'malicious')).toContain("status='malicious'")
    expect(setVerdictStatusSql(['uat-vd-eslint-31'], 'malicious')).toContain(
      "id IN ('uat-vd-eslint-31')",
    )
  })

  it('rejects an id that could carry sql', () => {
    expect(() => setVerdictStatusSql(["x'; DROP TABLE scan_verdicts; --"], 'clean')).toThrow(
      UnsafeSqlTokenError,
    )
  })

  it('refuses an empty id list rather than updating every row', () => {
    expect(() => setVerdictStatusSql([], 'malicious')).toThrow(/no verdict ids/)
  })
})

describe('resetCatalogSql', () => {
  it('returns every seeded verdict to clean and drops harness-owned publisher trust', () => {
    const sql = resetCatalogSql()
    expect(sql).toContain("status='clean'")
    expect(sql).toContain("id LIKE 'uat-vd-%'")
    expect(sql).toContain('DELETE FROM vscode_trusted_publishers')
  })
})

describe('trustPublisherSql', () => {
  it('tags the row so the reset only removes rows the harness added', () => {
    expect(trustPublisherSql('esbenp')).toContain("('esbenp'")
    expect(trustPublisherSql('esbenp')).toContain('ON CONFLICT DO NOTHING')
  })

  it('rejects a publisher that could carry sql', () => {
    expect(() => trustPublisherSql("esbenp'")).toThrow(UnsafeSqlTokenError)
  })
})

describe('psqlArgs', () => {
  it('runs the statement inside the postgres container and stops on the first error', () => {
    expect(psqlArgs(target, 'SELECT 1;')).toEqual([
      'exec',
      '-i',
      'backend-postgres-global-1',
      'psql',
      '-U',
      'postgres',
      '-d',
      'pkgwarden_global',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'SELECT 1;',
    ])
  })
})
