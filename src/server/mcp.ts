import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import type {CallToolResult, Tool} from '@modelcontextprotocol/sdk/types.js'
import {z} from 'zod'
import type {PublishPostArgs, ReplyArgs} from '../shared/contracts.ts'
import {
  INSTRUCTIONS,
  schemas,
  type ToolName,
  toolDefinitions,
} from '../shared/tools.ts'
import {AppFailure, errorCode, safeMessage} from './errors.ts'
import type {Executor} from './executor.ts'
import {
  type Journal,
  type JournalEntry,
  MemoryConflict,
  type Reservation,
} from './journal.ts'

export type McpDeps = {
  executor: Executor
  journal: Journal
}

class DuplicatePublication extends Error {
  readonly reservation: Reservation

  constructor(reservation: Reservation) {
    super('duplicate publication')
    this.reservation = reservation
  }
}

/** A fresh stateless MCP server per HTTP request. */
export function createMcpServer(deps: McpDeps): McpServer {
  const definitions = new Map<string, Tool>(
    toolDefinitions().map(def => [def.name, def]),
  )
  const server = new McpServer(
    {name: 'GlyphWanders', version: '1.0.0'},
    {instructions: INSTRUCTIONS},
  )

  for (const name of Object.keys(schemas) as ToolName[]) {
    const definition = definitions.get(name)
    if (!definition) continue
    server.registerTool(
      name,
      {
        description: definition.description,
        inputSchema: schemas[name],
        annotations: definition.annotations,
      },
      (args: unknown) => dispatch(name, args as Record<string, unknown>),
    )
  }

  async function dispatch(
    name: ToolName,
    raw: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const input = {...raw}
    if (typeof input.requestId === 'string')
      input.requestId = input.requestId.trim()
    if (typeof input.parentId === 'string')
      input.parentId = input.parentId.trim()
    try {
      switch (name) {
        case 'read_activity':
          return await readActivity(schemas.read_activity.parse(input))
        case 'get_thread':
          return await getThread(schemas.get_thread.parse(input))
        case 'publish_post':
          return await publish(schemas.publish_post.parse(input))
        case 'reply':
          return await reply(schemas.reply.parse(input))
        case 'participation_history': {
          const args = schemas.participation_history.parse(input)
          return await participationHistory(args.limit)
        }
        case 'read_memory':
          schemas.read_memory.parse(input)
          return ok({memory: await deps.journal.readMemory()})
        case 'write_memory': {
          const args = schemas.write_memory.parse(input)
          return ok({
            memory: await deps.journal.writeMemory(args.value, args.version),
          })
        }
      }
    } catch (err) {
      if (err instanceof DuplicatePublication) {
        return duplicate(err.reservation)
      }
      if (err instanceof MemoryConflict) {
        return fail('memory_conflict', {memory: err.current})
      }
      if (err instanceof z.ZodError) {
        return fail('invalid_arguments')
      }
      if (err instanceof AppFailure) return fail(err.code)
      console.error(`tool ${name} failed`)
      return fail(errorCode(err))
    }
  }

  async function readActivity(
    args: z.infer<typeof schemas.read_activity>,
  ): Promise<CallToolResult> {
    const result = await deps.executor.activity(args)
    let recentComments: unknown[] = []
    let coverage = 'Recent comment pointers are best-effort since installation.'
    try {
      recentComments = await deps.journal.recentComments(args.limit)
    } catch {
      coverage =
        'Recent comment pointers are temporarily unavailable; get_thread still reads live text.'
    }
    return ok({...result, recentComments, coverage})
  }

  async function getThread(
    args: z.infer<typeof schemas.get_thread>,
  ): Promise<CallToolResult> {
    const result = await deps.executor.thread({
      ...args,
      offset: args.offset ?? 0,
    })
    try {
      await deps.journal.recordVisit(args.postId)
    } catch {
      // A visit record is metadata only; never fail a successful read for it.
    }
    const page = result.pagination
    const coverage = page.hasMore
      ? `Partial page: continue with offset=${page.nextOffset ?? 0}. Do not describe the discussion as complete.`
      : page.truncated
        ? 'Thread could not be fully enumerated; focus a commentId branch to continue.'
        : 'All comments in this branch were enumerated.'
    return ok({...result, coverage})
  }

  async function publish(args: PublishPostArgs): Promise<CallToolResult> {
    let reservation: Reservation | undefined
    try {
      const result = await deps.executor.publishPost(args, async () => {
        reservation = await reserve(args, {kind: 'publish_post'})
      })
      const durable = await markSucceeded(reservation, result.post.id)
      return ok({
        status: 'succeeded',
        kind: 'publish_post',
        post: result.post,
        durable,
      })
    } catch (err) {
      return writeFailure(err, reservation, 'publish_post')
    }
  }

  async function reply(args: ReplyArgs): Promise<CallToolResult> {
    let reservation: Reservation | undefined
    try {
      const result = await deps.executor.reply(args, async () => {
        reservation = await reserve(args, {
          kind: 'reply',
          parentId: args.parentId,
        })
      })
      const durable = await markSucceeded(reservation, result.comment.id)
      return ok({
        status: 'succeeded',
        kind: 'reply',
        comment: result.comment,
        durable,
      })
    } catch (err) {
      return writeFailure(err, reservation, 'reply')
    }
  }

  async function reserve(
    args: PublishPostArgs | ReplyArgs,
    meta: {
      kind: 'publish_post' | 'reply'
      parentId?: string
    },
  ): Promise<Reservation> {
    const input =
      'title' in args
        ? {kind: meta.kind, title: args.title, body: args.body}
        : {kind: meta.kind, parentId: meta.parentId, body: args.body}
    const reservation = await deps.journal.reserve({
      ...input,
      requestId: args.requestId,
    })
    if (reservation.duplicate) throw new DuplicatePublication(reservation)
    return reservation
  }

  async function markSucceeded(
    reservation: Reservation | undefined,
    id: string,
  ): Promise<boolean> {
    if (!reservation) return false
    try {
      await deps.journal.succeed(reservation.entry, id)
      return true
    } catch {
      // The pending reservation remains, so a later retry stays blocked.
      return false
    }
  }

  async function writeFailure(
    err: unknown,
    reservation: Reservation | undefined,
    kind: 'publish_post' | 'reply',
  ): Promise<CallToolResult> {
    if (err instanceof DuplicatePublication) return duplicate(err.reservation)
    if (err instanceof AppFailure && !reservation) return fail(err.code)
    if (reservation) {
      try {
        await deps.journal.uncertain(reservation.entry)
      } catch {
        // Pending is at least as safe as uncertain: it still blocks retries.
      }
      return fail('publication_uncertain', {
        status: 'uncertain',
        kind,
      })
    }
    return fail(errorCode(err))
  }

  async function participationHistory(limit: number): Promise<CallToolResult> {
    return ok(await deps.journal.history(limit))
  }

  return server
}

function duplicate(reservation: Reservation): CallToolResult {
  const entry: JournalEntry = reservation.entry
  const data = {
    status: entry.status === 'duplicate' ? 'pending' : entry.status,
    duplicate: true,
    kind: entry.kind,
    requestId: entry.requestId,
    ...(entry.id ? {id: entry.id} : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
  if (entry.status === 'succeeded') return ok(data)
  return fail('publication_uncertain', {
    ...data,
    status: entry.status === 'duplicate' ? 'pending' : entry.status,
    recovery:
      'Retry the same requestId to inspect the journal. Never publish this content under a new id until the owner reconciles it.',
  })
}

function ok(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{type: 'text', text: JSON.stringify(data)}],
    structuredContent: data,
  }
}

function fail(
  code: AppFailure['code'],
  extra: Record<string, unknown> = {},
): CallToolResult {
  return {
    isError: true,
    content: [{type: 'text', text: safeMessage(code)}],
    structuredContent: {status: 'error', code, ...extra},
  }
}
