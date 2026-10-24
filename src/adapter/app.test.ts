import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {test} from 'node:test'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {toolDefinitions} from '../shared/tools.ts'
import {createAdapter} from './app.ts'
import {configSchema} from './config.ts'

test('stateless proxy preserves real MCP transport and enforces owner/scopes without leaking credentials', async () => {
  const config = configSchema.parse({
    PUBLIC_URL: 'https://glyph.example',
    OAUTH_ISSUER: 'https://auth.example/',
    OAUTH_SUBJECT: 'owner',
    DEVVIT_MCP_URL:
      'https://glyphwanders-abc123-external.devvit.net/external/mcp',
    DEVVIT_TOKEN: `devvit_at_${'x'.repeat(40)}`,
  })
  let forwarded = 0
  let publications = 0
  let rejectUpstream = false
  let rateLimited = false
  const backend = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${config.DEVVIT_TOKEN}`)
    assert.equal(req.headers.cookie, undefined)
    assert.equal(req.headers.origin, undefined)
    const server = new Server(
      {name: 'mock Devvit gateway', version: '1'},
      {capabilities: {tools: {}}},
    )
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: toolDefinitions(),
    }))
    server.setRequestHandler(CallToolRequestSchema, request => {
      if (request.params.name === 'publish_post') publications++
      const data = {status: 'succeeded', redditId: 't3_test'}
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
  }).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => backend.once('listening', resolve))
  const address = backend.address()
  assert.ok(address && typeof address !== 'string')
  const fetchUpstream: typeof fetch = async (url, init) => {
    assert.equal(url, config.DEVVIT_MCP_URL)
    assert.equal(init?.redirect, 'error')
    forwarded++
    if (rateLimited)
      return new Response(null, {status: 429, headers: {'Retry-After': '12'}})
    if (rejectUpstream)
      return new Response('private error containing secrets', {status: 401})
    return fetch(`http://127.0.0.1:${address.port}/external/mcp`, init)
  }
  const app = createServer(
    createAdapter(
      config,
      async token => {
        if (!['owner', 'reader', 'stranger'].includes(token))
          throw new Error('Invalid token')
        return {
          sub: token === 'stranger' ? 'other-user' : 'owner',
          scopes:
            token === 'reader'
              ? ['glyph:read']
              : ['glyph:read', 'glyph:publish', 'glyph:state'],
        }
      },
      fetchUpstream,
    ),
  ).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => app.once('listening', resolve))
  const appAddress = app.address()
  assert.ok(appAddress && typeof appAddress !== 'string')
  const base = `http://127.0.0.1:${appAddress.port}`
  const clients: Client[] = []
  async function connect(token: string) {
    const client = new Client({name: 'test', version: '1'})
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: {
          headers: {Authorization: `Bearer ${token}`, Cookie: 'private=cookie'},
        },
      }),
    )
    clients.push(client)
    return client
  }
  const post = (
    value: unknown,
    token = 'owner',
    extra: Record<string, string> = {},
  ) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...extra,
      },
      body: JSON.stringify(value),
    })
  const write = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'publish_post',
      arguments: {
        title: 'Test',
        body: 'explicit mock',
        requestId: randomUUID(),
      },
    },
  }
  try {
    const metadata = await (
      await fetch(`${base}/.well-known/oauth-protected-resource`)
    ).json()
    assert.equal(metadata.resource, 'https://glyph.example/mcp')
    assert.doesNotMatch(JSON.stringify(metadata), /devvit_at_/)
    const denied = await post(write, 'invalid')
    assert.equal(denied.status, 401)
    assert.match(
      denied.headers.get('www-authenticate') ?? '',
      /oauth-protected-resource/,
    )
    assert.equal((await post(write, 'stranger')).status, 403)
    assert.equal((await post(write, config.DEVVIT_TOKEN)).status, 401)
    assert.equal(
      (await post(write, 'owner', {Origin: 'https://evil.example'})).status,
      403,
    )
    assert.equal((await post([write])).status, 400)
    assert.equal(
      (await post({...write, params: {name: '__proto__'}})).status,
      400,
    )
    assert.equal(forwarded, 0)
    const reader = await connect('reader')
    const deniedWrite = await reader.callTool(write.params)
    assert.equal(deniedWrite.isError, true)
    assert.ok(deniedWrite._meta?.['mcp/www_authenticate'])
    assert.equal(publications, 0)
    const owner = await connect('owner')
    const tools = (await owner.listTools()).tools
    assert.equal(tools.length, 7)
    assert.equal(
      tools.find(tool => tool.name === 'publish_post')?.annotations
        ?.readOnlyHint,
      false,
    )
    assert.equal((await owner.callTool(write.params)).isError, undefined)
    assert.equal(publications, 1)
    rateLimited = true
    const cooldown = await post(write)
    assert.equal(cooldown.status, 429)
    assert.equal(cooldown.headers.get('retry-after'), '12')
    rateLimited = false
    rejectUpstream = true
    const unavailable = await post(write)
    assert.equal(unavailable.status, 502)
    assert.doesNotMatch(
      await unavailable.text(),
      /private error|devvit_at_|cookie/,
    )
    assert.equal(
      (await fetch(`${base}/worker/claim`, {method: 'POST'})).status,
      404,
    )
  } finally {
    for (const client of clients) await client.close()
    await new Promise<void>(resolve => app.close(() => resolve()))
    await new Promise<void>(resolve => backend.close(() => resolve()))
  }
})
