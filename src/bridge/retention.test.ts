import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Store} from './store.ts'

test('read content expires but consequential read timestamps and visited IDs survive', () => {
  const store = new Store(':memory:')
  try {
    const read = store.enqueue('activity', {}, 1)
    store.claim(2)
    store.complete(read.id, {posts: ['untrusted content']}, undefined, 3)
    const thread = store.enqueue('thread', {postId: 't3_test'}, 4)
    store.claim(5)
    store.complete(thread.id, {comments: ['untrusted content']}, undefined, 6)
    store.pruneReads(86_400_007)
    assert.equal(store.get(read.id).result, null)
    assert.equal(store.get(thread.id).status, 'expired')
    assert.equal(store.history(10).lastActivityRead?.timestamp, 3)
    assert.equal(store.history(10).visits.length, 1)
  } finally {
    store.close()
  }
})

test('consecutive errors back off exponentially instead of hammering Reddit', () => {
  const store = new Store(':memory:')
  try {
    const first = store.enqueue('activity', {}, 1)
    store.claim(2)
    store.complete(first.id, null, 'rate_limited', 3)
    const second = store.enqueue('activity', {}, 4)
    assert.equal(store.claim(60_002), null)
    assert.ok(store.claim(60_004))
    store.complete(second.id, null, 'rate_limited', 60_005)
    store.enqueue('activity', {}, 60_006)
    assert.equal(store.claim(120_006), null)
    assert.ok(store.claim(180_006))
  } finally {
    store.close()
  }
})
