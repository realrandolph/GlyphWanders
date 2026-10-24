import assert from 'node:assert/strict'
import {test} from 'node:test'
import {generateKeyPair, SignJWT} from 'jose'
import {verifyAccessToken} from './app.ts'
import {configSchema} from './config.ts'

test('JWT signatures, issuer, audience, expiry, not-before and required claims', async () => {
  const config = configSchema.parse({
    PUBLIC_URL: 'https://glyph.example',
    OAUTH_ISSUER: 'https://auth.example/',
    OAUTH_SUBJECT: 'owner',
    WORKER_TOKEN: 'x'.repeat(40),
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
    {iss: 'https://attacker.example/'},
    {aud: 'other-resource'},
    {exp: 1},
    {nbf: Math.floor(Date.now() / 1000) + 600},
    {exp: undefined},
    {sub: undefined},
  ]) {
    await assert.rejects(() =>
      sign(bad).then(token => verifyAccessToken(token, publicKey, config)),
    )
  }
  const otherKey = await generateKeyPair('RS256')
  await assert.rejects(() =>
    sign().then(token => verifyAccessToken(token, otherKey.publicKey, config)),
  )
  assert.equal(
    configSchema.safeParse({...config, PUBLIC_URL: 'http://insecure.example'})
      .success,
    false,
  )
  assert.equal(
    configSchema.safeParse({...config, WORKER_TOKEN: 'short'}).success,
    false,
  )
})
