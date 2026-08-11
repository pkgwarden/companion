export const LOCAL_GATE_URL = 'http://127.0.0.1:8006'

/**
 * The editor opens an IPC socket under the user-data-dir and macOS caps that path at 103 bytes,
 * so the profile root has to stay short. Observed failing with the session scratchpad path.
 */
export const DEFAULT_PROFILE_ROOT = '/tmp/pkgwarden-uat'
const MAX_PROFILE_ROOT_LENGTH = 40

export class HarnessConfigError extends Error {}

export interface CatalogDatabaseTarget {
  container: string
  user: string
  database: string
}

export interface HarnessEnv {
  gateUrl: string
  gateToken: string
  profileRoot: string
  catalogDatabase: CatalogDatabaseTarget
}

function required(source: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = source[name]?.trim()
  if (value === undefined || value === '') {
    throw new HarnessConfigError(
      `${name} is not set. The harness never prompts for a token: mint one against the local gate stack and pass it in.`,
    )
  }
  return value
}

function optional(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: string,
): string {
  const value = source[name]?.trim()
  return value === undefined || value === '' ? fallback : value
}

/**
 * Loopback only. The companion's default `pkgwarden.apiUrl` is the production index, and a live
 * token plus a production URL is a real production sync — the harness must not be one typo away
 * from that.
 */
function loopbackGateUrl(rawUrl: string): string {
  const trimmed = rawUrl.replace(/\/+$/, '')
  let host: string
  try {
    host = new URL(trimmed).hostname
  } catch {
    throw new HarnessConfigError(`PKGWARDEN_UAT_GATE_URL is not a URL: ${rawUrl}`)
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new HarnessConfigError(
      `PKGWARDEN_UAT_GATE_URL must point at a local gate stack, got ${rawUrl}. This harness stages malware verdicts in the catalog database and must never touch a deployed gate.`,
    )
  }
  return trimmed
}

export function readHarnessEnv(source: Readonly<Record<string, string | undefined>>): HarnessEnv {
  const profileRoot = optional(source, 'PKGWARDEN_UAT_PROFILE_ROOT', DEFAULT_PROFILE_ROOT)
  if (profileRoot.length > MAX_PROFILE_ROOT_LENGTH) {
    throw new HarnessConfigError(
      `PKGWARDEN_UAT_PROFILE_ROOT must be at most ${MAX_PROFILE_ROOT_LENGTH} characters (the editor's IPC socket path is capped), got ${profileRoot.length}.`,
    )
  }
  return {
    gateUrl: loopbackGateUrl(optional(source, 'PKGWARDEN_UAT_GATE_URL', LOCAL_GATE_URL)),
    gateToken: required(source, 'PKGWARDEN_UAT_GATE_TOKEN'),
    profileRoot,
    catalogDatabase: {
      container: optional(source, 'PKGWARDEN_UAT_DB_CONTAINER', 'backend-postgres-global-1'),
      user: optional(source, 'PKGWARDEN_UAT_DB_USER', 'postgres'),
      database: optional(source, 'PKGWARDEN_UAT_CATALOG_DB', 'pkgwarden_global'),
    },
  }
}
