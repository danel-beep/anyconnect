-- Personal tokens issued before MCP-only became the default (PR #56, live 2026-11-05 02:21 UTC)
-- got the management API (scope "api") without anyone asking for it. They keep MCP; a token for
-- the REST API is issued again with the "api" scope ticked.
UPDATE "api_tokens" SET "scopes" = array_remove("scopes", 'api') WHERE 'api' = ANY("scopes") AND "created_at" < '2026-11-05T02:21:00Z';
