import {
  type ActivityArgs,
  type ActivityResult,
  type CommentData,
  type PublishPostArgs,
  type PublishPostResult,
  type ReplyArgs,
  type ReplyResult,
  TARGET_SUBREDDIT,
  THREAD_MAX_LIMIT,
  type ThreadArgs,
  type ThreadResult,
} from '../shared/contracts.ts'
import {AppFailure, errorCode} from './errors.ts'
import type {RateGate} from './rate-limit.ts'

const noopGate: RateGate = {
  assertReady: async () => undefined,
  recordFailure: async () => undefined,
  recordSuccess: async () => undefined,
}

/** The subset of Reddit data the app is allowed to read. */
export type RedditPost = {
  id: string
  authorName: string
  subredditName: string
  permalink: string
  title: string
  body: string | undefined
  createdAt: Date
  numberOfComments: number
}

export type RedditComment = {
  id: string
  authorName: string
  subredditName: string
  body: string
  createdAt: Date
  parentId: string
  postId: string
  permalink: string
  replies?: RedditListing<RedditComment> | undefined
}

export type RedditListing<T> = {
  readonly hasMore: boolean
  readonly children?: T[] | undefined
  /** Cumulative, matching the Devvit Listing API. */
  get(count: number): Promise<T[]>
}

/** Injectable Reddit client used by the executor. */
export type RedditApi = {
  getPostById(id: string): Promise<RedditPost>
  getCommentById(id: string): Promise<RedditComment>
  getNewPosts(options: {
    subredditName: string
    limit: number
    after?: string | undefined
    pageSize?: number
  }): RedditListing<RedditPost>
  getComments(options: {
    postId: string
    commentId?: string | undefined
    limit?: number | undefined
    pageSize?: number
    sort?: 'new'
  }): RedditListing<RedditComment>
  submitPost(options: {
    subredditName: string
    title: string
    text: string
  }): Promise<RedditPost>
  submitComment(options: {id: string; text: string}): Promise<RedditComment>
}

/** Runs immediately before the single public write; throwing aborts the write. */
export type BeforeWrite = () => Promise<void>

export type Executor = {
  activity(args: ActivityArgs): Promise<ActivityResult>
  thread(args: ThreadArgs): Promise<ThreadResult>
  publishPost(
    args: PublishPostArgs,
    beforeWrite?: BeforeWrite,
  ): Promise<PublishPostResult>
  reply(args: ReplyArgs, beforeWrite?: BeforeWrite): Promise<ReplyResult>
}

const THREAD_PAGE_SIZE = 100
const THREAD_TIME_BUDGET_MS = 7_000
const THREAD_FETCH_BUDGET = 5_000
const THREAD_SCAN_SLACK = 200
const THREAD_OUTPUT_CHARS = 300_000
const ACTIVITY_OUTPUT_CHARS = 400_000

class ThreadBudget extends Error {}

type ListFrame = {
  kind: 'list'
  listing: RedditListing<RedditComment>
  items: RedditComment[]
  index: number
  done: boolean
}

type NodeFrame = {kind: 'node'; comment: RedditComment}
type Frame = ListFrame | NodeFrame

export function createExecutor(
  api: RedditApi,
  target: string = TARGET_SUBREDDIT,
  gate: RateGate = noopGate,
): Executor {
  function assertTarget(subredditName: string): void {
    if (subredditName.toLowerCase() !== target.toLowerCase()) {
      throw new AppFailure('target_restricted')
    }
  }

  function isTarget(thing: {subredditName: string}): boolean {
    return thing.subredditName.toLowerCase() === target.toLowerCase()
  }

  /** Cooldown is checked before every Reddit call and persisted on 429. */
  async function redditRead<T>(fn: () => Promise<T>): Promise<T> {
    await gate.assertReady()
    try {
      const result = await fn()
      await gate.recordSuccess().catch(() => undefined)
      return result
    } catch (err) {
      const code = errorCode(err)
      if (code === 'rate_limited') {
        await gate.recordFailure().catch(() => undefined)
      }
      if (err instanceof AppFailure) throw err
      throw new AppFailure(
        code === 'rate_limited' ? 'rate_limited' : 'reddit_unavailable',
      )
    }
  }

  async function redditWrite<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn()
      await gate.recordSuccess().catch(() => undefined)
      return result
    } catch (err) {
      const code = errorCode(err)
      if (code === 'rate_limited') {
        await gate.recordFailure().catch(() => undefined)
      }
      if (err instanceof AppFailure) throw err
      throw new AppFailure(
        code === 'rate_limited' ? 'rate_limited' : 'reddit_unavailable',
      )
    }
  }

  async function activity(args: ActivityArgs): Promise<ActivityResult> {
    const listing = api.getNewPosts({
      subredditName: target,
      limit: args.limit,
      after: args.after,
      pageSize: args.limit,
    })
    const raw = await redditRead(() => listing.get(args.limit))
    const all = raw.filter(isTarget).map(toPost)
    const posts: typeof all = []
    let chars = 0
    let bounded = false
    for (const item of all) {
      const size = item.title.length + item.body.length
      if (posts.length > 0 && chars + size > ACTIVITY_OUTPUT_CHARS) {
        bounded = true
        break
      }
      posts.push(item)
      chars += size
    }
    const hasMore = listing.hasMore || bounded
    return {
      posts,
      pagination: {
        nextAfter: hasMore
          ? (posts.at(-1)?.id ?? raw.at(-1)?.id ?? null)
          : null,
        hasMore,
      },
    }
  }

  async function thread(args: ThreadArgs): Promise<ThreadResult> {
    const post = await redditRead(() => api.getPostById(args.postId))
    assertTarget(post.subredditName)
    if (args.commentId) {
      const focus = await redditRead(() =>
        api.getCommentById(args.commentId as string),
      )
      assertTarget(focus.subredditName)
      if (focus.postId !== args.postId) {
        throw new AppFailure('target_restricted')
      }
    }

    const offset = args.offset ?? 0
    const limit = Math.min(args.limit, THREAD_MAX_LIMIT)
    const started = Date.now()
    const scanLimit = offset + limit + THREAD_SCAN_SLACK
    const listing = api.getComments({
      postId: args.postId,
      commentId: args.commentId,
      pageSize: THREAD_PAGE_SIZE,
      sort: 'new',
    })

    const stack: Frame[] = [listFrame(listing)]
    const seen = new Set<string>()
    const page: CommentData[] = []
    let accepted = 0
    let fetched = 0
    let chars = 0
    let hasMore = false
    let truncated = false

    function budgetExceeded(): boolean {
      return (
        Date.now() - started > THREAD_TIME_BUDGET_MS ||
        fetched > THREAD_FETCH_BUDGET ||
        accepted >= scanLimit
      )
    }

    async function nextComment(
      frame: ListFrame,
    ): Promise<RedditComment | undefined> {
      while (frame.index < frame.items.length) return frame.items[frame.index++]
      if (frame.done || !frame.listing.hasMore) return undefined
      const before = frame.items.length
      const items = await redditRead(() =>
        frame.listing.get(before + THREAD_PAGE_SIZE),
      )
      fetched += Math.max(0, items.length - before)
      if (items.length <= before) {
        frame.done = true
        return undefined
      }
      frame.items = items
      return nextComment(frame)
    }

    try {
      while (stack.length > 0) {
        if (budgetExceeded()) throw new ThreadBudget()
        const frame = stack.at(-1)
        if (!frame) break

        if (frame.kind === 'list') {
          const comment = await nextComment(frame)
          if (!comment) {
            stack.pop()
            continue
          }
          stack.push({kind: 'node', comment})
          continue
        }

        stack.pop()
        if (!isTarget(frame.comment) || frame.comment.postId !== args.postId) {
          continue
        }
        if (seen.has(frame.comment.id)) continue
        seen.add(frame.comment.id)
        fetched++

        if (accepted < offset) {
          accepted++
          pushReplies(stack, frame.comment)
          continue
        }
        if (page.length >= limit) {
          hasMore = true
          break
        }
        const body = frame.comment.body
        if (page.length > 0 && chars + body.length > THREAD_OUTPUT_CHARS) {
          hasMore = true
          truncated = true
          break
        }
        page.push(serializeComment(frame.comment))
        chars += body.length
        accepted++
        pushReplies(stack, frame.comment)
      }
    } catch (err) {
      if (!(err instanceof ThreadBudget)) throw err
      hasMore = true
      truncated = true
    }

    if (truncated && page.length === 0) {
      throw new AppFailure('thread_truncated')
    }
    const nextOffset = hasMore ? offset + page.length : null
    return {
      post: toPost(post),
      comments: page,
      pagination: {
        count: page.length,
        hasMore,
        nextOffset,
        truncated,
      },
    }
  }

  async function publishPost(
    args: PublishPostArgs,
    beforeWrite?: BeforeWrite,
  ): Promise<PublishPostResult> {
    await gate.assertReady()
    await beforeWrite?.()
    const post = await redditWrite(() =>
      api.submitPost({
        subredditName: target,
        title: args.title,
        text: args.body,
      }),
    )
    assertTarget(post.subredditName)
    return {post: toPost(post)}
  }

  async function reply(
    args: ReplyArgs,
    beforeWrite?: BeforeWrite,
  ): Promise<ReplyResult> {
    if (args.parentId.startsWith('t3_')) {
      const post = await redditRead(() => api.getPostById(args.parentId))
      assertTarget(post.subredditName)
    } else {
      const parent = await redditRead(() => api.getCommentById(args.parentId))
      assertTarget(parent.subredditName)
      const post = await redditRead(() => api.getPostById(parent.postId))
      assertTarget(post.subredditName)
    }

    await gate.assertReady()
    await beforeWrite?.()
    const comment = await redditWrite(() =>
      api.submitComment({
        id: args.parentId,
        text: args.body,
      }),
    )
    assertTarget(comment.subredditName)
    return {comment: serializeComment(comment)}
  }

  return {activity, thread, publishPost, reply}
}

function listFrame(listing: RedditListing<RedditComment>): ListFrame {
  return {
    kind: 'list',
    listing,
    items: listing.children?.slice() ?? [],
    index: 0,
    done: false,
  }
}

function pushReplies(stack: Frame[], comment: RedditComment): void {
  if (comment.replies) stack.push(listFrame(comment.replies))
}

function toPost(post: RedditPost): ActivityResult['posts'][number] {
  return {
    id: post.id,
    title: post.title,
    body: post.body ?? '',
    author: post.authorName,
    url: canonicalUrl(post.permalink),
    createdAt: post.createdAt.toISOString(),
    subreddit: post.subredditName,
    commentCount: post.numberOfComments,
  }
}

/** Converts a Reddit comment into the only comment shape returned to callers. */
export function serializeComment(comment: RedditComment): CommentData {
  return {
    id: comment.id,
    parentId: comment.parentId,
    postId: comment.postId,
    author: comment.authorName,
    body: comment.body,
    url: canonicalUrl(comment.permalink),
    createdAt: comment.createdAt.toISOString(),
  }
}

function canonicalUrl(permalink: string): string {
  if (/^https?:\/\//i.test(permalink)) return permalink
  const path = permalink.startsWith('/') ? permalink : `/${permalink}`
  return `https://www.reddit.com${path}`
}

/** Exported for callers that need to classify an executor failure safely. */
export {errorCode}
