import assert from 'node:assert/strict'
import {test} from 'node:test'
import {generateKeyPair, SignJWT} from 'jose'
import {verifyAccessToken} from './auth.ts'
import {configSchema} from './config.ts'

test('JWT signature, issuer, resource audience, expiry and not-before are enforced', async () => {
  const config = configSchema.parse({
    PUBLIC_URL: 'https://glyph.example',
    OAUTH_ISSUER: 'https://auth.example/',
    OAUTH_SUBJECT: 'owner',
    DEVVIT_MCP_URL:
      'https://glyphwanders-abc123-external.devvit.net/external/mcp',
    DEVVIT_TOKEN: `devvit_at_${'x'.repeat(40)}`,
  })
  const {privateKey, publicKey} = await generateKeyPair('RS256')
  const sign = (changes: Record<string, unknown> = {}) =>
    new SignJWT({
      sub: 'owner',
      iss: config.OAUTH_ISSUER,
      aud: 'https://glyph.example/mcp',
      exp: Math.floor(Date.now() / 1000) + 60,
      scope: 'glyph:read glyph:publish',
      ...changes,
    })
      .setProtectedHeader({alg: 'RS256'})
      .sign(privateKey)
  assert.deepEqual(await verifyAccessToken(await sign(), publicKey, config), {
    sub: 'owner',
    scopes: ['glyph:read', 'glyph:publish'],
  })
  for (const bad of [
    {iss: 'https://evil.example/'},
    {aud: 'another-resource'},
    {exp: 1},
    {nbf: Math.floor(Date.now() / 1000) + 600},
    {exp: undefined},
    {sub: undefined},
  ])
    await assert.rejects(() =>
      sign(bad).then(token => verifyAccessToken(token, publicKey, config)),
    )
  const other = await generateKeyPair('RS256')
  await assert.rejects(() =>
    sign().then(token => verifyAccessToken(token, other.publicKey, config)),
  )
  for (const changes of [
    {PUBLIC_URL: 'not a URL'},
    {OAUTH_ISSUER: 'not a URL'},
    {DEVVIT_MCP_URL: 'not a URL'},
    {PUBLIC_URL: 'http://plain.example'},
    {DEVVIT_MCP_URL: 'https://evil.example/external/mcp'},
    {DEVVIT_MCP_URL: `${config.DEVVIT_MCP_URL}?externalToken=secret`},
    {DEVVIT_TOKEN: 'short'},
  ])
    assert.equal(configSchema.safeParse({...config, ...changes}).success, false)
})
