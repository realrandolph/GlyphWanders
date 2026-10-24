import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {createRequire} from 'node:module'
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

// Use the newest installed workerd if available; Miniflare's bundled copy may
// predate the production compatibility date.
try {
  process.env.MINIFLARE_WORKERD_PATH ??= createRequire(import.meta.url).resolve(
    'workerd/bin/workerd',
  )
} catch {}

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

type Strategy = {date: string; flags?: string[]}
const convertV4 = (
  miniflare as unknown as {
    convertV4MiniflareOptions?: (options: unknown) => unknown
  }
).convertV4MiniflareOptions
const isV5 = typeof convertV4 === 'function'
// Prefer the production compatibility date. Older Miniflare/workerd builds
// reject dates newer than their binary; the fallback date still has Node
// compatibility enabled by default and the same node:http server support.
const strategies: Strategy[] = isV5
  ? [{date: '2026-10-24'}, {date: '2026-08-03', flags: ['nodejs_compat']}]
  : [{date: '2026-08-03', flags: ['nodejs_compat']}]
let chosen: Strategy | undefined

async function createWorker(
  t: import('node:test').TestContext,
  options: Record<string, unknown> = {},
) {
  const attempts = chosen ? [chosen] : strategies
  let lastError: unknown
  for (const strategy of attempts) {
    let mf: InstanceType<typeof miniflare.Miniflare> | undefined
    try {
      const workerOptions = {
        modules: true,
        script: bundleSource,
        compatibilityDate: strategy.date,
        compatibilityFlags: strategy.flags,
        log: new miniflare.Log(miniflare.LogLevel.NONE),
        ...options,
      }
      mf = new miniflare.Miniflare(
        (isV5 ? convertV4?.(workerOptions) : workerOptions) as never,
      )
      await mf.ready
      chosen = strategy
      t.after(() => mf?.dispose())
      return mf
    } catch (error) {
      lastError = error
      await mf?.dispose().catch(() => {})
    }
  }
  throw lastError
}

const {privateKey, publicKey} = await generateKeyPair('RS256')
const otherKey = (await generateKeyPair('RS256')).privateKey
const signingKey = await exportJWK(publicKey)
const jwk = {...signingKey, kid: 'test-key', alg: 'RS256', use: 'sig'}

async function sign(
  payload: Record<string, unknown> = {},
  options: {issuer?: string; audience?: string; key?: CryptoKey} = {},
) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    sub: 'owner',
    scope: 'glyph:read glyph:publish glyph:state',
    exp: now + 300,
    ...payload,
  })
    .setProtectedHeader({alg: 'RS256', kid: 'test-key'})
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

function mockOutbound(counters: {
  discovery: number
  jwks: number
  devvit: number
}) {
  return async (request: Request) => {
    if (request.url === DISCOVERY) {
      counters.discovery++
      return Response.json({issuer: ISSUER, jwks_uri: JWKS})
    }
    if (request.url === JWKS) {
      counters.jwks++
      return Response.json({keys: [jwk]})
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
    if (rejectUpstream)
      return new Response(`private upstream error ${MANAGED_TOKEN}`, {
        status: 401,
      })
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
  const counters = {discovery: 0, jwks: 0, devvit: 0}
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
  assert.deepEqual(counters, {discovery: 0, jwks: 0, devvit: 0})
})

test('invalid and partial configuration never exposes values or makes network calls', async t => {
  const counters = {discovery: 0, jwks: 0, devvit: 0}
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
  assert.deepEqual(counters, {discovery: 0, jwks: 0, devvit: 0})
})

test('configured health and OAuth metadata are configuration-only and network-free', async t => {
  const counters = {discovery: 0, jwks: 0, devvit: 0}
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
  assert.deepEqual(counters, {discovery: 0, jwks: 0, devvit: 0})
})

test('real MCP initialize/list/call proxies with managed credentials and caches completed auth', async t => {
  const counters = {discovery: 0, jwks: 0, devvit: 0}
  const mf = await createWorker(t, {
    bindings: config,
    outboundService: mockOutbound(counters),
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
  const counters = {discovery: 0, jwks: 0, devvit: 0}
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
  assert.deepEqual(counters, {discovery: 0, jwks: 0, devvit: 0})
})
