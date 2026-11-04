ALTER TABLE "activities" ADD COLUMN "cycle_index" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "farm_state" jsonb;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_cycle_index_check" CHECK ("activities"."cycle_index" >= 0);