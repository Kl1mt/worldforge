ALTER TABLE "characters" ADD COLUMN "warehouse_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "in_warehouse" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_warehouse_level_check" CHECK ("characters"."warehouse_level" >= 0);--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_warehouse_check" CHECK (not "item_instances"."in_warehouse" or "item_instances"."equipped_slot" is null);