import assert from 'node:assert/strict'
import {test} from 'node:test'
import {AppFailure, errorCode, withReadRetry} from './errors.ts'

test('errors collapse to small non-sensitive codes', () => {
  assert.equal(
    errorCode(new AppFailure('target_restricted')),
    'target_restricted',
  )
  assert.equal(
    errorCode(new Error('429 Too Many Requests token=secret')),
    'rate_limited',
  )
  assert.equal(errorCode(new Error('boom token=secret')), 'internal')
})

test('read retries use bounded exponential backoff', async () => {
  let calls = 0
  const result = await withReadRetry(
    async () => {
      calls++
      if (calls < 3) throw new Error('429 rate limit')
      return 'ok'
    },
    {attempts: 3, baseDelayMs: 1},
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 3)
})

test('writes must not use read retries', async () => {
  await assert.rejects(
    withReadRetry(async () => {
      throw new AppFailure('publication_uncertain')
    }),
    /publication_uncertain/,
  )
})
