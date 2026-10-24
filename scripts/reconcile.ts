// Local owner-only recovery. Never issues a Reddit write or clears deduplication.
import {Store} from '../src/bridge/store.ts'

const [id, publishedId] = process.argv.slice(2)
if (!id || !publishedId || !/^t[13]_[a-z0-9]+$/.test(publishedId))
  throw new Error(
    'Usage: npm run bridge:reconcile -- OPERATION_UUID VERIFIED_REDDIT_FULLNAME',
  )
if (!process.env.SQLITE_PATH) throw new Error('SQLITE_PATH required')
const store = new Store(process.env.SQLITE_PATH)
try {
  const job = store.get(id)
  if (job.status !== 'uncertain')
    throw new Error('Only uncertain operations can be reconciled')
  if (!publishedId.startsWith(job.kind === 'publish_post' ? 't3_' : 't1_'))
    throw new Error('Reddit ID type does not match operation')
  store.complete(id, {id: publishedId, reconciledByOwner: true})
  console.info(
    'Recorded owner-verified publication. No Reddit write performed.',
  )
} finally {
  store.close()
}
