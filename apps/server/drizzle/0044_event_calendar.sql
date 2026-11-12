CREATE TABLE "event_calendar" (
	"id" integer PRIMARY KEY NOT NULL,
	"paused" boolean DEFAULT true NOT NULL,
	"rotation" jsonb NOT NULL,
	"gap_days" integer NOT NULL,
	"next_index" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "event_calendar_one_row" CHECK ("event_calendar"."id" = 1),
	CONSTRAINT "event_calendar_gap_check" CHECK ("event_calendar"."gap_days" >= 0),
	CONSTRAINT "event_calendar_index_check" CHECK ("event_calendar"."next_index" >= 0),
	CONSTRAINT "event_calendar_count_check" CHECK ("event_calendar"."created_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "world_events" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "world_events" ADD COLUMN "calendar_slot" integer;--> statement-breakpoint
ALTER TABLE "event_calendar" ADD CONSTRAINT "event_calendar_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "world_events_calendar_slot_idx" ON "world_events" USING btree ("calendar_slot");--> statement-breakpoint
ALTER TABLE "world_events" ADD CONSTRAINT "world_events_source_check" CHECK ("world_events"."source" in ('manual', 'calendar'));