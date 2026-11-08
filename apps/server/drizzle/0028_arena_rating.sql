CREATE TABLE "arena_ratings" (
	"season" integer NOT NULL,
	"character_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"class_id" text NOT NULL,
	"level" integer NOT NULL,
	"bracket_id" text NOT NULL,
	"rating_version" integer NOT NULL,
	"rating" double precision NOT NULL,
	"deviation" double precision NOT NULL,
	"volatility" double precision NOT NULL,
	"games" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"draws" integer DEFAULT 0 NOT NULL,
	"last_rated_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "arena_ratings_season_character_id_pk" PRIMARY KEY("season","character_id"),
	CONSTRAINT "arena_ratings_counts_check" CHECK ("arena_ratings"."games" >= 0 and "arena_ratings"."wins" + "arena_ratings"."losses" + "arena_ratings"."draws" = "arena_ratings"."games")
);
--> statement-breakpoint
ALTER TABLE "season_awards" DROP CONSTRAINT "season_awards_metric_check";--> statement-breakpoint
ALTER TABLE "season_standings" DROP CONSTRAINT "season_standings_metric_check";--> statement-breakpoint
ALTER TABLE "duel_defences" ADD COLUMN "power" integer;--> statement-breakpoint
ALTER TABLE "duel_defences" ADD COLUMN "power_version" integer;--> statement-breakpoint
ALTER TABLE "duels" ADD COLUMN "rating" jsonb;--> statement-breakpoint
ALTER TABLE "arena_ratings" ADD CONSTRAINT "arena_ratings_season_seasons_number_fk" FOREIGN KEY ("season") REFERENCES "public"."seasons"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arena_ratings" ADD CONSTRAINT "arena_ratings_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arena_ratings" ADD CONSTRAINT "arena_ratings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "arena_ratings_ladder_idx" ON "arena_ratings" USING btree ("season","rating" DESC NULLS LAST,"games","character_id");--> statement-breakpoint
CREATE INDEX "arena_ratings_character_id_idx" ON "arena_ratings" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "arena_ratings_account_id_idx" ON "arena_ratings" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "duels_pair_idx" ON "duels" USING btree ("challenger_account_id","defender_account_id","fought_at");--> statement-breakpoint
ALTER TABLE "season_awards" ADD CONSTRAINT "season_awards_metric_check" CHECK ("season_awards"."metric" in ('level', 'gearScore', 'power', 'pveProgress', 'arena'));--> statement-breakpoint
ALTER TABLE "season_standings" ADD CONSTRAINT "season_standings_metric_check" CHECK ("season_standings"."metric" in ('level', 'gearScore', 'power', 'pveProgress', 'arena'));