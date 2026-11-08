CREATE TABLE "game_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "game_settings_version_check" CHECK ("game_settings"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "game_settings" ADD CONSTRAINT "game_settings_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;