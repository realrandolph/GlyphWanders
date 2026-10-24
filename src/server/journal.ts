import {createHash} from 'node:crypto'
import {
  type CommentEventRequest,
  type RecentComment,
  TARGET_SUBREDDIT,
} from '../shared/contracts.ts'
import {AppFailure} from './errors.ts'

/** The small Redis surface this app uses; the Devvit client satisfies it. */
export type RedisLike = {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<unknown>
  hGet(key: string, field: string): Promise<string | undefined>
  hSet(key: string, fieldValues: {[field: string]: string}): Promise<unknown>
  hSetNX(key: string, field: string, value: string): Promise<number>
  hGetAll(key: string): Promise<Record<string, string>>
  zAdd(
    key: string,
    ...members: Array<{member: string; score: number}>
  ): Promise<unknown>
  zCard(key: string): Promise<number>
  zRange(
    key: string,
    start: number,
    stop: number,
    options: {reverse?: boolean; by: 'rank' | 'score' | 'lex'},
  ): Promise<Array<{member: string; score: number}>>
  zRemRangeByRank(key: string, start: number, stop: number): Promise<unknown>
  watch(...keys: string[]): Promise<TxLike>
}

export type TxLike = {
  multi(): Promise<unknown>
  set(key: string, value: string): Promise<unknown>
  exec(): Promise<unknown[] | null>
  discard(): Promise<unknown>
  unwatch(): Promise<unknown>
}

export const PUBLICATION_KEY = 'glyphwanders:publications'
export const MEMORY_KEY = 'glyphwanders:memory'
export const RECENT_COMMENT_KEY = 'glyphwanders:recent-comments'
export const VISITED_KEY = 'glyphwanders:visited'

const HISTORY_MAX = 100
const RECENT_COMMENT_MAX = 100
const VISITED_MAX = 200

export type PublicationKind = 'publish_post' | 'reply'
export type PublicationStatus = 'pending' | 'succeeded' | 'uncertain'

type StoredEntry = {
  kind: PublicationKind
  parentId?: string
  hash: string
  status: PublicationStatus | 'duplicate'
  id?: string
  duplicateOf?: string
  createdAt: string
  updatedAt: string
}

export type JournalEntry = StoredEntry & {requestId: string}

export type Reservation = {
  entry: JournalEntry
  /** True when this request or identical content already had a journal entry. */
  duplicate: boolean
}

export type History = {
  publications: Array<{
    requestId: string
    kind: PublicationKind
    status: PublicationStatus
    id?: string
    createdAt: string
    updatedAt: string
  }>
  visitedPosts: Array<{postId: string; visitedAt: string}>
}

export type MemoryDoc = {
  value: string | null
  version: number
  updatedAt: string | null
}

export class MemoryConflict extends AppFailure {
  readonly current: MemoryDoc

  constructor(current: MemoryDoc) {
    super('memory_conflict')
    this.name = 'MemoryConflict'
    this.current = current
  }
}

export type Journal = ReturnType<typeof createJournal>

export function createJournal(
  redis: RedisLike,
  target: string = TARGET_SUBREDDIT,
) {
  async function readEntry(field: string): Promise<JournalEntry | undefined> {
    const raw = await guard(() => redis.hGet(PUBLICATION_KEY, field))
    if (!raw) return undefined
    return parseEntry(field.slice(2), raw)
  }

  async function resolveEntry(
    field: string,
    entry: StoredEntry,
  ): Promise<JournalEntry> {
    if (entry.status !== 'duplicate' || !entry.duplicateOf) {
      return {...entry, requestId: field.slice(2)}
    }
    const owner = await readEntry(entry.duplicateOf)
    if (owner) return owner
    throw new AppFailure('journal_unavailable')
  }

  /**
   * Reserves a pending publication before any Reddit write. Both the request
   * field and normalized-content alias are first-writer-wins, so retries,
   * interruptions and concurrent identical requests never write twice.
   */
  async function reserve(input: {
    kind: PublicationKind
    parentId?: string
    title?: string
    body: string
    requestId: string
  }): Promise<Reservation> {
    const hash = fingerprint(input, target)
    const requestId = input.requestId.trim().toLowerCase()
    const requestField = `r:${requestId}`
    const aliasField = `c:${hash}`

    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await readEntry(requestField)
      if (existing) {
        if (existing.hash !== hash) throw new AppFailure('journal_conflict')
        return {
          entry: await resolveEntry(requestField, existing),
          duplicate: true,
        }
      }

      const ownerField = await guard(() =>
        redis.hGet(PUBLICATION_KEY, aliasField),
      )
      if (ownerField) {
        const owner = await readEntry(ownerField)
        if (owner) {
          return {
            entry: await resolveEntry(ownerField, owner),
            duplicate: true,
          }
        }
        throw new AppFailure('journal_unavailable')
      }

      const now = new Date().toISOString()
      const pending: StoredEntry = {
        kind: input.kind,
        ...(input.parentId ? {parentId: input.parentId} : {}),
        hash,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      }
      const reserved = await guard(() =>
        redis.hSetNX(PUBLICATION_KEY, requestField, JSON.stringify(pending)),
      )
      if (reserved <= 0) continue

      const aliased = await guard(() =>
        redis.hSetNX(PUBLICATION_KEY, aliasField, requestField),
      )
      if (aliased > 0) {
        return {
          entry: {...pending, requestId},
          duplicate: false,
        }
      }

      // A concurrent identical request won the content alias. Link this request
      // id to the winner instead of leaving an ambiguous pending reservation.
      const winnerField = await guard(() =>
        redis.hGet(PUBLICATION_KEY, aliasField),
      )
      const winner = winnerField ? await readEntry(winnerField) : undefined
      if (!winnerField || !winner) throw new AppFailure('journal_unavailable')
      const link: StoredEntry = {
        ...pending,
        status: 'duplicate',
        duplicateOf: winnerField,
        updatedAt: new Date().toISOString(),
      }
      await guard(() =>
        redis.hSet(PUBLICATION_KEY, {
          [requestField]: JSON.stringify(link),
        }),
      )
      return {
        entry: await resolveEntry(winnerField, winner),
        duplicate: true,
      }
    }
    throw new AppFailure('journal_unavailable')
  }

  async function succeed(entry: JournalEntry, id: string): Promise<void> {
    await update(entry, {status: 'succeeded', id})
  }

  async function uncertain(entry: JournalEntry): Promise<void> {
    await update(entry, {status: 'uncertain'})
  }

  async function update(
    entry: JournalEntry,
    patch: {status: PublicationStatus; id?: string},
  ): Promise<void> {
    const current = await readEntry(`r:${entry.requestId}`)
    if (!current || current.hash !== entry.hash) {
      throw new AppFailure('journal_unavailable')
    }
    const next: StoredEntry = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    await guard(() =>
      redis.hSet(PUBLICATION_KEY, {
        [`r:${entry.requestId}`]: JSON.stringify(next),
      }),
    )
  }

  async function history(limit: number): Promise<History> {
    const all = await guard(() => redis.hGetAll(PUBLICATION_KEY))
    const publications: History['publications'] = []
    for (const [field, raw] of Object.entries(all)) {
      if (!field.startsWith('r:')) continue
      let entry: JournalEntry
      try {
        entry = parseEntry(field.slice(2), raw)
      } catch {
        continue
      }
      if (entry.status === 'duplicate') continue
      publications.push({
        requestId: entry.requestId,
        kind: entry.kind,
        status: entry.status,
        ...(entry.id ? {id: entry.id} : {}),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })
    }
    publications.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return {
      publications: publications.slice(0, Math.min(limit, HISTORY_MAX)),
      visitedPosts: await visitedPosts(limit),
    }
  }

  async function recordComment(event: CommentEventRequest): Promise<void> {
    const pointer: RecentComment = event.comment
    const parsed = Date.parse(pointer.createdAt)
    const score = Number.isFinite(parsed) ? parsed : Date.now()
    const key = RECENT_COMMENT_KEY
    await guard(() => redis.zAdd(key, {member: JSON.stringify(pointer), score}))
    const count = await guard(() => redis.zCard(key))
    if (count > RECENT_COMMENT_MAX) {
      await guard(() =>
        redis.zRemRangeByRank(key, 0, count - RECENT_COMMENT_MAX - 1),
      )
    }
  }

  async function recentComments(limit: number): Promise<RecentComment[]> {
    const count = Math.min(limit, 50)
    const rows = await guard(() =>
      redis.zRange(RECENT_COMMENT_KEY, 0, count - 1, {
        by: 'rank',
        reverse: true,
      }),
    )
    const out: RecentComment[] = []
    for (const row of rows) {
      try {
        const value: unknown = JSON.parse(row.member)
        if (
          value &&
          typeof value === 'object' &&
          typeof (value as RecentComment).id === 'string' &&
          typeof (value as RecentComment).postId === 'string' &&
          typeof (value as RecentComment).createdAt === 'string'
        ) {
          out.push(value as RecentComment)
        }
      } catch {
        // Skip a corrupt pointer; never let it hide the rest.
      }
    }
    return out
  }

  async function recordVisit(postId: string): Promise<void> {
    const key = VISITED_KEY
    await guard(() => redis.zAdd(key, {member: postId, score: Date.now()}))
    const count = await guard(() => redis.zCard(key))
    if (count > VISITED_MAX) {
      await guard(() => redis.zRemRangeByRank(key, 0, count - VISITED_MAX - 1))
    }
  }

  async function visitedPosts(limit: number): Promise<History['visitedPosts']> {
    const rows = await guard(() =>
      redis.zRange(VISITED_KEY, 0, Math.min(limit, VISITED_MAX) - 1, {
        by: 'rank',
        reverse: true,
      }),
    )
    return rows.map(row => ({
      postId: row.member,
      visitedAt: new Date(row.score).toISOString(),
    }))
  }

  async function readMemory(): Promise<MemoryDoc> {
    const raw = await guard(() => redis.get(MEMORY_KEY))
    return parseMemory(raw)
  }

  /** Compare-and-swap the single scratch document; null is a tombstone. */
  async function writeMemory(
    value: string | null,
    expectedVersion: number,
  ): Promise<MemoryDoc> {
    const tx = await guard(() => redis.watch(MEMORY_KEY))
    let executed = false
    try {
      const current = parseMemory(await guard(() => redis.get(MEMORY_KEY)))
      if (current.version !== expectedVersion) throw new MemoryConflict(current)
      const next: MemoryDoc = {
        value,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      }
      await guard(() => tx.multi())
      await guard(() => tx.set(MEMORY_KEY, JSON.stringify(next)))
      const result = await guard(() => tx.exec())
      executed = true
      if (result === null) throw new MemoryConflict(current)
      return next
    } catch (err) {
      if (!executed) await tx.discard().catch(() => undefined)
      throw err
    }
  }

  return {
    reserve,
    succeed,
    uncertain,
    history,
    recordComment,
    recentComments,
    recordVisit,
    readMemory,
    writeMemory,
  }
}

function fingerprint(
  input: {
    kind: PublicationKind
    parentId?: string
    title?: string
    body: string
  },
  target: string,
): string {
  const canonical = JSON.stringify({
    kind: input.kind,
    parentId: input.parentId?.trim().toLowerCase() ?? null,
    title: input.title?.trim() ?? null,
    body: input.body.trim(),
    target,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function parseEntry(requestId: string, raw: string): JournalEntry {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new AppFailure('journal_unavailable')
  }
  if (!value || typeof value !== 'object') {
    throw new AppFailure('journal_unavailable')
  }
  const entry = value as Record<string, unknown>
  if (
    (entry.kind !== 'publish_post' && entry.kind !== 'reply') ||
    typeof entry.hash !== 'string' ||
    !['pending', 'succeeded', 'uncertain', 'duplicate'].includes(
      String(entry.status),
    ) ||
    typeof entry.createdAt !== 'string' ||
    typeof entry.updatedAt !== 'string' ||
    (entry.id !== undefined && typeof entry.id !== 'string') ||
    (entry.parentId !== undefined && typeof entry.parentId !== 'string') ||
    (entry.duplicateOf !== undefined && typeof entry.duplicateOf !== 'string')
  ) {
    throw new AppFailure('journal_unavailable')
  }
  return {...(entry as StoredEntry), requestId}
}

function parseMemory(raw: string | undefined): MemoryDoc {
  if (!raw) return {value: null, version: 0, updatedAt: null}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new AppFailure('journal_unavailable')
  }
  if (!value || typeof value !== 'object') {
    throw new AppFailure('journal_unavailable')
  }
  const doc = value as Record<string, unknown>
  if (
    typeof doc.version !== 'number' ||
    !Number.isInteger(doc.version) ||
    doc.version < 0 ||
    (doc.value !== null && typeof doc.value !== 'string') ||
    (doc.updatedAt !== null && typeof doc.updatedAt !== 'string')
  ) {
    throw new AppFailure('journal_unavailable')
  }
  return {
    value: doc.value as string | null,
    version: doc.version,
    updatedAt: (doc.updatedAt as string | null) ?? null,
  }
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof AppFailure) throw err
    throw new AppFailure('journal_unavailable')
  }
}
