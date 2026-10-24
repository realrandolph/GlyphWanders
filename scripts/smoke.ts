// A manual protocol client, never an LLM or a scheduler. Writes require explicit flags.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const origin = process.env.PUBLIC_URL?.replace(/\/$/, '')
const token = process.env.SMOKE_ACCESS_TOKEN
if (!origin || !token)
  throw new Error(
    'Set PUBLIC_URL and a short-lived owner SMOKE_ACCESS_TOKEN from OAuth Inspector',
  )
const client = new Client({name: 'GlyphWanders manual test', version: '2'})
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: {headers: {Authorization: `Bearer ${token}`}},
  }),
)
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({name, arguments: args})
  if (result.isError) throw new Error(JSON.stringify(result.content))
  return result.structuredContent as Record<string, unknown>
}
try {
  console.info(
    'Tools:',
    (await client.listTools()).tools.map(tool => tool.name).join(', '),
  )
  const activity = await call('read_activity', {limit: 5})
  const posts = activity.posts as {id: string}[]
  if (posts[0]) await call('get_thread', {postId: posts[0].id, limit: 10})
  const before = await call('read_memory')
  console.info('Memory version:', before.version)
  if (process.argv.includes('--persist-confirmed')) {
    const saved = await call('write_memory', {
      value: `Manual persistence verification ${new Date().toISOString()}`,
      version: before.version,
    })
    const after = await call('read_memory')
    assert.equal(after.version, saved.version)
    console.info(
      'Persistence verified. Restore prior scratch text with the new CAS version if desired.',
    )
  }
  if (process.argv.includes('--publish-confirmed')) {
    const args = {
      title: 'GlyphWanders explicit bridge test',
      body: 'Owner-authorized manual integration test, not an autonomous Glyph visit.',
      requestId: randomUUID(),
    }
    // Log the recovery key BEFORE any network write. Keep it if interrupted.
    console.info('Publication requestId (reuse on recovery):', args.requestId)
    const published = await call('publish_post', args)
    const duplicate = await call('publish_post', args)
    assert.deepEqual(duplicate, published)
    // Publication journal response is checked explicitly; never treat uncertainty as success.
    assert.equal(published.status, 'succeeded')
    const id = published.redditId
    assert.equal(typeof id, 'string')
    const replyId = randomUUID()
    console.info('Reply requestId (reuse on recovery):', replyId)
    const reply = await call('reply', {
      parentId: id,
      body: 'Owner-authorized manual reply verification.',
      requestId: replyId,
    })
    assert.equal(reply.status, 'succeeded')
    console.info(
      'Public test post and reply created; remove manually on Reddit if desired.',
    )
  } else
    console.info(
      'No public writes. --publish-confirmed explicitly authorizes a PRODUCTION test post and reply.',
    )
  await call('participation_history')
  console.info('PASS')
} finally {
  await client.close()
}
