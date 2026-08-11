import { describe, expect, it } from 'vitest'

import { catalogPickItems, explicitRefPickItem, TRUSTED_PUBLISHER_DETAIL } from './catalogItems'
import type { VscodeCatalogItem, VscodeCatalogPage } from './gateClient'

function page(...items: VscodeCatalogItem[]): VscodeCatalogPage {
  return { items, total: items.length, page: 1, limit: 25, hasMore: false }
}

const linterPro: VscodeCatalogItem = {
  extensionId: 'contoso.linter-pro',
  displayName: 'Linter Pro',
  description: 'Lints everything',
  latestVersion: '4.2.1',
  trustedPublisher: false,
}

describe('catalogPickItems', () => {
  it('renders the display name, the id and the latest catalog version', () => {
    expect(catalogPickItems(page(linterPro))).toEqual([
      {
        label: 'Linter Pro',
        description: 'contoso.linter-pro · latest 4.2.1',
        extensionId: 'contoso.linter-pro',
        version: null,
      },
    ])
  })

  it('falls back to the id when the catalog has no display name', () => {
    expect(catalogPickItems(page({ ...linterPro, displayName: null }))[0]?.label).toBe(
      'contoso.linter-pro',
    )
  })

  it('drops the version clause when the catalog has no latest version', () => {
    expect(catalogPickItems(page({ ...linterPro, latestVersion: null }))[0]?.description).toBe(
      'contoso.linter-pro',
    )
  })

  it('marks a trusted publisher, the only policy signal the catalog list carries', () => {
    expect(catalogPickItems(page({ ...linterPro, trustedPublisher: true }))[0]?.detail).toBe(
      TRUSTED_PUBLISHER_DETAIL,
    )
  })

  it('leaves an untrusted publisher undecorated, because policy is checked on selection', () => {
    expect(catalogPickItems(page(linterPro))[0]?.detail).toBeUndefined()
  })

  it('renders an empty page as no items', () => {
    expect(catalogPickItems(page())).toEqual([])
  })
})

describe('explicitRefPickItem', () => {
  it('carries the named version through to the install attempt', () => {
    expect(explicitRefPickItem('contoso.linter-pro', '4.2.1')).toMatchObject({
      label: 'Install contoso.linter-pro@4.2.1',
      extensionId: 'contoso.linter-pro',
      version: '4.2.1',
    })
  })
})
