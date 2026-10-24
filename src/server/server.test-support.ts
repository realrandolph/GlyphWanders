import type {
  RedditApi,
  RedditComment,
  RedditListing,
  RedditPost,
} from './executor.ts'
import {createExecutor} from './executor.ts'
import {createJournal, type Reservation} from './journal.ts'
import {MemoryRedis} from './memory-redis.ts'
import type {ServerDeps} from './server.ts'

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

const reply: RedditComment = {
  ...comment,
  id: 't1_reply1',
  parentId: 't1_comment1',
  body: 'A reply',
  createdAt: new Date('2026-01-02T05:05:06.000Z'),
}

const second: RedditComment = {
  ...comment,
  id: 't1_comment2',
  body: 'Another comment',
  createdAt: new Date('2026-01-02T06:05:06.000Z'),
}

function listing<T>(items: T[]): RedditListing<T> {
  return {hasMore: false, children: items, get: async () => items}
}

export type TestDeps = ServerDeps & {
  submits: Array<{
    kind: 'post' | 'comment'
    title?: string
    body: string
    id?: string
  }>
  reservations: Reservation[]
}

export function createServerDeps(): TestDeps {
  const submits: TestDeps['submits'] = []
  const reservations: Reservation[] = []
  const api: RedditApi = {
    getPostById: async id => {
      if (id === post.id) return post
      throw new Error('unknown post')
    },
    getCommentById: async id => {
      if (id === comment.id) return comment
      if (id === reply.id) return reply
      throw new Error('unknown comment')
    },
    getNewPosts: () => listing([post]),
    getComments: () =>
      listing([{...comment, replies: listing([reply])}, second]),
    submitPost: async options => {
      submits.push({kind: 'post', title: options.title, body: options.text})
      return {...post, id: 't3_new'}
    },
    submitComment: async options => {
      submits.push({kind: 'comment', body: options.text, id: options.id})
      return {...comment, id: 't1_new'}
    },
  }
  const journal = createJournal(new MemoryRedis())
  const reserve = journal.reserve
  journal.reserve = async input => {
    const reservation = await reserve(input)
    reservations.push(reservation)
    return reservation
  }
  return {
    executor: createExecutor(api, target),
    journal,
    getComment: id => api.getCommentById(id),
    target,
    submits,
    reservations,
  }
}
