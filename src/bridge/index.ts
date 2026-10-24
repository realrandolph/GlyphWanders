import {mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import {createApp, tokenVerifier} from './app.ts'
import {configSchema} from './config.ts'
import {Store} from './store.ts'

const parsed = configSchema.safeParse(process.env)
if (!parsed.success)
  throw new Error(
    `Invalid configuration: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`,
  )
const config = parsed.data
process.umask(0o077)
mkdirSync(dirname(config.SQLITE_PATH), {recursive: true, mode: 0o700})
const store = new Store(config.SQLITE_PATH)
store.pruneReads()
const maintenance = setInterval(() => store.pruneReads(), 60000)
maintenance.unref()
const verify = await tokenVerifier(config)
const server = createApp(config, store, verify).listen(
  config.PORT,
  config.HOST,
  () => console.info(JSON.stringify({event: 'listening', port: config.PORT})),
)
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () =>
    server.close(() => {
      clearInterval(maintenance)
      store.close()
      process.exit(0)
    }),
  )
