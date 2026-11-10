CREATE TABLE "cosmetic_unlocks" (
	"account_id" uuid NOT NULL,
	"cosmetic_id" text NOT NULL,
	"source" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cosmetic_unlocks_account_id_cosmetic_id_pk" PRIMARY KEY("account_id","cosmetic_id")
);
--> statement-breakpoint
CREATE TABLE "event_participants" (
	"event" integer NOT NULL,
	"character_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"progress" integer[] NOT NULL,
	"bounty_kills" integer DEFAULT 0 NOT NULL,
	"bonus" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tallies" integer DEFAULT 0 NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "event_participants_event_character_id_pk" PRIMARY KEY("event","character_id")
);
--> statement-breakpoint
CREATE TABLE "event_track_grants" (
	"event" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"tier" integer NOT NULL,
	"cosmetic_id" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "event_track_grants_event_account_id_tier_pk" PRIMARY KEY("event","account_id","tier")
);
--> statement-breakpoint
CREATE TABLE "event_tracks" (
	"event" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"tallies" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "event_tracks_event_account_id_pk" PRIMARY KEY("event","account_id"),
	CONSTRAINT "event_tracks_tallies_check" CHECK ("event_tracks"."tallies" >= 0)
);
--> statement-breakpoint
CREATE TABLE "world_events" (
	"number" integer PRIMARY KEY NOT NULL,
	"definition_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"rewards_swept_at" timestamp with time zone,
	CONSTRAINT "world_events_window_check" CHECK ("world_events"."ends_at" > "world_events"."starts_at"),
	CONSTRAINT "world_events_number_check" CHECK ("world_events"."number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "prestige_displays" ADD COLUMN "cosmetic_title" text;--> statement-breakpoint
ALTER TABLE "cosmetic_unlocks" ADD CONSTRAINT "cosmetic_unlocks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_event_world_events_number_fk" FOREIGN KEY ("event") REFERENCES "public"."world_events"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_track_grants" ADD CONSTRAINT "event_track_grants_event_world_events_number_fk" FOREIGN KEY ("event") REFERENCES "public"."world_events"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_track_grants" ADD CONSTRAINT "event_track_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tracks" ADD CONSTRAINT "event_tracks_event_world_events_number_fk" FOREIGN KEY ("event") REFERENCES "public"."world_events"("number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tracks" ADD CONSTRAINT "event_tracks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_participants_character_idx" ON "event_participants" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "event_participants_account_idx" ON "event_participants" USING btree ("event","account_id");--> statement-breakpoint
CREATE INDEX "world_events_window_idx" ON "world_events" USING btree ("starts_at","ends_at");--> statement-breakpoint
ALTER TABLE "prestige_displays" ADD CONSTRAINT "prestige_displays_cosmetic_title_fk" FOREIGN KEY ("account_id","cosmetic_title") REFERENCES "public"."cosmetic_unlocks"("account_id","cosmetic_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prestige_displays" ADD CONSTRAINT "prestige_displays_one_title_check" CHECK ("prestige_displays"."cosmetic_title" is null or "prestige_displays"."title_season" is null);