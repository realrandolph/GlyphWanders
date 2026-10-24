import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {CommentEventRequest} from '../shared/contracts.ts'
import {handleCommentCreate} from './comment-events.ts'
import type {RedditComment} from './executor.ts'

const target = 'GlyphsPlayground'

const oldPostComment: RedditComment = {
  id: 't1_comment1',
  authorName: 'bob',
  subredditName: target,
  body: 'A comment on an old post',
  createdAt: new Date('2026-01-02T04:05:06.000Z'),
  parentId: 't3_oldpost',
  postId: 't3_oldpost',
  permalink: '/r/GlyphsPlayground/comments/oldpost/title/comment1/',
}

function payload() {
  return {
    type: 'CommentCreate',
    comment: {id: 't1_comment1', body: 'A comment on an old post'},
    post: {id: 't3_oldpost'},
    subreddit: {name: target},
  }
}

test('records a comment created on an old post without its text', async () => {
  const recorded: CommentEventRequest[] = []
  const captured = await handleCommentCreate(payload(), {
    getComment: async id => {
      assert.equal(id, 't1_comment1')
      return oldPostComment
    },
    record: async event => {
      recorded.push(event)
    },
  })

  assert.equal(captured, true)
  assert.deepEqual(recorded, [
    {
      subreddit: target,
      comment: {
        id: 't1_comment1',
        postId: 't3_oldpost',
        createdAt: '2026-01-02T04:05:06.000Z',
      },
    },
  ])
  assert.equal(
    JSON.stringify(recorded).includes('A comment on an old post'),
    false,
  )
})

test('does not record a non-target comment', async () => {
  let recorded = false
  const captured = await handleCommentCreate(payload(), {
    getComment: async () => ({...oldPostComment, subredditName: 'Elsewhere'}),
    record: async () => {
      recorded = true
    },
  })

  assert.equal(captured, false)
  assert.equal(recorded, false)
})

test('ignores malformed events without reading Reddit', async () => {
  let read = false
  let recorded = false
  const captured = await handleCommentCreate(
    {type: 'CommentCreate', comment: {id: 'not-a-comment'}},
    {
      getComment: async () => {
        read = true
        return oldPostComment
      },
      record: async () => {
        recorded = true
      },
    },
  )

  assert.equal(captured, false)
  assert.equal(read, false)
  assert.equal(recorded, false)
})
