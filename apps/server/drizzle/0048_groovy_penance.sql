CREATE TABLE "character_loadouts" (
	"character_id" uuid NOT NULL,
	"preset" smallint NOT NULL,
	"actives" jsonb NOT NULL,
	"passive" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_loadouts_character_id_preset_pk" PRIMARY KEY("character_id","preset"),
	CONSTRAINT "character_loadouts_preset_check" CHECK ("character_loadouts"."preset" between 1 and 3)
);
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "soul_fragments" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "loadout_preset" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "character_loadouts" ADD CONSTRAINT "character_loadouts_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_soul_fragments_check" CHECK ("activities"."soul_fragments" >= 0);--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_loadout_preset_check" CHECK ("characters"."loadout_preset" between 1 and 3);