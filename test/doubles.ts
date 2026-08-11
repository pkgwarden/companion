import type { CompanionLog } from '../src/log'
import type { GlobalStateStore } from '../src/syncState'
import type { SecretStore } from '../src/tokenStore'

/** Returns a token until the Nth read, then undefined — models sign-out mid-sync. */
export class FlipAfterReadSecretStore implements SecretStore {
  private reads = 0
  private value: string

  constructor(
    initialToken: string,
    private readonly flipAfter: number,
  ) {
    this.value = initialToken
  }

  async get(_key: string): Promise<string | undefined> {
    this.reads += 1
    return this.reads >= this.flipAfter ? undefined : this.value
  }

  async store(_key: string, value: string): Promise<void> {
    this.value = value
  }

  async delete(_key: string): Promise<void> {
    this.reads = this.flipAfter
  }
}

export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key)
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }

  keys(): string[] {
    return [...this.values.keys()]
  }
}

/** Stands in for a machine with no OS keyring, where every SecretStorage call rejects. */
export class UnavailableSecretStore implements SecretStore {
  async get(): Promise<string | undefined> {
    throw new Error('keyring unavailable')
  }

  async store(): Promise<void> {
    throw new Error('keyring unavailable')
  }

  async delete(): Promise<void> {
    throw new Error('keyring unavailable')
  }
}

/**
 * SecretStorage whose reads stay pending until `releaseGets` — used to prove a late refresh
 * cannot overwrite a sign-in / sign-out that finished while the read was in flight.
 */
export class ControllableSecretStore implements SecretStore {
  private readonly values = new Map<string, string>()
  private readonly pendingGets: Array<() => void> = []
  private holdRemaining: number

  /** When set, only the first N reads stay pending until `releaseGets`; later reads resolve immediately. */
  constructor(holdReads = Number.POSITIVE_INFINITY) {
    this.holdRemaining = holdReads
  }

  async get(key: string): Promise<string | undefined> {
    const snapshot = this.values.get(key)
    if (this.holdRemaining <= 0) {
      return snapshot
    }
    this.holdRemaining -= 1
    return new Promise((resolve) => {
      this.pendingGets.push(() => resolve(snapshot))
    })
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }

  keys(): string[] {
    return [...this.values.keys()]
  }

  releaseGets(count?: number): void {
    const take = count ?? this.pendingGets.length
    const pending = this.pendingGets.splice(0, take)
    for (const resolve of pending) {
      resolve()
    }
  }
}

/**
 * GlobalState whose `update` calls stay pending until `releaseUpdates` — used to interleave
 * cross-window sync claims the way two editor windows racing on shared Memento would.
 */
export class ControllableGlobalState implements GlobalStateStore {
  private readonly values = new Map<string, unknown>()
  private readonly pendingUpdates: Array<() => void> = []
  private holdRemaining: number

  constructor(holdUpdates = Number.POSITIVE_INFINITY) {
    this.holdRemaining = holdUpdates
  }

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined
  }

  async update(key: string, value: unknown): Promise<void> {
    if (this.holdRemaining <= 0) {
      this.values.set(key, value)
      return
    }
    this.holdRemaining -= 1
    await new Promise<void>((resolve) => {
      this.pendingUpdates.push(() => {
        this.values.set(key, value)
        resolve()
      })
    })
  }

  releaseUpdates(count = 1): void {
    const pending = this.pendingUpdates.splice(0, count)
    for (const run of pending) {
      run()
    }
  }

  pendingUpdateCount(): number {
    return this.pendingUpdates.length
  }
}

/** GlobalState whose writes never land — models a Memento that silently refuses to persist. */
export class DiscardingGlobalState implements GlobalStateStore {
  get<T>(_key: string): T | undefined {
    return undefined
  }

  async update(_key: string, _value: unknown): Promise<void> {}
}

/** Stands in for `context.globalState`; one instance shared by two stores models two windows. */
export class InMemoryGlobalState implements GlobalStateStore {
  private readonly values = new Map<string, unknown>()

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value)
  }

  keys(): string[] {
    return [...this.values.keys()]
  }
}

export class RecordingLog implements CompanionLog {
  readonly lines: string[] = []

  append(message: string): void {
    this.lines.push(message)
  }
}

export interface ExtensionContextDouble {
  subscriptions: { dispose(): unknown }[]
  secrets: SecretStore
  globalState: InMemoryGlobalState
  extensionPath: string
}

export function createExtensionContextDouble(
  extensionPath = '/tmp/pkgwarden-companion-absent/pkgwarden.companion-0.1.0',
): ExtensionContextDouble & { secrets: InMemorySecretStore } {
  return {
    subscriptions: [],
    secrets: new InMemorySecretStore(),
    globalState: new InMemoryGlobalState(),
    extensionPath,
  }
}

export function createUnreadableSecretsContextDouble(): ExtensionContextDouble {
  return {
    ...createExtensionContextDouble(),
    secrets: new UnavailableSecretStore(),
  }
}
