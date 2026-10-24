import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {test} from 'node:test'
import {type Context, runWithContext} from '@devvit/web/server'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {generateKeyPair, SignJWT} from 'jose'
import {runSmoke} from '../../scripts/smoke.ts'
import {
  createExecutor,
  type RedditApi,
  type RedditPost,
} from '../server/executor.ts'
import {createJournal} from '../server/journal.ts'
import {MemoryRedis} from '../server/memory-redis.ts'
import {createOnReq} from '../server/server.ts'
import {createAdapter} from './app.ts'
import {verifyAccessToken} from './auth.ts'
import {configSchema} from './config.ts'

test('real OAuth → adapter → Devvit MCP → mocked Reddit/native Redis flow, including safe smoke flags', async () => {
  const config = configSchema.parse({
    PUBLIC_URL: 'https://glyph.example',
    OAUTH_ISSUER: 'https://auth.example/',
    OAUTH_SUBJECT: 'owner',
    DEVVIT_MCP_URL:
      'https://glyphwanders-abc123-external.devvit.net/external/mcp',
    DEVVIT_TOKEN: `devvit_at_${'x'.repeat(40)}`,
  })
  const {privateKey, publicKey} = await generateKeyPair('RS256')
  const token = await new SignJWT({
    sub: 'owner',
    scope: 'glyph:read glyph:publish glyph:state',
  })
    .setProtectedHeader({alg: 'RS256'})
    .setIssuer(config.OAUTH_ISSUER)
    .setAudience('https://glyph.example/mcp')
    .setExpirationTime('5m')
    .sign(privateKey)
  const redis = new MemoryRedis()
  const posts = new Map<string, RedditPost>()
  let postWrites = 0
  let replyWrites = 0
  const empty = () => ({hasMore: false, children: [], get: async () => []})
  const api: RedditApi = {
    getNewPosts: () => ({hasMore: false, get: async () => [...posts.values()]}),
    getPostById: async id => {
      const post = posts.get(id)
      if (!post) throw new Error('Unknown mock post')
      return post
    },
    getCommentById: async () => {
      throw new Error('No mock comment read expected')
    },
    getComments: empty,
    submitPost: async args => {
      postWrites++
      const post = {
        id: 't3_mocked',
        title: args.title,
        body: args.text,
        subredditName: args.subredditName,
        authorName: 'glyphwanders',
        permalink: '/r/GlyphsPlayground/comments/mocked',
        createdAt: new Date(),
        numberOfComments: 0,
      }
      posts.set(post.id, post)
      return post
    },
    submitComment: async args => {
      replyWrites++
      assert.equal(args.id, 't3_mocked')
      return {
        id: 't1_mocked',
        parentId: args.id,
        postId: args.id,
        body: args.text,
        subredditName: 'GlyphsPlayground',
        authorName: 'glyphwanders',
        permalink: '/r/GlyphsPlayground/comments/mocked/comment/mocked',
        createdAt: new Date(),
      }
    },
  }
  // Local gateway mock enforces the managed token; production enforcement belongs to Reddit.
  const backend = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${config.DEVVIT_TOKEN}`)
    const handler = createOnReq({
      executor: createExecutor(api),
      journal: createJournal(redis),
      getComment: api.getCommentById,
    })
    await runWithContext(
      {appName: 'glyphwanders', subredditName: 'GlyphsPlayground'} as Context,
      () => handler(req, res),
    )
  }).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => backend.once('listening', resolve))
  const backAddress = backend.address()
  assert.ok(backAddress && typeof backAddress !== 'string')
  const app = createServer(
    createAdapter(
      config,
      value => verifyAccessToken(value, publicKey, config),
      async (url, init) => {
        assert.equal(url, config.DEVVIT_MCP_URL)
        return fetch(`http://127.0.0.1:${backAddress.port}/external/mcp`, init)
      },
    ),
  ).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => app.once('listening', resolve))
  const appAddress = app.address()
  assert.ok(appAddress && typeof appAddress !== 'string')
  const client = new Client({name: 'local integration test', version: '1'})
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${appAddress.port}/mcp`),
        {requestInit: {headers: {Authorization: `Bearer ${token}`}}},
      ),
    )
    const tools = (await client.listTools()).tools
    assert.equal(tools.length, 7)
    assert.ok(tools.every(tool => tool._meta?.securitySchemes))
    await runSmoke(client)
    assert.equal(postWrites + replyWrites, 0)
    await runSmoke(client, ['--publish-confirmed', '--persist-confirmed'])
    assert.equal(postWrites, 1)
    assert.equal(replyWrites, 1)
    const memory = await client.callTool({name: 'read_memory', arguments: {}})
    assert.ok(memory.structuredContent)
    assert.equal(
      (memory.structuredContent.memory as {version: number}).version,
      2,
    )
    assert.equal((memory.structuredContent.memory as {value: null}).value, null)
    const history = await client.callTool({
      name: 'participation_history',
      arguments: {},
    })
    assert.ok(history.structuredContent)
    assert.equal(
      (history.structuredContent.publications as unknown[]).length,
      2,
    )
    const thread = await client.callTool({
      name: 'get_thread',
      arguments: {postId: 't3_mocked'},
    })
    assert.equal(thread.isError, undefined)
    assert.equal(
      thread.structuredContent?.post &&
        (thread.structuredContent.post as {id: string}).id,
      't3_mocked',
    )
    // A new request id with identical content is still not permission to duplicate publication.
    await runSmoke(client, ['--publish-confirmed'])
    assert.equal(postWrites, 1)
    assert.equal(replyWrites, 1)
  } finally {
    await client.close()
    await new Promise<void>(resolve => app.close(() => resolve()))
    await new Promise<void>(resolve => backend.close(() => resolve()))
  }
})
