import assert from 'node:assert/strict'
import {test} from 'node:test'
import {exportJWK, generateKeyPair, SignJWT} from 'jose'
import {lazyTokenVerifier, verifyAccessToken} from './auth.ts'
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

test('lazy verifier discovers inside requests, caches only completed verifiers with a TTL', async () => {
  const config = configSchema.parse({
    PUBLIC_URL: 'https://glyph.example',
    OAUTH_ISSUER: 'https://auth.example/',
    OAUTH_SUBJECT: 'owner',
    DEVVIT_MCP_URL:
      'https://glyphwanders-abc123-external.devvit.net/external/mcp',
    DEVVIT_TOKEN: `devvit_at_${'x'.repeat(40)}`,
  })
  const {privateKey, publicKey} = await generateKeyPair('RS256')
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: 'lazy-key',
    alg: 'RS256',
    use: 'sig',
  }
  let discoveries = 0
  let jwksFetches = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let hold = false
  const upstream: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url === 'https://auth.example/.well-known/openid-configuration') {
      discoveries++
      if (hold) await gate
      assert.equal(init?.redirect, 'error')
      return Response.json({
        issuer: config.OAUTH_ISSUER,
        jwks_uri: 'https://auth.example/jwks',
      })
    }
    if (url === 'https://auth.example/jwks') {
      jwksFetches++
      return Response.json({keys: [jwk]})
    }
    throw new Error('Unexpected discovery request')
  }
  const token = await new SignJWT({
    sub: 'owner',
    scope: 'glyph:read',
    exp: Math.floor(Date.now() / 1000) + 300,
  })
    .setProtectedHeader({alg: 'RS256', kid: 'lazy-key'})
    .setIssuer(config.OAUTH_ISSUER)
    .setAudience('https://glyph.example/mcp')
    .sign(privateKey)
  const verify = lazyTokenVerifier(config, upstream, 1000)

  // Cold concurrent requests each discover: no pending promise is shared.
  hold = true
  const first = verify(token)
  const second = verify(token)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(discoveries, 2)
  hold = false
  release()
  assert.deepEqual(await Promise.all([first, second]), [
    {sub: 'owner', scopes: ['glyph:read']},
    {sub: 'owner', scopes: ['glyph:read']},
  ])
  assert.equal(jwksFetches, 2)

  await verify(token)
  assert.equal(discoveries, 2)
  assert.equal(jwksFetches, 2)

  await new Promise(resolve => setTimeout(resolve, 1100))
  await verify(token)
  assert.equal(discoveries, 3)
  assert.equal(jwksFetches, 3)
})
