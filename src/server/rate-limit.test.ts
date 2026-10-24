import assert from 'node:assert/strict'
import {test} from 'node:test'
import {AppFailure} from './errors.ts'
import {MemoryRedis} from './memory-redis.ts'
import {createRateGate} from './rate-limit.ts'

const isRateLimited = (err: unknown) =>
  err instanceof AppFailure && err.code === 'rate_limited'

test('429 cooldown persists and grows exponentially', async () => {
  let clock = 1_000_000
  const gate = createRateGate(new MemoryRedis(), () => clock)
  await gate.assertReady()

  await gate.recordFailure()
  clock += 59_000
  await assert.rejects(gate.assertReady(), isRateLimited)
  clock += 2_000
  await gate.assertReady()

  await gate.recordFailure()
  clock += 119_000
  await assert.rejects(gate.assertReady(), isRateLimited)
  clock += 2_000
  await gate.assertReady()

  await gate.recordSuccess()
  await gate.recordFailure()
  clock += 59_000
  await assert.rejects(gate.assertReady(), isRateLimited)
  clock += 2_000
  await gate.assertReady()
})

test('concurrent rate failures share one persisted backoff', async () => {
  let clock = 5_000_000
  const gate = createRateGate(new MemoryRedis(), () => clock)
  await Promise.all([gate.recordFailure(), gate.recordFailure()])
  clock += 61_000
  await assert.rejects(gate.assertReady(), isRateLimited)
  clock += 60_000
  await gate.assertReady()
})

test('a Redis failure fails closed as rate limited, never as auth', async () => {
  class Broken extends MemoryRedis {
    override async get(): Promise<string | undefined> {
      throw new Error('storage failure token=secret')
    }
  }
  const gate = createRateGate(new Broken())
  await assert.rejects(gate.assertReady(), isRateLimited)
})

test('a late concurrent success cannot clear an active 429 cooldown', async () => {
  const gate = createRateGate(new MemoryRedis(), () => 1_000_000)
  await gate.recordFailure()
  await gate.recordSuccess()
  await assert.rejects(gate.assertReady(), isRateLimited)
})

test('empty native SDK EXEC arrays never claim a cooldown was persisted', async () => {
  class Aborted extends MemoryRedis {
    override async watch(...keys: string[]) {
      const tx = await super.watch(...keys)
      return {...tx, exec: async () => []}
    }
  }
  await assert.rejects(
    createRateGate(new Aborted()).recordFailure(),
    isRateLimited,
  )
})
