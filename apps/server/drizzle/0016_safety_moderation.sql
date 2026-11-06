CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reporter_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_key" text NOT NULL,
	"target" jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"sanction_id" uuid,
	CONSTRAINT "reports_status_check" CHECK ("reports"."status" in ('open', 'dismissed', 'actioned'))
);
--> statement-breakpoint
CREATE TABLE "sanctions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_key" text,
	"target" jsonb,
	"reason" text NOT NULL,
	"issued_by" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	"lift_reason" text,
	CONSTRAINT "sanctions_kind_check" CHECK ("sanctions"."kind" in ('mute', 'suspend', 'rename', 'hide')),
	CONSTRAINT "sanctions_expiry_check" CHECK ("sanctions"."expires_at" > "sanctions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "role" text DEFAULT 'player' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "handle" text;--> statement-breakpoint
-- Hand-written backfill: existing accounts get a random handle (12 hex characters of a v4 UUID's
-- random part; hex digits are a subset of the handle alphabet). New accounts get theirs from the server.
UPDATE "accounts" SET "handle" = substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) WHERE "handle" IS NULL;--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "handle" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_accounts_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_subject_id_accounts_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolved_by_accounts_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_sanction_id_sanctions_id_fk" FOREIGN KEY ("sanction_id") REFERENCES "public"."sanctions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanctions" ADD CONSTRAINT "sanctions_subject_id_accounts_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanctions" ADD CONSTRAINT "sanctions_issued_by_accounts_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanctions" ADD CONSTRAINT "sanctions_lifted_by_accounts_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reports_open_reporter_target_key" ON "reports" USING btree ("reporter_id","target_key") WHERE "reports"."status" = 'open';--> statement-breakpoint
CREATE INDEX "reports_target_key_status_idx" ON "reports" USING btree ("target_key","status");--> statement-breakpoint
CREATE INDEX "reports_open_idx" ON "reports" USING btree ("id") WHERE "reports"."status" = 'open';--> statement-breakpoint
CREATE INDEX "sanctions_subject_id_expires_at_idx" ON "sanctions" USING btree ("subject_id","expires_at");--> statement-breakpoint
CREATE INDEX "sanctions_target_key_idx" ON "sanctions" USING btree ("target_key") WHERE "sanctions"."target_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_handle_key" ON "accounts" USING btree ("handle");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_role_check" CHECK ("accounts"."role" in ('player', 'moderator', 'admin'));