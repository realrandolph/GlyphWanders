import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {test} from 'node:test'
import {
  type Context,
  reddit,
  runWithContext,
  settings,
} from '@devvit/web/server'
import {onReq} from './server.ts'

test('Devvit internal routes enforce target and moderator; no public write endpoints', async t => {
  let settingsReads = 0
  t.mock.method(settings, 'get', async () => {
    settingsReads++
    return undefined
  })
  t.mock.method(reddit, 'getModerators', () => ({get: async () => []}))
  const server = createServer(async (req, res) => {
    await runWithContext(
      {
        appName: 'glyphwanders',
        subredditName: req.headers['test-subreddit'] ?? 'GlyphsPlayground',
        username: 'not-a-moderator',
        userId: 't2_test',
      } as unknown as Context,
      () => onReq(req, res),
    )
  }).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    for (const route of [
      '/api/publish_post',
      '/api/reply',
      '/external/mcp',
      '/',
    ]) {
      assert.equal(
        (await fetch(`${base}${route}`, {method: 'POST'})).status,
        404,
      )
    }
    assert.equal(
      (
        await fetch(`${base}/internal/scheduler/poll`, {
          method: 'POST',
          headers: {'test-subreddit': 'Elsewhere'},
        })
      ).status,
      403,
    )
    assert.equal(settingsReads, 0)
    const nonMod = await fetch(`${base}/internal/menu/poll`, {method: 'POST'})
    assert.match(JSON.stringify(await nonMod.json()), /Only moderators/)
    assert.equal(settingsReads, 0)
    assert.equal(
      (await fetch(`${base}/internal/scheduler/poll`, {method: 'POST'})).status,
      200,
    )
    assert.equal(settingsReads, 2)
    await fetch(`${base}/internal/triggers/comment`, {
      method: 'POST',
      headers: {'test-subreddit': 'Elsewhere'},
      body: JSON.stringify({comment: {id: 't1_other'}}),
    })
    assert.equal(settingsReads, 2)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
