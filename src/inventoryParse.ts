import type { VscodeInventoryEntry } from './gateClient'

export interface ParsedInventory {
  entries: VscodeInventoryEntry[]
  /** Something in the inventory could not be read, so gate is seeing an incomplete picture. */
  partial: boolean
}

interface InstalledExtensionRecord {
  extensionId: string
  currentVersion: string
  installedTimestamp: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readEntry(value: unknown): InstalledExtensionRecord | null {
  const entry = asRecord(value)
  const identifier = entry === null ? null : asRecord(entry.identifier)
  const metadata = entry === null ? null : asRecord(entry.metadata)
  const extensionId = identifier?.id
  const currentVersion = entry?.version
  if (typeof extensionId !== 'string' || typeof currentVersion !== 'string') {
    return null
  }
  const installedTimestamp = metadata?.installedTimestamp
  return {
    extensionId: extensionId.toLowerCase(),
    currentVersion,
    installedTimestamp: typeof installedTimestamp === 'number' ? installedTimestamp : 0,
  }
}

/**
 * Parses the `extensions.json` the editor keeps beside the extension folders. Unlike
 * `vscode.extensions.all` it lists disabled extensions too, which is the whole reason we read it.
 * An update leaves the superseded copy in the file (observed: 8 entries for one extension), so
 * the most recently installed copy of each id wins — the version the editor is actually running.
 */
export function parseInstalledExtensions(content: string): ParsedInventory {
  let payload: unknown
  try {
    payload = JSON.parse(content)
  } catch {
    return { entries: [], partial: true }
  }
  if (!Array.isArray(payload)) {
    return { entries: [], partial: true }
  }
  const newest = new Map<string, InstalledExtensionRecord>()
  let partial = false
  for (const value of payload) {
    const record = readEntry(value)
    if (record === null) {
      partial = true
      continue
    }
    const known = newest.get(record.extensionId)
    if (known === undefined || record.installedTimestamp >= known.installedTimestamp) {
      newest.set(record.extensionId, record)
    }
  }
  return {
    entries: [...newest.values()].map(({ extensionId, currentVersion }) => ({
      extensionId,
      currentVersion,
    })),
    partial,
  }
}
