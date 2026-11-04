CREATE TABLE "item_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"character_id" uuid NOT NULL,
	"base_id" text NOT NULL,
	"rarity_id" text NOT NULL,
	"item_level" integer NOT NULL,
	"affixes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seed" bigint NOT NULL,
	"equipped_slot" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_instances_item_level_check" CHECK ("item_instances"."item_level" >= 1)
);
--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_instances_character_id_idx" ON "item_instances" USING btree ("character_id");--> statement-breakpoint
CREATE UNIQUE INDEX "item_instances_equipped_slot_key" ON "item_instances" USING btree ("character_id","equipped_slot") WHERE "item_instances"."equipped_slot" is not null;