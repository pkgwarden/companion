import { join } from 'node:path'

interface ParsedReference {
  extensionId: string
  version: string
}

function parseReference(reference: string): ParsedReference {
  const separator = reference.lastIndexOf('@')
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error(`inventory injection needs an id@version reference, got ${reference}`)
  }
  return {
    extensionId: reference.slice(0, separator),
    version: reference.slice(separator + 1),
  }
}

function entryId(entry: unknown): string {
  const identifier = (entry as { identifier?: { id?: unknown } }).identifier
  return typeof identifier?.id === 'string' ? identifier.id.toLowerCase() : ''
}

/** Rows the editor never installed, so gate answers a policy that includes them. */
export function withInjectedEntries(
  entries: readonly unknown[],
  references: readonly string[],
  extensionsDir: string,
): unknown[] {
  const injected = references.map((reference) => {
    const { extensionId, version } = parseReference(reference)
    return {
      identifier: { id: extensionId },
      version,
      location: { $mid: 1, path: join(extensionsDir, extensionId), scheme: 'file' },
      relativeLocation: extensionId,
      metadata: { installedTimestamp: Date.now() },
    }
  })
  return [...entries, ...injected]
}

/**
 * Removes the injected rows by id rather than restoring the file as it was: a stage may have
 * installed or uninstalled something meanwhile, and rewriting the old text would hide it.
 */
export function withoutInjectedEntries(
  entries: readonly unknown[],
  references: readonly string[],
): unknown[] {
  const injectedIds = new Set(
    references.map((reference) => parseReference(reference).extensionId.toLowerCase()),
  )
  return entries.filter((entry) => !injectedIds.has(entryId(entry)))
}
