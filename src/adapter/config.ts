import {z} from 'zod'

const https = z.url().refine(value => {
  const url = new URL(value)
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  )
}, 'HTTPS without credentials, query or fragment required')
export const configSchema = z.object({
  PUBLIC_URL: https.refine(
    value => new URL(value).pathname === '/',
    'Use an origin, no path',
  ),
  OAUTH_ISSUER: https,
  OAUTH_SUBJECT: z.string().min(1),
  DEVVIT_MCP_URL: https.refine(
    value =>
      /^glyphwanders-[a-z0-9]+-external\.devvit\.net$/.test(
        new URL(value).hostname,
      ) && new URL(value).pathname === '/external/mcp',
    'Use the installation-specific GlyphWanders external MCP endpoint',
  ),
  DEVVIT_TOKEN: z.string().regex(/^devvit_at_[a-zA-Z0-9_-]{16,}$/),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
})
export type Config = z.infer<typeof configSchema>
