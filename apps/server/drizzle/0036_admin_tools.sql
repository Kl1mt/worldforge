CREATE TABLE "telemetry_daily_test" (
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"dim1" text DEFAULT '' NOT NULL,
	"dim2" text DEFAULT '' NOT NULL,
	"dim3" text DEFAULT '' NOT NULL,
	"events" bigint DEFAULT 0 NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "telemetry_daily_test_day_metric_dim1_dim2_dim3_pk" PRIMARY KEY("day","metric","dim1","dim2","dim3"),
	CONSTRAINT "telemetry_daily_test_events_check" CHECK ("telemetry_daily_test"."events" >= 0)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "duel_reset_day" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "duel_reset_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "delete_reason" text;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "deletion" jsonb;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_deleted_by_accounts_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "characters_deleted_at_idx" ON "characters" USING btree ("deleted_at") WHERE "characters"."deleted_at" is not null;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_deleted_check" CHECK (("characters"."deleted_at" is null) = ("characters"."delete_reason" is null));