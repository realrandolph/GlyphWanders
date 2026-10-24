import {z} from 'zod'

/** The only subreddit this worker is allowed to touch. */
export const TARGET_SUBREDDIT = 'GlyphsPlayground'

/** Subreddit-scoped setting holding the bridge base URL. */
export const BRIDGE_URL_SETTING = 'bridge-url'
/** Global secret setting holding the bridge bearer token. */
export const BRIDGE_TOKEN_SETTING = 'bridge-token'

export const ACTIVITY_DEFAULT_LIMIT = 20
export const ACTIVITY_MAX_LIMIT = 50
export const THREAD_MAX_LIMIT = 100

const FULLNAME_RE = /^t[1-6]_[a-z0-9]+$/i
const POST_ID_RE = /^t3_[a-z0-9]+$/i
const COMMENT_ID_RE = /^t1_[a-z0-9]+$/i
const PARENT_ID_RE = /^t[13]_[a-z0-9]+$/i

const fullname = z.string().regex(FULLNAME_RE, 'expected a Reddit fullname')
const postId = z.string().regex(POST_ID_RE, 'expected a t3_ post id')
const commentId = z.string().regex(COMMENT_ID_RE, 'expected a t1_ comment id')
const parentId = z
  .string()
  .regex(PARENT_ID_RE, 'expected a t1_ comment or t3_ post id')
const requestId = z.string().min(1).max(128)

/* Operation arguments. Each job's `args` is validated against one of these. */
export const ActivityArgsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(ACTIVITY_MAX_LIMIT)
    .default(ACTIVITY_DEFAULT_LIMIT),
  after: fullname.optional(),
})

export const ThreadArgsSchema = z.object({
  postId,
  commentId: commentId.optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(THREAD_MAX_LIMIT)
    .default(THREAD_MAX_LIMIT),
})

export const PublishPostArgsSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(40000),
  requestId,
})

export const ReplyArgsSchema = z.object({
  parentId,
  body: z.string().min(1).max(10000),
  requestId,
})

export const OPERATION_KINDS = [
  'activity',
  'thread',
  'publish_post',
  'reply',
] as const
export type OperationKind = (typeof OPERATION_KINDS)[number]

export const WorkerJobSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1).max(200),
    kind: z.literal('activity'),
    args: ActivityArgsSchema,
  }),
  z.object({
    id: z.string().min(1).max(200),
    kind: z.literal('thread'),
    args: ThreadArgsSchema,
  }),
  z.object({
    id: z.string().min(1).max(200),
    kind: z.literal('publish_post'),
    args: PublishPostArgsSchema,
  }),
  z.object({
    id: z.string().min(1).max(200),
    kind: z.literal('reply'),
    args: ReplyArgsSchema,
  }),
])

export const ClaimRequestSchema = z.object({
  subreddit: z.literal(TARGET_SUBREDDIT),
})
export const ClaimResponseSchema = z.object({
  job: WorkerJobSchema.nullable(),
})
export const CompleteRequestSchema = z.object({
  id: z.string().min(1).max(200),
  result: z.unknown(),
  error: z.string().max(2000).optional(),
})

/* Sanitized result data. No Reddit model objects cross the bridge. */
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

export const CommentEventRequestSchema = z.object({
  subreddit: z.literal(TARGET_SUBREDDIT),
  comment: CommentDataSchema,
})

const activityPage = z.object({
  nextAfter: fullname.nullable(),
  hasMore: z.boolean(),
})
const commentPage = z.object({
  count: z.number().int().nonnegative(),
  hasMore: z.boolean(),
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

export const OperationResultSchema = z.union([
  ActivityResultSchema,
  ThreadResultSchema,
  PublishPostResultSchema,
  ReplyResultSchema,
])

export type ActivityArgs = z.infer<typeof ActivityArgsSchema>
export type ThreadArgs = z.infer<typeof ThreadArgsSchema>
export type PublishPostArgs = z.infer<typeof PublishPostArgsSchema>
export type ReplyArgs = z.infer<typeof ReplyArgsSchema>
export type WorkerJob = z.infer<typeof WorkerJobSchema>
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>
export type CompleteRequest = z.infer<typeof CompleteRequestSchema>
export type PostData = z.infer<typeof PostDataSchema>
export type CommentData = z.infer<typeof CommentDataSchema>
export type CommentEventRequest = z.infer<typeof CommentEventRequestSchema>
export type ActivityResult = z.infer<typeof ActivityResultSchema>
export type ThreadResult = z.infer<typeof ThreadResultSchema>
export type PublishPostResult = z.infer<typeof PublishPostResultSchema>
export type ReplyResult = z.infer<typeof ReplyResultSchema>
export type OperationResult = z.infer<typeof OperationResultSchema>
