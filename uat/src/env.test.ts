import { describe, expect, it } from 'vitest'

import { DEFAULT_PROFILE_ROOT, HarnessConfigError, LOCAL_GATE_URL, readHarnessEnv } from './env'

const minimal = { PKGWARDEN_UAT_GATE_TOKEN: 'pkgw_gate_token' }

describe('readHarnessEnv', () => {
  it('defaults everything except the token', () => {
    expect(readHarnessEnv(minimal)).toEqual({
      gateUrl: LOCAL_GATE_URL,
      gateToken: 'pkgw_gate_token',
      profileRoot: DEFAULT_PROFILE_ROOT,
      catalogDatabase: {
        container: 'backend-postgres-global-1',
        user: 'postgres',
        database: 'pkgwarden_global',
      },
    })
  })

  it('refuses to run without a token rather than prompting a human for one', () => {
    expect(() => readHarnessEnv({})).toThrow(HarnessConfigError)
  })

  it('refuses a token that is only whitespace', () => {
    expect(() => readHarnessEnv({ PKGWARDEN_UAT_GATE_TOKEN: '   ' })).toThrow(HarnessConfigError)
  })

  it('accepts an explicit loopback gate url', () => {
    const env = readHarnessEnv({ ...minimal, PKGWARDEN_UAT_GATE_URL: 'http://localhost:9006/' })
    expect(env.gateUrl).toBe('http://localhost:9006')
  })

  it('refuses a non-loopback gate url so a stray env var cannot aim the harness at prod', () => {
    expect(() =>
      readHarnessEnv({ ...minimal, PKGWARDEN_UAT_GATE_URL: 'https://index.pkgwarden.com' }),
    ).toThrow(HarnessConfigError)
  })

  it('refuses a profile root long enough to break the editor IPC socket', () => {
    expect(() =>
      readHarnessEnv({ ...minimal, PKGWARDEN_UAT_PROFILE_ROOT: `/tmp/${'d'.repeat(80)}` }),
    ).toThrow(HarnessConfigError)
  })

  it('takes database connection overrides', () => {
    const env = readHarnessEnv({
      ...minimal,
      PKGWARDEN_UAT_DB_CONTAINER: 'other-postgres',
      PKGWARDEN_UAT_DB_USER: 'gate',
      PKGWARDEN_UAT_CATALOG_DB: 'catalog',
    })
    expect(env.catalogDatabase).toEqual({
      container: 'other-postgres',
      user: 'gate',
      database: 'catalog',
    })
  })
})
