import {AppFailure} from './errors.ts'
import type {RedisLike} from './journal.ts'

export const RATE_KEY = 'glyphwanders:rate'
const BASE_DELAY_MS = 60_000
const MAX_DELAY_MS = 15 * 60_000
const MAX_ATTEMPTS = 3

export type RateState = {
  failures: number
  nextAttemptAt: number
  updatedAt: number
}

export type RateGate = {
  /** Fail closed if Redis cannot answer; never turns a cooldown into auth. */
  assertReady(): Promise<void>
  recordFailure(): Promise<void>
  recordSuccess(): Promise<void>
}

/** A global persisted 429 cooldown shared by reads and writes. */
export function createRateGate(
  redis: RedisLike,
  now: () => number = Date.now,
): RateGate {
  async function read(): Promise<RateState> {
    try {
      return parseRate(await redis.get(RATE_KEY))
    } catch {
      throw new AppFailure('rate_limited')
    }
  }

  async function assertReady(): Promise<void> {
    const state = await read()
    if (state.nextAttemptAt > now()) throw new AppFailure('rate_limited')
  }

  async function recordFailure(): Promise<void> {
    await update(state => {
      const failures = state.failures + 1
      const delay = Math.min(
        MAX_DELAY_MS,
        BASE_DELAY_MS * 2 ** Math.min(failures - 1, 4),
      )
      return {
        failures,
        nextAttemptAt: now() + delay,
        updatedAt: now(),
      }
    })
  }

  async function recordSuccess(): Promise<void> {
    await update(state => {
      // A success already in flight must not erase a concurrent 429 cooldown.
      if (state.nextAttemptAt > now()) return undefined
      if (state.failures === 0 && state.nextAttemptAt === 0) return undefined
      return {failures: 0, nextAttemptAt: 0, updatedAt: now()}
    })
  }

  async function update(
    next: (state: RateState) => RateState | undefined,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const tx = await redis.watch(RATE_KEY)
      let multiStarted = false
      let executed = false
      try {
        const current = parseRate(await redis.get(RATE_KEY))
        const value = next(current)
        if (!value) {
          await tx.unwatch()
          return
        }
        await tx.multi()
        multiStarted = true
        await tx.set(RATE_KEY, JSON.stringify(value))
        const result = await tx.exec()
        executed = true
        if (result?.length === 1 && result[0] === 'OK') return
      } catch (err) {
        if (!multiStarted) await tx.unwatch().catch(() => undefined)
        else if (!executed) await tx.discard().catch(() => undefined)
        if (err instanceof AppFailure) throw err
        throw new AppFailure('rate_limited')
      }
    }
    throw new AppFailure('rate_limited')
  }

  return {assertReady, recordFailure, recordSuccess}
}

function parseRate(raw: string | undefined): RateState {
  if (!raw) return {failures: 0, nextAttemptAt: 0, updatedAt: 0}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new AppFailure('rate_limited')
  }
  if (!value || typeof value !== 'object') {
    throw new AppFailure('rate_limited')
  }
  const state = value as Record<string, unknown>
  if (
    typeof state.failures !== 'number' ||
    !Number.isInteger(state.failures) ||
    state.failures < 0 ||
    typeof state.nextAttemptAt !== 'number' ||
    typeof state.updatedAt !== 'number'
  ) {
    throw new AppFailure('rate_limited')
  }
  return {
    failures: state.failures,
    nextAttemptAt: state.nextAttemptAt,
    updatedAt: state.updatedAt,
  }
}
