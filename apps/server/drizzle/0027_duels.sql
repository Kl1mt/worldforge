CREATE TABLE "duel_defences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"character_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"class_id" text NOT NULL,
	"level" integer NOT NULL,
	"bracket_id" text NOT NULL,
	"rules_version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duel_offers" (
	"character_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"bracket_id" text NOT NULL,
	"defence_ids" uuid[] NOT NULL,
	"offered_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"challenger_account_id" uuid,
	"challenger_character_id" uuid,
	"defender_account_id" uuid,
	"defender_character_id" uuid,
	"defence_id" uuid,
	"bracket_id" text NOT NULL,
	"day" date NOT NULL,
	"seed" text NOT NULL,
	"rules_version" integer NOT NULL,
	"challenger_snapshot" jsonb NOT NULL,
	"defender_snapshot" jsonb NOT NULL,
	"defence_set_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"sides" jsonb NOT NULL,
	"events" jsonb NOT NULL,
	"fought_at" timestamp with time zone NOT NULL,
	CONSTRAINT "duels_kind_check" CHECK ("duels"."kind" in ('rated', 'friendly')),
	CONSTRAINT "duels_outcome_check" CHECK ("duels"."outcome" in ('challenger', 'defender', 'draw')),
	CONSTRAINT "duels_reason_check" CHECK ("duels"."reason" in ('defeat', 'timeLimit'))
);
--> statement-breakpoint
ALTER TABLE "duel_defences" ADD CONSTRAINT "duel_defences_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duel_defences" ADD CONSTRAINT "duel_defences_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duel_offers" ADD CONSTRAINT "duel_offers_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duel_offers" ADD CONSTRAINT "duel_offers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duels" ADD CONSTRAINT "duels_challenger_account_id_accounts_id_fk" FOREIGN KEY ("challenger_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duels" ADD CONSTRAINT "duels_challenger_character_id_characters_id_fk" FOREIGN KEY ("challenger_character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duels" ADD CONSTRAINT "duels_defender_account_id_accounts_id_fk" FOREIGN KEY ("defender_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duels" ADD CONSTRAINT "duels_defender_character_id_characters_id_fk" FOREIGN KEY ("defender_character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duels" ADD CONSTRAINT "duels_defence_id_duel_defences_id_fk" FOREIGN KEY ("defence_id") REFERENCES "public"."duel_defences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "duel_defences_character_id_key" ON "duel_defences" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "duel_defences_bracket_idx" ON "duel_defences" USING btree ("bracket_id","set_at");--> statement-breakpoint
CREATE INDEX "duel_defences_account_id_idx" ON "duel_defences" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "duels_challenger_day_idx" ON "duels" USING btree ("challenger_account_id","day","kind");--> statement-breakpoint
CREATE INDEX "duels_challenger_time_idx" ON "duels" USING btree ("challenger_account_id","fought_at");--> statement-breakpoint
CREATE INDEX "duels_defender_time_idx" ON "duels" USING btree ("defender_account_id","fought_at");--> statement-breakpoint
CREATE INDEX "duels_defence_id_idx" ON "duels" USING btree ("defence_id");--> statement-breakpoint
CREATE INDEX "duels_challenger_character_id_idx" ON "duels" USING btree ("challenger_character_id");--> statement-breakpoint
CREATE INDEX "duels_defender_character_id_idx" ON "duels" USING btree ("defender_character_id");