import assert from 'node:assert/strict'
import {test} from 'node:test'
import {AppFailure, errorCode} from './errors.ts'

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
