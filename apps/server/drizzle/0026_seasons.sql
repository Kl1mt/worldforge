CREATE TABLE "prestige_displays" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"title_season" integer,
	"title_metric" text,
	"frame_season" integer,
	"frame_metric" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "prestige_displays_title_check" CHECK (("prestige_displays"."title_season" is null) = ("prestige_displays"."title_metric" is null)),
	CONSTRAINT "prestige_displays_frame_check" CHECK (("prestige_displays"."frame_season" is null) = ("prestige_displays"."frame_metric" is null))
);
--> statement-breakpoint
CREATE TABLE "season_awards" (
	"season" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"tier" text NOT NULL,
	"rank" integer NOT NULL,
	"character_id" uuid,
	"awarded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "season_awards_season_account_id_metric_pk" PRIMARY KEY("season","account_id","metric"),
	CONSTRAINT "season_awards_metric_check" CHECK ("season_awards"."metric" in ('level', 'gearScore', 'power', 'pveProgress')),
	CONSTRAINT "season_awards_tier_check" CHECK ("season_awards"."tier" in ('champion', 'exalted', 'renowned', 'veteran'))
);
--> statement-breakpoint
CREATE TABLE "season_entries" (
	"season" integer NOT NULL,
	"character_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"account_id" uuid NOT NULL,
	"class_id" text NOT NULL,
	"level" integer NOT NULL,
	"formula_version" integer NOT NULL,
	"value" bigint NOT NULL,
	"sort_key" bigint[] NOT NULL,
	"base_sort_key" bigint[],
	"achieved_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "season_entries_season_character_id_metric_pk" PRIMARY KEY("season","character_id","metric"),
	CONSTRAINT "season_entries_metric_check" CHECK ("season_entries"."metric" in ('level', 'gearScore', 'power', 'pveProgress'))
);
--> statement-breakpoint
CREATE TABLE "season_standings" (
	"season" integer NOT NULL,
	"metric" text NOT NULL,
	"rank" integer NOT NULL,
	"character_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"class_id" text NOT NULL,
	"level" integer NOT NULL,
	"formula_version" integer NOT NULL,
	"value" bigint NOT NULL,
	"sort_key" bigint[] NOT NULL,
	"achieved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "season_standings_season_metric_character_id_pk" PRIMARY KEY("season","metric","character_id"),
	CONSTRAINT "season_standings_metric_check" CHECK ("season_standings"."metric" in ('level', 'gearScore', 'power', 'pveProgress'))
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"number" integer PRIMARY KEY NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"awarded_at" timestamp with time zone,
	CONSTRAINT "seasons_window_check" CHECK ("seasons"."ends_at" > "seasons"."starts_at"),
	CONSTRAINT "seasons_number_check" CHECK ("seasons"."number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "prestige_displays" ADD CONSTRAINT "prestige_displays_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prestige_displays" ADD CONSTRAINT "prestige_displays_title_fk" FOREIGN KEY ("title_season","account_id","title_metric") REFERENCES "public"."season_awards"("season","account_id","metric") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prestige_displays" ADD CONSTRAINT "prestige_displays_frame_fk" FOREIGN KEY ("frame_season","account_id","frame_metric") REFERENCES "public"."season_awards"("season","account_id","metric") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_awards" ADD CONSTRAINT "season_awards_season_seasons_number_fk" FOREIGN KEY ("season") REFERENCES "public"."seasons"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_awards" ADD CONSTRAINT "season_awards_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_awards" ADD CONSTRAINT "season_awards_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_entries" ADD CONSTRAINT "season_entries_season_seasons_number_fk" FOREIGN KEY ("season") REFERENCES "public"."seasons"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_entries" ADD CONSTRAINT "season_entries_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_entries" ADD CONSTRAINT "season_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_standings" ADD CONSTRAINT "season_standings_season_seasons_number_fk" FOREIGN KEY ("season") REFERENCES "public"."seasons"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_standings" ADD CONSTRAINT "season_standings_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_standings" ADD CONSTRAINT "season_standings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "season_awards_account_id_idx" ON "season_awards" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "season_entries_rank_idx" ON "season_entries" USING btree ("season","metric","sort_key" desc,"achieved_at","character_id");--> statement-breakpoint
CREATE INDEX "season_entries_character_id_idx" ON "season_entries" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "season_entries_account_id_idx" ON "season_entries" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "season_standings_rank_idx" ON "season_standings" USING btree ("season","metric","rank");--> statement-breakpoint
CREATE INDEX "season_standings_account_id_idx" ON "season_standings" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "season_standings_character_id_idx" ON "season_standings" USING btree ("character_id");