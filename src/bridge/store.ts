import {createHash, randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'

export type Job = {
  id: string
  kind: string
  args: string
  status: string
  result: string | null
  error: string | null
  created: number
  updated: number
  attempts: number
}
const writing = (kind: string) => kind === 'publish_post' || kind === 'reply'

export class Store {
  db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, args TEXT NOT NULL,
        request_id TEXT UNIQUE, fingerprint TEXT UNIQUE, status TEXT NOT NULL, result TEXT, error TEXT,
        created INTEGER NOT NULL, updated INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id));
      INSERT OR IGNORE INTO requests SELECT request_id,id FROM jobs WHERE request_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS visits (post_id TEXT PRIMARY KEY, visited INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recent_comments (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, created_at TEXT NOT NULL, observed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS control (key TEXT PRIMARY KEY, value INTEGER NOT NULL);`)
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  get(id: string): Job {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as
      | Job
      | undefined
    if (!row) throw new Error('Unknown operation')
    return row
  }
  enqueue(kind: string, args: Record<string, unknown>, now = Date.now()): Job {
    return this.transaction(() => {
      const {requestId, ...content} = args
      const canonical = JSON.stringify(
        Object.fromEntries(Object.entries(content).sort()),
      )
      const fingerprint = writing(kind)
        ? createHash('sha256').update(`${kind}:${canonical}`).digest('hex')
        : null
      if (requestId) {
        const old = this.db
          .prepare(
            'SELECT jobs.* FROM jobs JOIN requests ON requests.job_id=jobs.id WHERE requests.request_id=?',
          )
          .get(String(requestId)) as Job | undefined
        if (old) {
          const {requestId: _, ...oldContent} = JSON.parse(old.args)
          if (
            old.kind !== kind ||
            JSON.stringify(
              Object.fromEntries(Object.entries(oldContent).sort()),
            ) !== canonical
          )
            throw new Error('requestId already used for different content')
          return old
        }
        const duplicate = this.db
          .prepare('SELECT * FROM jobs WHERE fingerprint=?')
          .get(fingerprint) as Job | undefined
        if (duplicate) {
          this.db
            .prepare('INSERT INTO requests VALUES(?,?)')
            .run(String(requestId), duplicate.id)
          return duplicate
        }
      }
      const pending = this.db
        .prepare(
          "SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running')",
        )
        .get() as {n: number}
      if (pending.n >= 100)
        throw new Error('Queue full; retrieve existing operations first')
      const id = randomUUID()
      this.db
        .prepare(
          'INSERT INTO jobs(id,kind,args,request_id,fingerprint,status,created,updated) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          kind,
          JSON.stringify(args),
          requestId ? String(requestId) : null,
          fingerprint,
          'queued',
          now,
          now,
        )
      if (requestId)
        this.db
          .prepare('INSERT INTO requests VALUES(?,?)')
          .run(String(requestId), id)
      return this.get(id)
    })
  }
  claim(now = Date.now()): {id: string; kind: string; args: unknown} | null {
    return this.transaction(() => {
      // Reddit has no transactional idempotency key: never re-send an ambiguous write.
      this.db
        .prepare(`UPDATE jobs SET status=CASE WHEN kind IN ('publish_post','reply') THEN 'uncertain'
        WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
        error='Worker lease expired; publication must not be retried automatically', updated=?
        WHERE status='running' AND updated<?`)
        .run(now, now - 120_000)
      this.db
        .prepare(
          "UPDATE jobs SET status='expired',error='Unclaimed operation expired',updated=? WHERE status='queued' AND created<?",
        )
        .run(now, now - 900_000)
      const cooldown = this.db
        .prepare("SELECT value FROM control WHERE key='cooldown'")
        .get() as {value: number} | undefined
      if (cooldown && cooldown.value > now) return null
      if (this.db.prepare("SELECT id FROM jobs WHERE status='running'").get())
        return null
      const row = this.db
        .prepare(
          "SELECT * FROM jobs WHERE status='queued' ORDER BY created,id LIMIT 1",
        )
        .get() as Job | undefined
      if (!row) return null
      this.db
        .prepare(
          "UPDATE jobs SET status='running',attempts=attempts+1,updated=? WHERE id=?",
        )
        .run(now, row.id)
      return {id: row.id, kind: row.kind, args: JSON.parse(row.args)}
    })
  }
  complete(id: string, result: unknown, error?: string, now = Date.now()): Job {
    return this.transaction(() => {
      const row = this.get(id)
      if (row.status === 'succeeded' || row.status === 'failed') return row
      if (row.status !== 'running' && row.status !== 'uncertain')
        throw new Error('Operation not claimed')
      const status = error
        ? writing(row.kind)
          ? 'uncertain'
          : 'failed'
        : 'succeeded'
      this.db
        .prepare(
          'UPDATE jobs SET status=?,result=?,error=?,updated=? WHERE id=?',
        )
        .run(status, JSON.stringify(result ?? null), error ?? null, now, id)
      if (error)
        this.db
          .prepare(
            "INSERT INTO control VALUES('cooldown',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(now + 60_000)
      if (!error && row.kind === 'thread') {
        const {postId} = JSON.parse(row.args)
        this.db
          .prepare(
            'INSERT INTO visits VALUES(?,?) ON CONFLICT(post_id) DO UPDATE SET visited=excluded.visited',
          )
          .run(postId, now)
      }
      return this.get(id)
    })
  }
  history(limit: number) {
    return {
      publications: this.db
        .prepare(
          "SELECT id,kind,status,result,error,created,updated FROM jobs WHERE kind IN ('publish_post','reply') ORDER BY created DESC LIMIT ?",
        )
        .all(limit)
        .map(row => ({
          ...row,
          result: row.result ? JSON.parse(String(row.result)) : null,
        })),
      visits: this.db
        .prepare('SELECT * FROM visits ORDER BY visited DESC LIMIT ?')
        .all(limit),
      lastActivityRead: this.db
        .prepare(
          "SELECT max(updated) AS timestamp FROM jobs WHERE kind='activity' AND status='succeeded'",
        )
        .get(),
    }
  }
  readState() {
    return this.db
      .prepare('SELECT * FROM state ORDER BY key')
      .all()
      .map(row => ({...row, value: JSON.parse(String(row.value))}))
  }
  recordComment(
    comment: {id: string; postId: string; createdAt: string},
    now = Date.now(),
  ) {
    this.transaction(() => {
      // Only metadata is persisted: content is fetched live via get_thread.
      this.db
        .prepare('INSERT OR IGNORE INTO recent_comments VALUES(?,?,?,?)')
        .run(comment.id, comment.postId, comment.createdAt, now)
      this.db
        .prepare(
          'DELETE FROM recent_comments WHERE id NOT IN (SELECT id FROM recent_comments ORDER BY observed DESC LIMIT 500)',
        )
        .run()
    })
  }
  recentComments(limit: number) {
    return this.db
      .prepare(
        'SELECT id,post_id AS postId,created_at AS createdAt,observed FROM recent_comments ORDER BY observed DESC LIMIT ?',
      )
      .all(limit)
  }
  pruneReads(now = Date.now()) {
    this.db
      .prepare(
        "UPDATE jobs SET result=NULL,status='expired',error='Read result expired; request a fresh read' WHERE kind IN ('activity','thread') AND status='succeeded' AND updated<?",
      )
      .run(now - 86_400_000)
  }
  writeState(key: string, value: string | null, version: number) {
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT version FROM state WHERE key=?')
        .get(key) as {version: number} | undefined
      if ((row?.version ?? 0) !== version)
        throw new Error('State version conflict; read state again')
      const count = this.db
        .prepare('SELECT count(*) AS n FROM state')
        .get() as {n: number}
      if (!row && count.n >= 100)
        throw new Error('Scratchspace limited to 100 keys')
      // Preserve a tombstone version on deletion to prevent ABA lost updates.
      this.db
        .prepare(
          'INSERT INTO state VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=excluded.version',
        )
        .run(key, value ?? 'null', version + 1)
      return {key, version: version + 1}
    })
  }
  close() {
    this.db.close()
  }
}

export function operation(job: Job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    created: job.created,
    updated: job.updated,
    result: job.result ? JSON.parse(job.result) : null,
    error: job.error,
    ...(['queued', 'running'].includes(job.status)
      ? {
          next: 'Devvit polls once per minute. Call get_operation with this id later; do not busy-poll. No publication confirmed yet.',
        }
      : {}),
    ...(job.status === 'uncertain'
      ? {
          next: 'Do NOT retry with another requestId. Ask the owner to inspect Reddit and reconcile this operation.',
        }
      : {}),
  }
}
