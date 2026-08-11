/** What `pw vscode sync-policy` writes above the pin map; the companion must not eat it. */
export const MANAGED_BANNER =
  '// Managed by pkgwarden. Pins come from the gate policy sync; edit policy in the gate.'

export const STRAY_COMMENT = '// UAT stray comment: not pkgwarden business.'

export function renderSeedSettings(values: Readonly<Record<string, unknown>>): string {
  const body = Object.entries(values).map(
    ([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  )
  return `{\n  ${STRAY_COMMENT}\n${body.join(',\n')}\n}\n`
}

/** Throws rather than no-op: a banner that was never written cannot prove it survived a write. */
export function insertCommentAbove(text: string, key: string, comment: string): string {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.trimStart().startsWith(`${JSON.stringify(key)}:`))
  if (index === -1) {
    throw new Error(`settings.json has no ${key} key to put a comment above`)
  }
  const line = lines[index] ?? ''
  const indent = line.slice(0, line.length - line.trimStart().length)
  return [...lines.slice(0, index), `${indent}${comment}`, ...lines.slice(index)].join('\n')
}

export function hasLine(text: string, line: string): boolean {
  return text.split('\n').some((candidate) => candidate.trim() === line.trim())
}

/** Line comments only, which is all the harness ever writes; unreadable content reads as empty. */
export function parseSettings(text: string): Record<string, unknown> {
  const stripped = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
  try {
    const parsed: unknown = JSON.parse(stripped)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Order-insensitive rendering, so "the sync rewrote the same map" reads as unchanged. */
export function stableFingerprint(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value === undefined ? '{}' : JSON.stringify(value)
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  return JSON.stringify(Object.fromEntries(entries))
}
