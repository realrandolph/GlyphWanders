import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  ActivityArgsSchema,
  ClaimRequestSchema,
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

test('thread requires a post id and caps the limit', () => {
  assert.equal(ThreadArgsSchema.safeParse({postId: 't1_abc'}).success, false)
  assert.equal(ThreadArgsSchema.safeParse({postId: 't3_abc'}).success, true)
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

test('writes validate lengths and request ids', () => {
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

test('claim is restricted to the target subreddit', () => {
  assert.equal(
    ClaimRequestSchema.safeParse({subreddit: TARGET_SUBREDDIT}).success,
    true,
  )
  assert.equal(
    ClaimRequestSchema.safeParse({subreddit: 'OtherSubreddit'}).success,
    false,
  )
})
