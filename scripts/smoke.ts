// A manual protocol client, never an LLM or a scheduler. Writes require explicit flags.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export async function runSmoke(
  client: Pick<Client, 'callTool' | 'listTools'>,
  flags: string[] = [],
) {
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({name, arguments: args})
    if (result.isError) throw new Error(JSON.stringify(result.content))
    return result.structuredContent as Record<string, unknown>
  }
  console.info(
    'Tools:',
    (await client.listTools()).tools.map(tool => tool.name).join(', '),
  )
  const activity = await call('read_activity', {limit: 5})
  const posts = activity.posts as {id: string}[]
  if (posts[0]) await call('get_thread', {postId: posts[0].id, limit: 10})
  const before = (await call('read_memory')).memory as {
    value: string | null
    version: number
  }
  console.info('Memory version:', before.version)
  if (flags.includes('--persist-confirmed')) {
    const value = `Manual persistence verification ${new Date().toISOString()}`
    const saved = (
      await call('write_memory', {
        value,
        version: before.version,
      })
    ).memory as typeof before
    const after = (await call('read_memory')).memory as typeof before
    assert.equal(after.value, value)
    assert.equal(after.version, saved.version)
    assert.equal(after.version, before.version + 1)
    await call('write_memory', {value: before.value, version: after.version})
    console.info(
      'Persistence verified and prior scratch text restored using CAS.',
    )
  }
  if (flags.includes('--publish-confirmed')) {
    const args = {
      title: 'GlyphWanders explicit bridge test',
      body: 'Owner-authorized manual integration test, not an autonomous Glyph visit.',
      requestId: randomUUID(),
    }
    // Log the recovery key BEFORE any network write. Keep it if interrupted.
    console.info('Publication requestId (reuse on recovery):', args.requestId)
    const published = await call('publish_post', args)
    const duplicate = await call('publish_post', args)
    // Publication journal response is checked explicitly; never treat uncertainty as success.
    assert.equal(published.status, 'succeeded')
    const id = (published.post as {id: string} | undefined)?.id ?? published.id
    assert.equal(typeof id, 'string')
    assert.equal(duplicate.status, 'succeeded')
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.id, id)
    const replyId = randomUUID()
    console.info('Reply requestId (reuse on recovery):', replyId)
    const replyArgs = {
      parentId: id,
      body: 'Owner-authorized manual reply verification.',
      requestId: replyId,
    }
    const reply = await call('reply', replyArgs)
    assert.equal(reply.status, 'succeeded')
    const duplicateReply = await call('reply', replyArgs)
    assert.equal(duplicateReply.status, 'succeeded')
    assert.equal(duplicateReply.duplicate, true)
    assert.equal(
      duplicateReply.id,
      (reply.comment as {id: string} | undefined)?.id ?? reply.id,
    )
    console.info(
      'Public test post and reply created; remove manually on Reddit if desired.',
    )
  } else
    console.info(
      'No public writes. --publish-confirmed explicitly authorizes a PRODUCTION test post and reply.',
    )
  await call('participation_history')
  console.info('PASS')
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const origin = process.env.PUBLIC_URL?.replace(/\/$/, '')
  const token = process.env.SMOKE_ACCESS_TOKEN
  if (!origin || !token)
    throw new Error(
      'Set PUBLIC_URL and a short-lived owner SMOKE_ACCESS_TOKEN from OAuth Inspector',
    )
  const client = new Client({name: 'GlyphWanders manual test', version: '2'})
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: {headers: {Authorization: `Bearer ${token}`}},
      }),
    )
    await runSmoke(client, process.argv.slice(2))
  } finally {
    await client.close()
  }
}
