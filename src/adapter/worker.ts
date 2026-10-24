import {handleAsNodeRequest} from 'cloudflare:node'
import {createServer, type Server} from 'node:http'
import {createAdapter} from './app.ts'
import {lazyTokenVerifier} from './auth.ts'
import {type Config, configSchema} from './config.ts'

const REQUIRED = [
  'PUBLIC_URL',
  'OAUTH_ISSUER',
  'OAUTH_SUBJECT',
  'DEVVIT_MCP_URL',
  'DEVVIT_TOKEN',
] as const
const CONFIGURED_ROUTES = new Set([
  '/mcp',
  '/.well-known/oauth-protected-resource',
])

export type WorkerEnv = Record<string, unknown>

let cached: {key: string; server: Server; port: number} | undefined

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
  })
}

function configKey(config: Config) {
  // Memory only, never logged. The managed token is included so a rotation
  // rebuilds the adapter instead of forwarding the previous credential.
  return JSON.stringify([
    config.PUBLIC_URL,
    config.OAUTH_ISSUER,
    config.OAUTH_SUBJECT,
    config.DEVVIT_MCP_URL,
    config.DEVVIT_TOKEN,
  ])
}

/**
 * Workers cannot use fetch's redirect:"error"; redirect:"manual" plus a status
 * check is equivalent and keeps the existing adapter's no-redirect guarantee.
 */
const edgeFetch: typeof fetch = async (input, init) => {
  if (init?.redirect !== 'error') return fetch(input, init)
  const response = await fetch(input, {...init, redirect: 'manual'})
  if (response.status >= 300 && response.status < 400)
    throw new Error('Redirect denied')
  return response
}

/** The Node HTTP server is constructed once per isolate and reused. */
function adapterPort(config: Config) {
  const key = configKey(config)
  if (cached?.key === key) return cached.port
  cached?.server.close()
  cached = undefined
  // createAdapter's 120/min limit is per-isolate best effort, not global.
  const server = createServer(
    createAdapter(config, lazyTokenVerifier(config, edgeFetch), edgeFetch),
  )
  server.listen(0)
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Node HTTP server did not bind')
  cached = {key, server, port: address.port}
  return address.port
}

function invalidFields(error: {issues: {path: PropertyKey[]}[]}) {
  const fields = new Set<string>()
  for (const issue of error.issues) {
    const field = issue.path[0]
    if (typeof field === 'string' && REQUIRED.includes(field as never))
      fields.add(field)
  }
  return [...fields]
}

/** HOST and PORT are Node-only; Worker env can contain unrelated bindings. */
function parseConfig(env: WorkerEnv) {
  return configSchema.safeParse({
    PUBLIC_URL: env.PUBLIC_URL,
    OAUTH_ISSUER: env.OAUTH_ISSUER,
    OAUTH_SUBJECT: env.OAUTH_SUBJECT,
    DEVVIT_MCP_URL: env.DEVVIT_MCP_URL,
    DEVVIT_TOKEN: env.DEVVIT_TOKEN,
  })
}

export default {
  async fetch(request: Request, env: WorkerEnv = {}): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/health') {
      if (request.method !== 'GET') return json(404, {error: 'Not found'})
      const parsed = parseConfig(env)
      if (!parsed.success)
        return json(503, {
          status: 'unavailable',
          ready: false,
          configured: false,
          missing: invalidFields(parsed.error),
        })
      return json(200, {
        status: 'ok',
        ready: true,
        configured: true,
        liveVerified: false,
      })
    }
    if (!CONFIGURED_ROUTES.has(path)) return json(404, {error: 'Not found'})

    const parsed = parseConfig(env)
    if (!parsed.success) return json(503, {error: 'Service unavailable'})
    try {
      return await handleAsNodeRequest(adapterPort(parsed.data), request)
    } catch {
      console.error(JSON.stringify({event: 'worker_request_failed'}))
      return json(503, {error: 'Service unavailable'})
    }
  },
}
