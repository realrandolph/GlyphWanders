# Privacy and operations

## Data and trust boundary

- Only r/GlyphsPlayground is accessible. No DMs, other subreddits, voting, moderation, arbitrary HTTP fetching or conversation ingestion tools exist.
- The OAuth provider authenticates the owner. Only one exact immutable subject is allowed; tokens must also have the correct audience and scopes. A login by another account cannot read scratchspace or publish. Worker bearer credentials are separate and can never authorize `/mcp`.
- Devvit only accepts Reddit work through the authenticated outbound queue. No browser-facing write API or frontend exists. Moderators can poll already-authorized jobs, not author new ones through the menu.
- All Reddit content (and scratch notes) is untrusted. Tool/server descriptions warn ChatGPT not to follow embedded instructions or leak private context. These warnings are not a guarantee against model prompt injection: keep human publication confirmation, review bodies, and connect as few sensitive plugins as possible in the same conversation.
- The service receives only tool arguments/results, not general ChatGPT conversation history. ChatGPT may still choose to send private context as an argument: do not authorize such publication. The operator/hosting provider controls the service filesystem.

## Local SQLite data

Stored locally: operation arguments, publication content hashes, request-ID aliases, statuses/results, timestamps, published IDs, visited post IDs, up to 500 recent comment ID/post ID pointers, and up to 100 bridge scratch notes. Full read results are transient and cleared after 24 hours by minute maintenance (and at startup). New-post/thread data may contain Reddit text until then. Comment-create notifications send only IDs and creation timestamps, never author names or text. Publication arguments and outcomes remain for deduplication/reconciliation. Scratch notes persist until explicitly deleted; deletion leaves a null/version tombstone, not the note text.

Reddit create events are best-effort and start only after installation; there is no historical backfill, edit tracker or claim of complete coverage. Recent IDs can refer to removed content; retrieve live threads before replying. Bounded thread output can be truncated. Read results can become stale during their 24-hour lifetime; issue a fresh read before a consequential response.

Run under a dedicated OS user. New service files use umask 077; the default data directory is mode 0700. Never commit `.env`, SQLite/WAL files or logs. The app logs operation IDs/kinds/statuses, not auth headers, contents or raw exception text. Disable body/header logging in the proxy and IdP debugging tools too. IdP and hosting logs have their own retention policies.

SQLite/WAL deletion is logical, not guaranteed forensic erasure. For strict erasure stop the service, checkpoint/vacuum using trusted SQLite tools, remove applicable backups, and follow your storage provider's deletion process. Do not erase idempotency metadata while a publication might still be in flight.

## Backups, deploys, rate limits

- Back up SQLite with an online SQLite backup tool or stop the service and copy the database **together with any WAL/SHM files**. Encrypt backups, restrict access and choose a finite retention period. Restoring an old snapshot can lose deduplication keys: stop Devvit polling, reconcile Reddit publications since that snapshot, then resume. Never run two independent DB copies against the same app worker credentials.
- Run one service instance on durable local disk. SQLite `BEGIN IMMEDIATE`, WAL and busy timeout protect concurrent claims across connections. Local state updates use compare-and-swap versions, including deletion tombstones.
- Normal Devvit throughput is one operation per minute. Errors impose an exponential cooldown from one minute up to one hour, reset by success. Reads may recover after a worker crash; publications never auto-retry on an ambiguous Reddit/network outcome. Inspect `uncertain` manually. Reddit's own limits/restrictions still apply; no quota or engagement target is implemented.
- For prolonged outages, unclaimed work expires rather than posting stale drafts later. Disable polling/revoke credentials before migrations or restoration. Restarting the bridge is safe with the same durable DB.
- `/health` proves only service liveness, not Reddit permission, domain approval, OAuth grant, or ChatGPT eligibility. Verify each with the documented manual flow.
- CI runs tests/build and a production dependency audit. Devvit CLI development dependencies may have upstream audit findings; do not downgrade Devvit blindly with `npm audit fix --force`. Production runtime excludes the CLI. Re-evaluate tooling updates separately.

## Revoke / rotate

To stop publishing immediately, remove `glyph:publish` from the owner/provider grant, revoke the OAuth link, and stop the bridge/worker if already-issued tokens or queued operations might remain. JWT validation cannot instantly revoke an already-issued self-contained JWT; use short access-token lifetimes (e.g. 5–15 minutes). Change `OAUTH_SUBJECT` or stop the service for immediate ingress denial. Provider refresh-token revocation prevents new tokens, not necessarily current access tokens.

To rotate `WORKER_TOKEN`, stop the service, update its environment and the Devvit global secret, then restart. Old worker tokens receive 401. Never rotate by placing a credential in a URL or chat. Keep `.env` mode 0600. If the worker token leaks, it can claim jobs, forge results and supply discovery metadata; rotate it and reconcile all affected publications.

## Policy content to adapt for Reddit review

Before production, publish a policy naming the actual operator, contact address, service hostname, hosting/IdP providers, these stored data categories, purpose (owner-directed Reddit participation), retention/deletion and backup practices, and whether any additional analytics/logging exists. State that Reddit content is passed to ChatGPT only when the owner uses the bridge, public posts/replies are visible on Reddit, and provider terms apply. Publish terms explaining authorized use, human approval of public content, no guaranteed uptime/scheduling, no manufactured engagement, and revocation. This file is operational documentation, not legal advice or a fictitious hosted policy.
