import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {runSmoke} from '../../scripts/smoke.ts'

test('manual smoke defaults to read-only; explicit flags verify persistence and publication deduplication', async t => {
  t.mock.method(console, 'info', () => {})
  const calls: string[] = []
  let memory = {value: 'consequential prior note', version: 2}
  const publications = new Set<string>()
  const mock = {
    listTools: async () => ({tools: []}),
    callTool: async ({
      name,
      arguments: args = {},
    }: {
      name: string
      arguments?: Record<string, unknown>
    }) => {
      calls.push(name)
      let data: Record<string, unknown> = {}
      if (name === 'read_activity') data = {posts: [{id: 't3_example'}]}
      if (name === 'read_memory') data = {memory: {...memory}}
      if (name === 'write_memory') {
        assert.equal(args.version, memory.version)
        memory = {value: args.value as string, version: memory.version + 1}
        data = {memory: {...memory}}
      }
      if (name === 'publish_post' || name === 'reply') {
        const key = String(args.requestId)
        const id = name === 'publish_post' ? 't3_mocked' : 't1_mocked'
        if (publications.has(key))
          data = {status: 'succeeded', duplicate: true, id}
        else {
          publications.add(key)
          data = {
            status: 'succeeded',
            [name === 'publish_post' ? 'post' : 'comment']: {id},
            durable: true,
          }
        }
      }
      return {content: [], structuredContent: data}
    },
  } as unknown as Pick<Client, 'callTool' | 'listTools'>
  await runSmoke(mock)
  assert.deepEqual(calls, [
    'read_activity',
    'get_thread',
    'read_memory',
    'participation_history',
  ])
  assert.equal(publications.size, 0)
  calls.length = 0
  await runSmoke(mock, ['--persist-confirmed', '--publish-confirmed'])
  assert.equal(publications.size, 2)
  assert.equal(memory.value, 'consequential prior note')
  assert.equal(memory.version, 4)
  assert.equal(calls.filter(name => name === 'publish_post').length, 2)
  assert.equal(calls.filter(name => name === 'reply').length, 2)
})
