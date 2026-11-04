# AnyConnect — notes for coding agents

Cloud MCP hub: AI clients (Claude, ChatGPT, Claude Code) connect once over OAuth and get tools for
every connected service *account* (several accounts per service). TypeScript, Node 22+, Hono,
Postgres + Drizzle, MCP SDK v2 (`@modelcontextprotocol/server`). The owner speaks Russian:
user-facing docs and UI text are Russian-first (UI has RU/EN in `src/web/i18n.ts`); code and
comments are English.

## Principles

The owner's standing rule for the whole project: build every change so the project stays easy to
develop further. In practice:

- Extend through the existing seams (connectors via the SDK, `ConnectorResolver`, `HubTokenVerifier`,
  `RateLimiter`, `buildCatalog` modes) instead of special cases in the hub or routes.
- Keep layers separate (`routes → mcp/oauth → hub → core → connectors`, see `docs/ARCHITECTURE.md`).
- Schema changes go through migrations; new behavior comes with tests; docs stay current (Russian).
- No quick hacks that will need rework later; if a shortcut is truly needed, say so in the PR.

## Commands

- `npm run dev` — run with reload (needs Postgres; `docker compose up -d db`)
- `npm run check` — lint (Biome) + typecheck (TypeScript 7) + tests (Vitest)
- `npm test` — integration tests need Postgres at `TEST_DATABASE_URL`
  (default `postgres://postgres@localhost:5432/anyconnect_test`); files run sequentially
- `npm run db:generate` — create a migration after editing `src/db/schema.ts`; commit `drizzle/`
- `npm run cli -- help` — admin CLI

## Layout and rules

- `src/connectors/sdk.ts` is the connector API and must not import app code (nor may anything else
  under `src/connectors/`). Connectors do all I/O through `ctx.fetch` / `ctx.network` (hub network
  policy, test fixtures); REST services are best written as HTTP manifests. See `docs/CONNECTORS.md`.
  New service = `defineConnector({...})` in `src/connectors/builtin/`, registered in
  `src/connectors/index.ts`. Never add inputs named `account` or `fields` (reserved by the hub).
  Give write actions an explicit `risk`; shared interfaces live in `src/connectors/capabilities.ts`
  (see `docs/CONNECTORS.md`).
- `src/hub/catalog.ts` decides what the AI sees; keep it a pure function and covered by tests.
- `src/hub/hub.ts` resolves calls; every connector call runs through the stage chain in
  `src/hub/executor.ts` (audit → policy → risk → confirm → limits → idempotency → untrusted →
  shape → invoke). New cross-cutting rules are new stages, not code in `hub.ts`.
  Connectors throw `ConnectorError` for user-safe errors.
- `src/oauth/server.ts` is framework-free; HTTP lives in `src/routes/`.
- Secrets only via env vars. Credentials are encrypted with `SecretBox` (AAD = account id).
  Tokens are stored as SHA-256 hashes. Never log arguments, tokens or credentials.
- Imports use `.js` extensions (NodeNext). Validate external input with zod.
- Tests: `test/helpers.ts` starts a real hub on a random port; `TestBrowser` walks login/consent.
