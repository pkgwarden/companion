/**
 * Mirrors the ref rules of the retired `pw vscode install` spec (#551) so both surfaces would
 * accept exactly the same refs, and the marketplace's own id shape
 * (`EXTENSION_IDENTIFIER_PATTERN`: one dot, alphanumerics and hyphens, no leading hyphen).
 */
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/
const VERSION_PATTERN = /^[^\s@]+$/

export interface ExtensionRef {
  extensionId: string
  version: string | null
}

export type PickerInput =
  | { kind: 'empty' }
  | { kind: 'search'; query: string }
  | { kind: 'explicit'; extensionId: string; version: string }
  | { kind: 'malformed'; raw: string }

/** Only the id is lowercased: gate matches catalog versions byte for byte, prerelease tags and all. */
export function parseExtensionRef(raw: string): ExtensionRef | null {
  const [rawId, version, ...rest] = raw.trim().split('@')
  if (rest.length > 0 || rawId === undefined) {
    return null
  }
  const extensionId = rawId.toLowerCase()
  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    return null
  }
  if (version === undefined) {
    return { extensionId, version: null }
  }
  return VERSION_PATTERN.test(version) ? { extensionId, version } : null
}

/** The bare `publisher` key gate and VS Code write a wholesale allow under. */
export function publisherOf(extensionId: string): string {
  const [publisher] = extensionId.split('.')
  return publisher ?? extensionId
}

/** A version separator commits the input to the explicit-ref path; anything else is a search. */
export function classifyPickerInput(raw: string): PickerInput {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { kind: 'empty' }
  }
  if (!trimmed.includes('@')) {
    return { kind: 'search', query: trimmed }
  }
  const reference = parseExtensionRef(trimmed)
  if (reference === null || reference.version === null) {
    return { kind: 'malformed', raw: trimmed }
  }
  return { kind: 'explicit', extensionId: reference.extensionId, version: reference.version }
}
