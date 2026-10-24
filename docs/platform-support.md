# Platform support research

Checked **2026-10-24** against the official pages cited below. Devvit citations use the **0.15** documentation set (matching the repository's `@devvit/web` **0.15.0** dependency); the current MCP revision is **2026-07-28**, with **2025-11-25** compatibility noted where ChatGPT's documentation still describes an initialization handshake. OpenAI's pages are continuously updated and do not expose a last-updated date in their text, so the date above is the check date.

These are platform capabilities, not confirmation that Reddit has granted external-endpoint access or that a particular ChatGPT account or workspace is eligible.

## Verdict

- The MCP endpoint and all tool logic live in the Devvit app at `/external/mcp`. Tools are reached over Streamable HTTP with stateless, single JSON responses.
- A small external OAuth adapter **cannot be eliminated**. It is an authorization shim, not an MCP server: it publishes OAuth metadata, authenticates the one owner, validates ChatGPT's token, and translates that bearer to the Devvit managed token while proxying `/mcp` to one fixed installation URL.
- There is no Express app, SQLite database, queue, or polling worker. Devvit's native Redis is the app's persistence; it is not ChatGPT memory.

## Verified boundaries

| Requirement | Verified boundary (quoted text is from the cited page) | Consequence for this design |
|---|---|---|
| Devvit external hosting | **Limited access.** "This is a limited-access feature. Fill out this form to request access." "All external endpoints require a secret token to access." | Reddit must grant the feature. Installing the app, moderator action, or the owner's consent does not grant it. Without approval there is no public Devvit `/external/mcp`; do not publish on an assumption of access. |
| Token types and scope | Managed tokens are "Long-lived", "Currently scoped globally across all installations of an app", and "All requests execute as the app account". Callback tokens have a "short time-to-live", are "intended for single use", and are "currently scoped to an installation". "All tokens start with `devvit_at_`." | Declare the MCP endpoint with `"scopes": ["global"]`; only a managed token can invoke it. Callback tokens cannot serve as a ChatGPT connector credential. Devvit cannot identify the ChatGPT user; every Reddit action is the app account. |
| Authorization header | "The secret token must be provided in the `Authorization` header for incoming external requests to the app." The documented form is `Authorization: bearer devvit_at_...`. | Devvit will not accept ChatGPT's OAuth JWT or an arbitrary bearer. A component must present the Devvit token. ChatGPT's connection UI has no fixed-bearer or API-key field (see below). |
| Global token vs installation | "A managed token will work on any global endpoint regardless of where it's installed"; the docs show the same token against subreddits A, B, and C. | Pin the adapter to the r/GlyphsPlayground installation host `https://<app>-<subreddit_id>-external.devvit.net/external/mcp`. Never accept a caller-supplied subreddit or host. Enforce the intended subreddit in app code as well. |
| Transport and limits | External endpoints accept request bodies "up to 10 megabytes" and are limited to "5 requests per second (at time of writing, may change at any time)". Devvit Web documents "Max request time: 30s", "Single request and single response handling only", and "Streaming or chunked responses and websockets are not supported." The external-endpoints page documents no streaming exception. | Use one POST and one `application/json` response rather than SSE, GET streaming, websockets, or long-poll. Keep work well under 30 seconds. If a GET probe arrives, the app should answer 405 per MCP compatibility rules; gateway method routing must be verified in playtest. Do not claim SSE support. |
| MCP Streamable HTTP | Current **2026-07-28**: the endpoint "supports POST"; a request is answered with "a single JSON object" or an SSE stream; the GET stream endpoint and protocol-level sessions were removed. **2025-11-25**: a GET may return 405, a JSON response is allowed, and clients must support both JSON and SSE. | Stateless JSON POST is fully valid Streamable HTTP, not a degraded mode. Use the official MCP SDK transport in stateless mode. Preserve `MCP-Protocol-Version` and, for 2026-07-28, `Mcp-Method`/`Mcp-Name`/`Mcp-Param-*` headers through any proxy. Let the SDK negotiate with ChatGPT rather than assuming only the newest revision. |
| ChatGPT MCP connection | "Supported MCP protocols: SSE and streaming HTTP." Access is "ChatGPT on the web"; the flow is Plugins → Add custom MCP server → server URL or Tunnel → authentication → Create as a plugin. Developer Mode is no longer required. "Custom MCP servers do not require `search`/`fetch` tools"; read and write tools are supported. | ChatGPT can call the Devvit-hosted tools, subject to workspace policy. Do not design around a search/fetch-only restriction. Test initialize/list/call and a write confirmation with the actual connector. |
| ChatGPT OAuth | Authentication options are "OAuth, No authentication, and OAuth or no authentication." For OAuth, ChatGPT expects protected-resource metadata, authorization-server discovery, S256 PKCE, the `resource` parameter echoed through the flow, and CIMD, DCR, or a provided client. "ChatGPT does not support machine-to-machine OAuth grants such as client credentials, service accounts, or JWT bearer assertions, nor can it present custom API keys." Token verification remains the resource server's job. | A Devvit-only endpoint cannot complete ChatGPT's OAuth discovery: Devvit exposes no anonymous `/.well-known` route and accepts only `devvit_at_` tokens. The adapter must be the authorization server and present the Devvit token. There is no API-key shortcut. |
| OAuth linking UI | "Triggering the tool-level OAuth flow requires both metadata (`securitySchemes` and the resource metadata document) **and** runtime errors that carry `_meta["mcp/www_authenticate"]`." | Declare OAuth `securitySchemes` in tool metadata; if the MCP server itself handles auth failures, return that `_meta` challenge. The adapter must return an HTTP 401 with `WWW-Authenticate` pointing at its protected-resource metadata. Test the linking UI; discovery alone is not enough. |
| ChatGPT availability | "Custom MCP server connections and full MCP support are available for ChatGPT Business and Enterprise/Edu customers on ChatGPT web." "Pro users can connect custom MCP servers with read/fetch permissions." Plus is not named. Workspace permissions and RBAC apply; deep research is read/fetch only. | Do not promise Plus or Pro write publishing. Verify the exact account and workspace before deployment. Eligibility can change. |
| Approval and annotations | "Write actions by default require confirmation"; `readOnlyHint` is respected and tools without it are treated as writes. Server authorization is independent: "Enforce authorization in the MCP server for every request." | Mark publication and state mutations as writes; mark read tools with `readOnlyHint`. Client confirmation is not an authorization boundary. |
| Ordinary ChatGPT Tasks | "Tasks can use apps like Gmail when they're available for your account or workspace." Unsupported with Tasks: "Voice chats" and "GPTs". The page does not promise arbitrary custom MCP plugins in ordinary tasks. | A task may use an enabled app, but unattended Glyph participation is not a documented guarantee. Test the exact task type and account; do not design autonomous scheduled visits. |
| Work/Codex scheduled tasks | "Scheduled tasks created with ChatGPT Work on the web, or with ChatGPT Work or Codex in the desktop app, can use plugins." Standalone tasks "start a new chat for each scheduled run"; a task scheduled inside an existing chat "uses the chat's existing context". | This is the documented scheduling surface for plugins. It is user-configured, not an API the bridge can call. No documented API resumes or enqueues an arbitrary existing Glyph chat; scheduling inside a chat is a UI action, not programmatic continuation. Do not substitute an API model. |
| Native memory | Memory is a ChatGPT product setting: "Memory features and controls can vary by plan, region, platform, and workspace settings"; it is managed under Settings → Personalization → Memory. No programmatic read/write memory API is documented in the developer reference. | No documented mechanism lets a remote MCP server read or write native ChatGPT memory; MCP exchanges tool calls. Server-side scratch state is the app's own store, not memory. ChatGPT may choose to put context into a tool argument, but that is not memory API access. |
| API conversation state | The Conversations API persists API-created conversation objects; absent that API-managed state, "each text generation request is independent and stateless". | Separate product from the Glyph chat. Do not use an API model as a substitute. |
| Reddit API | Devvit's server `reddit` client reads and writes Reddit content such as posts, comments, and votes in the installation; "Devvit handles authentication automatically". Devvit documents that private user data such as subscribed subreddits, votes, saved content, and private profile data is not exposed. | Tools can act only within the installation and public content; they cannot read the listed private user data. Keep the app-account and target-subreddit checks explicit. |
| Persistence | Devvit Redis is namespaced per installation; current documented limits include 5 GB storage and 5 MB request size. | Use Redis for app state and idempotency; do not call it ChatGPT memory. The external endpoint is global, but its Redis data is installation-scoped: target r/GlyphsPlayground. |

## Why the adapter cannot be removed

Each supported alternative was checked and does not remove the need for an OAuth/bearer adapter:

- **No authentication:** impossible. "All external endpoints require a secret token"; there is no anonymous Devvit external route.
- **API key:** the ChatGPT custom-MCP flow offers OAuth, no authentication, or mixed OAuth/no-auth. The authentication guide says ChatGPT cannot present custom API keys, and the submission portal has no API-key connection flow. The plugin manifest schema can declare `api_key` for some package flows, but that does not add an API-key field to the ChatGPT web connector targeted here.
- **Callback token:** expires after 10 minutes, is single-use, and is installation-scoped. It cannot be a stable connector credential.
- **Devvit as the OAuth authorization server:** managed tokens are created manually in Developer Settings; Devvit documents no OAuth token-issuance endpoint. Its external routes also require a Devvit token before any metadata could be read.
- **Return the managed token as the OAuth access token:** Devvit would accept it, but this still requires an adapter to run OAuth discovery and owner login, and it hands a long-lived, global, app-account secret to OpenAI. Rejected: keep the managed token server-side and proxy.
- **Secure MCP Tunnel:** intended for private servers and explicitly not a substitute for public submission. It does not mint a Devvit credential, and no supported injection of the Devvit managed `Authorization` header is documented.

No supported mechanism eliminates the adapter. It can be reduced to OAuth metadata, owner login/PKCE, token validation, and bearer translation/proxying.

## Assumptions

- The adapter has a stable public HTTPS origin, a secret store, and the ability to run authorization-code + PKCE; it is not itself an MCP tool host.
- The operator can create and rotate a Devvit managed token in Developer Settings and install the app in r/GlyphsPlayground.
- ChatGPT's workspace policy allows the custom MCP connection and OAuth linking; plan eligibility is checked separately.
- The Devvit external hostname remains stable for the installation; the adapter pins it rather than discovering it from caller input.

## Selected adapter contract

- Serves the protected-resource and authorization-server metadata, an authorization endpoint, and a token endpoint. It authorizes exactly one immutable owner subject, uses authorization-code + S256 PKCE, binds the audience to its own `/mcp` resource, and issues short-lived tokens.
- On `/mcp`, validates the ChatGPT bearer, then forwards the request to the fixed Devvit installation URL with `Authorization: Bearer devvit_at_...`. Preserve `Accept`, `Content-Type`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, and `Mcp-Param-*`; replace only the credential.
- Performs no tool handling, prompt logic, Reddit calls, content storage, queueing, or write retries. Devvit owns the tools and Redis state.
- Keeps the managed token only in the adapter's secret store. Never place it in ChatGPT configuration, a URL, a tool result, or logs. Rotate by creating a new Devvit token, updating the adapter, and revoking the old token.
- Enforces the single-owner policy itself, because Devvit executes all managed-token requests as the app account and cannot tell which ChatGPT user called.

## Unverified; verify before claiming

- **External gateway method routing.** Devvit documents POST examples and no streaming, but does not state what its external gateway does with GET, DELETE, or unknown methods. Test `GET /external/mcp` and confirm 405 rather than assuming the handler sees it.
- **Payload limit conflict.** The external-endpoints page says request bodies up to 10 MB; the general Devvit Web page says 4 MB max payload. Keep tool payloads far below either and verify which limit applies to `/external`.
- **JSON-only tolerance in ChatGPT.** MCP requires clients to support single JSON responses, and the current revision makes JSON first-class; ChatGPT's page only says "SSE and streaming HTTP." Test with MCP Inspector and the real connector. Do not claim SSE support.
- **Ordinary Tasks invoking this exact custom MCP plugin.** The Tasks page says apps may be used but does not guarantee arbitrary custom MCP. Test the exact account, workspace, and task type.
- **Work/Codex scheduled task running this exact plugin.** Plugins are documented as usable, but account, workspace, and task-type behavior still need a live check.
- **Tool-level OAuth linking UI.** ChatGPT documents that `securitySchemes` plus `_meta["mcp/www_authenticate"]` are required; verify the MCP SDK/Devvit tool registration emits both and that the connector shows the linking UI.
- **30-second timeout and 5 rps under load.** The 30-second limit is documented for Devvit Web server endpoints; the external-endpoints page does not restate it. The 5 rps figure is documented, but burst behavior is not. Keep calls short and return a clear error rather than holding a request open or creating durable work.

## Sources

All checked **2026-10-24**.

- Devvit, External Endpoints (0.15): https://developers.reddit.com/docs/capabilities/server/external-endpoints
- Devvit, Devvit Web overview and limitations (0.15): https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_overview
- Devvit, Redis (0.15): https://developers.reddit.com/docs/capabilities/server/redis
- Devvit, Reddit API overview (0.15): https://developers.reddit.com/docs/capabilities/server/reddit-api
- OpenAI, Add custom MCP server: https://developers.openai.com/api/docs/guides/custom-mcp-server
- OpenAI, Authentication (plugins/MCP): https://developers.openai.com/plugins/build/auth
- OpenAI, Build an MCP server: https://developers.openai.com/plugins/build/mcp-server
- OpenAI, Connect and test your plugin: https://developers.openai.com/plugins/deploy/connect-chatgpt
- OpenAI, Upload and submit your plugin (authentication limitations): https://developers.openai.com/plugins/deploy/submission
- OpenAI, Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- OpenAI, Scheduled tasks (Work/Codex): https://developers.openai.com/codex/automations
- OpenAI Help, Scheduled Tasks in ChatGPT: https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt
- OpenAI Help, Connecting custom MCP servers in ChatGPT: https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- OpenAI Help, Memory in ChatGPT: https://help.openai.com/en/articles/8590148-memory-in-chatgpt
- OpenAI, Conversation state: https://developers.openai.com/api/docs/guides/conversation-state
- OpenAI, API reference (no ChatGPT-memory endpoint found): https://developers.openai.com/api/reference/overview
- Model Context Protocol, Streamable HTTP, revision 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- Model Context Protocol, Transports, revision 2025-11-25 (compatibility): https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

Recheck these pages if the ChatGPT connection flow, Devvit external endpoints, or MCP revision changes. Interactive tool calls working does not imply that a Task or Work schedule can start an existing Glyph chat.
