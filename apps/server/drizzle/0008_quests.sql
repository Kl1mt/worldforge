CREATE TABLE "character_quests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"character_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quest_id" text NOT NULL,
	"contract_day" text,
	"contract_slot" smallint,
	"objectives" jsonb NOT NULL,
	"progress" jsonb NOT NULL,
	"reward" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"turned_in_at" timestamp with time zone,
	CONSTRAINT "character_quests_kind_check" CHECK ("character_quests"."kind" in ('story', 'contract')),
	CONSTRAINT "character_quests_status_check" CHECK ("character_quests"."status" in ('active', 'turnedIn')),
	CONSTRAINT "character_quests_turned_in_check" CHECK (("character_quests"."status" = 'turnedIn') = ("character_quests"."turned_in_at" is not null)),
	CONSTRAINT "character_quests_contract_check" CHECK (("character_quests"."kind" = 'contract') = ("character_quests"."contract_day" is not null and "character_quests"."contract_slot" is not null))
);
--> statement-breakpoint
ALTER TABLE "character_quests" ADD CONSTRAINT "character_quests_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "character_quests_character_id_status_idx" ON "character_quests" USING btree ("character_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "character_quests_story_key" ON "character_quests" USING btree ("character_id","quest_id") WHERE "character_quests"."kind" = 'story';--> statement-breakpoint
CREATE UNIQUE INDEX "character_quests_contract_slot_key" ON "character_quests" USING btree ("character_id","contract_day","contract_slot") WHERE "character_quests"."kind" = 'contract';