/** Mirrors COMPANION_EXTENSION_ID in gate_vscode_policy_service.py; gate self-allows this id. */
export const COMPANION_EXTENSION_ID = 'pkgwarden.companion'

/** Matches GATE_RESOLUTION_INDEX_PROD_ORIGIN in gate-webapp/src/lib/gate-docs-index.ts. */
export const DEFAULT_GATE_API_URL = 'https://index.pkgwarden.com'

export const GATE_WEBAPP_URL = 'https://gate.pkgwarden.com'

/** The only place a gate token is ever written, and only into SecretStorage. */
export const GATE_TOKEN_SECRET_KEY = 'pkgwarden.gateToken'

export const SIGN_IN_COMMAND = 'pkgwarden.signIn'
export const SIGN_OUT_COMMAND = 'pkgwarden.signOut'
export const SYNC_NOW_COMMAND = 'pkgwarden.syncNow'
export const INSTALL_EXTENSION_COMMAND = 'pkgwarden.installExtension'

/** One label for the palette title and the status-bar menu entry. */
export const INSTALL_EXTENSION_TITLE = 'Install extension…'

/** Status-bar click target. Deliberately not contributed: it is not a palette command. */
export const SHOW_MENU_COMMAND = 'pkgwarden.showMenu'

export interface EditorIdentity {
  appName: string
  uriScheme: string
}

/**
 * `vscode.env.appName` / `vscode.env.uriScheme` as observed in each editor's Extension
 * Development Host on 2026-07-28 (RV4): VS Code 1.130.0 and Cursor 3.13.10 (API 1.128.0) on
 * macOS, and matching each app's `product.json` `nameLong` / `urlProtocol`.
 * PRs 3–5 branch on editor identity; these are the literal strings, recorded not guessed.
 */
export const OBSERVED_EDITOR_IDENTITIES: readonly EditorIdentity[] = [
  { appName: 'Visual Studio Code', uriScheme: 'vscode' },
  { appName: 'Cursor', uriScheme: 'cursor' },
]
