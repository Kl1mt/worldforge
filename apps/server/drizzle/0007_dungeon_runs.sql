CREATE TABLE "dungeon_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"character_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"dungeon_id" text NOT NULL,
	"seed_secret" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"boss_loot_eligible" boolean NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"outcome" text,
	"boss_loot_granted" boolean DEFAULT false NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dungeon_runs_ends_at_check" CHECK ("dungeon_runs"."ends_at" >= "dungeon_runs"."started_at")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"account_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" smallint NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_account_id_key_pk" PRIMARY KEY("account_id","key")
);
--> statement-breakpoint
ALTER TABLE "dungeon_runs" ADD CONSTRAINT "dungeon_runs_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dungeon_runs" ADD CONSTRAINT "dungeon_runs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dungeon_runs_account_open_key" ON "dungeon_runs" USING btree ("account_id") WHERE "dungeon_runs"."claimed_at" is null;--> statement-breakpoint
CREATE INDEX "dungeon_runs_character_id_started_at_idx" ON "dungeon_runs" USING btree ("character_id","started_at");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys" USING btree ("created_at");