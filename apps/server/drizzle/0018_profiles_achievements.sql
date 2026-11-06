CREATE TABLE "account_achievements" (
	"account_id" uuid NOT NULL,
	"achievement_id" text NOT NULL,
	"character_id" uuid,
	"source" text NOT NULL,
	"awarded_at" timestamp with time zone NOT NULL,
	"shown_slot" smallint,
	CONSTRAINT "account_achievements_account_id_achievement_id_pk" PRIMARY KEY("account_id","achievement_id"),
	CONSTRAINT "account_achievements_source_check" CHECK ("account_achievements"."source" in ('live', 'backfill')),
	CONSTRAINT "account_achievements_shown_slot_check" CHECK ("account_achievements"."shown_slot" between 0 and 15)
);
--> statement-breakpoint
CREATE TABLE "data_backfills" (
	"id" text PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "profile_visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "showcase_character_id" uuid;--> statement-breakpoint
ALTER TABLE "account_achievements" ADD CONSTRAINT "account_achievements_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_achievements" ADD CONSTRAINT "account_achievements_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_achievements_shown_slot_key" ON "account_achievements" USING btree ("account_id","shown_slot") WHERE "account_achievements"."shown_slot" is not null;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_showcase_character_id_characters_id_fk" FOREIGN KEY ("showcase_character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_profile_visibility_check" CHECK ("accounts"."profile_visibility" in ('public', 'friendsAndGuild', 'hidden'));