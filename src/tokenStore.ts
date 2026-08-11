import { GATE_TOKEN_SECRET_KEY } from './constants'

/** The slice of `vscode.SecretStorage` the companion uses. */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>
  store(key: string, value: string): PromiseLike<void>
  delete(key: string): PromiseLike<void>
}

export function normalizeToken(rawToken: string): string | null {
  const trimmed = rawToken.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * SecretStorage needs an OS keyring, which some Linux and remote setups do not provide. The
 * failure detail never carries the token — only the keyring error text is interpolated.
 */
export function secretReadFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `pkgwarden could not read your gate token from the editor's secret storage (${detail}) — sign in again to retry.`
}

export function secretWriteFailureMessage(error: unknown, action: 'save' | 'clear'): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (action === 'save') {
    return `pkgwarden could not store your gate token in the editor's secret storage (${detail}) — you are still signed out.`
  }
  return `pkgwarden could not clear your gate token from the editor's secret storage (${detail}) — you may still be signed in.`
}

export class GateTokenStore {
  private readonly secrets: SecretStore

  constructor(secrets: SecretStore) {
    this.secrets = secrets
  }

  async read(): Promise<string | undefined> {
    return this.secrets.get(GATE_TOKEN_SECRET_KEY)
  }

  async save(token: string): Promise<void> {
    await this.secrets.store(GATE_TOKEN_SECRET_KEY, token)
  }

  async clear(): Promise<void> {
    await this.secrets.delete(GATE_TOKEN_SECRET_KEY)
  }
}
