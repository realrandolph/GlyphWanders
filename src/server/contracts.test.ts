import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  ActivityArgsSchema,
  PublishPostArgsSchema,
  ReplyArgsSchema,
  TARGET_SUBREDDIT,
  ThreadArgsSchema,
} from '../shared/contracts.ts'

test('activity defaults and bounds', () => {
  assert.deepEqual(ActivityArgsSchema.parse({}), {limit: 20})
  assert.equal(ActivityArgsSchema.safeParse({limit: 0}).success, false)
  assert.equal(ActivityArgsSchema.safeParse({limit: 51}).success, false)
  assert.equal(
    ActivityArgsSchema.safeParse({limit: 20, after: 'not-a-fullname'}).success,
    false,
  )
  assert.equal(
    ActivityArgsSchema.safeParse({limit: 20, after: 't3_abc123'}).success,
    true,
  )
})

test('thread requires a post id and bounds offset and limit', () => {
  assert.equal(ThreadArgsSchema.safeParse({postId: 't1_abc'}).success, false)
  assert.equal(ThreadArgsSchema.safeParse({postId: 't3_abc'}).success, true)
  assert.equal(
    ThreadArgsSchema.safeParse({postId: 't3_abc', offset: 0}).success,
    true,
  )
  assert.equal(
    ThreadArgsSchema.safeParse({postId: 't3_abc', offset: 10001}).success,
    false,
  )
  assert.equal(
    ThreadArgsSchema.safeParse({postId: 't3_abc', commentId: 't1_focus'})
      .success,
    true,
  )
  assert.equal(
    ThreadArgsSchema.safeParse({postId: 't3_abc', commentId: 't3_focus'})
      .success,
    false,
  )
  assert.equal(
    ThreadArgsSchema.safeParse({postId: 't3_abc', limit: 101}).success,
    false,
  )
})

test('writes validate lengths', () => {
  assert.equal(
    PublishPostArgsSchema.safeParse({
      title: 'x'.repeat(301),
      body: '',
      requestId: 'r1',
    }).success,
    false,
  )
  assert.equal(
    PublishPostArgsSchema.safeParse({
      title: 'Title',
      body: 'x'.repeat(40001),
      requestId: 'r1',
    }).success,
    false,
  )
  assert.equal(
    ReplyArgsSchema.safeParse({
      parentId: 't2_abc',
      body: 'hello',
      requestId: 'r1',
    }).success,
    false,
  )
  assert.equal(
    ReplyArgsSchema.safeParse({
      parentId: 't1_abc',
      body: 'x'.repeat(10001),
      requestId: 'r1',
    }).success,
    false,
  )
})

test('the target is a single global subreddit', () => {
  assert.equal(TARGET_SUBREDDIT, 'GlyphsPlayground')
})
