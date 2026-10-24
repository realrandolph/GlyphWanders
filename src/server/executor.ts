import {
  type ActivityArgs,
  type ActivityResult,
  type CommentData,
  type OperationResult,
  type PostData,
  type PublishPostArgs,
  type PublishPostResult,
  type ReplyArgs,
  type ReplyResult,
  TARGET_SUBREDDIT,
  THREAD_MAX_LIMIT,
  type ThreadArgs,
  type ThreadResult,
  type WorkerJob,
} from '../shared/contracts.ts'
import {WorkerFailure} from './errors.ts'

/** The subset of Reddit data the worker is allowed to read. */
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
    limit: number
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

export type Executor = {
  activity(args: ActivityArgs): Promise<ActivityResult>
  thread(args: ThreadArgs): Promise<ThreadResult>
  publishPost(args: PublishPostArgs): Promise<PublishPostResult>
  reply(args: ReplyArgs): Promise<ReplyResult>
  execute(job: WorkerJob): Promise<OperationResult>
}

export function createExecutor(
  api: RedditApi,
  target: string = TARGET_SUBREDDIT,
): Executor {
  function assertTarget(subredditName: string): void {
    if (subredditName.toLowerCase() !== target.toLowerCase()) {
      throw new WorkerFailure('target_restricted')
    }
  }

  async function activity(args: ActivityArgs): Promise<ActivityResult> {
    const listing = api.getNewPosts({
      subredditName: target,
      limit: args.limit,
      after: args.after,
      pageSize: args.limit,
    })
    const raw = await listing.get(args.limit)
    const posts = raw.filter(p => isTarget(p)).map(toPost)
    return {
      posts,
      pagination: {
        nextAfter: listing.hasMore ? (posts.at(-1)?.id ?? null) : null,
        hasMore: listing.hasMore,
      },
    }
  }

  async function thread(args: ThreadArgs): Promise<ThreadResult> {
    const post = await api.getPostById(args.postId)
    assertTarget(post.subredditName)
    if (args.commentId) {
      const focus = await api.getCommentById(args.commentId)
      assertTarget(focus.subredditName)
      if (focus.postId !== args.postId)
        throw new WorkerFailure('target_restricted')
    }

    const budget = Math.min(args.limit, THREAD_MAX_LIMIT)
    const listing = api.getComments({
      postId: args.postId,
      commentId: args.commentId,
      limit: budget,
      pageSize: budget,
      sort: 'new',
    })
    const belongs = (comment: RedditComment) =>
      isTarget(comment) && comment.postId === args.postId
    const top = (await listing.get(budget)).filter(belongs)

    // BFS over Comment.replies, capped by one global comment budget.
    const queue = [...top]
    const seen = new Set<string>()
    const flat: RedditComment[] = []
    let hasMore = listing.hasMore

    while (queue.length > 0 && flat.length < budget) {
      const comment = queue.shift()
      if (!comment || seen.has(comment.id)) continue
      seen.add(comment.id)
      flat.push(comment)

      if (flat.length >= budget) {
        // The budget was reached before this comment's replies were read.
        const replies = comment.replies
        hasMore =
          hasMore ||
          queue.length > 0 ||
          Boolean(replies?.hasMore || replies?.children?.length)
        break
      }

      const replies = comment.replies
      if (!replies) continue
      const remaining = budget - flat.length - queue.length
      if (remaining <= 0) {
        if (replies.hasMore || replies.children?.length) hasMore = true
        continue
      }
      const next = (await replies.get(remaining)).filter(belongs)
      queue.push(...next)
      if (replies.hasMore) hasMore = true
    }
    if (queue.length > 0) hasMore = true

    const comments = flat
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(serializeComment)
    return {
      post: toPost(post),
      comments,
      pagination: {count: comments.length, hasMore},
    }
  }

  async function publishPost(
    args: PublishPostArgs,
  ): Promise<PublishPostResult> {
    const post = await api.submitPost({
      subredditName: target,
      title: args.title,
      text: args.body,
    })
    assertTarget(post.subredditName)
    return {post: toPost(post)}
  }

  async function reply(args: ReplyArgs): Promise<ReplyResult> {
    if (args.parentId.startsWith('t3_')) {
      const post = await api.getPostById(args.parentId)
      assertTarget(post.subredditName)
    } else {
      const parent = await api.getCommentById(args.parentId)
      assertTarget(parent.subredditName)
      const post = await api.getPostById(parent.postId)
      assertTarget(post.subredditName)
    }

    const comment = await api.submitComment({
      id: args.parentId,
      text: args.body,
    })
    assertTarget(comment.subredditName)
    return {comment: serializeComment(comment)}
  }

  function isTarget(thing: {subredditName: string}): boolean {
    return thing.subredditName.toLowerCase() === target.toLowerCase()
  }

  async function execute(job: WorkerJob): Promise<OperationResult> {
    switch (job.kind) {
      case 'activity':
        return activity(job.args)
      case 'thread':
        return thread(job.args)
      case 'publish_post':
        return publishPost(job.args)
      case 'reply':
        return reply(job.args)
    }
  }

  return {activity, thread, publishPost, reply, execute}
}

function toPost(post: RedditPost): PostData {
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

/** Converts a Reddit comment into the only comment shape sent to the bridge. */
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
