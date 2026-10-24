/** Error codes are the only error detail that may leave the app. */
export const ERROR_CODES = [
  'rate_limited',
  'reddit_unavailable',
  'target_restricted',
  'journal_unavailable',
  'journal_conflict',
  'publication_uncertain',
  'memory_conflict',
  'invalid_arguments',
  'thread_truncated',
  'internal',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export class AppFailure extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode) {
    super(code)
    this.name = 'AppFailure'
    this.code = code
  }
}

/** Classifies raw failures without retaining their message or payload. */
export function errorCode(err: unknown): ErrorCode {
  if (err instanceof AppFailure) return err.code
  if (
    err instanceof Error &&
    /rate.?limit|too many requests|\b429\b/i.test(err.message)
  ) {
    return 'rate_limited'
  }
  return 'internal'
}

/** Short, non-sensitive text suitable for a tool error. */
export function safeMessage(code: ErrorCode): string {
  switch (code) {
    case 'rate_limited':
      return 'Reddit is rate limiting requests. Try again later.'
    case 'reddit_unavailable':
      return 'Reddit is temporarily unavailable.'
    case 'target_restricted':
      return 'Only r/GlyphsPlayground is accessible.'
    case 'journal_unavailable':
      return 'Durable storage is unavailable; no public write was attempted.'
    case 'journal_conflict':
      return 'The request id was already used for different content.'
    case 'publication_uncertain':
      return 'Publication outcome is uncertain. Do not resubmit; retry the same requestId to inspect the journal or ask the owner to reconcile.'
    case 'memory_conflict':
      return 'Memory version does not match. Read memory again before writing.'
    case 'invalid_arguments':
      return 'Invalid tool arguments.'
    case 'thread_truncated':
      return 'This thread is too large to enumerate in one bounded request. Focus a commentId branch and continue.'
    case 'internal':
      return 'The operation failed safely.'
  }
}

/** Exponential backoff for read-only Reddit calls. Writes never retry. */
export async function withReadRetry<T>(
  fn: () => Promise<T>,
  options: {attempts?: number; baseDelayMs?: number} = {},
): Promise<T> {
  const attempts = options.attempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 120
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      const code = errorCode(err)
      if (code !== 'rate_limited' && code !== 'reddit_unavailable') throw err
      if (attempt + 1 < attempts) {
        await new Promise(resolve =>
          setTimeout(resolve, baseDelayMs * 2 ** attempt),
        )
      }
    }
  }
  throw last
}
