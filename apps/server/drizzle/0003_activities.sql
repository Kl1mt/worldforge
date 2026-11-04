CREATE TABLE "activities" (
	"character_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"area_id" text NOT NULL,
	"seed_secret" text NOT NULL,
	"settlement_seq" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"carry_ms" integer DEFAULT 0 NOT NULL,
	"health" integer,
	"summary" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_carry_ms_check" CHECK ("activities"."carry_ms" >= 0),
	CONSTRAINT "activities_settlement_seq_check" CHECK ("activities"."settlement_seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activities_account_id_key" ON "activities" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "activities_settled_at_idx" ON "activities" USING btree ("settled_at");