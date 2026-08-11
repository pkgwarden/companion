/** Mirrors VscodePolicyReason in gate_vscode_catalog_service.py. */
export type VscodePolicyReason =
  | 'quarantine'
  | 'scan_verdict'
  | 'not_in_catalog'
  | 'pending_scan'
  | 'known_malware'
  | 'trusted_publisher'
  | 'ms_lookup_capped'

/** Mirrors VscodeInventoryEntry. */
export interface VscodeInventoryEntry {
  extensionId: string
  currentVersion: string
}

/**
 * Mirrors the `extensions.allowed` value of VscodePolicyResponse: a version pin list per
 * `publisher.extension`, or `true` against a bare publisher gate trusts wholesale.
 */
export type VscodePinMap = Record<string, string[] | boolean>

/** Mirrors the picker-relevant fields of VscodeExtensionListItem. */
export interface VscodeCatalogItem {
  extensionId: string
  displayName: string | null
  description: string | null
  latestVersion: string | null
  trustedPublisher: boolean
}

/** Mirrors VscodeExtensionListPage. */
export interface VscodeCatalogPage {
  items: VscodeCatalogItem[]
  total: number
  page: number
  limit: number
  hasMore: boolean
}

/** Mirrors the picker-relevant fields of VscodeWhyBlockedResponse. */
export interface VscodeWhyBlocked {
  blocked: boolean
  reason: VscodePolicyReason | null
  /** `details.summary` of the scan verdict, when the server sent one. */
  verdictSummary: string | null
  quarantineCutoffUtc: string | null
}

/** Mirrors VscodeInstallCheckResponse. */
export interface VscodeInstallCheckResult {
  extensionId: string
  extensionExists: boolean
  resolvedVersion: string | null
  whyBlocked: VscodeWhyBlocked
  /** Server-ordered ascending; the client never sorts versions itself. */
  allowedVersions: string[]
}

/** Mirrors VscodeWithheldVersion (gate PR 1); absent from responses until that ships. */
export interface VscodeWithheldVersion {
  extensionId: string
  version: string
  reason: VscodePolicyReason
  rollbackVersion: string | null
}

/** Mirrors VscodePolicyResponse. */
export interface VscodePolicyResult {
  extensionsAllowed: VscodePinMap
  generatedAt: string
  withheld: VscodeWithheldVersion[]
}

export type GateClientErrorKind = 'unauthenticated' | 'metered-out' | 'network' | 'server'

export class GateClientError extends Error {
  readonly kind: GateClientErrorKind

  constructor(kind: GateClientErrorKind, message: string) {
    super(message)
    this.name = 'GateClientError'
    this.kind = kind
  }
}

export function isMeteredOut(error: unknown): boolean {
  return error instanceof GateClientError && error.kind === 'metered-out'
}

export interface FetchResponse {
  status: number
  json(): Promise<unknown>
}

export interface FetchInit {
  method: string
  headers: Record<string, string>
  body?: string
  signal: AbortSignal
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>

/** Failing closed has to be bounded: a hung connection must surface, not stall a sync forever. */
export const GATE_REQUEST_TIMEOUT_MS = 15_000

/** One page is plenty for a quick-pick the user filters by typing. */
export const CATALOG_SEARCH_PAGE_SIZE = 25

/** The catalog route answers an empty page below two characters, so one is not worth a call. */
export const CATALOG_MIN_QUERY_LENGTH = 2

export interface GateClientOptions {
  apiUrl: string
  token: string
  requestTimeoutMs?: number
  fetchImplementation?: FetchLike
}

/** Mirrors normalize_api_base in pkgwarden-cli: gate routers live under `/api/v1`. */
export function normalizeApiBase(rawUrl: string): string {
  const stripped = rawUrl.trim().replace(/\/+$/, '')
  if (stripped.endsWith('/api/v1')) {
    return stripped
  }
  return stripped.endsWith('/api') ? `${stripped}/v1` : `${stripped}/api/v1`
}

export function classifyResponseStatus(status: number): GateClientErrorKind | null {
  if (status < 400) {
    return null
  }
  if (status === 401 || status === 403) {
    return 'unauthenticated'
  }
  return status === 429 ? 'metered-out' : 'server'
}

function malformedResponse(): GateClientError {
  return new GateClientError('server', 'gate returned a response in an unexpected shape')
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw malformedResponse()
  }
  return value as Record<string, unknown>
}

function asString(value: unknown): string {
  if (typeof value !== 'string') {
    throw malformedResponse()
  }
  return value
}

function asOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }
  return asString(value)
}

function asBoolean(value: unknown, fallback: boolean | null = null): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (fallback !== null && (value === undefined || value === null)) {
    return fallback
  }
  throw malformedResponse()
}

function asNumber(value: unknown): number {
  if (typeof value !== 'number') {
    throw malformedResponse()
  }
  return value
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw malformedResponse()
  }
  return value.map(asString)
}

function parseCatalogItem(value: unknown): VscodeCatalogItem {
  const item = asRecord(value)
  return {
    extensionId: asString(item.extension_id),
    displayName: asOptionalString(item.display_name),
    description: asOptionalString(item.description),
    latestVersion: asOptionalString(item.latest_version),
    trustedPublisher: asBoolean(item.trusted_publisher, false),
  }
}

export function parseCatalogPage(payload: unknown): VscodeCatalogPage {
  const body = asRecord(payload)
  if (!Array.isArray(body.items)) {
    throw malformedResponse()
  }
  return {
    items: body.items.map(parseCatalogItem),
    total: asNumber(body.total),
    page: asNumber(body.page),
    limit: asNumber(body.limit),
    hasMore: asBoolean(body.has_more),
  }
}

function parseWhyBlocked(value: unknown): VscodeWhyBlocked {
  const whyBlocked = asRecord(value)
  const details =
    whyBlocked.details === undefined || whyBlocked.details === null
      ? null
      : asRecord(whyBlocked.details)
  return {
    blocked: asBoolean(whyBlocked.blocked),
    reason: asOptionalString(whyBlocked.reason) as VscodePolicyReason | null,
    verdictSummary: details === null ? null : asOptionalString(details.summary),
    quarantineCutoffUtc: asOptionalString(whyBlocked.quarantine_cutoff_utc),
  }
}

export function parseInstallCheckResponse(payload: unknown): VscodeInstallCheckResult {
  const body = asRecord(payload)
  return {
    extensionId: asString(body.extension_id),
    extensionExists: asBoolean(body.extension_exists),
    resolvedVersion: asOptionalString(body.resolved_version),
    whyBlocked: parseWhyBlocked(body.why_blocked),
    allowedVersions: asStringList(body.allowed_versions),
  }
}

function parsePinMap(value: unknown): VscodePinMap {
  const pinMap: VscodePinMap = {}
  for (const [extensionId, pins] of Object.entries(asRecord(value))) {
    if (typeof pins === 'boolean') {
      pinMap[extensionId] = pins
    } else if (Array.isArray(pins) && pins.every((pin) => typeof pin === 'string')) {
      pinMap[extensionId] = pins
    } else {
      throw malformedResponse()
    }
  }
  return pinMap
}

function parseWithheldEntry(value: unknown): VscodeWithheldVersion {
  const entry = asRecord(value)
  const { extension_id: extensionId, version, reason, rollback_version: rollbackVersion } = entry
  if (
    typeof extensionId !== 'string' ||
    typeof version !== 'string' ||
    typeof reason !== 'string' ||
    !(typeof rollbackVersion === 'string' || rollbackVersion === null)
  ) {
    throw malformedResponse()
  }
  return { extensionId, version, reason: reason as VscodePolicyReason, rollbackVersion }
}

function parseWithheld(value: unknown): VscodeWithheldVersion[] {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw malformedResponse()
  }
  return value.map(parseWithheldEntry)
}

export function parsePolicyResponse(payload: unknown): VscodePolicyResult {
  const body = asRecord(payload)
  const generatedAt = body.generated_at
  if (typeof generatedAt !== 'string') {
    throw malformedResponse()
  }
  return {
    extensionsAllowed: parsePinMap(body['extensions.allowed']),
    generatedAt,
    withheld: parseWithheld(body.withheld),
  }
}

/**
 * Fails closed and never retries: one HTTP call per user-visible operation, and any failure
 * leaves the caller's existing pins alone.
 */
export class GateClient {
  private readonly apiBase: string
  private readonly token: string
  private readonly requestTimeoutMs: number
  private readonly fetchImplementation: FetchLike

  constructor(options: GateClientOptions) {
    this.apiBase = normalizeApiBase(options.apiUrl)
    this.token = options.token
    this.requestTimeoutMs = options.requestTimeoutMs ?? GATE_REQUEST_TIMEOUT_MS
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch
  }

  async fetchPolicy(inventory: readonly VscodeInventoryEntry[]): Promise<VscodePolicyResult> {
    const payload = await this.post('/vscode/policy', {
      inventory: inventory.map((entry) => ({
        extension_id: entry.extensionId,
        current_version: entry.currentVersion,
      })),
    })
    return parsePolicyResponse(payload)
  }

  async searchCatalog(
    query: string,
    page = 1,
    limit = CATALOG_SEARCH_PAGE_SIZE,
  ): Promise<VscodeCatalogPage> {
    const parameters = new URLSearchParams({
      q: query,
      page: String(page),
      limit: String(limit),
    })
    return parseCatalogPage(await this.get(`/catalog/vscode/extensions?${parameters.toString()}`))
  }

  /** The one metered call per install attempt: no version means gate resolves the latest allowed. */
  async installCheck(
    extensionId: string,
    version: string | null,
  ): Promise<VscodeInstallCheckResult> {
    const payload = await this.post('/vscode/install-check', {
      extension_id: extensionId,
      ...(version === null ? {} : { version }),
    })
    return parseInstallCheckResponse(payload)
  }

  private async get(path: string): Promise<unknown> {
    return this.request('GET', path)
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return this.request('POST', path, JSON.stringify(body))
  }

  private async request(method: 'GET' | 'POST', path: string, body?: string): Promise<unknown> {
    let response: FetchResponse
    try {
      response = await this.fetchImplementation(`${this.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new GateClientError('network', `${method} ${path} could not reach gate: ${detail}`)
    }
    const failure = classifyResponseStatus(response.status)
    if (failure !== null) {
      throw new GateClientError(failure, `${method} ${path} failed with HTTP ${response.status}`)
    }
    try {
      return await response.json()
    } catch {
      throw new GateClientError('server', `${method} ${path} returned a body that is not JSON`)
    }
  }
}
