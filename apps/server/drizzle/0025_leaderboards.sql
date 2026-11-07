CREATE TABLE "leaderboard_entries" (
	"character_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"account_id" uuid NOT NULL,
	"class_id" text NOT NULL,
	"level" integer NOT NULL,
	"formula_version" integer NOT NULL,
	"value" bigint NOT NULL,
	"sort_key" bigint[] NOT NULL,
	"inputs_hash" text NOT NULL,
	"input" jsonb NOT NULL,
	"achieved_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "leaderboard_entries_character_id_metric_pk" PRIMARY KEY("character_id","metric"),
	CONSTRAINT "leaderboard_entries_metric_check" CHECK ("leaderboard_entries"."metric" in ('level', 'gearScore', 'power', 'pveProgress'))
);
--> statement-breakpoint
ALTER TABLE "leaderboard_entries" ADD CONSTRAINT "leaderboard_entries_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_entries" ADD CONSTRAINT "leaderboard_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leaderboard_entries_rank_idx" ON "leaderboard_entries" USING btree ("metric","sort_key" desc,"achieved_at","character_id");--> statement-breakpoint
CREATE INDEX "leaderboard_entries_account_id_idx" ON "leaderboard_entries" USING btree ("account_id");