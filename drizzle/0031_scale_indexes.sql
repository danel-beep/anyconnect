CREATE INDEX "tool_calls_workspace_time_idx" ON "tool_calls" USING btree ("workspace_id","created_at","tool_name","connector_id","status");--> statement-breakpoint
DROP INDEX "tool_calls_workspace_id_created_at_index";--> statement-breakpoint
CREATE INDEX "messenger_chats_account_recent_idx" ON "messenger_chats" USING btree ("account_id","last_message_at" DESC NULLS LAST,"id");--> statement-breakpoint
DROP INDEX "messenger_chats_account_id_last_message_at_index";--> statement-breakpoint
CREATE INDEX "messenger_outbox_chat_id_index" ON "messenger_outbox" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "pending_calls_account_id_index" ON "pending_calls" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "trigger_cursors_account_id_index" ON "trigger_cursors" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "trigger_events_account_id_index" ON "trigger_events" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "trigger_events_skipped_idx" ON "trigger_events" USING btree ("created_at") WHERE "trigger_events"."status" = 'skipped';--> statement-breakpoint
-- Written by hand (drizzle has no storage parameters): the activity counts read only the index
-- (tool_calls_workspace_time_idx), which needs the table's visibility map to be current. The default
-- vacuums an insert-only table after its rows grow by 20%; at millions of rows that leaves days of
-- recent rows that each still cost a read of the table.
ALTER TABLE "tool_calls" SET (autovacuum_vacuum_insert_scale_factor = 0.02);
