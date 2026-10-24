/** Error codes are the only error detail that may leave the worker. */
export const WORKER_ERROR_CODES = [
  'rate_limited',
  'reddit_unavailable',
  'target_restricted',
  'invalid_worker_job',
  'bridge_unavailable',
] as const

export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[number]

export class WorkerFailure extends Error {
  readonly code: WorkerErrorCode

  constructor(code: WorkerErrorCode) {
    super(code)
    this.name = 'WorkerFailure'
    this.code = code
  }
}

/** Classifies raw failures without retaining their message or payload. */
export function errorCode(err: unknown): WorkerErrorCode {
  if (err instanceof WorkerFailure) return err.code
  if (
    err instanceof Error &&
    /rate.?limit|too many requests|\b429\b/i.test(err.message)
  ) {
    return 'rate_limited'
  }
  return 'reddit_unavailable'
}
