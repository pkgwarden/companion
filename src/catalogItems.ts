import type { VscodeCatalogPage } from './gateClient'

export const TRUSTED_PUBLISHER_DETAIL = 'Trusted publisher — allowed by pkgwarden wholesale.'

/** Structurally a `vscode.QuickPickItem`, plus what the install attempt needs from a selection. */
export interface InstallPickItem {
  label: string
  description: string
  detail?: string
  extensionId: string
  /** A version only when the user named one; otherwise gate resolves the latest allowed. */
  version: string | null
}

/**
 * The catalog list route carries no per-version verdict, so trust is the only policy signal to
 * render here; the real verdict comes from the install-check made when the user picks a row.
 */
export function catalogPickItems(page: VscodeCatalogPage): InstallPickItem[] {
  return page.items.map((item) => ({
    label: item.displayName ?? item.extensionId,
    description:
      item.latestVersion === null
        ? item.extensionId
        : `${item.extensionId} · latest ${item.latestVersion}`,
    ...(item.trustedPublisher ? { detail: TRUSTED_PUBLISHER_DETAIL } : {}),
    extensionId: item.extensionId,
    version: null,
  }))
}

export function explicitRefPickItem(extensionId: string, version: string): InstallPickItem {
  return {
    label: `Install ${extensionId}@${version}`,
    description: 'exact version — pkgwarden checks policy first',
    extensionId,
    version,
  }
}
