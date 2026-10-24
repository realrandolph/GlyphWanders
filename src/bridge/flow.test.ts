import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {test} from 'node:test'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {generateKeyPair, SignJWT} from 'jose'
import {pollOnce, postCommentEvent} from '../server/bridge.ts'
import {handleCommentCreate} from '../server/comment-events.ts'
import {
  createExecutor,
  type RedditApi,
  type RedditComment,
  type RedditPost,
} from '../server/executor.ts'
import {createApp, verifyAccessToken} from './app.ts'
import {configSchema} from './config.ts'
import {Store} from './store.ts'

test('end-to-end MCP → SQLite → Devvit poller → Reddit adapter boundary → result', async () => {
  const config = configSchema.parse({
    PUBLIC_URL: 'https://bridge.example',
    OAUTH_ISSUER: 'https://issuer.example/',
    OAUTH_SUBJECT: 'owner',
    WORKER_TOKEN: 'w'.repeat(64),
  })
  const {privateKey, publicKey} = await generateKeyPair('RS256')
  const token = await new SignJWT({
    scope: 'glyph:read glyph:publish glyph:state',
  })
    .setProtectedHeader({alg: 'RS256'})
    .setSubject('owner')
    .setIssuer(config.OAUTH_ISSUER)
    .setAudience(`${config.PUBLIC_URL}/mcp`)
    .setExpirationTime('5m')
    .sign(privateKey)
  const store = new Store(':memory:')
  const server = createApp(config, store, value =>
    verifyAccessToken(value, publicKey, config),
  ).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const local = `http://127.0.0.1:${address.port}`
  const client = new Client({name: 'full bridge test', version: '1'})
  let writes = 0
  const post: RedditPost = {
    id: 't3_post',
    title: 'Discussion',
    body: 'Untrusted Reddit text',
    authorName: 'human',
    subredditName: 'GlyphsPlayground',
    permalink: '/r/GlyphsPlayground/comments/post/',
    createdAt: new Date(),
    numberOfComments: 1,
  }
  const comment: RedditComment = {
    id: 't1_comment',
    parentId: post.id,
    postId: post.id,
    authorName: 'human',
    subredditName: 'GlyphsPlayground',
    body: 'An old post can get a new reply',
    permalink: '/r/GlyphsPlayground/comments/post/_/comment/',
    createdAt: new Date(),
  }
  const listing = <T>(items: T[]) => ({
    hasMore: false,
    get: async (n: number) => items.slice(0, n),
  })
  const api: RedditApi = {
    getPostById: async () => post,
    getCommentById: async () => comment,
    getNewPosts: () => listing([post]),
    getComments: () => listing([comment]),
    submitPost: async options => {
      writes++
      return {...post, title: options.title, body: options.text}
    },
    submitComment: async options => {
      writes++
      return {...comment, body: options.text, parentId: options.id}
    },
  }
  const executor = createExecutor(api)
  const bridgeConfig = {url: config.PUBLIC_URL, token: config.WORKER_TOKEN}
  const fetchImpl = (url: string, init: RequestInit) =>
    fetch(url.replace(config.PUBLIC_URL, local), init)
  const tick = () =>
    pollOnce({
      getConfig: async () => bridgeConfig,
      execute: executor.execute,
      fetchImpl,
    })
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await client.callTool({name, arguments: args})
    assert.notEqual(response.isError, true, JSON.stringify(response.content))
    return response.structuredContent as Record<string, unknown>
  }
  async function run(name: string, args: Record<string, unknown> = {}) {
    const queued = (await call(name, args)).operation as {id: string}
    assert.equal((await tick()).status, 'completed')
    const result = (await call('get_operation', {id: queued.id})).operation as {
      id: string
      status: string
      result: Record<string, unknown>
    }
    assert.equal(result.status, 'succeeded')
    return result
  }
  try {
    assert.equal(
      (
        await fetch(`${local}/mcp`, {
          method: 'POST',
          headers: {Authorization: `Bearer ${config.WORKER_TOKEN}`},
        })
      ).status,
      401,
    )
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${local}/mcp`), {
        requestInit: {headers: {Authorization: `Bearer ${token}`}},
      }),
    )
    await handleCommentCreate(
      {comment: {id: comment.id}},
      {
        getComment: api.getCommentById,
        postComment: event =>
          postCommentEvent(bridgeConfig, event.comment, fetchImpl),
      },
    )
    const discovered = await call('read_recent_comments')
    assert.deepEqual(
      (discovered.comments as {id: string}[]).map(c => c.id),
      [comment.id],
    )
    // Discovery persists metadata, never comment text or author details.
    assert.doesNotMatch(
      JSON.stringify(store.recentComments(10)),
      /old post|human/,
    )
    const activity = await run('read_activity')
    assert.equal((activity.result.posts as {id: string}[])[0]?.id, post.id)
    const thread = await run('get_thread', {
      postId: post.id,
      commentId: comment.id,
    })
    assert.equal((thread.result.comments as {id: string}[])[0]?.id, comment.id)
    const args = {
      title: 'Explicit test',
      body: 'ChatGPT-authored and owner-approved',
      requestId: randomUUID(),
    }
    const published = await run('publish_post', args)
    const replyTo = (published.result.post as {id: string}).id
    await run('reply', {
      parentId: replyTo,
      body: 'Approved reply',
      requestId: randomUUID(),
    })
    assert.equal(writes, 2)
    assert.equal(
      ((await call('publish_post', args)).operation as {id: string}).id,
      published.id,
    )
    assert.equal((await tick()).status, 'idle')
    assert.equal(writes, 2)
    assert.equal(
      ((await call('participation_history')).publications as unknown[]).length,
      2,
    )
    assert.equal(store.history(10).visits.length, 1)
    await call('write_state', {
      key: 'consequence',
      value: 'A thread was read; no future posting obligation.',
      version: 0,
    })
    assert.equal(((await call('read_state')).items as unknown[]).length, 1)
  } finally {
    await client.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
  }
})
