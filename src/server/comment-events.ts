import {z} from 'zod'
import {
  type CommentEventRequest,
  TARGET_SUBREDDIT,
} from '../shared/contracts.ts'
import {type RedditComment, serializeComment} from './executor.ts'

/** The supported onCommentCreate payload, narrowed to the field we need. */
const CommentCreatePayloadSchema = z
  .object({
    comment: z
      .object({id: z.string().regex(/^t1_[a-z0-9]+$/i)})
      .loose()
      .optional(),
  })
  .loose()

export type CommentEventDeps = {
  getComment: (id: string) => Promise<RedditComment>
  postComment: (event: CommentEventRequest) => Promise<void>
  target?: string
}

/**
 * Best-effort capture for comments created after installation. There is no
 * backfill; get_thread remains the fallback for historical comments.
 */
export async function handleCommentCreate(
  payload: unknown,
  deps: CommentEventDeps,
): Promise<boolean> {
  const event = CommentCreatePayloadSchema.safeParse(payload)
  const id = event.success ? event.data.comment?.id : undefined
  if (!id) return false

  // Re-read the comment so the subreddit check uses Reddit's current record.
  const comment = await deps.getComment(id)
  const target = deps.target ?? TARGET_SUBREDDIT
  if (comment.subredditName.toLowerCase() !== target.toLowerCase()) return false

  await deps.postComment({
    subreddit: TARGET_SUBREDDIT,
    comment: serializeComment(comment),
  })
  return true
}
