import {z} from 'zod'

const httpsUrl = z
  .url()
  .refine(value => new URL(value).protocol === 'https:', 'HTTPS required')
export const configSchema = z.object({
  PUBLIC_URL: httpsUrl.refine(
    value =>
      new URL(value).pathname === '/' &&
      !new URL(value).search &&
      !new URL(value).hash,
    'Use an origin without a path',
  ),
  OAUTH_ISSUER: httpsUrl,
  OAUTH_SUBJECT: z.string().min(1),
  WORKER_TOKEN: z.string().min(32),
  SQLITE_PATH: z.string().default('./data/glyphwanders.sqlite'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
})
export type Config = z.infer<typeof configSchema>
