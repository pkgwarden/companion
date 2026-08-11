import { describe, expect, it } from 'vitest'

import { withInjectedEntries, withoutInjectedEntries } from './inventoryEntries'

const existing = [
  { identifier: { id: 'dbaeumer.vscode-eslint' }, version: '3.0.31', metadata: {} },
] as unknown[]

describe('withInjectedEntries', () => {
  it('appends an entry the editor never installed so gate sees it in the inventory', () => {
    const entries = withInjectedEntries(existing, ['pkgwarden.companion@0.1.0'], '/tmp/ext')
    expect(entries).toHaveLength(2)
    expect(entries[1]).toMatchObject({
      identifier: { id: 'pkgwarden.companion' },
      version: '0.1.0',
      relativeLocation: 'pkgwarden.companion',
    })
  })

  it('leaves the list alone when there is nothing to inject', () => {
    expect(withInjectedEntries(existing, [], '/tmp/ext')).toEqual(existing)
  })

  it('refuses a reference without a version rather than inventing one', () => {
    expect(() => withInjectedEntries(existing, ['pkgwarden.companion'], '/tmp/ext')).toThrow(
      /pkgwarden.companion/,
    )
  })
})

describe('withoutInjectedEntries', () => {
  it('drops only the injected ids, keeping whatever the stage installed meanwhile', () => {
    const injected = withInjectedEntries(existing, ['pkgwarden.companion@0.1.0'], '/tmp/ext')
    const installedDuringStage = [
      ...injected,
      { identifier: { id: 'esbenp.prettier-vscode' }, version: '12.1.0' },
    ]
    expect(withoutInjectedEntries(installedDuringStage, ['pkgwarden.companion@0.1.0'])).toEqual([
      existing[0],
      { identifier: { id: 'esbenp.prettier-vscode' }, version: '12.1.0' },
    ])
  })

  it('matches ids case-insensitively, as the editor writes them', () => {
    const entries = [{ identifier: { id: 'Pkgwarden.Companion' }, version: '0.1.0' }]
    expect(withoutInjectedEntries(entries, ['pkgwarden.companion@0.1.0'])).toEqual([])
  })
})
