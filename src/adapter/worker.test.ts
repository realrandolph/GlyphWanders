import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {Server as McpServer} from '@modelcontextprotocol/sdk/server/index.js'
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {build} from 'esbuild'
import {exportJWK, generateKeyPair, SignJWT} from 'jose'
import * as miniflare from 'miniflare'
import {toolDefinitions} from '../shared/tools.ts'

const PUBLIC_URL = 'https://glyph-worker.example.workers.dev'
const ISSUER = 'https://auth.example/'
const MCP_URL = 'https://glyphwanders-abc123-external.devvit.net/external/mcp'
const MANAGED_TOKEN = `devvit_at_${'m'.repeat(40)}`
const SECRET = `devvit_at_${'s'.repeat(40)}`
const DISCOVERY = `${ISSUER}.well-known/openid-configuration`
const JWKS = `${ISSUER}jwks`
const config = {
  PUBLIC_URL,
  OAUTH_ISSUER: ISSUER,
  OAUTH_SUBJECT: 'owner',
  DEVVIT_MCP_URL: MCP_URL,
  DEVVIT_TOKEN: MANAGED_TOKEN,
}

const bundleDir = await mkdtemp(join(tmpdir(), 'glyphwanders-worker-'))
const bundlePath = join(bundleDir, 'worker.mjs')
await build({
  entryPoints: [new URL('./worker.ts', import.meta.url).pathname],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['cloudflare:*', 'node:*'],
  logLevel: 'silent',
})
const bundleSource = await readFile(bundlePath, 'utf8')

const COMPATIBILITY_DATE = '2026-10-24'
type ConvertedOptions = {
  workers: {config: {compatibilityDate?: string}}[]
}

async function createWorker(
  t: import('node:test').TestContext,
  options: Record<string, unknown> = {},
) {
  const workerOptions = {
    modules: true,
    script: bundleSource,
    compatibilityDate: COMPATIBILITY_DATE,
    log: new miniflare.Log(miniflare.LogLevel.NONE),
    ...options,
  }
  // The pinned Miniflare v5 API converts v4-style options. Assert the date
  // survived conversion, then let workerd start with exactly that date: no
  // fallback date or alternate workerd path is allowed.
  const converted = miniflare.convertV4MiniflareOptions(
    workerOptions as never,
  ) as unknown as ConvertedOptions
  assert.equal(
    converted.workers[0]?.config.compatibilityDate,
    COMPATIBILITY_DATE,
    'Miniflare must run the production compatibility date',
  )
  t.diagnostic(`workerd compatibility date ${COMPATIBILITY_DATE}`)
  const mf = new miniflare.Miniflare(converted as never)
  try {
    await mf.ready
  } catch (error) {
    await mf.dispose().catch(() => {})
    throw error
  }
  t.after(() => mf.dispose())
  return mf
}

const {privateKey, publicKey} = await generateKeyPair('RS256')
const otherKey = (await generateKeyPair('RS256')).privateKey
const signingKey = await exportJWK(publicKey)
const jwk = {...signingKey, kid: 'test-key', alg: 'RS256', use: 'sig'}

async function sign(
  payload: Record<string, unknown> = {},
  options: {
    issuer?: string
    audience?: string
    key?: CryptoKey
    kid?: string
  } = {},
) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    sub: 'owner',
    scope: 'glyph:read glyph:publish glyph:state',
    exp: now + 300,
    ...payload,
  })
    .setProtectedHeader({alg: 'RS256', kid: options.kid ?? 'test-key'})
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? `${PUBLIC_URL}/mcp`)
    .sign(options.key ?? privateKey)
}

let publications = 0
let managedAuthorization: string | undefined
let forwardedCookie: string | undefined
let forwardedOrigin: string | undefined
let rejectUpstream = false

const backend = createServer(async (req, res) => {
  managedAuthorization = req.headers.authorization
  forwardedCookie = req.headers.cookie
  forwardedOrigin = req.headers.origin
  const server = new McpServer(
    {name: 'mock Devvit gateway', version: '1'},
    {capabilities: {tools: {}}},
  )
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toolDefinitions(),
  }))
  server.setRequestHandler(CallToolRequestSchema, request => {
    if (request.params.name === 'publish_post') publications++
    const data = {status: 'succeeded', post: {id: 't3_mocked'}}
    return {
      content: [{type: 'text', text: JSON.stringify(data)}],
      structuredContent: data,
    }
  })
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res)
})
await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
const backendAddress = backend.address()
assert.ok(backendAddress && typeof backendAddress !== 'string')
const backendPort = backendAddress.port

after(async () => {
  await new Promise<void>(resolve => backend.close(() => resolve()))
  await rm(bundleDir, {recursive: true, force: true})
})

type Counters = {
  discovery: number
  jwks: number
  devvit: number
  redirects: number
}
type DiscoveryMode = 'ok' | 'redirect'
type JwksMode = 'ok' | 'redirect'
type DevvitMode =
  | 'proxy'
  | 'redirect'
  | 'reject'
  | 'rate-limit'
  | 'accepted'
  | 'no-content'
type MockOptions = {
  discovery?: DiscoveryMode
  jwks?: JwksMode
  devvit?: DevvitMode | DevvitMode[] | (() => DevvitMode)
  keys?: () => unknown[]
  jwksDelayMs?: () => number
}
const REDIRECT_TARGET = 'https://redirected.example/not-followed'

function redirectResponse() {
  return new Response('redirect target must not be followed', {
    status: 302,
    headers: {Location: REDIRECT_TARGET},
  })
}

function mockOutbound(counters: Counters, options: MockOptions = {}) {
  return async (request: Request) => {
    if (request.url === REDIRECT_TARGET) {
      counters.redirects++
      return new Response('redirect followed', {status: 200})
    }
    if (request.url === DISCOVERY) {
      counters.discovery++
      switch (options.discovery ?? 'ok') {
        case 'redirect':
          return redirectResponse()
        default:
          return Response.json({issuer: ISSUER, jwks_uri: JWKS})
      }
    }
    if (request.url === JWKS) {
      counters.jwks++
      const delay = options.jwksDelayMs?.() ?? 0
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      if (options.jwks === 'redirect') return redirectResponse()
      return Response.json({keys: (options.keys ?? (() => [jwk]))()})
    }
    if (request.url !== MCP_URL) {
      counters.devvit++
      return new Response('unexpected outbound request', {status: 502})
    }
    counters.devvit++
    assert.equal(
      request.headers.get('authorization'),
      `Bearer ${MANAGED_TOKEN}`,
    )
    const configured = options.devvit
    const mode =
      typeof configured === 'function'
        ? configured()
        : Array.isArray(configured)
          ? (configured.shift() ?? 'proxy')
          : (configured ?? 'proxy')
    switch (mode) {
      case 'redirect':
        return redirectResponse()
      case 'reject':
        return new Response(`private upstream error ${MANAGED_TOKEN}`, {
          status: 401,
        })
      case 'rate-limit':
        return new Response('private upstream rate limit', {
          status: 429,
          headers: {'Retry-After': '17'},
        })
      case 'accepted':
        return new Response(null, {status: 202})
      case 'no-content':
        return new Response(null, {status: 204})
      case 'proxy':
        break
    }
    const headers = new Headers()
    for (const name of [
      'authorization',
      'content-type',
      'accept',
      'mcp-protocol-version',
    ]) {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    }
    return fetch(`http://127.0.0.1:${backendPort}/external/mcp`, {
      method: request.method,
      headers,
      body: request.method === 'GET' ? undefined : await request.text(),
    })
  }
}

function post(
  mf: InstanceType<typeof miniflare.Miniflare>,
  token: string | undefined,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return mf.dispatchFetch('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      ...headers,
    },
    body: JSON.stringify(payload),
  })
}

test('unconfigured Worker is safe, reports readiness, and makes no network calls', async t => {
  const counters = {discovery: 0, jwks: 0, devvit: 0, redirects: 0}
  const mf = await createWorker(t, {outboundService: mockOutbound(counters)})

  const health = await mf.dispatchFetch('http://localhost/health')
  assert.equal(health.status, 503)
  const healthBody = (await health.json()) as {
    ready: boolean
    configured: boolean
    missing: string[]
  }
  assert.equal(healthBody.ready, false)
  assert.equal(healthBody.configured, false)
  assert.deepEqual(healthBody.missing, [
    'PUBLIC_URL',
    'OAUTH_ISSUER',
    'OAUTH_SUBJECT',
    'DEVVIT_MCP_URL',
    'DEVVIT_TOKEN',
  ])

  for (const path of ['/mcp', '/.well-known/oauth-protected-resource']) {
    const response = await mf.dispatchFetch(`http://localhost${path}`, {
      method: path === '/mcp' ? 'POST' : 'GET',
      headers: {'Content-Type': 'application/json'},
      body: path === '/mcp' ? '{}' : undefined,
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {error: 'Service unavailable'})
  }
  const unknown = await mf.dispatchFetch('http://localhost/worker/claim')
  assert.equal(unknown.status, 404)
  assert.deepEqual(await unknown.json(), {error: 'Not found'})
  assert.deepEqual(counters, {
    discovery: 0,
    jwks: 0,
    devvit: 0,
    redirects: 0,
  })
})

test('invalid and partial configuration never exposes values or makes network calls', async t => {
  const counters = {discovery: 0, jwks: 0, devvit: 0, redirects: 0}
  const mf = await createWorker(t, {
    bindings: {
      ...config,
      DEVVIT_TOKEN: `${SECRET}!`,
      OAUTH_ISSUER: `https://auth.example/?leak=${SECRET}`,
    },
    outboundService: mockOutbound(counters),
  })
  const health = await mf.dispatchFetch('http://localhost/health')
  assert.equal(health.status, 503)
  const healthText = await health.text()
  assert.match(healthText, /OAUTH_ISSUER/)
  assert.match(healthText, /DEVVIT_TOKEN/)
  assert.doesNotMatch(healthText, new RegExp(SECRET))
  assert.doesNotMatch(healthText, /leak=/)
  assert.equal(
    (await post(mf, undefined, {jsonrpc: '2.0', id: 1, method: 'ping'})).status,
    503,
  )
  const mcpText = await (
    await post(mf, undefined, {jsonrpc: '2.0', id: 1, method: 'ping'})
  ).text()
  assert.deepEqual(JSON.parse(mcpText), {error: 'Service unavailable'})
  assert.doesNotMatch(mcpText, new RegExp(SECRET))
  assert.deepEqual(counters, {
    discovery: 0,
    jwks: 0,
    devvit: 0,
    redirects: 0,
  })
})

test('configured health and OAuth metadata are configuration-only and network-free', async t => {
  const counters = {discovery: 0, jwks: 0, devvit: 0, redirects: 0}
  const mf = await createWorker(t, {
    bindings: {...config, HOST: 123, PORT: 'not-a-port'},
    outboundService: mockOutbound(counters),
  })
  const health = await mf.dispatchFetch('http://localhost/health')
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), {
    status: 'ok',
    ready: true,
    configured: true,
    liveVerified: false,
  })
  const metadata = await mf.dispatchFetch(
    'https://arbitrary-host.example/.well-known/oauth-protected-resource',
  )
  assert.equal(metadata.status, 200)
  const metadataText = await metadata.text()
  assert.deepEqual(JSON.parse(metadataText), {
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: [ISSUER],
    scopes_supported: ['glyph:read', 'glyph:publish', 'glyph:state'],
  })
  assert.doesNotMatch(metadataText, new RegExp(MANAGED_TOKEN))
  assert.deepEqual(counters, {
    discovery: 0,
    jwks: 0,
    devvit: 0,
    redirects: 0,
  })
})

test('real MCP initialize/list/call proxies with managed credentials and caches completed auth', async t => {
  const counters = {discovery: 0, jwks: 0, devvit: 0, redirects: 0}
  const mf = await createWorker(t, {
    bindings: config,
    outboundService: mockOutbound(counters, {
      devvit: () => (rejectUpstream ? 'reject' : 'proxy'),
    }),
  })
  const url = await mf.ready
  const owner = await sign()
  const client = new Client({name: 'worker test', version: '1'})
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', url), {
      requestInit: {headers: {Authorization: `Bearer ${owner}`}},
    }),
  )
  try {
    const tools = (await client.listTools()).tools
    assert.equal(tools.length, 7)
    assert.equal(
      tools.find(tool => tool.name === 'publish_post')?.annotations
        ?.readOnlyHint,
      false,
    )
    const result = await client.callTool({
      name: 'publish_post',
      arguments: {
        title: 'Worker test',
        body: 'explicit mock',
        requestId: randomUUID(),
      },
    })
    assert.equal(result.isError, undefined)
    assert.equal(publications, 1)
    assert.equal(managedAuthorization, `Bearer ${MANAGED_TOKEN}`)
    assert.equal(forwardedCookie, undefined)
    assert.equal(forwardedOrigin, undefined)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(MANAGED_TOKEN))
    assert.doesNotMatch(JSON.stringify(result), new RegExp(owner))
  } finally {
    await client.close()
  }
  assert.equal(counters.discovery, 1)
  assert.equal(counters.jwks, 1)

  // A second MCP session in the same isolate reuses the completed verifier.
  const again = await mf.dispatchFetch('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${owner}`,
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 2, method: 'ping'}),
  })
  assert.equal(again.status, 200)
  assert.equal(counters.discovery, 1)
  assert.equal(counters.jwks, 1)

  const missing = await post(mf, undefined, {
    jsonrpc: '2.0',
    id: 3,
    method: 'ping',
  })
  assert.equal(missing.status, 401)
  assert.match(
    missing.headers.get('www-authenticate') ?? '',
    /oauth-protected-resource/,
  )
  assert.equal(
    (
      await post(mf, 'not-a-jwt', {
        jsonrpc: '2.0',
        id: 4,
        method: 'ping',
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await post(mf, await sign({}, {audience: 'https://other.example/mcp'}), {
        jsonrpc: '2.0',
        id: 5,
        method: 'ping',
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await post(mf, await sign({}, {issuer: 'https://evil.example/'}), {
        jsonrpc: '2.0',
        id: 6,
        method: 'ping',
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await post(mf, await sign({}, {key: otherKey}), {
        jsonrpc: '2.0',
        id: 13,
        method: 'ping',
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await post(mf, await sign({exp: Math.floor(Date.now() / 1000) - 5}), {
        jsonrpc: '2.0',
        id: 7,
        method: 'ping',
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await post(
        mf,
        await sign(),
        {jsonrpc: '2.0', id: 8, method: 'ping'},
        {Origin: 'https://evil.example'},
      )
    ).status,
    403,
  )
  assert.equal(
    (
      await post(mf, await sign({sub: 'someone-else'}), {
        jsonrpc: '2.0',
        id: 9,
        method: 'ping',
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await post(mf, await sign({scope: 'glyph:publish'}), {
        jsonrpc: '2.0',
        id: 10,
        method: 'ping',
      })
    ).status,
    403,
  )

  const reader = await sign({scope: 'glyph:read'})
  const denied = await post(mf, reader, {
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {name: 'write_memory', arguments: {value: null, version: 0}},
  })
  assert.equal(denied.status, 200)
  const deniedBody = (await denied.json()) as {
    result: {isError?: boolean; _meta: Record<string, unknown>}
  }
  assert.equal(deniedBody.result.isError, true)
  assert.ok(deniedBody.result._meta['mcp/www_authenticate'])
  assert.equal(publications, 1)

  rejectUpstream = true
  try {
    const unavailable = await post(mf, owner, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/list',
    })
    assert.equal(unavailable.status, 502)
    const text = await unavailable.text()
    assert.doesNotMatch(text, /private upstream/)
    assert.doesNotMatch(text, new RegExp(MANAGED_TOKEN))
  } finally {
    rejectUpstream = false
  }
  assert.equal(counters.discovery, 1)
  assert.equal(counters.jwks, 1)
})

test('per-isolate rate limit returns a generic 429 without outbound traffic', async t => {
  const counters = {discovery: 0, jwks: 0, devvit: 0, redirects: 0}
  const mf = await createWorker(t, {
    bindings: config,
    outboundService: mockOutbound(counters),
  })
  for (let index = 0; index < 120; index++)
    assert.equal(
      (
        await post(mf, undefined, {
          jsonrpc: '2.0',
          id: index,
          method: 'ping',
        })
      ).status,
      401,
    )
  const limited = await post(mf, undefined, {
    jsonrpc: '2.0',
    id: 120,
    method: 'ping',
  })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '60')
  assert.deepEqual(await limited.json(), {error: 'Rate limited'})
  assert.deepEqual(counters, {
    discovery: 0,
    jwks: 0,
    devvit: 0,
    redirects: 0,
  })
})

test('Worker rejects discovery, JWKS, and Devvit redirects without following them', async t => {
  const scenarios: {
    name: string
    options: MockOptions
    foreignSignature?: boolean
    status: number
    counters: Counters
  }[] = [
    {
      name: 'discovery redirect',
      options: {discovery: 'redirect'},
      foreignSignature: true,
      status: 401,
      counters: {discovery: 1, jwks: 0, devvit: 0, redirects: 0},
    },
    {
      name: 'JWKS redirect',
      options: {jwks: 'redirect'},
      status: 401,
      counters: {discovery: 1, jwks: 1, devvit: 0, redirects: 0},
    },
    {
      name: 'Devvit redirect',
      options: {devvit: 'redirect'},
      status: 502,
      counters: {discovery: 1, jwks: 1, devvit: 1, redirects: 0},
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async t => {
      const counters = {discovery: 0, jwks: 0, devvit: 0, redirects: 0}
      const mf = await createWorker(t, {
        bindings: config,
        outboundService: mockOutbound(counters, scenario.options),
      })
      const token = scenario.foreignSignature
        ? await sign({}, {key: otherKey})
        : await sign()
      const response = await post(mf, token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
      })
      assert.equal(response.status, scenario.status)
      const text = await response.text()
      assert.doesNotMatch(text, new RegExp(MANAGED_TOKEN))
      assert.doesNotMatch(text, /private|redirect target|followed/i)
      if (scenario.status === 401) {
        assert.deepEqual(JSON.parse(text), {error: 'Authentication required'})
        assert.match(
          response.headers.get('www-authenticate') ?? '',
          /oauth-protected-resource/,
        )
      } else
        assert.deepEqual(JSON.parse(text), {
          error:
            'Devvit unavailable or configuration rejected. A publication may be uncertain; retry only with the same requestId.',
        })
      assert.deepEqual(counters, scenario.counters)
    })
  }
})

test('Worker maps upstream rate limits and passes through accepted empty responses', async t => {
  const counters = {discovery: 0, jwks: 0, devvit: 0, redirects: 0}
  const mf = await createWorker(t, {
    bindings: config,
    outboundService: mockOutbound(counters, {
      devvit: ['rate-limit', 'accepted', 'no-content'],
    }),
  })
  const owner = await sign()

  const limited = await post(mf, owner, {
    jsonrpc: '2.0',
    id: 1,
    method: 'ping',
  })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '17')
  const limitedText = await limited.text()
  assert.match(limitedText, /Devvit rate limited/)
  assert.doesNotMatch(limitedText, /private|upstream/i)

  const accepted = await post(mf, owner, {
    jsonrpc: '2.0',
    id: 2,
    method: 'ping',
  })
  assert.equal(accepted.status, 202)
  assert.equal(await accepted.text(), '')

  const noContent = await post(mf, owner, {
    jsonrpc: '2.0',
    id: 3,
    method: 'ping',
  })
  assert.equal(noContent.status, 204)
  assert.equal(await noContent.text(), '')

  assert.deepEqual(counters, {
    discovery: 1,
    jwks: 1,
    devvit: 3,
    redirects: 0,
  })
})

test('five concurrent cold requests authenticate and reload a rotated JWKS after cooldown', {
  timeout: 60_000,
}, async t => {
  const counters = {discovery: 0, jwks: 0, devvit: 0, redirects: 0}
  // This rotation key is local to this test, not the shared signing keys.
  const rotated = await generateKeyPair('RS256')
  let activeJwk = jwk
  const mf = await createWorker(t, {
    bindings: config,
    outboundService: mockOutbound(counters, {
      keys: () => [activeJwk],
      // Keep every JWKS response in flight long enough for all concurrent
      // requests to reach their own jose resolver call.
      jwksDelayMs: () => 150,
    }),
  })

  const owner = await sign()
  const cold = await Promise.all(
    Array.from({length: 5}, (_, index) =>
      post(mf, owner, {jsonrpc: '2.0', id: index + 1, method: 'ping'}),
    ),
  )
  for (const response of cold) {
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /"jsonrpc":"2.0"/)
    assert.doesNotMatch(body, /"error"/)
  }
  assert.equal(managedAuthorization, `Bearer ${MANAGED_TOKEN}`)
  assert.equal(counters.discovery, 5)
  assert.equal(counters.jwks, 5)
  assert.equal(counters.devvit, 5)

  const jwksBeforeRotation = counters.jwks
  // jose's remote JWKS cooldown is fixed at 30 seconds in production.
  await new Promise(resolve => setTimeout(resolve, 31_000))
  activeJwk = {
    ...(await exportJWK(rotated.publicKey)),
    kid: 'rotated-key',
    alg: 'RS256',
    use: 'sig',
  }
  const rotatedOwner = await sign(
    {},
    {key: rotated.privateKey, kid: 'rotated-key'},
  )
  const refreshed = await Promise.all(
    Array.from({length: 5}, (_, index) =>
      post(mf, rotatedOwner, {
        jsonrpc: '2.0',
        id: index + 10,
        method: 'ping',
      }),
    ),
  )
  for (const response of refreshed) {
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /"jsonrpc":"2.0"/)
    assert.doesNotMatch(body, /"error"/)
  }
  assert.equal(managedAuthorization, `Bearer ${MANAGED_TOKEN}`)
  // The verifier itself is cached: rotation must not redo discovery.
  assert.equal(counters.discovery, 5)
  // jose 6.2.13 clears pending JWKS work per request on Cloudflare Workers,
  // so each of the five concurrent unknown-kid requests reloads once.
  assert.equal(counters.jwks - jwksBeforeRotation, 5)
  assert.equal(counters.jwks, 10)
  assert.equal(counters.devvit, 10)
  assert.equal(counters.redirects, 0)
})
