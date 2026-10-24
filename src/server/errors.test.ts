import assert from 'node:assert/strict'
import {test} from 'node:test'
import {errorCode, WorkerFailure} from './errors.ts'

test('errors collapse to small non-sensitive codes', () => {
  assert.equal(
    errorCode(new WorkerFailure('target_restricted')),
    'target_restricted',
  )
  assert.equal(
    errorCode(new Error('429 Too Many Requests token=secret')),
    'rate_limited',
  )
  assert.equal(errorCode(new Error('boom token=secret')), 'reddit_unavailable')
})
