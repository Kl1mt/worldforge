ALTER TABLE "activities" ADD COLUMN "pending_area_id" text;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "progress" jsonb DEFAULT '{"gravewardenDefeated":false}'::jsonb NOT NULL;