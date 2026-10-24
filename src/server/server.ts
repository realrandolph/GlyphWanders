import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit, redis} from '@devvit/web/server'
import type {TriggerResponse, UiResponse} from '@devvit/web/shared'
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {TARGET_SUBREDDIT} from '../shared/contracts.ts'
import {handleCommentCreate} from './comment-events.ts'
import {redditApi} from './devvit-reddit.ts'
import {errorCode} from './errors.ts'
import {createExecutor, type Executor} from './executor.ts'
import {createJournal, type Journal} from './journal.ts'
import {createMcpServer} from './mcp.ts'
import {createRateGate} from './rate-limit.ts'

export type ServerDeps = {
  executor: Executor
  journal: Journal
  getComment: typeof redditApi.getCommentById
  target?: string
}

const defaultJournal = createJournal(redis)
const defaultDeps: ServerDeps = {
  executor: createExecutor(redditApi, TARGET_SUBREDDIT, createRateGate(redis)),
  journal: defaultJournal,
  getComment: id => redditApi.getCommentById(id),
}

type ErrorRsp = {error: string; status: number}

/** A request handler with injectable dependencies for local tests. */
export function createOnReq(deps: ServerDeps = defaultDeps) {
  return async function onRequest(
    reqMsg: IncomingMessage,
    rspMsg: ServerResponse,
  ): Promise<void> {
    try {
      await route(reqMsg, rspMsg, deps)
    } catch (err) {
      if (rspMsg.headersSent) {
        rspMsg.end()
        return
      }
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
}

export const onReq = createOnReq()

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const path = (reqMsg.url ?? '').split('?')[0]

  if (reqMsg.method === 'POST' && path === '/external/mcp') {
    if (!isTarget(deps)) throw new HttpError(403, 'forbidden')
    await handleMcp(reqMsg, rspMsg, deps)
    return
  }

  if (reqMsg.method === 'POST' && path === '/internal/triggers/comment') {
    if (!isTarget(deps)) {
      reqMsg.resume()
      writeJson<TriggerResponse>(200, {}, rspMsg)
      return
    }
    const response = await commentTrigger(reqMsg, deps)
    writeJson<TriggerResponse>(200, response, rspMsg)
    return
  }

  if (reqMsg.method === 'POST' && path === '/internal/menu/journal') {
    reqMsg.resume()
    if (!isTarget(deps)) throw new HttpError(403, 'forbidden')
    const response = await journalMenu(deps)
    writeJson<UiResponse>(200, response, rspMsg)
    return
  }

  reqMsg.resume()
  if (path === '/external/mcp') {
    rspMsg.setHeader('Allow', 'POST')
    writeJson<ErrorRsp>(405, {error: 'method not allowed', status: 405}, rspMsg)
    return
  }
  writeJson<ErrorRsp>(404, {error: 'not found', status: 404}, rspMsg)
}

/**
 * The Devvit platform validates the managed token before this handler runs.
 * The context subreddit check is the app-level boundary on top of that.
 */
function isTarget(deps: ServerDeps): boolean {
  const target = deps.target ?? TARGET_SUBREDDIT
  return context.subredditName?.toLowerCase() === target.toLowerCase()
}

async function handleMcp(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  let body: unknown
  try {
    body = await readJson(reqMsg)
  } catch (err) {
    if (err instanceof HttpError) throw err
    writeJson(
      400,
      {
        jsonrpc: '2.0',
        error: {code: -32700, message: 'Parse error'},
        id: null,
      },
      rspMsg,
    )
    return
  }

  const server = createMcpServer(deps)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(reqMsg, rspMsg, body)
  } finally {
    await server.close().catch(() => undefined)
  }
}

/** Target-only, best-effort metadata capture. No comment text is persisted. */
async function commentTrigger(
  reqMsg: IncomingMessage,
  deps: ServerDeps,
): Promise<TriggerResponse> {
  let payload: unknown
  try {
    payload = await readJson(reqMsg)
  } catch {
    return {}
  }

  try {
    await handleCommentCreate(payload, {
      getComment: id => deps.getComment(id),
      record: event => deps.journal.recordComment(event),
      target: deps.target,
    })
  } catch (err) {
    console.error(`comment event failed: ${errorCode(err)}`)
  }
  return {}
}

/** Read-only moderator view; it never mutates or replays journal entries. */
async function journalMenu(deps: ServerDeps): Promise<UiResponse> {
  if (!(await isModerator())) {
    return toast('Only moderators can inspect the publication journal.')
  }
  try {
    const history = await deps.journal.history(100)
    const counts = {pending: 0, succeeded: 0, uncertain: 0}
    for (const entry of history.publications) counts[entry.status]++
    return toast(
      `Publication journal: ${counts.succeeded} succeeded, ${counts.pending} pending, ${counts.uncertain} uncertain. Pending/uncertain writes must never be resubmitted.`,
      counts.uncertain === 0 && counts.pending === 0,
    )
  } catch (err) {
    console.error(`journal menu failed: ${errorCode(err)}`)
    return toast('Publication journal is temporarily unavailable.')
  }
}

function toast(text: string, success = false): UiResponse {
  return {
    showToast: {text, appearance: success ? 'success' : 'neutral'},
  }
}

async function isModerator(): Promise<boolean> {
  const target = TARGET_SUBREDDIT
  const username = context.username || (await reddit.getCurrentUsername())
  if (!username) return false
  try {
    const listing = reddit.getModerators({
      subredditName: target,
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
