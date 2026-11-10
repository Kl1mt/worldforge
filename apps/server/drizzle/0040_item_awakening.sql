ALTER TABLE "item_instances" ADD COLUMN "awakening" jsonb;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "awakened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_awakening_check" CHECK (("item_instances"."awakening" is null) = ("item_instances"."awakened_at" is null));