import {z} from 'zod'
import {
  type ClaimRequest,
  type CommentData,
  type CommentEventRequest,
  type CompleteRequest,
  TARGET_SUBREDDIT,
  type WorkerJob,
  WorkerJobSchema,
} from '../shared/contracts.ts'
import {errorCode, WorkerFailure} from './errors.ts'

export const HTTP_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 1_000_000

export type BridgeConfig = {url: string; token: string}
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type PollDeps = {
  getConfig: () => Promise<BridgeConfig>
  execute: (job: WorkerJob) => Promise<unknown>
  fetchImpl?: FetchLike
}

export type PollOutcome =
  | {status: 'skipped'}
  | {status: 'idle'}
  | {
      status: 'completed'
      jobId: string
      kind: WorkerJob['kind'] | null
      ok: boolean
    }

/**
 * Claims at most one job, executes it once, and completes it once. Writes are
 * never retried here: idempotency belongs to the bridge's SQLite queue.
 */
export async function pollOnce(deps: PollDeps): Promise<PollOutcome> {
  const rawConfig = await deps.getConfig()
  const config = {
    url: rawConfig.url.trim(),
    token: rawConfig.token.trim(),
  }
  if (!config.url || !config.token) return {status: 'skipped'}

  const fetchImpl = deps.fetchImpl ?? fetch
  const claimBody: ClaimRequest = {subreddit: TARGET_SUBREDDIT}
  const claimRaw = await postBridgeJson(
    config,
    '/worker/claim',
    claimBody,
    fetchImpl,
  )

  const envelope = ClaimEnvelopeSchema.safeParse(claimRaw)
  if (!envelope.success) {
    throw new WorkerFailure('bridge_unavailable')
  }
  if (envelope.data.job === null) return {status: 'idle'}

  const job = WorkerJobSchema.safeParse(envelope.data.job)
  if (!job.success) {
    const jobId = readJobId(envelope.data.job)
    if (!jobId) throw new WorkerFailure('bridge_unavailable')
    await complete(config, jobId, null, 'invalid_worker_job', fetchImpl)
    return {status: 'completed', jobId, kind: null, ok: false}
  }

  let result: unknown
  try {
    result = await deps.execute(job.data)
  } catch (err) {
    await complete(config, job.data.id, null, errorCode(err), fetchImpl)
    return {
      status: 'completed',
      jobId: job.data.id,
      kind: job.data.kind,
      ok: false,
    }
  }

  await complete(config, job.data.id, result ?? null, undefined, fetchImpl)
  return {
    status: 'completed',
    jobId: job.data.id,
    kind: job.data.kind,
    ok: true,
  }
}

export function bridgeEndpoint(base: string, route: string): string {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new WorkerFailure('bridge_unavailable')
  }
  if (url.protocol !== 'https:') {
    throw new WorkerFailure('bridge_unavailable')
  }
  if (url.username || url.password) {
    throw new WorkerFailure('bridge_unavailable')
  }
  if (url.search || url.hash) {
    throw new WorkerFailure('bridge_unavailable')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${route.replace(/^\/+/, '')}`
  return url.toString()
}

/**
 * Sends one best-effort recent-comment event. The bridge owns deduplication and
 * persistence; triggers only cover comments created after install.
 */
export async function postCommentEvent(
  config: BridgeConfig,
  comment: CommentData,
  fetchImpl?: FetchLike,
): Promise<void> {
  const body: CommentEventRequest = {subreddit: TARGET_SUBREDDIT, comment}
  await postBridgeJson(config, '/worker/comment', body, fetchImpl)
}

const ClaimEnvelopeSchema = z.object({job: z.unknown().nullable()})

async function complete(
  config: BridgeConfig,
  id: string,
  result: unknown,
  error: string | undefined,
  fetchImpl: FetchLike,
): Promise<void> {
  const body: CompleteRequest = error ? {id, result, error} : {id, result}
  await postBridgeJson(config, '/worker/complete', body, fetchImpl)
}

/** The single safe outbound path for bridge requests. */
export async function postBridgeJson(
  config: BridgeConfig,
  route: string,
  body: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  const endpoint = bridgeEndpoint(config.url, route)
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })

  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new WorkerFailure('bridge_unavailable')
  }

  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new WorkerFailure('bridge_unavailable')
  }
  if (!response.ok) {
    throw new WorkerFailure(
      response.status === 429 ? 'rate_limited' : 'bridge_unavailable',
    )
  }
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new WorkerFailure('bridge_unavailable')
  }
}

function readJobId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('id' in value)) return
  const id = value.id
  if (typeof id === 'string' && id.length > 0) return id
}
