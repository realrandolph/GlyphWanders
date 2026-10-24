import type {IncomingMessage, RequestListener, ServerResponse} from 'node:http'
import {schemas, scopeFor} from '../shared/tools.ts'
import type {Identity} from './auth.ts'
import type {Config} from './config.ts'

async function boundedBody(source: AsyncIterable<Uint8Array>, limit: number) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of source) {
    size += chunk.length
    if (size > limit) throw new Error('Body too large')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(data))
}

/** OAuth credential translation only. All MCP handling and persistent state live in Devvit. */
export function createAdapter(
  config: Config,
  verify: (token: string) => Promise<Identity>,
  upstream: typeof fetch = fetch,
): RequestListener {
  const origin = config.PUBLIC_URL.replace(/\/$/, '')
  const resource = `${origin}/mcp`
  const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="glyph:read glyph:publish glyph:state"`
  let windowStart = Date.now()
  let count = 0
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        json(res, 200, {status: 'ok'})
        return
      }
      if (
        req.method === 'GET' &&
        req.url === '/.well-known/oauth-protected-resource'
      ) {
        json(res, 200, {
          resource,
          authorization_servers: [config.OAUTH_ISSUER],
          scopes_supported: ['glyph:read', 'glyph:publish', 'glyph:state'],
        })
        return
      }
      if (req.url !== '/mcp') {
        json(res, 404, {error: 'Not found'})
        return
      }
      if (Date.now() - windowStart >= 60000) {
        windowStart = Date.now()
        count = 0
      }
      if (++count > 120) {
        res.setHeader('Retry-After', '60')
        json(res, 429, {error: 'Rate limited'})
        return
      }
      if (req.headers.origin && req.headers.origin !== origin) {
        json(res, 403, {error: 'Origin denied'})
        return
      }
      let identity: Identity
      try {
        const token = /^Bearer (\S+)$/i.exec(
          req.headers.authorization ?? '',
        )?.[1]
        if (!token) throw new Error('Missing token')
        identity = await verify(token)
      } catch {
        res.setHeader('WWW-Authenticate', challenge)
        json(res, 401, {error: 'Authentication required'})
        return
      }
      if (identity.sub !== config.OAUTH_SUBJECT) {
        json(res, 403, {error: 'Forbidden'})
        return
      }
      if (!identity.scopes.includes('glyph:read')) {
        res.setHeader(
          'WWW-Authenticate',
          `${challenge}, error="insufficient_scope"`,
        )
        json(res, 403, {error: 'Missing read scope'})
        return
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST')
        json(res, 405, {error: 'Use POST'})
        return
      }
      let body: {
        jsonrpc?: unknown
        method?: unknown
        params?: {name?: unknown}
        id?: unknown
      }
      try {
        body = JSON.parse(await boundedBody(req, 1_000_000))
      } catch {
        json(res, 400, {error: 'Invalid request'})
        return
      }
      if (
        !body ||
        Array.isArray(body) ||
        body.jsonrpc !== '2.0' ||
        ![
          'initialize',
          'notifications/initialized',
          'ping',
          'tools/list',
          'tools/call',
        ].includes(String(body.method))
      ) {
        json(res, 400, {error: 'Unsupported MCP request'})
        return
      }
      if (body.method === 'tools/call') {
        const name = body.params?.name
        if (
          typeof name !== 'string' ||
          !Object.hasOwn(schemas, name) ||
          body.id === undefined
        ) {
          json(res, 400, {error: 'Unknown tool or missing request ID'})
          return
        }
        if (!identity.scopes.includes(scopeFor(name))) {
          const auth = `${challenge}, error="insufficient_scope", error_description="Additional tool scope required"`
          json(res, 200, {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              isError: true,
              content: [
                {type: 'text', text: 'Additional authorization required'},
              ],
              _meta: {'mcp/www_authenticate': [auth]},
            },
          })
          return
        }
      }
      // Never forward the owner's OAuth token, cookies, Origin or arbitrary headers.
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.DEVVIT_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      }
      const protocol = req.headers['mcp-protocol-version']
      if (typeof protocol === 'string' && protocol.length < 100)
        headers['MCP-Protocol-Version'] = protocol
      try {
        const response = await upstream(config.DEVVIT_MCP_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(25000),
        })
        if (response.status === 429) {
          const retry = Number(response.headers.get('retry-after'))
          res.setHeader(
            'Retry-After',
            String(
              Number.isFinite(retry) && retry > 0
                ? Math.min(Math.ceil(retry), 3600)
                : 60,
            ),
          )
          json(res, 429, {
            error:
              'Devvit rate limited. Retry later with the same publication requestId.',
          })
          return
        }
        if (!response.ok) throw new Error('Devvit rejected request')
        if (response.status === 202 || response.status === 204) {
          res.writeHead(response.status)
          res.end()
          return
        }
        if (
          !response.headers.get('content-type')?.includes('application/json') ||
          !response.body
        )
          throw new Error('Invalid Devvit response')
        const text = await boundedBody(response.body, 10_000_000)
        JSON.parse(text)
        res.writeHead(response.status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        })
        res.end(text)
      } catch {
        console.error(JSON.stringify({event: 'devvit_request_failed'}))
        json(res, 502, {
          error:
            'Devvit unavailable or configuration rejected. A publication may be uncertain; retry only with the same requestId.',
        })
      }
    } catch {
      if (!res.headersSent) json(res, 400, {error: 'Invalid request'})
      else res.end()
    }
  }
}
