import { describe, expect, it } from 'vitest'

import {
  CATALOG_SEARCH_PAGE_SIZE,
  classifyResponseStatus,
  type FetchInit,
  type FetchLike,
  type FetchResponse,
  GATE_REQUEST_TIMEOUT_MS,
  GateClient,
  GateClientError,
  isMeteredOut,
  normalizeApiBase,
  parseCatalogPage,
  parseInstallCheckResponse,
  parsePolicyResponse,
} from './gateClient'

interface RecordedRequest {
  url: string
  init: FetchInit
}

const policyPayload = {
  'extensions.allowed': { 'contoso.linter-pro': ['4.1.9'], contoso: true },
  generated_at: '2026-07-28T12:00:00Z',
  withheld: [
    {
      extension_id: 'contoso.linter-pro',
      version: '4.2.1',
      reason: 'scan_verdict',
      rollback_version: '4.1.9',
    },
  ],
}

const catalogPayload = {
  items: [
    {
      extension_id: 'contoso.linter-pro',
      display_name: 'Linter Pro',
      description: 'Lints everything',
      latest_version: '4.2.1',
      install_count: 1200,
      namespace_verified: true,
      trusted_publisher: false,
    },
  ],
  total: 1,
  page: 1,
  limit: 25,
  has_more: false,
}

const installCheckPayload = {
  extension_id: 'contoso.linter-pro',
  extension_exists: true,
  resolved_version: '4.1.9',
  why_blocked: {
    blocked: false,
    reason: null,
    details: { status: 'completed', risk_score: 2, summary: 'no findings', findings: [] },
    quarantine_days: 14,
    quarantine_cutoff_utc: null,
  },
  allowed_versions: ['4.1.7', '4.1.9'],
}

function clientWith(fetchImplementation: FetchLike): GateClient {
  return new GateClient({
    apiUrl: 'https://index.pkgwarden.com',
    token: 'gate-token',
    fetchImplementation,
  })
}

function recordingClient(respond: () => Promise<FetchResponse>): {
  client: GateClient
  requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  const client = clientWith(async (url, init) => {
    requests.push({ url, init })
    return respond()
  })
  return { client, requests }
}

function respondWith(status: number, body: unknown): () => Promise<FetchResponse> {
  return async () => ({ status, json: async () => body })
}

describe('normalizeApiBase', () => {
  it('appends the api prefix the gate routers are mounted under', () => {
    expect(normalizeApiBase('https://index.pkgwarden.com/')).toBe(
      'https://index.pkgwarden.com/api/v1',
    )
  })

  it('leaves an already-prefixed base alone', () => {
    expect(normalizeApiBase('https://index.pkgwarden.com/api/v1')).toBe(
      'https://index.pkgwarden.com/api/v1',
    )
  })

  it('completes a half-written prefix', () => {
    expect(normalizeApiBase(' https://index.pkgwarden.com/api ')).toBe(
      'https://index.pkgwarden.com/api/v1',
    )
  })
})

describe('classifyResponseStatus', () => {
  it('treats a rejected token as unauthenticated', () => {
    expect(classifyResponseStatus(401)).toBe('unauthenticated')
    expect(classifyResponseStatus(403)).toBe('unauthenticated')
  })

  it('treats 429 as metered out', () => {
    expect(classifyResponseStatus(429)).toBe('metered-out')
  })

  it('treats every other failure as a server error', () => {
    expect(classifyResponseStatus(400)).toBe('server')
    expect(classifyResponseStatus(503)).toBe('server')
  })

  it('passes success through', () => {
    expect(classifyResponseStatus(200)).toBeNull()
  })
})

describe('parsePolicyResponse', () => {
  it('reads the aliased pin map, publisher-wide allows and withheld entries', () => {
    expect(parsePolicyResponse(policyPayload)).toEqual({
      extensionsAllowed: { 'contoso.linter-pro': ['4.1.9'], contoso: true },
      generatedAt: '2026-07-28T12:00:00Z',
      withheld: [
        {
          extensionId: 'contoso.linter-pro',
          version: '4.2.1',
          reason: 'scan_verdict',
          rollbackVersion: '4.1.9',
        },
      ],
    })
  })

  it('defaults withheld to empty so older gate deployments still parse', () => {
    const { withheld } = parsePolicyResponse({
      'extensions.allowed': {},
      generated_at: '2026-07-28T12:00:00Z',
    })

    expect(withheld).toEqual([])
  })

  it('rejects a payload without a pin map', () => {
    expect(() => parsePolicyResponse({ generated_at: '2026-07-28T12:00:00Z' })).toThrowError(
      GateClientError,
    )
  })

  it('rejects pin values that are neither version lists nor a publisher-wide allow', () => {
    expect(() =>
      parsePolicyResponse({
        'extensions.allowed': { 'contoso.linter-pro': 4 },
        generated_at: '2026-07-28T12:00:00Z',
      }),
    ).toThrowError(GateClientError)
  })

  it('rejects a withheld entry missing its rollback field', () => {
    expect(() =>
      parsePolicyResponse({
        'extensions.allowed': {},
        generated_at: '2026-07-28T12:00:00Z',
        withheld: [
          { extension_id: 'contoso.linter-pro', version: '4.2.1', reason: 'scan_verdict' },
        ],
      }),
    ).toThrowError(GateClientError)
  })
})

describe('GateClient.fetchPolicy', () => {
  it('posts the inventory as a bearer-authenticated json request', async () => {
    const { client, requests } = recordingClient(respondWith(200, policyPayload))

    await client.fetchPolicy([{ extensionId: 'contoso.linter-pro', currentVersion: '4.2.1' }])

    expect(requests).toHaveLength(1)
    const request = requests[0] as RecordedRequest
    expect(request.url).toBe('https://index.pkgwarden.com/api/v1/vscode/policy')
    expect(request.init.method).toBe('POST')
    expect(request.init.headers.Authorization).toBe('Bearer gate-token')
    expect(request.init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(request.init.body ?? 'null')).toEqual({
      inventory: [{ extension_id: 'contoso.linter-pro', current_version: '4.2.1' }],
    })
  })

  it('surfaces a rejected token as unauthenticated without retrying', async () => {
    const { client, requests } = recordingClient(respondWith(401, {}))

    await expect(client.fetchPolicy([])).rejects.toMatchObject({ kind: 'unauthenticated' })
    expect(requests).toHaveLength(1)
  })

  it('surfaces metering exhaustion without retrying', async () => {
    const { client, requests } = recordingClient(respondWith(429, {}))

    await expect(client.fetchPolicy([])).rejects.toMatchObject({ kind: 'metered-out' })
    expect(requests).toHaveLength(1)
  })

  it('surfaces a server failure without retrying', async () => {
    const { client, requests } = recordingClient(respondWith(503, {}))

    await expect(client.fetchPolicy([])).rejects.toMatchObject({ kind: 'server' })
    expect(requests).toHaveLength(1)
  })

  it('surfaces a transport failure as a network error without retrying', async () => {
    const { client, requests } = recordingClient(() => {
      throw new Error('getaddrinfo ENOTFOUND')
    })

    await expect(client.fetchPolicy([])).rejects.toMatchObject({ kind: 'network' })
    expect(requests).toHaveLength(1)
  })

  it('bounds every request so a hung gate cannot stall a sync forever', async () => {
    const { client, requests } = recordingClient(respondWith(200, policyPayload))

    await client.fetchPolicy([])

    expect(requests[0]?.init.signal.aborted).toBe(false)
    expect(GATE_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('surfaces a timed-out request as a network failure without retrying', async () => {
    const requests: RecordedRequest[] = []
    const client = new GateClient({
      apiUrl: 'https://index.pkgwarden.com',
      token: 'gate-token',
      requestTimeoutMs: 5,
      fetchImplementation: (url, init) => {
        requests.push({ url, init })
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason))
        })
      },
    })

    await expect(client.fetchPolicy([])).rejects.toMatchObject({ kind: 'network' })
    expect(requests).toHaveLength(1)
  })

  it('surfaces an unreadable body as a server error', async () => {
    const { client } = recordingClient(async () => ({
      status: 200,
      json: async () => {
        throw new Error('Unexpected token <')
      },
    }))

    await expect(client.fetchPolicy([])).rejects.toMatchObject({ kind: 'server' })
  })
})

describe('isMeteredOut', () => {
  it('recognises the metering failure the status bar has a state for', () => {
    expect(isMeteredOut(new GateClientError('metered-out', 'quota'))).toBe(true)
  })

  it('does not mistake other failures for metering', () => {
    expect(isMeteredOut(new GateClientError('server', 'boom'))).toBe(false)
    expect(isMeteredOut(new Error('boom'))).toBe(false)
  })
})

describe('parseCatalogPage', () => {
  it('reads the paging envelope and only the fields the picker renders', () => {
    expect(parseCatalogPage(catalogPayload)).toEqual({
      items: [
        {
          extensionId: 'contoso.linter-pro',
          displayName: 'Linter Pro',
          description: 'Lints everything',
          latestVersion: '4.2.1',
          trustedPublisher: false,
        },
      ],
      total: 1,
      page: 1,
      limit: 25,
      hasMore: false,
    })
  })

  it('tolerates the optional catalog fields being absent', () => {
    expect(
      parseCatalogPage({
        items: [{ extension_id: 'contoso.linter-pro' }],
        total: 1,
        page: 1,
        limit: 25,
        has_more: false,
      }).items,
    ).toEqual([
      {
        extensionId: 'contoso.linter-pro',
        displayName: null,
        description: null,
        latestVersion: null,
        trustedPublisher: false,
      },
    ])
  })

  it('rejects a page whose items are not a list', () => {
    expect(() =>
      parseCatalogPage({ items: {}, total: 0, page: 1, limit: 25, has_more: false }),
    ).toThrowError(GateClientError)
  })

  it('rejects a page missing its paging counters', () => {
    expect(() => parseCatalogPage({ items: [] })).toThrowError(GateClientError)
  })
})

describe('parseInstallCheckResponse', () => {
  it('reads the verdict, the resolved version and the server-ordered allowed versions', () => {
    expect(parseInstallCheckResponse(installCheckPayload)).toEqual({
      extensionId: 'contoso.linter-pro',
      extensionExists: true,
      resolvedVersion: '4.1.9',
      whyBlocked: {
        blocked: false,
        reason: null,
        verdictSummary: 'no findings',
        quarantineCutoffUtc: null,
      },
      allowedVersions: ['4.1.7', '4.1.9'],
    })
  })

  it('reads a blocked verdict with its quarantine cutoff', () => {
    expect(
      parseInstallCheckResponse({
        ...installCheckPayload,
        resolved_version: '4.2.1',
        why_blocked: {
          blocked: true,
          reason: 'quarantine',
          quarantine_cutoff_utc: '2026-08-11T09:30:00Z',
        },
      }).whyBlocked,
    ).toEqual({
      blocked: true,
      reason: 'quarantine',
      verdictSummary: null,
      quarantineCutoffUtc: '2026-08-11T09:30:00Z',
    })
  })

  it('reads the verdict summary a withheld version carries', () => {
    expect(
      parseInstallCheckResponse({
        ...installCheckPayload,
        why_blocked: {
          blocked: true,
          reason: 'scan_verdict',
          details: { status: 'completed', risk_score: 90, summary: 'credential exfiltration' },
        },
      }).whyBlocked.verdictSummary,
    ).toBe('credential exfiltration')
  })

  it('reads an extension gate has never seen', () => {
    expect(
      parseInstallCheckResponse({
        extension_id: 'contoso.nope',
        extension_exists: false,
        resolved_version: null,
        why_blocked: { blocked: true, reason: 'not_in_catalog' },
        allowed_versions: [],
      }),
    ).toMatchObject({ extensionExists: false, resolvedVersion: null, allowedVersions: [] })
  })

  it('rejects a response without a verdict', () => {
    expect(() =>
      parseInstallCheckResponse({
        extension_id: 'contoso.linter-pro',
        extension_exists: true,
        resolved_version: '4.1.9',
        allowed_versions: [],
      }),
    ).toThrowError(GateClientError)
  })

  it('rejects a response whose allowed versions are not strings', () => {
    expect(() =>
      parseInstallCheckResponse({ ...installCheckPayload, allowed_versions: [4] }),
    ).toThrowError(GateClientError)
  })
})

describe('GateClient.searchCatalog', () => {
  it('gets the catalog route with the query and paging the picker asked for', async () => {
    const { client, requests } = recordingClient(respondWith(200, catalogPayload))

    const result = await client.searchCatalog('linter pro')

    expect(requests).toHaveLength(1)
    const request = requests[0] as RecordedRequest
    expect(request.url).toBe(
      `https://index.pkgwarden.com/api/v1/catalog/vscode/extensions?q=linter+pro&page=1&limit=${CATALOG_SEARCH_PAGE_SIZE}`,
    )
    expect(request.init.method).toBe('GET')
    expect(request.init.headers.Authorization).toBe('Bearer gate-token')
    expect(request.init.body).toBeUndefined()
    expect(result.items).toHaveLength(1)
  })

  it('surfaces metering exhaustion without retrying', async () => {
    const { client, requests } = recordingClient(respondWith(429, {}))

    await expect(client.searchCatalog('linter')).rejects.toMatchObject({ kind: 'metered-out' })
    expect(requests).toHaveLength(1)
  })
})

describe('GateClient.installCheck', () => {
  it('posts the extension id and the explicitly requested version', async () => {
    const { client, requests } = recordingClient(respondWith(200, installCheckPayload))

    await client.installCheck('contoso.linter-pro', '4.2.1')

    expect(requests).toHaveLength(1)
    const request = requests[0] as RecordedRequest
    expect(request.url).toBe('https://index.pkgwarden.com/api/v1/vscode/install-check')
    expect(request.init.method).toBe('POST')
    expect(JSON.parse(request.init.body ?? 'null')).toEqual({
      extension_id: 'contoso.linter-pro',
      version: '4.2.1',
    })
  })

  it('omits the version so gate resolves the latest allowed one', async () => {
    const { client, requests } = recordingClient(respondWith(200, installCheckPayload))

    await client.installCheck('contoso.linter-pro', null)

    expect(JSON.parse((requests[0] as RecordedRequest).init.body ?? 'null')).toEqual({
      extension_id: 'contoso.linter-pro',
    })
  })

  it('makes exactly one metered call and does not retry a server failure', async () => {
    const { client, requests } = recordingClient(respondWith(503, {}))

    await expect(client.installCheck('contoso.linter-pro', null)).rejects.toMatchObject({
      kind: 'server',
    })
    expect(requests).toHaveLength(1)
  })
})
