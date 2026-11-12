CREATE TABLE "account_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "loot_filter_presets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "account_notifications" ADD CONSTRAINT "account_notifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_notifications_account_id_idx" ON "account_notifications" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "account_notifications_created_at_idx" ON "account_notifications" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_notifications_dedupe_idx" ON "account_notifications" USING btree ("account_id","dedupe_key");