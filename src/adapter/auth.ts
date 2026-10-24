import {
  type CryptoKey,
  createRemoteJWKSet,
  customFetch,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose'
import {z} from 'zod'
import type {Config} from './config.ts'

export type Identity = {sub: string; scopes: string[]}
/** Discovery and JWKS refresh are bounded; completed verifiers are reused for 10 minutes. */
const VERIFIER_TTL_MS = 10 * 60 * 1000
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
export async function tokenVerifier(
  config: Config,
  upstream: typeof fetch = fetch,
) {
  const response = await upstream(
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
  const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri), {
    cacheMaxAge: VERIFIER_TTL_MS,
    cooldownDuration: 30_000,
    timeoutDuration: 10_000,
    [customFetch]: (url, options) => upstream(url, options),
  })
  return (token: string) => verifyAccessToken(token, jwks, config)
}

/**
 * Worker-only verifier: no network at module initialization. Discovery and
 * JWKS fetch happen inside requests. Only completed verifiers are cached, so
 * concurrent requests never share a pending network promise. Each verifier is
 * bound to one config; a changed issuer, audience or subject gets a new one.
 */
export function lazyTokenVerifier(
  config: Config,
  upstream: typeof fetch = fetch,
  ttlMs = VERIFIER_TTL_MS,
) {
  let cached: {expiresAt: number; verify: (token: string) => Promise<Identity>}
  return async (token: string) => {
    if (!cached || cached.expiresAt <= Date.now()) {
      const verify = await tokenVerifier(config, upstream)
      cached = {expiresAt: Date.now() + ttlMs, verify}
    }
    return cached.verify(token)
  }
}
