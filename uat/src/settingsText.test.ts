import { describe, expect, it } from 'vitest'

import {
  hasLine,
  insertCommentAbove,
  MANAGED_BANNER,
  parseSettings,
  renderSeedSettings,
  STRAY_COMMENT,
  stableFingerprint,
} from './settingsText'

describe('renderSeedSettings', () => {
  it('carries a stray comment that has nothing to do with pkgwarden', () => {
    const text = renderSeedSettings({ 'pkgwarden.apiUrl': 'http://127.0.0.1:8006' })
    expect(hasLine(text, STRAY_COMMENT)).toBe(true)
    expect(parseSettings(text)).toEqual({ 'pkgwarden.apiUrl': 'http://127.0.0.1:8006' })
  })
})

describe('insertCommentAbove', () => {
  it('puts the banner on its own line directly above the key', () => {
    const text = '{\n  "a": 1,\n  "extensions.allowed": {}\n}\n'
    const updated = insertCommentAbove(text, 'extensions.allowed', MANAGED_BANNER)
    expect(updated.split('\n')[2]).toBe(`  ${MANAGED_BANNER}`)
    expect(updated.split('\n')[3]).toBe('  "extensions.allowed": {}')
  })

  it('throws when the key is absent so a silent no-op cannot pass the banner scenario', () => {
    expect(() =>
      insertCommentAbove('{\n  "a": 1\n}\n', 'extensions.allowed', MANAGED_BANNER),
    ).toThrow(/extensions.allowed/)
  })
})

describe('parseSettings', () => {
  it('ignores line comments', () => {
    expect(parseSettings('{\n  // note\n  "a": [1]\n}\n')).toEqual({ a: [1] })
  })

  it('keeps a url containing a double slash intact', () => {
    expect(parseSettings('{\n  "u": "http://127.0.0.1:8006"\n}\n')).toEqual({
      u: 'http://127.0.0.1:8006',
    })
  })

  it('returns an empty object for unreadable content', () => {
    expect(parseSettings('not json')).toEqual({})
  })
})

describe('hasLine', () => {
  it('matches regardless of indentation', () => {
    expect(hasLine('{\n      // hi\n}', '// hi')).toBe(true)
    expect(hasLine('{\n  // hello\n}', '// hi')).toBe(false)
  })
})

describe('stableFingerprint', () => {
  it('is insensitive to key order so a rewritten map still compares equal', () => {
    expect(stableFingerprint({ b: [1], a: true })).toBe(stableFingerprint({ a: true, b: [1] }))
  })

  it('distinguishes different values', () => {
    expect(stableFingerprint({ a: ['1'] })).not.toBe(stableFingerprint({ a: ['2'] }))
  })

  it('renders an absent map as empty', () => {
    expect(stableFingerprint(undefined)).toBe('{}')
  })
})
