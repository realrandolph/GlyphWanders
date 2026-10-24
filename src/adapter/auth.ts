import {
  type CryptoKey,
  createRemoteJWKSet,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose'
import {z} from 'zod'
import type {Config} from './config.ts'

export type Identity = {sub: string; scopes: string[]}
export async function verifyAccessToken(
  token: string,
  key: CryptoKey | JWTVerifyGetKey,
  config: Config,
): Promise<Identity> {
  const {payload} = await jwtVerify(token, key as JWTVerifyGetKey, {
    issuer: config.OAUTH_ISSUER,
    audience: `${config.PUBLIC_URL.replace(/\/$/, '')}/mcp`,
    algorithms: ['RS256', 'ES256'],
    requiredClaims: ['exp', 'sub'],
  })
  return {
    sub: payload.sub ?? '',
    scopes: typeof payload.scope === 'string' ? payload.scope.split(' ') : [],
  }
}
export async function tokenVerifier(config: Config) {
  const response = await fetch(
    new URL(
      '.well-known/openid-configuration',
      config.OAUTH_ISSUER.endsWith('/')
        ? config.OAUTH_ISSUER
        : `${config.OAUTH_ISSUER}/`,
    ),
    {signal: AbortSignal.timeout(10000), redirect: 'error'},
  )
  if (!response.ok) throw new Error('OAuth discovery failed')
  const metadata = z
    .object({issuer: z.string(), jwks_uri: z.url()})
    .parse(await response.json())
  if (
    metadata.issuer !== config.OAUTH_ISSUER ||
    new URL(metadata.jwks_uri).protocol !== 'https:'
  )
    throw new Error('Invalid OAuth metadata')
  const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri))
  return (token: string) => verifyAccessToken(token, jwks, config)
}
