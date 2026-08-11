import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { recorder, resetVscodeDouble } from '../test/vscodeDouble'
import { collectInventory, installedExtensionsPath } from './inventory'

async function extensionsDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pkgwarden-companion-'))
}

/** Shape of a real `extensions.json` record (RV1, 2026-07-28) rather than a minimal stand-in. */
function fileEntry(id: string, version: string, installedTimestamp = 1_684_081_152_344) {
  return {
    identifier: { id, uuid: '236ff452-49f5-47a4-8928-ab18f5b9c7bf' },
    version,
    location: { $mid: 1, path: `/Users/dev/.vscode/extensions/${id}-${version}`, scheme: 'file' },
    relativeLocation: `${id}-${version}`,
    metadata: { installedTimestamp, updated: false, preRelease: false },
  }
}

beforeEach(() => {
  resetVscodeDouble()
})

describe('installedExtensionsPath', () => {
  it('derives the file from the companion install directory, with no per-editor path', () => {
    expect(installedExtensionsPath('/Users/dev/.cursor/extensions/pkgwarden.companion-0.1.0')).toBe(
      '/Users/dev/.cursor/extensions/extensions.json',
    )
  })
})

describe('collectInventory', () => {
  it("reads the editor's own extensions.json, so an extension the API cannot see still reaches gate", async () => {
    // redhat.java is disabled in this developer's VS Code (RV1): the file lists it, and
    // `vscode.extensions.all` — modelled here by installedExtensions — does not.
    const directory = await extensionsDirectory()
    await writeFile(
      join(directory, 'extensions.json'),
      JSON.stringify([
        fileEntry('redhat.java', '1.45.0'),
        fileEntry('eriklynd.json-tools', '1.0.2'),
        fileEntry('ms-toolsai.jupyter', '2025.1.0', 2),
        fileEntry('ms-toolsai.jupyter', '2025.9.1', 3),
      ]),
    )
    recorder.installedExtensions = [
      { id: 'eriklynd.json-tools', packageJSON: { version: '1.0.2' } },
      { id: 'ms-toolsai.jupyter', packageJSON: { version: '2025.9.1' } },
    ]

    const inventory = await collectInventory(join(directory, 'pkgwarden.companion-0.1.0'))

    expect(inventory).toEqual({
      entries: [
        { extensionId: 'redhat.java', currentVersion: '1.45.0' },
        { extensionId: 'eriklynd.json-tools', currentVersion: '1.0.2' },
        { extensionId: 'ms-toolsai.jupyter', currentVersion: '2025.9.1' },
      ],
      partial: false,
    })
  })

  it('falls back to the enabled extensions and flags the gap when the file is missing', async () => {
    const directory = await extensionsDirectory()
    recorder.installedExtensions = [
      { id: 'EriKlynd.Json-Tools', packageJSON: { version: '1.0.2' } },
      { id: 'vscode.git', packageJSON: {} },
    ]

    const inventory = await collectInventory(join(directory, 'pkgwarden.companion-0.1.0'))

    expect(inventory).toEqual({
      entries: [{ extensionId: 'eriklynd.json-tools', currentVersion: '1.0.2' }],
      partial: true,
    })
  })

  it('falls back when the file is there but unreadable as an inventory', async () => {
    const directory = await extensionsDirectory()
    await writeFile(join(directory, 'extensions.json'), '{ "not": "an array" }')
    recorder.installedExtensions = [{ id: 'redhat.java', packageJSON: { version: '1.45.0' } }]

    const inventory = await collectInventory(join(directory, 'pkgwarden.companion-0.1.0'))

    expect(inventory).toEqual({
      entries: [{ extensionId: 'redhat.java', currentVersion: '1.45.0' }],
      partial: true,
    })
  })
})
