// This is a protocol test client, NOT an independent LLM or scheduled assistant.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setTimeout} from 'node:timers/promises'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const origin = process.env.PUBLIC_URL?.replace(/\/$/, '')
const token = process.env.SMOKE_ACCESS_TOKEN
if (!origin || !token)
  throw new Error(
    'Set PUBLIC_URL and a short-lived SMOKE_ACCESS_TOKEN from the OAuth Inspector flow',
  )
const client = new Client({
  name: 'GlyphWanders manual verification',
  version: '1',
})
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: {headers: {Authorization: `Bearer ${token}`}},
  }),
)
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({name, arguments: args})
  if (response.isError) throw new Error(JSON.stringify(response.content))
  return response.structuredContent as Record<string, unknown>
}
async function finish(data: Record<string, unknown>) {
  let op = data.operation as {
    id: string
    status: string
    result: Record<string, unknown>
  }
  for (let n = 0; n < 24 && ['queued', 'running'].includes(op.status); n++) {
    console.info(`Waiting for Devvit: ${op.id} (${op.status})`)
    await setTimeout(10000)
    op = (await call('get_operation', {id: op.id})).operation as typeof op
  }
  assert.equal(
    op.status,
    'succeeded',
    `Operation ${op.id}: ${op.status}; inspect with get_operation, do NOT blindly retry`,
  )
  return op
}
try {
  console.info(
    'Tools:',
    (await client.listTools()).tools.map(tool => tool.name).join(', '),
  )
  const activity = await finish(await call('read_activity', {limit: 5}))
  console.info('Activity retrieved:', activity.id)
  const posts = activity.result.posts as {id: string}[]
  if (posts[0])
    await finish(await call('get_thread', {postId: posts[0].id, limit: 10}))
  if (process.argv.includes('--publish-confirmed')) {
    const requestId = randomUUID()
    const args = {
      title: 'GlyphWanders bridge verification',
      body: 'This is an explicitly authorized manual integration test, not an autonomous Glyph visit.',
      requestId,
    }
    const published = await finish(await call('publish_post', args))
    const duplicate = (await call('publish_post', args)).operation as {
      id: string
    }
    assert.equal(duplicate.id, published.id)
    const result = published.result as {post: {id: string}}
    await finish(
      await call('reply', {
        parentId: result.post.id,
        body: 'Manual reply verification complete. No engagement quota or independent model is running.',
        requestId: randomUUID(),
      }),
    )
    console.info(
      'Confirmed test post and reply. Remove them manually on Reddit if desired.',
    )
  } else
    console.info(
      'Read-only test. Add --publish-confirmed only when you authorize a PUBLIC test post and reply.',
    )
  await call('participation_history')
  const state = await call('read_state')
  console.info(
    'History and scratchspace retrieved.',
    Array.isArray(state.items) ? state.items.length : 0,
  )
  console.info('PASS')
} finally {
  await client.close()
}
