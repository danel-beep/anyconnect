-- Telegram is split into two services: `telegram` is now the personal account (gateway session)
-- and `telegram_bot` the Bot API bot. Bot accounts (mode bot, or no mode: bot was the default)
-- move to `telegram_bot`; the `mode` key is dropped from both.

-- Rules for the whole Telegram service applied to bots too: copy them for the new service.
INSERT INTO "access_rules" ("id", "workspace_id", "ai_client_id", "persona_id", "connector_id", "account_id", "access", "confirm", "undo_window_seconds", "note", "created_at", "updated_at")
SELECT 'rul_' || substr(md5(random()::text || r."id"), 1, 26), r."workspace_id", r."ai_client_id", r."persona_id", 'telegram_bot', NULL, r."access", r."confirm", r."undo_window_seconds", r."note", r."created_at", now()
FROM "access_rules" r
WHERE r."connector_id" = 'telegram' AND r."account_id" IS NULL;--> statement-breakpoint

CREATE TEMP TABLE "telegram_bot_accounts" AS
SELECT "id" FROM "accounts"
WHERE "connector_id" = 'telegram' AND coalesce("config"->>'mode', 'bot') <> 'user';--> statement-breakpoint

UPDATE "accounts" SET "connector_id" = 'telegram_bot', "config" = "config" - 'mode', "updated_at" = now()
WHERE "id" IN (SELECT "id" FROM "telegram_bot_accounts");--> statement-breakpoint

UPDATE "accounts" SET "config" = "config" - 'mode' - 'botApiUrl', "updated_at" = now()
WHERE "connector_id" = 'telegram' AND "config" ? 'mode';--> statement-breakpoint

UPDATE "access_rules" SET "connector_id" = 'telegram_bot', "updated_at" = now()
WHERE "account_id" IN (SELECT "id" FROM "telegram_bot_accounts");--> statement-breakpoint

UPDATE "pending_calls" SET "connector_id" = 'telegram_bot', "tool_name" = 'telegram_bot_' || substr("tool_name", 10), "updated_at" = now()
WHERE "account_id" IN (SELECT "id" FROM "telegram_bot_accounts") AND "tool_name" LIKE 'telegram\_%';--> statement-breakpoint

UPDATE "tool_calls" SET "connector_id" = 'telegram_bot'
WHERE "account_id" IN (SELECT "id" FROM "telegram_bot_accounts");--> statement-breakpoint

DROP TABLE "telegram_bot_accounts";
