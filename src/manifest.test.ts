import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  COMPANION_EXTENSION_ID,
  DEFAULT_GATE_API_URL,
  INSTALL_EXTENSION_COMMAND,
  SIGN_IN_COMMAND,
  SIGN_OUT_COMMAND,
  SYNC_NOW_COMMAND,
} from './constants'

interface Manifest {
  name: string
  publisher: string
  version: string
  activationEvents: string[]
  engines: { vscode: string }
  repository: { type: string; url: string }
  packageManager: string
  contributes: {
    commands: { command: string; title: string }[]
    configuration: { properties: Record<string, { default: unknown; enum?: string[] }> }
  }
  dependencies?: Record<string, string>
  devDependencies: Record<string, string>
  icon?: string
  scripts: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Manifest

const packagingIgnores = readFileSync(new URL('../.vscodeignore', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')

describe('the extension manifest', () => {
  it('publishes under the id the gate backend self-allows', () => {
    expect(`${manifest.publisher}.${manifest.name}`).toBe(COMPANION_EXTENSION_ID)
  })

  it('activates late and only wires things up', () => {
    expect(manifest.activationEvents).toEqual(['onStartupFinished'])
  })

  it('contributes no command that has no implementation yet', () => {
    expect(manifest.contributes.commands.map((entry) => entry.command)).toEqual([
      INSTALL_EXTENSION_COMMAND,
      SIGN_IN_COMMAND,
      SIGN_OUT_COMMAND,
      SYNC_NOW_COMMAND,
    ])
  })

  it('titles the picker command the way the status-bar menu does', () => {
    const installCommand = manifest.contributes.commands.find(
      (entry) => entry.command === INSTALL_EXTENSION_COMMAND,
    )
    expect(installCommand?.title).toBe('Install extension…')
  })

  it('defaults the api url to the deployed gate index', () => {
    expect(manifest.contributes.configuration.properties['pkgwarden.apiUrl']?.default).toBe(
      DEFAULT_GATE_API_URL,
    )
  })

  it('defaults remediation to automatic rollback', () => {
    const remediation = manifest.contributes.configuration.properties['pkgwarden.remediation']
    expect(remediation?.default).toBe('auto')
    expect(remediation?.enum).toEqual(['auto', 'notify'])
  })

  it('ships with zero runtime dependencies', () => {
    expect(manifest.dependencies).toBeUndefined()
  })

  it('requires the vscode release that introduced extensions.allowed', () => {
    expect(manifest.engines.vscode).toBe('^1.96.0')
  })

  it('bumps the package version for mirror republish', () => {
    expect(manifest.version).toBe('0.1.1')
  })

  it('types the api at the engine floor, so no newer api can typecheck its way in', () => {
    expect(manifest.devDependencies['@types/vscode']).toBe(
      `~${manifest.engines.vscode.replace(/^\^/, '')}`,
    )
  })

  it('points the marketplace listing at the public mirror repo', () => {
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'https://github.com/pkgwarden/companion',
    })
  })

  it('pins the package manager so the mirrored public repo can resolve pnpm on its own', () => {
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/)
  })

  it('points the marketplace listing at the packaged icon', () => {
    expect(manifest.icon).toBe('icon.png')
    expect(existsSync(new URL('../icon.png', import.meta.url))).toBe(true)
  })

  it('ships a LICENSE and README so vsce packages a real listing', () => {
    expect(existsSync(new URL('../LICENSE', import.meta.url))).toBe(true)
    expect(existsSync(new URL('../README.md', import.meta.url))).toBe(true)
  })

  it('packages without --skip-license so vsce does not warn on a missing license', () => {
    expect(manifest.scripts.package).not.toContain('--skip-license')
  })
})

describe('the packaged vsix', () => {
  it('leaves the internal publishing runbook out of what users download', () => {
    expect(packagingIgnores).toContain('PUBLISH.md')
  })

  it('leaves the release workflow out of what users download', () => {
    expect(packagingIgnores).toContain('.github/**')
  })

  it('leaves the mirror-generated lockfile out of what users download', () => {
    expect(packagingIgnores).toContain('pnpm-lock.yaml')
  })

  it('keeps the marketplace listing files in', () => {
    for (const listingFile of ['README.md', 'LICENSE', 'icon.png']) {
      expect(packagingIgnores).not.toContain(listingFile)
    }
  })
})
