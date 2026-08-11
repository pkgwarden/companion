/**
 * Port for "sync now, ignoring the daily cadence". The picker needs one after an install so the
 * inventory-scoped pin map catches up, but it must not own a sync engine: PR 3 registers the real
 * trigger, and until then a picker install simply skips the immediate sync.
 *
 * A trigger that throws is reported, never allowed to fail an install that already succeeded.
 */
export type SyncTrigger = () => void

export interface SyncTriggerRegistration {
  dispose(): void
}

export type SyncRequestOutcome =
  | { kind: 'requested' }
  | { kind: 'no-trigger' }
  | { kind: 'failed'; error: unknown }

let registeredTrigger: SyncTrigger | null = null

export function registerSyncTrigger(trigger: SyncTrigger): SyncTriggerRegistration {
  registeredTrigger = trigger
  return {
    dispose: () => {
      if (registeredTrigger === trigger) {
        registeredTrigger = null
      }
    },
  }
}

export function requestImmediateSync(): SyncRequestOutcome {
  const trigger = registeredTrigger
  if (trigger === null) {
    return { kind: 'no-trigger' }
  }
  try {
    trigger()
    return { kind: 'requested' }
  } catch (error) {
    return { kind: 'failed', error }
  }
}
