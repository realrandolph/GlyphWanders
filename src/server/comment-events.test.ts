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

test('captures a comment created on an old post', async () => {
  const posted: CommentEventRequest[] = []
  const captured = await handleCommentCreate(payload(), {
    getComment: async id => {
      assert.equal(id, 't1_comment1')
      return oldPostComment
    },
    postComment: async event => {
      posted.push(event)
    },
  })

  assert.equal(captured, true)
  assert.deepEqual(posted, [
    {
      subreddit: target,
      comment: {
        id: 't1_comment1',
        parentId: 't3_oldpost',
        postId: 't3_oldpost',
        author: 'bob',
        body: 'A comment on an old post',
        url: 'https://www.reddit.com/r/GlyphsPlayground/comments/oldpost/title/comment1/',
        createdAt: '2026-01-02T04:05:06.000Z',
      },
    },
  ])
})

test('does not post a non-target comment', async () => {
  let posted = false
  const captured = await handleCommentCreate(payload(), {
    getComment: async () => ({...oldPostComment, subredditName: 'Elsewhere'}),
    postComment: async () => {
      posted = true
    },
  })

  assert.equal(captured, false)
  assert.equal(posted, false)
})

test('ignores malformed events without reading Reddit', async () => {
  let read = false
  let posted = false
  const captured = await handleCommentCreate(
    {type: 'CommentCreate', comment: {id: 'not-a-comment'}},
    {
      getComment: async () => {
        read = true
        return oldPostComment
      },
      postComment: async () => {
        posted = true
      },
    },
  )

  assert.equal(captured, false)
  assert.equal(read, false)
  assert.equal(posted, false)
})
