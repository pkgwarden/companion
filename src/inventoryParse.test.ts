import { describe, expect, it } from 'vitest'

import { parseInstalledExtensions } from './inventoryParse'

interface FileEntryOverrides {
  id: string
  version: string
  installedTimestamp?: number
}

/** Shape observed in real `extensions.json` files (RV1, 2026-07-28). */
function fileEntry({ id, version, installedTimestamp = 1_684_081_152_344 }: FileEntryOverrides) {
  return {
    identifier: { id, uuid: '236ff452-49f5-47a4-8928-ab18f5b9c7bf' },
    version,
    location: { $mid: 1, path: `/Users/dev/.vscode/extensions/${id}-${version}`, scheme: 'file' },
    relativeLocation: `${id}-${version}`,
    metadata: { installedTimestamp, updated: false, preRelease: false },
  }
}

function fileContent(entries: unknown[]): string {
  return JSON.stringify(entries)
}

describe('parseInstalledExtensions', () => {
  it('includes extensions the editor has disabled, which vscode.extensions.all omits', () => {
    // redhat.java is disabled in this developer's VS Code (RV1) and still listed in the file.
    const content = fileContent([
      fileEntry({ id: 'eriklynd.json-tools', version: '1.0.2' }),
      fileEntry({ id: 'redhat.java', version: '1.45.0' }),
    ])

    expect(parseInstalledExtensions(content)).toEqual({
      entries: [
        { extensionId: 'eriklynd.json-tools', currentVersion: '1.0.2' },
        { extensionId: 'redhat.java', currentVersion: '1.45.0' },
      ],
      partial: false,
    })
  })

  it('lowercases ids before they reach gate', () => {
    const content = fileContent([fileEntry({ id: 'RedHat.Java', version: '1.45.0' })])

    expect(parseInstalledExtensions(content).entries).toEqual([
      { extensionId: 'redhat.java', currentVersion: '1.45.0' },
    ])
  })

  it('keeps only the newest install when an update left the previous copy behind', () => {
    // Observed in RV1: ms-toolsai.jupyter had 8 entries, one per update.
    const content = fileContent([
      fileEntry({ id: 'ms-toolsai.jupyter', version: '2024.3.1', installedTimestamp: 1 }),
      fileEntry({ id: 'ms-toolsai.jupyter', version: '2025.9.1', installedTimestamp: 3 }),
      fileEntry({ id: 'ms-toolsai.jupyter', version: '2025.1.0', installedTimestamp: 2 }),
    ])

    expect(parseInstalledExtensions(content)).toEqual({
      entries: [{ extensionId: 'ms-toolsai.jupyter', currentVersion: '2025.9.1' }],
      partial: false,
    })
  })

  it('flags a partial inventory when the file is not the array the editor writes', () => {
    expect(parseInstalledExtensions('{ "extensions": [] }')).toEqual({ entries: [], partial: true })
    expect(parseInstalledExtensions('not json at all')).toEqual({ entries: [], partial: true })
  })

  it('keeps the usable entries but flags a partial inventory when one is malformed', () => {
    const content = fileContent([
      fileEntry({ id: 'eriklynd.json-tools', version: '1.0.2' }),
      { identifier: { id: 'broken.entry' } },
      'nonsense',
    ])

    expect(parseInstalledExtensions(content)).toEqual({
      entries: [{ extensionId: 'eriklynd.json-tools', currentVersion: '1.0.2' }],
      partial: true,
    })
  })

  it('treats an empty array as a complete, empty inventory', () => {
    expect(parseInstalledExtensions('[]')).toEqual({ entries: [], partial: false })
  })
})
