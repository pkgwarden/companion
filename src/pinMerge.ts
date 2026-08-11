import { publisherOf } from './extensionRef'
import type { VscodePinMap } from './gateClient'

export type PinDecision =
  | { kind: 'write'; pinMap: VscodePinMap }
  /** A wholesale `true` already covers the extension; writing a version list would take that away. */
  | { kind: 'already-allowed' }

/**
 * Read-merge-write for one extension: the picker only ever speaks for the extension it is
 * installing, so unrelated pins (and this extension's existing ones) survive. The sync engine is
 * the only path allowed to replace the whole map.
 */
export function planPinUpdate(
  current: VscodePinMap,
  extensionId: string,
  versions: readonly string[],
): PinDecision {
  const existing = current[extensionId]
  // Gate writes a trusted publisher's allow under the bare publisher key, so a version list for
  // one of its extensions would narrow it — VS Code takes the most specific key. A more-specific
  // `false` still blocks install until we replace it with an explicit version allowlist.
  if (existing !== false && (existing === true || current[publisherOf(extensionId)] === true)) {
    return { kind: 'already-allowed' }
  }
  // Gate sorts ascending, so pins it no longer lists (grandfathered installs) go in front and the
  // last element stays the latest allowed version.
  const carriedOver = Array.isArray(existing)
    ? existing.filter((version) => !versions.includes(version))
    : []
  return { kind: 'write', pinMap: { ...current, [extensionId]: [...carriedOver, ...versions] } }
}
