# Manyplug — notes for coding agents

Cloud MCP hub: AI clients (Claude, ChatGPT, Claude Code) connect once over OAuth and get tools for
every connected service *account* (several accounts per service). TypeScript, Node 22+, Hono,
Postgres + Drizzle, MCP SDK v2 (`@modelcontextprotocol/server`). The owner speaks Russian,
but the product targets an international, English-speaking audience: the website, dashboard and
admin default to English and Russian is a second locale picked with the language switch (RU/EN in
`src/web/i18n.ts`). Examples and visuals use international services and names. Repo docs
(README, `docs/`) stay in Russian for the owner; code and
comments are English.

## Principles

The owner's standing rule for the whole project: build every change so the project stays easy to
develop further. In practice:

- Extend through the existing seams (connectors via the SDK, `ConnectorResolver`, `HubTokenVerifier`,
  `BillingProvider` for payment providers and `Mailer` for the hub's own email (see `docs/BILLING.md`),
  `RateLimiter`, `buildCatalog` modes, `ErrorSink` / `HealthCheck` in `src/ops/`) instead of special
  cases in the hub or routes.
- Keep layers separate (`routes → mcp/oauth → hub → core → connectors`, see `docs/ARCHITECTURE.md`).
- Schema changes go through migrations; new behavior comes with tests; docs stay current (Russian).
- No quick hacks that will need rework later; if a shortcut is truly needed, say so in the PR.

## Commands

- `npm run dev` — run with reload (needs Postgres; `docker compose up -d db`)
- `npm run check` — lint (Biome) + typecheck (TypeScript 7) + tests (Vitest); run before every PR
- `npm run check:fast` — lint + typecheck + only the tests affected by changes since `origin/main`;
  use it while iterating, then the full `check`
- `npm test` — integration tests need Postgres at `TEST_DATABASE_URL`
  (default `postgres://postgres@localhost:5432/manyplug_test`); files run in parallel, each Vitest
  worker on its own database (`manyplug_test_w1`, `_w2`…, created automatically, see `test/setup/`)
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
- Every connector ships a setup guide (`ui.locales.{en,ru}.setup`) written to the standard in
  `docs/CONNECTORS.md` ("Стандарт инструкции"): time, what you need, one action per step with exact
  button names in `**bold**`, `fills` for each form field, common problems. `test/connectors/setup-guides.test.ts`
  enforces it; have someone without context read the guide before merging.
- Messengers (`docs/MESSENGERS.md`): connectors declare `messenger` and use `messengerActions`;
  storage, search, outbox and pacing live in `src/messaging/`; long-lived sessions run in the
  gateway process (`src/gateway/`, `node dist/gateway/index.js`) behind `SessionDriver`. Message
  content is always encrypted; external ids are stored only as keyed hashes.
- `src/hub/catalog.ts` decides what the AI sees; keep it a pure function and covered by tests.
- `src/hub/hub.ts` resolves calls; every connector call runs through the stage chain in
  `src/hub/executor.ts` (audit → meter → quota → policy → risk → confirm → limits → circuit →
  idempotency → untrusted → shape → invoke). New cross-cutting rules are new stages, not code in `hub.ts`.
  Connectors throw `ConnectorError` for user-safe errors.
- Unexpected errors go through `services.ops.errors.capture()` (scrubbed, grouped, shown in the admin
  panel, optionally Sentry), never a bare `logger.error`; see `docs/OPERATIONS.md`.
- Analytics (`docs/ANALYTICS.md`): count product events with `services.analytics.track(name, key)`;
  page views are counted by middleware. Cookieless: never store IPs or user agents, only the daily
  visitor hash and aggregates; reports go in `AnalyticsReports` (`src/analytics/reports.ts`).
- `src/oauth/server.ts` is framework-free; HTTP lives in `src/routes/`.
- Secrets only via env vars. Credentials are encrypted with `SecretBox` (AAD = account id).
  Tokens are stored as SHA-256 hashes. Never log arguments, tokens or credentials.
- Imports use `.js` extensions (NodeNext). Validate external input with zod.
- The product name lives in `src/brand.ts` (`BRAND.name` / `BRAND.slug`); use it in new strings and
  identifiers. The product was called AnyConnect until Nov 2026: crypto key-derivation labels, the
  migration lock and Render resource names keep that name on purpose (`LEGACY_SLUGS`).
- Tests: `test/helpers.ts` starts a real hub on a random port; `TestBrowser` walks login/consent.
  End-to-end connection tests live in `test/e2e/` (fake internet for service hosts, AI client
  profiles in `ai-clients.ts`); a new AI client is one entry in `AI_CLIENTS`. See `docs/TESTING.md`.
