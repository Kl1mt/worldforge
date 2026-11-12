CREATE TABLE "guild_hall_displays" (
	"guild_id" uuid PRIMARY KEY NOT NULL,
	"hall_banner" text,
	"crest_frame" text,
	"backdrop" text,
	"title_colour" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_hall_upgrades" (
	"guild_id" uuid NOT NULL,
	"upgrade_id" text NOT NULL,
	"bought_by" uuid,
	"gold" bigint NOT NULL,
	"materials" jsonb NOT NULL,
	"bought_at" timestamp with time zone NOT NULL,
	CONSTRAINT "guild_hall_upgrades_guild_id_upgrade_id_pk" PRIMARY KEY("guild_id","upgrade_id")
);
--> statement-breakpoint
CREATE TABLE "guild_season_awards" (
	"season" integer NOT NULL,
	"guild_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"rank" integer NOT NULL,
	"awarded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "guild_season_awards_season_guild_id_pk" PRIMARY KEY("season","guild_id"),
	CONSTRAINT "guild_season_awards_tier_check" CHECK ("guild_season_awards"."tier" in ('champion', 'exalted', 'renowned'))
);
--> statement-breakpoint
CREATE TABLE "guild_season_entries" (
	"season" integer NOT NULL,
	"guild_id" uuid NOT NULL,
	"formula_version" integer NOT NULL,
	"value" bigint NOT NULL,
	"sort_key" bigint[] NOT NULL,
	"inputs_hash" text NOT NULL,
	"input" jsonb NOT NULL,
	"members" integer NOT NULL,
	"achieved_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "guild_season_entries_season_guild_id_pk" PRIMARY KEY("season","guild_id")
);
--> statement-breakpoint
CREATE TABLE "guild_season_rosters" (
	"season" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"guild_id" uuid NOT NULL,
	CONSTRAINT "guild_season_rosters_season_account_id_pk" PRIMARY KEY("season","account_id")
);
--> statement-breakpoint
CREATE TABLE "guild_season_standings" (
	"season" integer NOT NULL,
	"guild_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"name" text NOT NULL,
	"tag" text NOT NULL,
	"emblem" text NOT NULL,
	"formula_version" integer NOT NULL,
	"value" bigint NOT NULL,
	"sort_key" bigint[] NOT NULL,
	"inputs_hash" text NOT NULL,
	"input" jsonb NOT NULL,
	"members" integer NOT NULL,
	"achieved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "guild_season_standings_season_guild_id_pk" PRIMARY KEY("season","guild_id")
);
--> statement-breakpoint
CREATE TABLE "guild_treasuries" (
	"guild_id" uuid PRIMARY KEY NOT NULL,
	"gold" bigint DEFAULT 0 NOT NULL,
	"materials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "guild_treasuries_gold_check" CHECK ("guild_treasuries"."gold" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guild_treasury_gifts" (
	"guild_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"resource" text NOT NULL,
	"amount" bigint NOT NULL,
	CONSTRAINT "guild_treasury_gifts_guild_id_account_id_day_resource_pk" PRIMARY KEY("guild_id","account_id","day","resource"),
	CONSTRAINT "guild_treasury_gifts_amount_check" CHECK ("guild_treasury_gifts"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "seasons" ADD COLUMN "guild_archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "seasons" ADD COLUMN "guild_awarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guild_hall_displays" ADD CONSTRAINT "guild_hall_displays_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_hall_displays" ADD CONSTRAINT "guild_hall_displays_banner_fk" FOREIGN KEY ("guild_id","hall_banner") REFERENCES "public"."guild_hall_upgrades"("guild_id","upgrade_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_hall_displays" ADD CONSTRAINT "guild_hall_displays_crest_fk" FOREIGN KEY ("guild_id","crest_frame") REFERENCES "public"."guild_hall_upgrades"("guild_id","upgrade_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_hall_displays" ADD CONSTRAINT "guild_hall_displays_backdrop_fk" FOREIGN KEY ("guild_id","backdrop") REFERENCES "public"."guild_hall_upgrades"("guild_id","upgrade_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_hall_displays" ADD CONSTRAINT "guild_hall_displays_colour_fk" FOREIGN KEY ("guild_id","title_colour") REFERENCES "public"."guild_hall_upgrades"("guild_id","upgrade_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_hall_upgrades" ADD CONSTRAINT "guild_hall_upgrades_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_hall_upgrades" ADD CONSTRAINT "guild_hall_upgrades_bought_by_accounts_id_fk" FOREIGN KEY ("bought_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_season_awards" ADD CONSTRAINT "guild_season_awards_season_seasons_number_fk" FOREIGN KEY ("season") REFERENCES "public"."seasons"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_season_awards" ADD CONSTRAINT "guild_season_awards_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_season_entries" ADD CONSTRAINT "guild_season_entries_season_seasons_number_fk" FOREIGN KEY ("season") REFERENCES "public"."seasons"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_season_entries" ADD CONSTRAINT "guild_season_entries_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_season_rosters" ADD CONSTRAINT "guild_season_rosters_season_seasons_number_fk" FOREIGN KEY ("season") REFERENCES "public"."seasons"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_season_rosters" ADD CONSTRAINT "guild_season_rosters_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_season_rosters" ADD CONSTRAINT "guild_season_rosters_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_season_standings" ADD CONSTRAINT "guild_season_standings_season_seasons_number_fk" FOREIGN KEY ("season") REFERENCES "public"."seasons"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_season_standings" ADD CONSTRAINT "guild_season_standings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_treasuries" ADD CONSTRAINT "guild_treasuries_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_treasury_gifts" ADD CONSTRAINT "guild_treasury_gifts_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_treasury_gifts" ADD CONSTRAINT "guild_treasury_gifts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guild_season_awards_guild_id_idx" ON "guild_season_awards" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "guild_season_entries_rank_idx" ON "guild_season_entries" USING btree ("season","sort_key" desc,"achieved_at","guild_id");--> statement-breakpoint
CREATE INDEX "guild_season_entries_guild_id_idx" ON "guild_season_entries" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "guild_season_rosters_guild_idx" ON "guild_season_rosters" USING btree ("season","guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guild_season_standings_rank_idx" ON "guild_season_standings" USING btree ("season","rank");--> statement-breakpoint
CREATE INDEX "guild_season_standings_guild_id_idx" ON "guild_season_standings" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "guild_treasury_gifts_account_id_idx" ON "guild_treasury_gifts" USING btree ("account_id");