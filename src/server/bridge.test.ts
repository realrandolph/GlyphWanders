import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  type BridgeConfig,
  bridgeEndpoint,
  type FetchLike,
  type PollDeps,
  pollOnce,
  postCommentEvent,
} from './bridge.ts'

const config: BridgeConfig = {
  url: 'https://bridge.example/',
  token: 'secret-token',
}

type Call = {url: string; init: RequestInit}

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'},
  })
}

function recorder(handler: (call: Call, index: number) => Response): {
  calls: Call[]
  fetchImpl: FetchLike
} {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const call = {url, init}
    calls.push(call)
    return handler(call, calls.length - 1)
  }
  return {calls, fetchImpl}
}

function deps(
  fetchImpl: FetchLike,
  execute: PollDeps['execute'] = async () => ({ok: true}),
  bridgeConfig: BridgeConfig = config,
): PollDeps {
  return {getConfig: async () => bridgeConfig, execute, fetchImpl}
}

test('claims and completes exactly one job', async () => {
  const {calls, fetchImpl} = recorder((_call, index) => {
    if (index === 0) {
      return response({
        job: {id: 'job-1', kind: 'thread', args: {postId: 't3_abc', limit: 10}},
      })
    }
    return response({ok: true})
  })
  let executions = 0
  const outcome = await pollOnce(
    deps(fetchImpl, async job => {
      executions++
      assert.equal(job.kind, 'thread')
      return {thread: true}
    }),
  )

  assert.deepEqual(outcome, {
    status: 'completed',
    jobId: 'job-1',
    kind: 'thread',
    ok: true,
  })
  assert.equal(executions, 1)
  assert.equal(calls.length, 2)

  const claim = calls[0]
  const complete = calls[1]
  assert.ok(claim)
  assert.ok(complete)
  assert.equal(claim.url, 'https://bridge.example/worker/claim')
  assert.equal(complete.url, 'https://bridge.example/worker/complete')
  assert.equal(claim.init.redirect, 'error')
  assert.equal(
    (claim.init.headers as Record<string, string>).Authorization,
    'Bearer secret-token',
  )
  assert.deepEqual(JSON.parse(String(claim.init.body)), {
    subreddit: 'GlyphsPlayground',
  })
  assert.deepEqual(JSON.parse(String(complete.init.body)), {
    id: 'job-1',
    result: {thread: true},
  })
})

test('an idle claim does not complete a job', async () => {
  const {calls, fetchImpl} = recorder(() => response({job: null}))
  const outcome = await pollOnce(deps(fetchImpl))

  assert.deepEqual(outcome, {status: 'idle'})
  assert.equal(calls.length, 1)
})

test('a failed job is completed once and never retried', async () => {
  const {calls, fetchImpl} = recorder((_call, index) => {
    if (index === 0) {
      return response({
        job: {
          id: 'job-1',
          kind: 'reply',
          args: {parentId: 't3_abc', body: 'hi', requestId: 'r1'},
        },
      })
    }
    return response({ok: false}, 500)
  })
  let executions = 0

  await assert.rejects(
    pollOnce(
      deps(fetchImpl, async () => {
        executions++
        throw new Error('reddit write failed for https://user:pass@example.com')
      }),
    ),
    /bridge_unavailable/,
  )

  assert.equal(executions, 1)
  assert.equal(calls.length, 2)
  const complete = calls[1]
  assert.ok(complete)
  const body = JSON.parse(String(complete.init.body))
  assert.equal(body.id, 'job-1')
  assert.equal(body.result, null)
  assert.equal(body.error, 'reddit_unavailable')
  assert.doesNotMatch(
    JSON.stringify(body),
    /secret-token|user:pass|reddit write failed/,
  )
})

test('invalid job args are completed without executing', async () => {
  const {calls, fetchImpl} = recorder((_call, index) => {
    if (index === 0) {
      return response({
        job: {id: 'job-1', kind: 'activity', args: {limit: 51}},
      })
    }
    return response({ok: true})
  })
  let executions = 0
  const outcome = await pollOnce(
    deps(fetchImpl, async () => {
      executions++
      return {}
    }),
  )

  assert.deepEqual(outcome, {
    status: 'completed',
    jobId: 'job-1',
    kind: null,
    ok: false,
  })
  assert.equal(executions, 0)
  assert.equal(calls.length, 2)
  const complete = calls[1]
  assert.ok(complete)
  const body = JSON.parse(String(complete.init.body))
  assert.equal(body.error, 'invalid_worker_job')
})

test('missing bridge configuration is skipped', async () => {
  const {calls, fetchImpl} = recorder(() => response({job: null}))
  const outcome = await pollOnce(
    deps(fetchImpl, async () => ({}), {url: '', token: ''}),
  )

  assert.deepEqual(outcome, {status: 'skipped'})
  assert.equal(calls.length, 0)
})

test('bridge URL must be HTTPS without credentials or query', () => {
  assert.equal(
    bridgeEndpoint('https://bridge.example/base', '/worker/claim'),
    'https://bridge.example/base/worker/claim',
  )
  assert.throws(
    () => bridgeEndpoint('http://bridge.example', '/claim'),
    /bridge_unavailable/,
  )
  assert.throws(
    () => bridgeEndpoint('https://user:pass@bridge.example', '/claim'),
    /bridge_unavailable/,
  )
  assert.throws(
    () => bridgeEndpoint('https://bridge.example?token=x', '/claim'),
    /bridge_unavailable/,
  )
})

test('posts one comment event with the bridge contract shape', async () => {
  const {calls, fetchImpl} = recorder(() => response({ok: true}))
  const comment = {
    id: 't1_comment1',
    postId: 't3_post1',
    createdAt: '2026-01-02T04:05:06.000Z',
  }

  await postCommentEvent(config, comment, fetchImpl)

  const call = calls[0]
  assert.ok(call)
  assert.equal(call.url, 'https://bridge.example/worker/comment')
  assert.equal(call.init.redirect, 'error')
  assert.equal(
    (call.init.headers as Record<string, string>).Authorization,
    'Bearer secret-token',
  )
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    subreddit: 'GlyphsPlayground',
    comment,
  })
})
