import * as vscode from 'vscode'

import { COMPANION_EXTENSION_ID } from './constants'
import type { VscodePinMap } from './gateClient'

export const ALLOWED_EXTENSIONS_SECTION = 'extensions'
export const ALLOWED_EXTENSIONS_SETTING = 'allowed'

/** Keeps hand-edited or policy-injected junk out of the comparison instead of throwing mid-sync. */
export function asPinMap(value: unknown): VscodePinMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  const pins: VscodePinMap = {}
  for (const [extensionId, entry] of Object.entries(value)) {
    if (typeof entry === 'boolean') {
      pins[extensionId] = entry
    } else if (Array.isArray(entry) && entry.every((version) => typeof version === 'string')) {
      pins[extensionId] = entry
    }
  }
  return pins
}

function pinsEqual(left: string[] | boolean, right: string[] | boolean): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((version, index) => version === right[index])
  }
  return left === right
}

export function pinMapsEqual(left: VscodePinMap, right: VscodePinMap): boolean {
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) {
    return false
  }
  return keys.every((extensionId) => {
    const other = right[extensionId]
    const mine = left[extensionId]
    return mine !== undefined && other !== undefined && pinsEqual(mine, other)
  })
}

export function countPinnedExtensions(pins: VscodePinMap): number {
  return Object.keys(pins).length
}

/**
 * Self-guard: replacing the map with a server response that predates gate's self-allow would
 * drop our own pin, and the editor disables an extension whose version is no longer allowed.
 */
export function withSelfPinPreserved(
  serverPins: VscodePinMap,
  effectivePins: VscodePinMap,
): VscodePinMap {
  const selfPin = effectivePins[COMPANION_EXTENSION_ID]
  if (serverPins[COMPANION_EXTENSION_ID] !== undefined || selfPin === undefined) {
    return serverPins
  }
  return { ...serverPins, [COMPANION_EXTENSION_ID]: selfPin }
}

export function readEffectivePins(): VscodePinMap {
  return asPinMap(
    vscode.workspace
      .getConfiguration(ALLOWED_EXTENSIONS_SECTION)
      .get<unknown>(ALLOWED_EXTENSIONS_SETTING),
  )
}

/**
 * Replaces the whole `extensions.allowed` value, exactly like `pw vscode sync-policy`: the
 * server response is authoritative for the full inventory. Returns whether the effective value
 * read back differently — the only way to notice that a device policy layer owns the setting.
 */
export async function writePins(pins: VscodePinMap): Promise<boolean> {
  await vscode.workspace
    .getConfiguration(ALLOWED_EXTENSIONS_SECTION)
    .update(ALLOWED_EXTENSIONS_SETTING, pins, vscode.ConfigurationTarget.Global)
  return !pinMapsEqual(pins, readEffectivePins())
}
