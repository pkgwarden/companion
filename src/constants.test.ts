import { describe, expect, it } from 'vitest'

import { COMPANION_EXTENSION_ID, OBSERVED_EDITOR_IDENTITIES } from './constants'

describe('COMPANION_EXTENSION_ID', () => {
  it('is lowercased, because every id comparison happens lowercased', () => {
    expect(COMPANION_EXTENSION_ID).toBe(COMPANION_EXTENSION_ID.toLowerCase())
  })
})

describe('OBSERVED_EDITOR_IDENTITIES', () => {
  it('carries one distinct uri scheme per editor actually launched (RV4)', () => {
    const schemes = OBSERVED_EDITOR_IDENTITIES.map((identity) => identity.uriScheme)

    expect(schemes).toEqual(['vscode', 'cursor'])
    expect(new Set(schemes).size).toBe(schemes.length)
  })
})
