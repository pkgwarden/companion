import { GATE_WEBAPP_URL } from './constants'
import type { GateClientErrorKind, VscodePolicyReason } from './gateClient'
import { GateClientError } from './gateClient'
import { formatUtcDate } from './utcDate'

/** A sync failed on gate's side of the wire (`GateClientErrorKind`) or on ours (`local`). */
export type SyncFailureKind = GateClientErrorKind | 'local'

/**
 * What a sync the user asked for says when it fails. Every line states that the pins already in
 * settings still stand: failing closed is only honest if the user hears about it.
 */
export function syncFailureMessage(kind: SyncFailureKind): string {
  switch (kind) {
    case 'unauthenticated':
      return 'pkgwarden gate rejected this token, so your extension pins are unchanged — sign in again with a current gate API token.'
    case 'metered-out':
      return 'pkgwarden gate declined this sync for quota reasons, so your extension pins are unchanged.'
    case 'network':
      return 'pkgwarden could not reach gate, so your extension pins are unchanged — the pkgwarden output channel has the details.'
    case 'server':
      return 'pkgwarden gate could not produce a policy, so your extension pins are unchanged — the pkgwarden output channel has the details.'
    case 'local':
      return 'pkgwarden could not write extensions.allowed, so your extension pins are unchanged — the pkgwarden output channel has the details.'
  }
}

export const SIGN_IN_REQUIRED_MESSAGE =
  'Sign in with a pkgwarden gate token before installing extensions.'

/** The `publisher.name@version` form the editor installs by, or the bare id when there is no version. */
export function extensionReference(extensionId: string, version: string | null): string {
  return version === null ? extensionId : `${extensionId}@${version}`
}

export interface BlockedContext {
  extensionId: string
  version: string | null
  reason: VscodePolicyReason | null
  quarantineCutoffUtc: string | null
  verdictSummary: string | null
  /** Only an explicitly requested version gets the "latest allowed version" pointer. */
  explicitVersionRequested: boolean
  /** Server-sorted ascending; the client never sorts versions itself. */
  allowedVersions: readonly string[]
}

function reasonSentence(context: BlockedContext, reference: string): string {
  switch (context.reason) {
    case 'pending_scan':
      return `${reference} is pending a security scan; a scan has been queued — retry in a few minutes.`
    case 'quarantine': {
      const cutoff =
        context.quarantineCutoffUtc === null ? null : formatUtcDate(context.quarantineCutoffUtc)
      const until = cutoff === null ? '' : ` until ${cutoff}`
      return `${reference} is in quarantine${until} (published too recently).`
    }
    case 'scan_verdict':
    case 'known_malware': {
      const summary = context.verdictSummary === null ? '' : ` (${context.verdictSummary})`
      return `${reference} was withheld by pkgwarden's security scan${summary}; this cannot be overridden.`
    }
    case 'not_in_catalog':
      return `${reference} not found in the gate catalog — check the id on ${GATE_WEBAPP_URL}/extensions (the catalog is crawled nightly; very new versions may not be indexed yet).`
    default: {
      const detail = context.reason === null ? '' : ` (${context.reason})`
      return `${reference} is not allowed by pkgwarden policy${detail}.`
    }
  }
}

export function blockedMessage(context: BlockedContext): string {
  const reference = extensionReference(context.extensionId, context.version)
  const sentence = reasonSentence(context, reference)
  const latestAllowed = context.allowedVersions[context.allowedVersions.length - 1]
  if (!context.explicitVersionRequested || latestAllowed === undefined) {
    return sentence
  }
  return `${sentence} latest allowed version: ${latestAllowed}.`
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function gateFailureClause(error: unknown): string {
  if (!(error instanceof GateClientError)) {
    return `unexpected failure (${errorDetail(error)})`
  }
  switch (error.kind) {
    case 'unauthenticated':
      return 'gate rejected your token — sign in again'
    case 'metered-out':
      return 'your gate resolution quota is used up'
    case 'network':
      return 'gate is unreachable'
    case 'server':
      return 'gate returned an error'
  }
}

/** Every failure of the metered check says what did not happen: there are no retries. */
export function installCheckFailureMessage(error: unknown, reference: string): string {
  return `pkgwarden could not check ${reference}: ${gateFailureClause(error)}. Nothing was installed.`
}

export function catalogSearchFailureMessage(error: unknown): string {
  return `pkgwarden could not search the extension catalog: ${gateFailureClause(error)}.`
}

export function pinWriteFailureMessage(reference: string, error: unknown): string {
  return `pkgwarden could not add ${reference} to extensions.allowed (${errorDetail(error)}). Nothing was installed.`
}

/** The pin is a true policy statement even when the install fails, so it stays. */
export function installFailureMessage(reference: string, error: unknown): string {
  return `pkgwarden allowed ${reference} but the editor could not install it (${errorDetail(error)}). The pin was kept, so the next sync can reconcile it.`
}

export function installedMessage(reference: string): string {
  return `pkgwarden allowed and installed ${reference}.`
}

/** The install already happened, so a dead sync port is a heads-up, not a failed operation. */
export function syncTriggerFailureMessage(reference: string, error: unknown): string {
  return `pkgwarden installed ${reference} but could not start an immediate policy sync (${errorDetail(error)}). The next scheduled sync will reconcile it.`
}

export function unresolvedVersionMessage(extensionId: string): string {
  return `pkgwarden found no installable version of ${extensionId} in the gate catalog.`
}

export function malformedRefMessage(raw: string): string {
  return `"${raw}" is not an extension reference — use publisher.name or publisher.name@version.`
}
