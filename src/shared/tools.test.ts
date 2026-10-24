import assert from 'node:assert/strict'
import {test} from 'node:test'
import {schemas, scopeFor, toolDefinitions} from './tools.ts'

test('compact tool interface has strict schemas, bounded inputs and explicit write annotations', () => {
  const tools = toolDefinitions()
  assert.equal(tools.length, 7)
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.match(tool.description ?? '', /GlyphsPlayground|scratchpad|bridge/)
    assert.ok(tool._meta?.securitySchemes)
    assert.equal(
      tool.annotations?.readOnlyHint,
      scopeFor(tool.name) === 'glyph:read',
    )
  }
  assert.equal(
    schemas.publish_post.safeParse({
      title: ' ',
      body: 'x',
      requestId: '6ef419cf-82e9-4668-8f2a-276191dff353',
    }).success,
    false,
  )
  assert.equal(
    schemas.reply.safeParse({
      parentId: 't1_good',
      body: 'x',
      requestId: 'not-a-uuid',
    }).success,
    false,
  )
  assert.equal(
    schemas.reply.safeParse({
      parentId: 't2_user',
      body: 'x',
      requestId: '6ef419cf-82e9-4668-8f2a-276191dff353',
    }).success,
    false,
  )
  assert.equal(
    schemas.read_activity.safeParse({subreddit: 'elsewhere'}).success,
    false,
  )
  assert.equal(
    schemas.get_thread.safeParse({postId: 't3_valid', offset: -1}).success,
    false,
  )
  assert.equal(
    schemas.get_thread.safeParse({postId: 't3_valid', limit: 101}).success,
    false,
  )
  assert.equal(
    schemas.write_memory.safeParse({value: 'x'.repeat(16001), version: 0})
      .success,
    false,
  )
  assert.equal(
    schemas.write_memory.safeParse({value: null, version: -1}).success,
    false,
  )
  assert.deepEqual(schemas.write_memory.parse({value: null, version: 1}), {
    value: null,
    version: 1,
  })
})
