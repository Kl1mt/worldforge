CREATE TABLE "cache_versions" (
	"name" text PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_failure_at" bigint NOT NULL,
	"locked_until" bigint DEFAULT 0 NOT NULL,
	"in_flight" integer DEFAULT 0 NOT NULL,
	"in_flight_until" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"starts" bigint[] NOT NULL,
	"hits" integer[] NOT NULL,
	"expires_at" bigint NOT NULL,
	"refused" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reserved_names" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"skeleton" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "display_name_skeleton" text;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "name_skeleton" text;--> statement-breakpoint
ALTER TABLE "guilds" ADD COLUMN "name_skeleton" text;--> statement-breakpoint
ALTER TABLE "reserved_names" ADD CONSTRAINT "reserved_names_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reserved_names_skeleton_key" ON "reserved_names" USING btree ("skeleton");--> statement-breakpoint
CREATE INDEX "accounts_display_name_skeleton_idx" ON "accounts" USING btree ("display_name_skeleton");--> statement-breakpoint
CREATE INDEX "characters_name_skeleton_idx" ON "characters" USING btree ("name_skeleton");--> statement-breakpoint
CREATE INDEX "guilds_name_skeleton_idx" ON "guilds" USING btree ("name_skeleton");