import {createServer} from 'node:http'
import {createAdapter} from './app.ts'
import {tokenVerifier} from './auth.ts'
import {configSchema} from './config.ts'

const parsed = configSchema.safeParse(process.env)
if (!parsed.success)
  throw new Error(
    `Invalid configuration: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`,
  )
const config = parsed.data
const verify = await tokenVerifier(config)
const server = createServer(createAdapter(config, verify))
server.requestTimeout = 30000
server.headersTimeout = 10000
server.listen(config.PORT, config.HOST, () =>
  console.info(JSON.stringify({event: 'listening', port: config.PORT})),
)
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close())
