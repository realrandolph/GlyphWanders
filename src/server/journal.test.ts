import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {CommentEventRequest} from '../shared/contracts.ts'
import {AppFailure} from './errors.ts'
import {
  createJournal,
  MEMORY_KEY,
  MemoryConflict,
  PUBLICATION_KEY,
} from './journal.ts'
import {MemoryRedis} from './memory-redis.ts'

const request = {
  kind: 'publish_post' as const,
  title: 'A title',
  body: 'A body',
  requestId: '11111111-1111-4111-8111-111111111111',
}

test('reserve blocks duplicate request ids and identical content', async () => {
  const journal = createJournal(new MemoryRedis())
  const first = await journal.reserve(request)
  assert.equal(first.duplicate, false)
  assert.equal(first.entry.status, 'pending')

  const retry = await journal.reserve(request)
  assert.equal(retry.duplicate, true)
  assert.equal(retry.entry.status, 'pending')

  const sameContent = await journal.reserve({
    ...request,
    requestId: '22222222-2222-4222-8222-222222222222',
  })
  assert.equal(sameContent.duplicate, true)
  assert.equal(sameContent.entry.requestId, request.requestId)
})

test('concurrent identical content writes one reservation', async () => {
  const journal = createJournal(new MemoryRedis())
  const otherId = '77777777-7777-4777-8777-777777777777'
  const results = await Promise.all([
    journal.reserve(request),
    journal.reserve({...request, requestId: otherId}),
  ])
  assert.equal(results.filter(result => result.duplicate === false).length, 1)
  assert.equal(new Set(results.map(result => result.entry.requestId)).size, 1)
  for (const id of [request.requestId, otherId]) {
    await assert.rejects(
      journal.reserve({...request, requestId: id, body: 'Different'}),
      (err: unknown) =>
        err instanceof AppFailure && err.code === 'journal_conflict',
    )
  }
})

test('a duplicate content request id is bound to the duplicate content', async () => {
  const journal = createJournal(new MemoryRedis())
  const first = await journal.reserve(request)
  await journal.succeed(first.entry, 't3_abc123')
  const duplicateId = '88888888-8888-4888-8888-888888888888'

  const duplicate = await journal.reserve({
    ...request,
    requestId: duplicateId,
  })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.entry.requestId, request.requestId)

  await assert.rejects(
    journal.reserve({...request, requestId: duplicateId, body: 'Different'}),
    (err: unknown) =>
      err instanceof AppFailure && err.code === 'journal_conflict',
  )
})

test('a request id cannot be reused for different content', async () => {
  const journal = createJournal(new MemoryRedis())
  await journal.reserve(request)
  await assert.rejects(
    journal.reserve({...request, body: 'Different'}),
    (err: unknown) =>
      err instanceof AppFailure && err.code === 'journal_conflict',
  )
})

test('a retry repairing an in-flight alias cannot create a self-referential duplicate', async t => {
  const redis = new MemoryRedis()
  const journal = createJournal(redis)
  const setNX = redis.hSetNX.bind(redis)
  let repaired = false
  t.mock.method(
    redis,
    'hSetNX',
    async (key: string, field: string, value: string) => {
      if (field.startsWith('c:') && !repaired) {
        repaired = true
        await journal.reserve(request)
      }
      return setNX(key, field, value)
    },
  )
  const reserved = await journal.reserve(request)
  assert.equal(reserved.duplicate, true)
  assert.equal(reserved.entry.status, 'pending')
  const raw = await redis.hGet(PUBLICATION_KEY, `r:${request.requestId}`)
  assert.ok(raw)
  assert.equal(JSON.parse(raw).duplicateOf, undefined)
  assert.equal((await journal.history(10)).publications.length, 1)
})

test('a succeeded publication is returned without another reservation', async () => {
  const journal = createJournal(new MemoryRedis())
  const first = await journal.reserve(request)
  await journal.succeed(first.entry, 't3_abc123')
  const retry = await journal.reserve(request)
  assert.equal(retry.duplicate, true)
  assert.equal(retry.entry.status, 'succeeded')
  assert.equal(retry.entry.id, 't3_abc123')
})

test('a failed reservation write stops before any Reddit write', async () => {
  class Broken extends MemoryRedis {
    override async hSetNX(): Promise<number> {
      throw new Error('storage quota token=secret')
    }
  }
  const journal = createJournal(new Broken())
  await assert.rejects(
    journal.reserve(request),
    (err: unknown) =>
      err instanceof AppFailure && err.code === 'journal_unavailable',
  )
})

test('index failure leaves a durable pending reservation and no write path', async () => {
  class BrokenIndex extends MemoryRedis {
    override async zAdd(): Promise<number> {
      throw new Error('index unavailable token=secret')
    }
  }
  const journal = createJournal(new BrokenIndex())
  await assert.rejects(
    journal.reserve(request),
    (err: unknown) =>
      err instanceof AppFailure && err.code === 'journal_unavailable',
  )
  const retry = await journal.reserve(request)
  assert.equal(retry.duplicate, true)
  assert.equal(retry.entry.status, 'pending')
})

test('history reads only the bounded index, not the whole hash', async () => {
  const redis = new MemoryRedis()
  const journal = createJournal(redis)
  await journal.reserve(request)
  const raw = await redis.hGet(PUBLICATION_KEY, `r:${request.requestId}`)
  assert.ok(raw)
  await redis.hSet(PUBLICATION_KEY, {'r:ghost': raw})
  const history = await journal.history(20)
  assert.deepEqual(
    history.publications.map(entry => entry.requestId),
    [request.requestId],
  )
})

test('history is compact and excludes duplicate aliases', async () => {
  const journal = createJournal(new MemoryRedis())
  const first = await journal.reserve(request)
  await journal.succeed(first.entry, 't3_abc123')
  await journal.reserve({...request, body: 'Different', requestId: 'uuid-2'})
  const history = await journal.history(20)
  assert.equal(history.publications.length, 2)
  assert.deepEqual(history.publications.map(entry => entry.status).sort(), [
    'pending',
    'succeeded',
  ])
  assert.equal(JSON.stringify(history).includes('A body'), false)
})

test('memory compare-and-swap includes a null tombstone', async () => {
  const journal = createJournal(new MemoryRedis())
  const created = await journal.writeMemory('remember', 0)
  assert.equal(created.version, 1)
  assert.equal(created.value, 'remember')

  await assert.rejects(
    journal.writeMemory('stale', 0),
    (err: unknown) =>
      err instanceof MemoryConflict && err.current.version === 1,
  )

  const cleared = await journal.writeMemory(null, 1)
  assert.equal(cleared.value, null)
  assert.equal(cleared.version, 2)
  assert.deepEqual(await journal.readMemory(), cleared)
})

test('an EXEC conflict refreshes the memory version in the error', async () => {
  const redis = new MemoryRedis()
  const journal = createJournal(redis)
  await journal.writeMemory('initial', 0)
  redis.beforeExec = async () => {
    await redis.set(
      MEMORY_KEY,
      JSON.stringify({
        value: 'concurrent',
        version: 2,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    )
  }
  await assert.rejects(
    journal.writeMemory('mine', 1),
    (err: unknown) =>
      err instanceof MemoryConflict &&
      err.current.version === 2 &&
      err.current.value === 'concurrent',
  )
})

test('two concurrent memory writes at one version cannot both win', async () => {
  const journal = createJournal(new MemoryRedis())
  const results = await Promise.allSettled([
    journal.writeMemory('left', 0),
    journal.writeMemory('right', 0),
  ])
  assert.equal(
    results.filter(result => result.status === 'fulfilled').length,
    1,
  )
  const rejected = results.find(result => result.status === 'rejected')
  assert.ok(rejected && rejected.status === 'rejected')
  assert.ok(rejected.reason instanceof MemoryConflict)
  assert.equal((await journal.readMemory()).version, 1)
})

test('empty native SDK EXEC arrays are conflicts, not successful memory writes', async () => {
  class Aborted extends MemoryRedis {
    override async watch(...keys: string[]) {
      const tx = await super.watch(...keys)
      return {...tx, exec: async () => []}
    }
  }
  const journal = createJournal(new Aborted())
  await assert.rejects(journal.writeMemory('not saved', 0), MemoryConflict)
  assert.equal((await journal.readMemory()).version, 0)
})

test('comment events store pointers only and keep the newest bounded set', async () => {
  const journal = createJournal(new MemoryRedis())
  const event = (id: string, createdAt: string): CommentEventRequest => ({
    subreddit: 'GlyphsPlayground',
    comment: {id, postId: 't3_post1', createdAt},
  })
  await journal.recordComment(event('t1_old', '2026-01-01T00:00:00.000Z'))
  await journal.recordComment(event('t1_new', '2026-02-01T00:00:00.000Z'))
  assert.deepEqual(await journal.recentComments(1), [
    {id: 't1_new', postId: 't3_post1', createdAt: '2026-02-01T00:00:00.000Z'},
  ])
})
