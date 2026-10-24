import {z} from 'zod'

/** The only subreddit this app is allowed to touch. */
export const TARGET_SUBREDDIT = 'GlyphsPlayground'

export const ACTIVITY_DEFAULT_LIMIT = 20
export const ACTIVITY_MAX_LIMIT = 50
export const THREAD_DEFAULT_LIMIT = 100
export const THREAD_MAX_LIMIT = 100
export const THREAD_MAX_OFFSET = 10000

const POST_ID_RE = /^t3_[a-z0-9]+$/i
const COMMENT_ID_RE = /^t1_[a-z0-9]+$/i
const PARENT_ID_RE = /^t[13]_[a-z0-9]+$/i

const postId = z
  .string()
  .trim()
  .toLowerCase()
  .max(32)
  .regex(POST_ID_RE, 'expected a t3_ post id')
const commentId = z
  .string()
  .trim()
  .toLowerCase()
  .max(32)
  .regex(COMMENT_ID_RE, 'expected a t1_ comment id')
const parentId = z
  .string()
  .trim()
  .toLowerCase()
  .max(32)
  .regex(PARENT_ID_RE, 'expected a t1_ comment or t3_ post id')

const requestId = z
  .string()
  .trim()
  .uuid()
  .describe(
    'Publication idempotency key. Reuse unchanged after any retry or interruption; never bypass an uncertain result with a new key.',
  )

/* Canonical, strict tool arguments. */
export const ActivityArgsSchema = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(ACTIVITY_MAX_LIMIT)
      .default(ACTIVITY_DEFAULT_LIMIT),
    after: postId.optional(),
  })
  .strict()

export const ThreadArgsSchema = z
  .object({
    postId,
    commentId: commentId.optional(),
    // The executor defaults an omitted offset to 0.
    offset: z.number().int().min(0).max(THREAD_MAX_OFFSET).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(THREAD_MAX_LIMIT)
      .default(THREAD_DEFAULT_LIMIT),
  })
  .strict()

export const PublishPostArgsSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(40000),
    requestId,
  })
  .strict()

export const ReplyArgsSchema = z
  .object({
    parentId,
    body: z.string().trim().min(1).max(10000),
    requestId,
  })
  .strict()

/* Sanitized result data. No Reddit model objects leave the app. */
export const PostDataSchema = z.object({
  id: z.string().regex(POST_ID_RE),
  title: z.string(),
  body: z.string(),
  author: z.string(),
  url: z.string(),
  createdAt: z.string(),
  subreddit: z.string(),
  commentCount: z.number().int().nonnegative(),
})

export const CommentDataSchema = z.object({
  id: z.string().regex(COMMENT_ID_RE),
  parentId: z.string().regex(PARENT_ID_RE),
  postId: z.string().regex(POST_ID_RE),
  author: z.string(),
  body: z.string(),
  url: z.string(),
  createdAt: z.string(),
})

/** A compact comment pointer; no comment text is persisted. */
export const RecentCommentSchema = CommentDataSchema.pick({
  id: true,
  postId: true,
  createdAt: true,
}).strict()
export const CommentEventRequestSchema = z.object({
  subreddit: z.literal(TARGET_SUBREDDIT),
  comment: RecentCommentSchema,
})

const activityPage = z.object({
  nextAfter: postId.nullable(),
  hasMore: z.boolean(),
})
const commentPage = z.object({
  count: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
})

export const ActivityResultSchema = z.object({
  posts: z.array(PostDataSchema),
  pagination: activityPage,
})
export const ThreadResultSchema = z.object({
  post: PostDataSchema,
  comments: z.array(CommentDataSchema),
  pagination: commentPage,
})
export const PublishPostResultSchema = z.object({
  post: PostDataSchema,
})
export const ReplyResultSchema = z.object({
  comment: CommentDataSchema,
})

export type ActivityArgs = z.infer<typeof ActivityArgsSchema>
export type ThreadArgs = z.infer<typeof ThreadArgsSchema>
export type PublishPostArgs = z.infer<typeof PublishPostArgsSchema>
export type ReplyArgs = z.infer<typeof ReplyArgsSchema>
export type PostData = z.infer<typeof PostDataSchema>
export type CommentData = z.infer<typeof CommentDataSchema>
export type CommentEventRequest = z.infer<typeof CommentEventRequestSchema>
export type RecentComment = z.infer<typeof RecentCommentSchema>
export type ActivityResult = z.infer<typeof ActivityResultSchema>
export type ThreadResult = z.infer<typeof ThreadResultSchema>
export type PublishPostResult = z.infer<typeof PublishPostResultSchema>
export type ReplyResult = z.infer<typeof ReplyResultSchema>
