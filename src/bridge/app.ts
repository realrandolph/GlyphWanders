import {timingSafeEqual} from 'node:crypto'
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'
import {rateLimit} from 'express-rate-limit'
import {
  type CryptoKey,
  createRemoteJWKSet,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose'
import {z} from 'zod'
import {CommentDataSchema} from '../shared/contracts.ts'
import type {Config} from './config.ts'
import type {Store} from './store.ts'
import {makeServer} from './tools.ts'

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
  const issuer = config.OAUTH_ISSUER
  const response = await fetch(
    new URL(
      '.well-known/openid-configuration',
      issuer.endsWith('/') ? issuer : `${issuer}/`,
    ),
    {signal: AbortSignal.timeout(10000), redirect: 'error'},
  )
  if (!response.ok) throw new Error('OAuth discovery failed')
  const metadata = z
    .object({issuer: z.string(), jwks_uri: z.url()})
    .parse(await response.json())
  if (
    metadata.issuer !== issuer ||
    new URL(metadata.jwks_uri).protocol !== 'https:'
  )
    throw new Error('Invalid OAuth metadata')
  const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri))
  return (token: string) => verifyAccessToken(token, jwks, config)
}
export function createApp(
  config: Config,
  store: Store,
  verify: (token: string) => Promise<Identity>,
) {
  const app = express()
  const origin = config.PUBLIC_URL.replace(/\/$/, '')
  const resource = `${origin}/mcp`
  const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="glyph:read glyph:publish glyph:state"`
  app.disable('x-powered-by')
  app.use(
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  )
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  app.get('/health', (_req, res) => res.json({status: 'ok'}))
  app.get('/.well-known/oauth-protected-resource', (_req, res) =>
    res.json({
      resource,
      authorization_servers: [config.OAUTH_ISSUER],
      scopes_supported: ['glyph:read', 'glyph:publish', 'glyph:state'],
    }),
  )
  app.use(express.json({limit: '1mb'}))
  app.use('/worker', (req, res, next) => {
    const expected = Buffer.from(`Bearer ${config.WORKER_TOKEN}`)
    const actual = Buffer.from(req.headers.authorization ?? '')
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res.sendStatus(401)
      return
    }
    next()
  })
  const claim = z.object({subreddit: z.literal('GlyphsPlayground')}).strict()
  const commentEvent = z
    .object({
      subreddit: z.literal('GlyphsPlayground'),
      comment: CommentDataSchema,
    })
    .strict()
  app.post('/worker/comment', (req, res) => {
    const event = commentEvent.safeParse(req.body)
    if (!event.success) {
      res.sendStatus(400)
      return
    }
    store.recordComment(event.data.comment)
    res.json({ok: true})
  })
  app.post('/worker/claim', (req, res) => {
    if (!claim.safeParse(req.body).success) {
      res.sendStatus(400)
      return
    }
    const job = store.claim()
    if (job)
      console.info(
        JSON.stringify({event: 'claimed', id: job.id, kind: job.kind}),
      )
    res.json({job})
  })
  const complete = z
    .object({
      id: z.string().uuid(),
      result: z.unknown().optional(),
      error: z.string().max(500).optional(),
    })
    .strict()
  app.post('/worker/complete', (req, res) => {
    const input = complete.safeParse(req.body)
    if (!input.success) {
      res.sendStatus(400)
      return
    }
    try {
      const job = store.complete(
        input.data.id,
        input.data.result,
        input.data.error,
      )
      console.info(
        JSON.stringify({event: 'completed', id: job.id, status: job.status}),
      )
      res.json({ok: true})
    } catch {
      res.status(409).json({error: 'Completion rejected'})
    }
  })
  app.all('/mcp', async (req, res) => {
    if (req.headers.origin && req.headers.origin !== origin) {
      res.sendStatus(403)
      return
    }
    let identity: Identity
    try {
      const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1]
      if (!token) throw new Error('Missing token')
      identity = await verify(token)
    } catch {
      res
        .set('WWW-Authenticate', challenge)
        .status(401)
        .json({error: 'Authentication required'})
      return
    }
    if (
      identity.sub !== config.OAUTH_SUBJECT ||
      !identity.scopes.includes('glyph:read')
    ) {
      res.sendStatus(403)
      return
    }
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').sendStatus(405)
      return
    }
    const server = makeServer(store, identity.scopes, challenge)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch {
      console.error(JSON.stringify({event: 'mcp_transport_error'}))
      if (!res.headersSent) res.sendStatus(500)
    }
  })
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(400).json({error: 'Invalid request'})
    },
  )
  return app
}
