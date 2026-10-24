# Deployment status — 2026-10-24

- Worker origin: `https://glyphwanders.dolfsgarden.workers.dev`
- Future ChatGPT MCP URL: `https://glyphwanders.dolfsgarden.workers.dev/mcp`
- `PUBLIC_URL` is configured as a Worker Secret.
- Missing: `OAUTH_ISSUER`, `OAUTH_SUBJECT`, `DEVVIT_MCP_URL`, `DEVVIT_TOKEN`.
- Public automated HTTP checks verified `/health`, `/mcp` and protected-resource metadata return 503 with safe JSON and `Cache-Control: no-store`; unknown routes return 404. Health reports `ready:false`, `configured:false`, and only the four missing field names.
- No live OAuth login, Reddit call, ChatGPT link or scheduled execution has been verified. This is deliberately **not ready** until real configuration is supplied.
- Bootstrap code version: `a1e56ea9-d6ab-4444-b913-4230100ef93f`; subsequent `PUBLIC_URL` binding deployment: `24ef1b06-83c5-4dc8-ba57-409dddbca64e`.

This is a dated operational record, not a continuously updated health monitor. See [`readme.md`](../readme.md#deploy-and-configure-with-wrangler) for private Wrangler/dashboard configuration and verification instructions. Never paste credentials into GitHub issues or chat.
