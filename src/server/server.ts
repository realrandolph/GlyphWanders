import type {IncomingMessage, ServerResponse} from 'node:http'
import type {TaskResponse} from '@devvit/web/server'
import {context, reddit, settings} from '@devvit/web/server'
import type {TriggerResponse, UiResponse} from '@devvit/web/shared'
import {
  BRIDGE_TOKEN_SETTING,
  BRIDGE_URL_SETTING,
  TARGET_SUBREDDIT,
} from '../shared/contracts.ts'
import {
  type BridgeConfig,
  type PollOutcome,
  pollOnce,
  postCommentEvent,
} from './bridge.ts'
import {handleCommentCreate} from './comment-events.ts'
import {redditApi} from './devvit-reddit.ts'
import {errorCode} from './errors.ts'
import {createExecutor} from './executor.ts'

const executor = createExecutor(redditApi)

type ErrorRsp = {error: string; status: number}

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    await route(reqMsg, rspMsg)
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    if (status >= 500) console.error(`request failed: ${errorCode(err)}`)
    writeJson<ErrorRsp>(
      status,
      {
        error: status === 403 ? 'forbidden' : 'internal error',
        status,
      },
      rspMsg,
    )
  }
}

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  const path = (reqMsg.url ?? '').split('?')[0]

  if (reqMsg.method === 'POST' && path === '/internal/triggers/comment') {
    const rsp = await commentTrigger(reqMsg)
    writeJson<TriggerResponse>(200, rsp, rspMsg)
    return
  }

  reqMsg.resume()

  if (reqMsg.method === 'POST' && path === '/internal/scheduler/poll') {
    if (!isTargetSubreddit()) throw new HttpError(403, 'forbidden')
    await pollAtTarget()
    writeJson<TaskResponse>(200, {}, rspMsg)
    return
  }

  if (reqMsg.method === 'POST' && path === '/internal/menu/poll') {
    const rsp = await pollFromMenu()
    writeJson<UiResponse>(200, rsp, rspMsg)
    return
  }

  writeJson<ErrorRsp>(404, {error: 'not found', status: 404}, rspMsg)
}

/** Target-only, best-effort; events are not backfilled or retried. */
async function commentTrigger(
  reqMsg: IncomingMessage,
): Promise<TriggerResponse> {
  if (!isTargetSubreddit()) {
    reqMsg.resume()
    return {}
  }
  const config = await getBridgeConfig()
  if (!config.url || !config.token) {
    reqMsg.resume()
    return {}
  }

  let payload: unknown
  try {
    payload = await readJson(reqMsg)
  } catch {
    return {}
  }

  try {
    await handleCommentCreate(payload, {
      getComment: id => redditApi.getCommentById(id),
      postComment: event => postCommentEvent(config, event.comment),
    })
  } catch (err) {
    console.error(`comment event failed: ${errorCode(err)}`)
  }
  return {}
}

async function pollFromMenu(): Promise<UiResponse> {
  if (!isTargetSubreddit()) {
    return toast(`Worker is restricted to r/${TARGET_SUBREDDIT}.`)
  }
  if (!(await isModerator())) {
    return toast('Only moderators can poll the worker.')
  }

  try {
    const outcome = await pollAtTarget()
    return toast(
      messageFor(outcome),
      outcome.status === 'completed' && outcome.ok,
    )
  } catch (err) {
    console.error(`poll failed: ${errorCode(err)}`)
    return toast('Worker poll failed.')
  }
}

async function getBridgeConfig(): Promise<BridgeConfig> {
  const [url, token] = await Promise.all([
    settings.get<string>(BRIDGE_URL_SETTING),
    settings.get<string>(BRIDGE_TOKEN_SETTING),
  ])
  return {
    url: typeof url === 'string' ? url : '',
    token: typeof token === 'string' ? token : '',
  }
}

async function pollAtTarget(): Promise<PollOutcome> {
  return pollOnce({
    getConfig: getBridgeConfig,
    execute: job => executor.execute(job),
  })
}

function messageFor(outcome: PollOutcome): string {
  switch (outcome.status) {
    case 'skipped':
      return 'Bridge is not configured.'
    case 'idle':
      return 'No worker jobs are queued.'
    case 'completed':
      if (!outcome.ok) return 'Worker job failed and was reported.'
      return `Completed ${outcome.kind ?? 'worker'} job.`
  }
}

function toast(text: string, success = false): UiResponse {
  return {
    showToast: {text, appearance: success ? 'success' : 'neutral'},
  }
}

function isTargetSubreddit(): boolean {
  return context.subredditName?.toLowerCase() === TARGET_SUBREDDIT.toLowerCase()
}

async function isModerator(): Promise<boolean> {
  const username = context.username || (await reddit.getCurrentUsername())
  if (!username) return false
  try {
    const listing = reddit.getModerators({
      subredditName: TARGET_SUBREDDIT,
      username,
      limit: 1,
    })
    const moderators = await listing.get(1)
    return moderators.some(
      mod => mod.username.toLowerCase() === username.toLowerCase(),
    )
  } catch {
    return false
  }
}

async function readJson(reqMsg: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of reqMsg) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1_000_000) throw new HttpError(413, 'payload too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeJson<T>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)
  const len = Buffer.byteLength(body)
  rsp.writeHead(status, {
    'Content-Length': len,
    'Content-Type': 'application/json',
  })
  rsp.end(body)
}

class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
