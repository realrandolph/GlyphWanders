import assert from 'node:assert/strict'
import {createServer, type Server} from 'node:http'
import {test} from 'node:test'
import {type Context, runWithContext} from '@devvit/web/server'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {createJournal} from './journal.ts'
import {MemoryRedis} from './memory-redis.ts'
import {createServerDeps, type TestDeps} from './server.test-support.ts'
import {createOnReq} from './server.ts'

const target = 'GlyphsPlayground'

test('MCP endpoint lists seven tools and enforces the target subreddit', async () => {
  await withServer(async ({base}) => {
    assert.equal(
      (await fetch(`${base}/api/publish_post`, {method: 'POST'})).status,
      404,
    )
    assert.equal((await fetch(`${base}/external/mcp`)).status, 405)
    assert.equal(
      (
        await fetch(`${base}/external/mcp`, {
          method: 'POST',
          headers: {'test-subreddit': 'Elsewhere'},
          body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await fetch(`${base}/external/mcp`, {
          method: 'POST',
          headers: {'test-subreddit': ''},
          body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
        })
      ).status,
      403,
    )

    const client = await connect(base)
    try {
      const tools = await client.listTools()
      assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
        'get_thread',
        'participation_history',
        'publish_post',
        'read_activity',
        'read_memory',
        'reply',
        'write_memory',
      ])
    } finally {
      await client.close()
    }
  })
})

test('raw tools/list preserves auth metadata and output schemas', async () => {
  await withServer(async ({base}) => {
    const tools = await rawTools(base)
    assert.equal(tools.length, 7)
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false)
      assert.equal(tool.outputSchema?.type, 'object')
      assert.equal(tool.outputSchema?.additionalProperties, true)
      assert.ok(tool.annotations)
      assert.deepEqual(tool._meta?.securitySchemes, tool.securitySchemes)
      assert.ok(tool._meta?.securitySchemes)
    }
  })
})

test('journal menu rejects a non-target installation before reading', async () => {
  const deps = createServerDeps()
  let reads = 0
  deps.journal.history = async () => {
    reads++
    return {publications: [], visitedPosts: []}
  }
  await withServer(async ({base}) => {
    const response = await fetch(`${base}/internal/menu/journal`, {
      method: 'POST',
      headers: {'test-subreddit': 'Elsewhere'},
    })
    assert.equal(response.status, 403)
    assert.equal(reads, 0)
  }, deps)
})

test('a persisted cooldown blocks publication before reservation', async () => {
  const deps = createServerDeps()
  await deps.rateGate.recordFailure()
  await withServer(async ({base}) => {
    const client = await connect(base)
    try {
      const result = await call(client, 'publish_post', {
        title: 'A title',
        body: 'A body',
        requestId: '99999999-9999-4999-8999-999999999999',
      })
      assert.equal(result.isError, true)
      assert.equal(
        (result.structuredContent as {code: string}).code,
        'rate_limited',
      )
      assert.equal(deps.reservations.length, 0)
      assert.equal(deps.submits.length, 0)
    } finally {
      await client.close()
    }
  }, deps)
})

test('a 429 read sets a cooldown that blocks the next read', async () => {
  let reads = 0
  const deps = createServerDeps({
    getNewPosts: () => ({
      hasMore: false,
      get: async () => {
        reads++
        throw new Error('429 Too Many Requests token=secret')
      },
    }),
  })
  await withServer(async ({base}) => {
    const client = await connect(base)
    try {
      const first = await call(client, 'read_activity', {limit: 5})
      assert.equal(
        (first.structuredContent as {code: string}).code,
        'rate_limited',
      )
      assert.equal(JSON.stringify(first).includes('secret'), false)
      assert.equal(reads, 1)

      const blocked = await call(client, 'get_thread', {
        postId: 't3_post1',
      })
      assert.equal(
        (blocked.structuredContent as {code: string}).code,
        'rate_limited',
      )
      assert.equal(reads, 1)
    } finally {
      await client.close()
    }
  }, deps)
})

test('a 429 write stays uncertain and sets the persisted cooldown', async () => {
  let submitCalls = 0
  const deps = createServerDeps({
    submitPost: async () => {
      submitCalls++
      throw new Error('429 Too Many Requests token=secret')
    },
  })
  await withServer(async ({base}) => {
    const client = await connect(base)
    try {
      const first = await call(client, 'publish_post', {
        title: 'A title',
        body: 'A body',
        requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      })
      assert.equal(first.isError, true)
      assert.equal(
        (first.structuredContent as {code: string}).code,
        'publication_uncertain',
      )
      assert.equal(JSON.stringify(first).includes('secret'), false)
      assert.equal(submitCalls, 1)
      assert.equal(deps.reservations.length, 1)

      const blocked = await call(client, 'publish_post', {
        title: 'Different title',
        body: 'Different body',
        requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      })
      assert.equal(
        (blocked.structuredContent as {code: string}).code,
        'rate_limited',
      )
      assert.equal(submitCalls, 1)
      assert.equal(deps.reservations.length, 1)
    } finally {
      await client.close()
    }
  }, deps)
})

test('read_activity returns live posts plus persisted comment pointers', async () => {
  await withServer(async ({base}) => {
    await postTrigger(base, {
      comment: {id: 't1_comment1'},
      post: {id: 't3_post1'},
      subreddit: {name: target},
    })
    const client = await connect(base)
    try {
      const result = await call(client, 'read_activity', {limit: 5})
      assert.equal(result.isError, undefined)
      const data = result.structuredContent as {
        posts: Array<{id: string}>
        recentComments: Array<{id: string; postId: string}>
      }
      assert.deepEqual(
        data.posts.map(post => post.id),
        ['t3_post1'],
      )
      assert.deepEqual(data.recentComments, [
        {
          id: 't1_comment1',
          postId: 't3_post1',
          createdAt: '2026-01-02T04:05:06.000Z',
        },
      ])
    } finally {
      await client.close()
    }
  })
})

test('get_thread pages nested comments with an explicit continuation', async () => {
  await withServer(async ({base}) => {
    const client = await connect(base)
    try {
      const first = await call(client, 'get_thread', {
        postId: 't3_post1',
        limit: 2,
      })
      const firstData = first.structuredContent as {
        comments: Array<{id: string}>
        pagination: {
          hasMore: boolean
          nextOffset: number | null
          truncated: boolean
        }
      }
      assert.deepEqual(
        firstData.comments.map(comment => comment.id),
        ['t1_comment1', 't1_reply1'],
      )
      assert.deepEqual(firstData.pagination, {
        count: 2,
        hasMore: true,
        nextOffset: 2,
        truncated: false,
      })

      const second = await call(client, 'get_thread', {
        postId: 't3_post1',
        offset: 2,
        limit: 2,
      })
      const secondData = second.structuredContent as {
        comments: Array<{id: string}>
        pagination: {
          hasMore: boolean
          nextOffset: number | null
          truncated: boolean
        }
      }
      assert.deepEqual(
        secondData.comments.map(comment => comment.id),
        ['t1_comment2'],
      )
      assert.deepEqual(secondData.pagination, {
        count: 1,
        hasMore: false,
        nextOffset: null,
        truncated: false,
      })

      const history = await call(client, 'participation_history', {limit: 5})
      const historyData = history.structuredContent as {
        visitedPosts: Array<{postId: string}>
      }
      assert.deepEqual(
        historyData.visitedPosts.map(post => post.postId),
        ['t3_post1'],
      )
    } finally {
      await client.close()
    }
  })
})

test('publish_post trims, deduplicates by request id and by content', async () => {
  await withServer(async ({base, deps}) => {
    const client = await connect(base)
    try {
      const requestId = '11111111-1111-4111-8111-111111111111'
      const first = await call(client, 'publish_post', {
        title: '  A title  ',
        body: '  A body  ',
        requestId,
      })
      assert.equal(first.isError, undefined)
      assert.equal(deps.submits.length, 1)
      assert.deepEqual(deps.submits[0], {
        kind: 'post',
        title: 'A title',
        body: 'A body',
      })

      const retry = await call(client, 'publish_post', {
        title: 'A title',
        body: 'A body',
        requestId,
      })
      assert.equal(retry.isError, undefined)
      assert.equal(
        (retry.structuredContent as {duplicate: boolean}).duplicate,
        true,
      )
      assert.equal(deps.submits.length, 1)

      const sameContent = await call(client, 'publish_post', {
        title: 'A title',
        body: 'A body',
        requestId: '22222222-2222-4222-8222-222222222222',
      })
      assert.equal(
        (sameContent.structuredContent as {duplicate: boolean}).duplicate,
        true,
      )
      assert.equal(deps.submits.length, 1)
    } finally {
      await client.close()
    }
  })
})

test('invalid arguments fail before any journal or Reddit write', async () => {
  await withServer(async ({base, deps}) => {
    const client = await connect(base)
    try {
      for (const [name, args] of [
        ['read_activity', {limit: 51}],
        ['publish_post', {title: 'x', body: 'y', requestId: 'not-a-uuid'}],
        ['reply', {parentId: 't3_post1', body: 'y', requestId: 'not-a-uuid'}],
        ['get_thread', {postId: 't3_post1', offset: 10001}],
        ['write_memory', {value: 'x', version: -1}],
      ] as const) {
        const result = await call(client, name, args)
        assert.equal(result.isError, true, name)
        const data = result.structuredContent as {code?: string} | undefined
        if (data?.code) assert.equal(data.code, 'invalid_arguments')
      }
      assert.equal(deps.submits.length, 0)
      assert.equal(deps.reservations.length, 0)
    } finally {
      await client.close()
    }
  })
})

test('a pending reservation blocks a retry instead of writing twice', async () => {
  await withServer(async ({base, deps}) => {
    const requestId = '33333333-3333-4333-8333-333333333333'
    await deps.journal.reserve({
      kind: 'publish_post',
      title: 'A title',
      body: 'A body',
      requestId,
    })
    const client = await connect(base)
    try {
      const result = await call(client, 'publish_post', {
        title: 'A title',
        body: 'A body',
        requestId,
      })
      assert.equal(result.isError, true)
      const data = result.structuredContent as {
        status: string
        duplicate: boolean
      }
      assert.equal(data.status, 'pending')
      assert.equal(data.duplicate, true)
      assert.equal(deps.submits.length, 0)
    } finally {
      await client.close()
    }
  })
})

test('a failed success update leaves the reservation pending and blocks retry', async () => {
  const deps = createServerDeps()
  deps.journal.succeed = async () => {
    throw new Error('storage failure token=secret')
  }
  await withServer(async ({base}) => {
    const client = await connect(base)
    try {
      const requestId = '55555555-5555-4555-8555-555555555555'
      const first = await call(client, 'publish_post', {
        title: 'A title',
        body: 'A body',
        requestId,
      })
      assert.equal(first.isError, undefined)
      assert.equal(
        (first.structuredContent as {durable: boolean}).durable,
        false,
      )
      assert.equal(deps.submits.length, 1)

      const retry = await call(client, 'publish_post', {
        title: 'A title',
        body: 'A body',
        requestId,
      })
      assert.equal(retry.isError, true)
      assert.equal(
        (retry.structuredContent as {status: string}).status,
        'pending',
      )
      assert.equal(deps.submits.length, 1)
    } finally {
      await client.close()
    }
  }, deps)
})

test('reply reserves before its write and deduplicates the UUID', async () => {
  await withServer(async ({base, deps}) => {
    const client = await connect(base)
    try {
      const requestId = '66666666-6666-4666-8666-666666666666'
      const first = await call(client, 'reply', {
        parentId: 't3_post1',
        body: '  A reply  ',
        requestId,
      })
      assert.equal(first.isError, undefined)
      assert.equal(deps.submits.length, 1)
      assert.deepEqual(deps.submits[0], {
        kind: 'comment',
        id: 't3_post1',
        body: 'A reply',
      })
      assert.equal(deps.reservations.length, 1)

      const retry = await call(client, 'reply', {
        parentId: 't3_post1',
        body: 'A reply',
        requestId,
      })
      assert.equal(retry.isError, undefined)
      assert.equal(
        (retry.structuredContent as {duplicate: boolean}).duplicate,
        true,
      )
      assert.equal(deps.submits.length, 1)
    } finally {
      await client.close()
    }
  })
})

test('a Redis failure before reservation prevents the public write', async () => {
  class BrokenRedis extends MemoryRedis {
    override async hSetNX(): Promise<number> {
      throw new Error('storage failure token=secret')
    }
  }
  const deps = createServerDeps()
  deps.journal = createJournal(new BrokenRedis())
  await withServer(async ({base}) => {
    const client = await connect(base)
    try {
      const result = await call(client, 'publish_post', {
        title: 'A title',
        body: 'A body',
        requestId: '44444444-4444-4444-8444-444444444444',
      })
      assert.equal(result.isError, true)
      assert.equal(
        (result.structuredContent as {code: string}).code,
        'journal_unavailable',
      )
      assert.equal(JSON.stringify(result).includes('secret'), false)
      assert.equal(deps.submits.length, 0)
    } finally {
      await client.close()
    }
  }, deps)
})

test('write_memory enforces CAS versions and keeps a null tombstone', async () => {
  await withServer(async ({base}) => {
    const client = await connect(base)
    try {
      const initial = await call(client, 'read_memory', {})
      assert.deepEqual(initial.structuredContent, {
        memory: {value: null, version: 0, updatedAt: null},
      })
      const written = await call(client, 'write_memory', {
        value: 'note',
        version: 0,
      })
      assert.equal(
        (written.structuredContent as {memory: {version: number}}).memory
          .version,
        1,
      )
      const stale = await call(client, 'write_memory', {
        value: 'stale',
        version: 0,
      })
      assert.equal(stale.isError, true)
      assert.equal(
        (stale.structuredContent as {code: string}).code,
        'memory_conflict',
      )
      const cleared = await call(client, 'write_memory', {
        value: null,
        version: 1,
      })
      const clearedData = cleared.structuredContent as {
        memory: {value: string | null; version: number}
      }
      assert.equal(clearedData.memory.value, null)
      assert.equal(clearedData.memory.version, 2)
    } finally {
      await client.close()
    }
  })
})

async function rawTools(base: string): Promise<
  Array<{
    inputSchema: {additionalProperties?: boolean}
    outputSchema?: {type?: string; additionalProperties?: boolean}
    annotations?: unknown
    _meta?: {securitySchemes?: unknown}
    securitySchemes?: unknown
  }>
> {
  await rawRpc(base, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {name: 'raw-test', version: '1.0.0'},
    },
  })
  const response = await rawRpc(base, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  })
  return response.result.tools as Array<{
    inputSchema: {additionalProperties?: boolean}
    outputSchema?: {type?: string; additionalProperties?: boolean}
    annotations?: unknown
    _meta?: {securitySchemes?: unknown}
    securitySchemes?: unknown
  }>
}

async function rawRpc(
  base: string,
  body: Record<string, unknown>,
): Promise<{result: {tools: unknown[]}}> {
  const response = await fetch(`${base}/external/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'test-subreddit': target,
    },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200)
  return (await response.json()) as {result: {tools: unknown[]}}
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  return await client.callTool({name, arguments: args})
}

async function connect(base: string): Promise<Client> {
  const client = new Client({name: 'glyphwanders-test', version: '1.0.0'})
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/external/mcp`), {
      requestInit: {'test-subreddit': target} as Record<string, string>,
    }),
  )
  return client
}

async function withServer(
  fn: (ctx: {base: string; deps: TestDeps; server: Server}) => Promise<void>,
  supplied?: TestDeps,
): Promise<void> {
  const deps = supplied ?? createServerDeps()
  const handler = createOnReq(deps)
  const server = createServer(async (req, res) => {
    await runWithContext(
      {
        appName: 'glyphwanders',
        subredditName: req.headers['test-subreddit'] ?? target,
        username: 'moderator',
        userId: 't2_mod',
        metadata: {},
      } as unknown as Context,
      () => handler(req, res),
    )
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    await fn({base, deps, server})
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

async function postTrigger(base: string, payload: unknown): Promise<void> {
  const response = await fetch(`${base}/internal/triggers/comment`, {
    method: 'POST',
    headers: {'test-subreddit': target, 'content-type': 'application/json'},
    body: JSON.stringify(payload),
  })
  assert.equal(response.status, 200)
}
