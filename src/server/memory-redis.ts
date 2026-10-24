import type {RedisLike, TxLike} from './journal.ts'

type Entry =
  | {type: 'string'; value: string; version: number}
  | {type: 'hash'; value: Map<string, string>; version: number}
  | {type: 'zset'; value: Map<string, number>; version: number}

/**
 * A small in-memory stand-in for Devvit's native Redis client. Unlike the
 * package's bundled test mock it enforces WATCH/EXEC conflicts, which is the
 * behaviour the memory CAS depends on.
 */
export class MemoryRedis implements RedisLike {
  readonly data = new Map<string, Entry>()
  /** Test hook run after MULTI/SET but before the EXEC conflict check. */
  beforeExec?: () => Promise<void>

  async get(key: string): Promise<string | undefined> {
    const entry = this.data.get(key)
    if (!entry) return undefined
    if (entry.type !== 'string') throw new Error('WRONGTYPE')
    return entry.value
  }

  async set(key: string, value: string): Promise<'OK'> {
    const existing = this.data.get(key)
    this.data.set(key, {
      type: 'string',
      value,
      version: (existing?.version ?? 0) + 1,
    })
    return 'OK'
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hash(key).value.get(field)
  }

  async hSet(
    key: string,
    fieldValues: {[field: string]: string},
  ): Promise<number> {
    const hash = this.hash(key)
    let added = 0
    for (const [field, value] of Object.entries(fieldValues)) {
      if (!hash.value.has(field)) added++
      hash.value.set(field, value)
    }
    hash.version++
    return added
  }

  async hSetNX(key: string, field: string, value: string): Promise<number> {
    const hash = this.hash(key)
    if (hash.value.has(field)) return 0
    hash.value.set(field, value)
    hash.version++
    return 1
  }

  async zAdd(
    key: string,
    ...members: Array<{member: string; score: number}>
  ): Promise<number> {
    const zset = this.zset(key)
    let added = 0
    for (const member of members) {
      if (!zset.value.has(member.member)) added++
      zset.value.set(member.member, member.score)
    }
    zset.version++
    return added
  }

  async zCard(key: string): Promise<number> {
    return this.zset(key).value.size
  }

  async zRange(
    key: string,
    start: number,
    stop: number,
    options: {reverse?: boolean; by: 'rank' | 'score' | 'lex'},
  ): Promise<Array<{member: string; score: number}>> {
    if (options.by !== 'rank') throw new Error('unsupported range')
    const rows = [...this.zset(key).value.entries()]
      .map(([member, score]) => ({member, score}))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member))
    if (options.reverse) rows.reverse()
    const end = stop < 0 ? rows.length + stop + 1 : stop + 1
    return rows.slice(start, end)
  }

  async zRemRangeByRank(
    key: string,
    start: number,
    stop: number,
  ): Promise<number> {
    const zset = this.zset(key)
    const rows = [...zset.value.entries()]
      .map(([member, score]) => ({member, score}))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member))
    const end = stop < 0 ? rows.length + stop + 1 : stop + 1
    const removed = rows.slice(start, end)
    for (const row of removed) zset.value.delete(row.member)
    if (removed.length > 0) zset.version++
    return removed.length
  }

  async watch(...keys: string[]): Promise<TxLike> {
    const versions = new Map(keys.map(key => [key, this.version(key)]))
    const queued: Array<() => void> = []
    let multiStarted = false
    return {
      multi: async () => {
        multiStarted = true
      },
      set: async (key: string, value: string) => {
        if (!multiStarted) throw new Error('EXEC without MULTI')
        queued.push(() => {
          const existing = this.data.get(key)
          this.data.set(key, {
            type: 'string',
            value,
            version: (existing?.version ?? 0) + 1,
          })
        })
      },
      exec: async () => {
        if (!multiStarted) throw new Error('EXEC without MULTI')
        if (this.beforeExec) await this.beforeExec()
        for (const [key, version] of versions) {
          if (this.version(key) !== version) return []
        }
        for (const apply of queued) apply()
        return queued.map(() => 'OK')
      },
      discard: async () => {
        queued.length = 0
        versions.clear()
      },
      unwatch: async () => {
        versions.clear()
      },
    }
  }

  private hash(key: string): Extract<Entry, {type: 'hash'}> {
    const existing = this.data.get(key)
    if (!existing) {
      const created: Entry = {type: 'hash', value: new Map(), version: 0}
      this.data.set(key, created)
      return created
    }
    if (existing.type !== 'hash') throw new Error('WRONGTYPE')
    return existing
  }

  private zset(key: string): Extract<Entry, {type: 'zset'}> {
    const existing = this.data.get(key)
    if (!existing) {
      const created: Entry = {type: 'zset', value: new Map(), version: 0}
      this.data.set(key, created)
      return created
    }
    if (existing.type !== 'zset') throw new Error('WRONGTYPE')
    return existing
  }

  private version(key: string): number {
    return this.data.get(key)?.version ?? 0
  }
}
