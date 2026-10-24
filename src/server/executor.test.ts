import assert from 'node:assert/strict'
import {test} from 'node:test'
import {AppFailure} from './errors.ts'
import {
  createExecutor,
  type RedditApi,
  type RedditComment,
  type RedditListing,
  type RedditPost,
} from './executor.ts'

const target = 'GlyphsPlayground'

const post: RedditPost = {
  id: 't3_post1',
  authorName: 'alice',
  subredditName: target,
  permalink: '/r/GlyphsPlayground/comments/post1/title/',
  title: 'A title',
  body: 'A body',
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  numberOfComments: 3,
}

const comment: RedditComment = {
  id: 't1_comment1',
  authorName: 'bob',
  subredditName: target,
  body: 'A comment',
  createdAt: new Date('2026-01-02T04:05:06.000Z'),
  parentId: 't3_post1',
  postId: 't3_post1',
  permalink: '/r/GlyphsPlayground/comments/post1/title/comment1/',
}

function listing<T>(items: T[], hasMore = false): RedditListing<T> {
  return {
    hasMore,
    children: items,
    get: async () => items,
  }
}

function makeApi(overrides: Partial<RedditApi>): RedditApi {
  return {
    getPostById: async () => {
      throw new Error('unexpected getPostById')
    },
    getCommentById: async () => {
      throw new Error('unexpected getCommentById')
    },
    getNewPosts: () => {
      throw new Error('unexpected getNewPosts')
    },
    getComments: () => {
      throw new Error('unexpected getComments')
    },
    submitPost: async () => {
      throw new Error('unexpected submitPost')
    },
    submitComment: async () => {
      throw new Error('unexpected submitComment')
    },
    ...overrides,
  }
}

test('activity returns sanitized posts and pagination', async () => {
  let options: Parameters<RedditApi['getNewPosts']>[0] | undefined
  const other: RedditPost = {
    ...post,
    id: 't3_other',
    subredditName: 'Elsewhere',
  }
  const executor = createExecutor(
    makeApi({
      getNewPosts: opts => {
        options = opts
        return listing([post, other], true)
      },
    }),
  )

  const result = await executor.activity({limit: 20, after: 't3_prev'})
  assert.equal(options?.subredditName, target)
  assert.equal(options?.limit, 20)
  assert.equal(options?.after, 't3_prev')
  assert.equal(result.posts.length, 1)
  const [first] = result.posts
  assert.ok(first)
  assert.deepEqual(first, {
    id: 't3_post1',
    title: 'A title',
    body: 'A body',
    author: 'alice',
    url: 'https://www.reddit.com/r/GlyphsPlayground/comments/post1/title/',
    createdAt: '2026-01-02T03:04:05.000Z',
    subreddit: target,
    commentCount: 3,
  })
  assert.deepEqual(result.pagination, {nextAfter: 't3_post1', hasMore: true})
})

test('thread verifies the post before reading comments', async () => {
  let commentsRead = false
  const executor = createExecutor(
    makeApi({
      getPostById: async () => ({...post, subredditName: 'Elsewhere'}),
      getComments: () => {
        commentsRead = true
        return listing([comment])
      },
    }),
  )

  await assert.rejects(
    executor.thread({postId: 't3_post1', limit: 100}),
    /target_restricted/,
  )
  assert.equal(commentsRead, false)
})

test('thread walks nested replies depth-first within the budget', async () => {
  let options: Parameters<RedditApi['getComments']>[0] | undefined
  const reply: RedditComment = {
    ...comment,
    id: 't1_reply1',
    parentId: 't1_comment1',
    body: 'A reply',
    createdAt: new Date('2026-01-02T06:00:00.000Z'),
    permalink: '/r/GlyphsPlayground/comments/post1/title/reply1/',
  }
  const second: RedditComment = {
    ...comment,
    id: 't1_comment2',
    body: 'Another top-level',
    createdAt: new Date('2026-01-02T05:00:00.000Z'),
  }
  const nested: RedditComment = {
    ...comment,
    replies: listing([reply]),
  }
  const executor = createExecutor(
    makeApi({
      getPostById: async () => post,
      getCommentById: async () => ({...comment, id: 't1_focus'}),
      getComments: opts => {
        options = opts
        return listing([
          nested,
          second,
          {...comment, id: 't1_other', subredditName: 'Elsewhere'},
        ])
      },
    }),
  )

  const result = await executor.thread({
    postId: 't3_post1',
    commentId: 't1_focus',
    offset: 0,
    limit: 3,
  })
  assert.equal(options?.postId, 't3_post1')
  assert.equal(options?.commentId, 't1_focus')
  assert.equal(options?.sort, 'new')
  assert.deepEqual(
    result.comments.map(c => c.id),
    ['t1_comment1', 't1_reply1', 't1_comment2'],
  )
  assert.equal(result.comments[1]?.parentId, 't1_comment1')
  assert.deepEqual(result.pagination, {
    count: 3,
    hasMore: false,
    nextOffset: null,
    truncated: false,
  })
  assert.deepEqual(result.comments[1], {
    id: 't1_reply1',
    parentId: 't1_comment1',
    postId: 't3_post1',
    author: 'bob',
    body: 'A reply',
    url: 'https://www.reddit.com/r/GlyphsPlayground/comments/post1/title/reply1/',
    createdAt: '2026-01-02T06:00:00.000Z',
  })
})

test('thread rejects a focused comment from another post before reading it', async () => {
  let read = false
  const executor = createExecutor(
    makeApi({
      getPostById: async () => post,
      getCommentById: async () => ({...comment, postId: 't3_elsewhere'}),
      getComments: () => {
        read = true
        return listing([])
      },
    }),
  )
  await assert.rejects(
    executor.thread({
      postId: post.id,
      commentId: comment.id,
      offset: 0,
      limit: 10,
    }),
    /target_restricted/,
  )
  assert.equal(read, false)
})

test('thread pages the complete nested tree with offsets', async () => {
  const reply1: RedditComment = {
    ...comment,
    id: 't1_reply1',
    parentId: 't1_comment1',
    createdAt: new Date('2026-01-02T06:00:00.000Z'),
  }
  const reply2: RedditComment = {
    ...comment,
    id: 't1_reply2',
    parentId: 't1_comment1',
    createdAt: new Date('2026-01-02T07:00:00.000Z'),
  }
  const root1: RedditComment = {
    ...comment,
    replies: listing([reply1, reply2]),
  }
  const root2: RedditComment = {...comment, id: 't1_comment2'}
  const executor = createExecutor(
    makeApi({
      getPostById: async () => post,
      getComments: () => listing([root1, root2]),
    }),
  )

  const first = await executor.thread({
    postId: post.id,
    offset: 0,
    limit: 2,
  })
  assert.deepEqual(
    first.comments.map(c => c.id),
    ['t1_comment1', 't1_reply1'],
  )
  assert.deepEqual(first.pagination, {
    count: 2,
    hasMore: true,
    nextOffset: 2,
    truncated: false,
  })

  const second = await executor.thread({
    postId: post.id,
    offset: first.pagination.nextOffset ?? 0,
    limit: 2,
  })
  assert.deepEqual(
    second.comments.map(c => c.id),
    ['t1_reply2', 't1_comment2'],
  )
  assert.deepEqual(second.pagination, {
    count: 2,
    hasMore: false,
    nextOffset: null,
    truncated: false,
  })
})

test('thread reports a continuation when the page limit cuts a branch', async () => {
  const reply: RedditComment = {
    ...comment,
    id: 't1_reply1',
    parentId: 't1_comment1',
    createdAt: new Date('2026-01-02T06:00:00.000Z'),
  }
  const executor = createExecutor(
    makeApi({
      getPostById: async () => post,
      getComments: () => listing([{...comment, replies: listing([reply])}]),
    }),
  )

  const result = await executor.thread({
    postId: 't3_post1',
    offset: 0,
    limit: 1,
  })
  assert.equal(result.comments.length, 1)
  assert.equal(result.pagination.hasMore, true)
  assert.equal(result.pagination.nextOffset, 1)
})

test('thread rejects an unreachable offset instead of claiming completion', async () => {
  const many = Array.from({length: 6000}, (_, index) => ({
    ...comment,
    id: `t1_c${index}`,
  }))
  const executor = createExecutor(
    makeApi({
      getPostById: async () => post,
      getComments: () => listing(many),
    }),
  )
  await assert.rejects(
    executor.thread({
      postId: post.id,
      offset: 5500,
      limit: 10,
    }),
    /thread_truncated/,
  )
})

test('reply rejects a comment outside the target subreddit', async () => {
  let submitted = false
  const executor = createExecutor(
    makeApi({
      getCommentById: async () => ({...comment, subredditName: 'Elsewhere'}),
      submitComment: async () => {
        submitted = true
        return comment
      },
    }),
  )

  await assert.rejects(
    executor.reply({parentId: 't1_comment1', body: 'hello', requestId: 'r1'}),
    /target_restricted/,
  )
  assert.equal(submitted, false)
})

test('reply verifies targets and reserves before the only write', async () => {
  const calls: string[] = []
  const executor = createExecutor(
    makeApi({
      getCommentById: async id => {
        calls.push(`comment:${id}`)
        return comment
      },
      getPostById: async id => {
        calls.push(`post:${id}`)
        return post
      },
      submitComment: async opts => {
        calls.push(`submit:${opts.id}`)
        return {...comment, id: 't1_reply'}
      },
    }),
  )

  const result = await executor.reply(
    {
      parentId: 't1_comment1',
      body: 'hello',
      requestId: 'r1',
    },
    async () => {
      calls.push('reserve')
    },
  )
  assert.deepEqual(calls, [
    'comment:t1_comment1',
    'post:t3_post1',
    'reserve',
    'submit:t1_comment1',
  ])
  assert.equal(result.comment.id, 't1_reply')
})

test('a throwing reservation hook prevents the write', async () => {
  let submitted = false
  const executor = createExecutor(
    makeApi({
      submitPost: async () => {
        submitted = true
        return post
      },
    }),
  )
  await assert.rejects(
    executor.publishPost(
      {title: 'Paper', body: 'Folded', requestId: 'r1'},
      async () => {
        throw new Error('no reservation')
      },
    ),
    /no reservation/,
  )
  assert.equal(submitted, false)
})

test('publish_post writes only to the target subreddit', async () => {
  let submitted: Parameters<RedditApi['submitPost']>[0] | undefined
  const executor = createExecutor(
    makeApi({
      submitPost: async opts => {
        submitted = opts
        return {...post, id: 't3_new'}
      },
    }),
  )

  const result = await executor.publishPost({
    title: 'Paper',
    body: 'Folded',
    requestId: 'r1',
  })
  assert.deepEqual(submitted, {
    subredditName: target,
    title: 'Paper',
    text: 'Folded',
  })
  assert.equal(result.post.id, 't3_new')
})

test('a 429 read records the persistent cooldown', async () => {
  let failures = 0
  const executor = createExecutor(
    makeApi({
      getNewPosts: () => ({
        hasMore: false,
        get: async () => {
          throw new Error('429 Too Many Requests token=secret')
        },
      }),
    }),
    target,
    {
      assertReady: async () => undefined,
      recordFailure: async () => {
        failures++
      },
      recordSuccess: async () => undefined,
    },
  )
  await assert.rejects(executor.activity({limit: 5}), /rate_limited/)
  assert.equal(failures, 1)
})

test('a cooldown blocks before a write reservation is made', async () => {
  let reserved = false
  let submitted = false
  const executor = createExecutor(
    makeApi({
      submitPost: async () => {
        submitted = true
        return post
      },
    }),
    target,
    {
      assertReady: async () => {
        throw new AppFailure('rate_limited')
      },
      recordFailure: async () => undefined,
      recordSuccess: async () => undefined,
    },
  )
  await assert.rejects(
    executor.publishPost(
      {title: 'A title', body: 'A body', requestId: 'r1'},
      async () => {
        reserved = true
      },
    ),
    /rate_limited/,
  )
  assert.equal(reserved, false)
  assert.equal(submitted, false)
})

test('a 429 write records the cooldown after its reservation', async () => {
  let failures = 0
  let reserved = false
  const executor = createExecutor(
    makeApi({
      submitPost: async () => {
        throw new Error('429 Too Many Requests')
      },
    }),
    target,
    {
      assertReady: async () => undefined,
      recordFailure: async () => {
        failures++
      },
      recordSuccess: async () => undefined,
    },
  )
  await assert.rejects(
    executor.publishPost(
      {title: 'A title', body: 'A body', requestId: 'r1'},
      async () => {
        reserved = true
      },
    ),
    /rate_limited/,
  )
  assert.equal(reserved, true)
  assert.equal(failures, 1)
})
