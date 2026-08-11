import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import * as vscode from 'vscode'

import { type ParsedInventory, parseInstalledExtensions } from './inventoryParse'

export const INSTALLED_EXTENSIONS_FILE = 'extensions.json'

/**
 * The companion is installed alongside every other extension, so its own install directory's
 * parent is the editor's extensions directory — no per-editor path table to keep current.
 */
export function installedExtensionsPath(extensionPath: string): string {
  return join(dirname(extensionPath), INSTALLED_EXTENSIONS_FILE)
}

function enabledExtensionsFallback(): ParsedInventory {
  const entries = vscode.extensions.all
    .map((extension) => ({
      extensionId: extension.id.toLowerCase(),
      currentVersion: extension.packageJSON.version,
    }))
    .filter((entry) => typeof entry.currentVersion === 'string')
  return { entries, partial: true }
}

/**
 * Reading the file is what gets disabled extensions into the inventory. When it is missing,
 * unreadable, or shaped in a way we do not recognise, the enabled-only API list keeps the sync
 * running with `partial` set so the status bar can stop promising full coverage.
 */
export async function collectInventory(extensionPath: string): Promise<ParsedInventory> {
  let content: string
  try {
    content = await readFile(installedExtensionsPath(extensionPath), 'utf8')
  } catch {
    return enabledExtensionsFallback()
  }
  const parsed = parseInstalledExtensions(content)
  return parsed.entries.length === 0 ? enabledExtensionsFallback() : parsed
}
