import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {Store} from './store.ts'

test('publication idempotency, content deduplication and conflicting keys', () => {
  const db = new Store(':memory:')
  try {
    const args = {title: 'hello', body: 'world', requestId: randomUUID()}
    const first = db.enqueue('publish_post', args)
    assert.equal(db.enqueue('publish_post', args).id, first.id)
    const alias = randomUUID()
    assert.equal(
      db.enqueue('publish_post', {...args, requestId: alias}).id,
      first.id,
    )
    assert.throws(
      () =>
        db.enqueue('publish_post', {
          ...args,
          body: 'changed',
          requestId: alias,
        }),
      /different content/,
    )
    assert.throws(
      () => db.enqueue('publish_post', {...args, body: 'changed'}),
      /different content/,
    )
    assert.equal(db.claim()?.id, first.id)
    assert.equal(db.claim(), null)
    db.complete(first.id, {id: 't3_test'})
    assert.equal(db.enqueue('publish_post', args).status, 'succeeded')
    assert.equal(db.history(20).publications.length, 1)
  } finally {
    db.close()
  }
})

test('worker crashes never requeue writes; late successful completion reconciles', () => {
  const db = new Store(':memory:')
  try {
    const row = db.enqueue(
      'reply',
      {parentId: 't3_a', body: 'hi', requestId: randomUUID()},
      1,
    )
    db.claim(2)
    assert.equal(db.claim(120003), null)
    assert.equal(db.get(row.id).status, 'uncertain')
    db.complete(row.id, {id: 't1_b'}, undefined, 120004)
    assert.equal(db.get(row.id).status, 'succeeded')
    assert.equal(db.claim(120005), null)
  } finally {
    db.close()
  }
})

test('read leases recover, queued jobs expire and failed writes trigger cooldown', () => {
  const db = new Store(':memory:')
  try {
    const read = db.enqueue('thread', {postId: 't3_a'}, 1)
    db.claim(2)
    assert.equal(db.claim(120003)?.id, read.id)
    db.complete(read.id, {post: {id: 't3_a'}}, undefined, 120004)
    assert.equal(db.history(5).visits.length, 1)
    const write = db.enqueue(
      'reply',
      {requestId: randomUUID(), body: 'hi'},
      120005,
    )
    db.claim(120006)
    db.complete(write.id, null, 'rate_limited', 120007)
    const later = db.enqueue('activity', {}, 120008)
    assert.equal(db.claim(120009), null)
    assert.equal(db.claim(180008)?.id, later.id)
    db.complete(later.id, {})
    const expired = db.enqueue('activity', {}, 1)
    db.claim(1_000_000)
    assert.equal(db.get(expired.id).status, 'expired')
  } finally {
    db.close()
  }
})

test('persistent SQLite, concurrent connections, scratch CAS and deletion tombstones', () => {
  const dir = mkdtempSync(
    join(existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir(), 'glyph-'),
  )
  const path = join(dir, 'test.sqlite')
  const a = new Store(path)
  const b = new Store(path)
  try {
    a.enqueue('activity', {})
    assert.ok(a.claim())
    assert.equal(b.claim(), null)
    a.writeState('notes', JSON.stringify('consequential'), 0)
    assert.throws(() => b.writeState('notes', '"stale"', 0), /version conflict/)
    b.writeState('notes', null, 1)
    assert.throws(() => a.writeState('notes', '"stale"', 0), /version conflict/)
    assert.deepEqual(a.readState(), [{key: 'notes', value: null, version: 2}])
  } finally {
    a.close()
    b.close()
    rmSync(dir, {recursive: true})
  }
})
