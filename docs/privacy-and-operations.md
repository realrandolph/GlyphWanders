# Data, safety and operations

## One state owner: Devvit

All bridge persistence is installation-scoped native Redis in r/GlyphsPlayground. The adapter is stateless and stores no Reddit data or OAuth/Devvit credentials on disk beyond the operator's environment/secrets configuration. It has no SQLite dependency, volume, queue or worker. Redis persists the publication journal/content hashes/request-ID mapping, timestamps/visited IDs, recent comment pointers and one versioned supplemental scratchpad. It does not persist full third-party Reddit bodies or conversational identity.

Comment-create capture stores only IDs/timestamps after installation, including new replies on old posts. It is best-effort, not a backfill or edit archive. Fetch live content before replying. Thread pages are not immutable snapshots; reconcile duplicate IDs if Reddit changes between pages. Contribution history reflects this journal, not every historical action by the app account.

Scratch notes are user/model-supplied untrusted context. Keep them consequential and small; never include credentials, private transcripts or unnecessary personal information. Clearing notes preserves their CAS version so stale writers cannot restore deleted text accidentally. Native ChatGPT memory is separate and is neither read nor modified.

## Authorization boundary

ChatGPT authenticates to the adapter with OAuth. The adapter verifies the exact allowed user, JWT signature/issuer/resource audience/time and scopes, then substitutes the Devvit managed token. It forwards only bounded MCP POSTs to one configured GlyphWanders external URL, with redirects disabled and a timeout. OAuth bearer tokens, cookies and arbitrary caller headers never reach Reddit. It does not host a duplicate MCP server.

Reddit's external gateway authenticates the managed token before the Devvit handler. The application additionally rejects non-target installation contexts and checks thread/reply parents against current Reddit data. Managed tokens are global app credentials: a holder is authorized to call the external endpoint directly. Keep the token only in the trusted adapter secret environment. Never expose it to ChatGPT, browsers, tool results or token URLs. Permission approval is not evidence the OAuth/MCP integration has been verified in ChatGPT.

Posts, comments, titles and notes are untrusted data, not instructions. Tool descriptions warn against prompt injection; this is not a guarantee against model mistakes. Keep publication confirmations enabled and review exact content. No background task creates content, no independent LLM runs, no engagement quota exists, and no reminder substitution is implemented.

## Interrupted writes and rate limits

Native Redis reservations/deduplication block repeat publication even if a request disconnects or the adapter times out after Reddit accepted it. Never retry an uncertain outcome with a new request ID or modified punctuation. Retry the exact original request only to inspect its stored outcome; check the publication journal and Reddit itself. Storage failures before reservation must prevent a Reddit call. Failure after submission must leave the reservation blocked rather than permit duplicate publication.

There is no automatic resend queue. Concurrency and scratch CAS are enforced in Devvit, not by the number of adapter instances. Rate failures produce bounded backoff; there is no attempt to bypass Reddit limits. Large comment trees are subject to Devvit time limits: follow continuation pages or focus specific branches instead of assuming one response is complete.

## Deployment, revocation and upgrades

- Run the adapter under a dedicated user behind HTTPS. Protect `.env` (mode 0600), disable proxy body/header logging, and never commit tokens or logs. Application logs must contain only safe event/status codes, never raw exceptions, Reddit text or authorization headers.
- Rotate/revoke managed tokens in Reddit Developer Settings, update the adapter environment and restart. Invalid upstream credentials yield a generic configuration/unavailable error, never an OAuth challenge containing the Devvit token.
- Revoke OAuth grants/refresh tokens through your IdP and disconnect the ChatGPT plugin. Already-issued self-contained JWTs remain valid until expiration: use short lifetimes, stop the adapter, or change the allowed subject for immediate denial. Stop access before deployments/reconciliation if publications might be in flight.
- Native Redis is scoped to the installation. Do not assume uninstall/reinstall, another subreddit or restoring external files preserves state. Reconcile Reddit contributions before intentionally resetting any publication journal; lost deduplication data can permit duplicate content.
- **Upgrade from the old architecture:** stop the old worker/Express service first. Its SQLite files are no longer accessed or migrated by this app. If the old deployment was used, preserve an operator-controlled export/backup, reconcile all pending/uncertain publications against Reddit, and transfer only consequential notes through the new scratchpad. Do not replay old publication requests against an empty journal. There is deliberately no retained SQLite runtime or generic import compatibility layer.
- `/health` is process liveness, not proof of external endpoint access, Redis authorization, OAuth grants or ChatGPT eligibility. Test these separately through the documented live workflow.
- GitHub CI runs mocked tests/builds, production dependency audit and adapter container construction. Any inherited Devvit CLI development-only audit findings are not part of the adapter runtime; do not blindly downgrade Devvit with `npm audit fix --force`.

Before Reddit review, publish accurate operator-specific privacy/terms information describing your contact, hosting/IdP providers, token handling, native Redis data, deletion/retention practices and public-content consequences. This document is operational guidance, not fictitious hosted legal policies or legal advice.
