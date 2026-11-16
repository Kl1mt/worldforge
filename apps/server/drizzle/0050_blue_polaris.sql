CREATE TABLE "shrine_accounts" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"daily_through" integer NOT NULL,
	"marks" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shrine_accounts_marks_check" CHECK ("shrine_accounts"."marks" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shrine_draw_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_key" text NOT NULL,
	"count" integer NOT NULL,
	"character_id" uuid,
	"granted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shrine_draw_grants_source_check" CHECK ("shrine_draw_grants"."source" in ('daily', 'play', 'shop')),
	CONSTRAINT "shrine_draw_grants_count_check" CHECK ("shrine_draw_grants"."count" > 0)
);
--> statement-breakpoint
CREATE TABLE "shrine_draws" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"spent_source" text NOT NULL,
	"seed" text NOT NULL,
	"cosmetic_id" text NOT NULL,
	"rarity" text NOT NULL,
	"outcome" text NOT NULL,
	"marks" integer DEFAULT 0 NOT NULL,
	"drawn_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shrine_draws_spent_source_check" CHECK ("shrine_draws"."spent_source" in ('daily', 'play', 'shop')),
	CONSTRAINT "shrine_draws_outcome_check" CHECK ("shrine_draws"."outcome" in ('grant', 'marks')),
	CONSTRAINT "shrine_draws_marks_check" CHECK ("shrine_draws"."marks" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shrine_purchases" (
	"account_id" uuid NOT NULL,
	"cosmetic_id" text NOT NULL,
	"price" integer NOT NULL,
	"bought_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shrine_purchases_account_id_cosmetic_id_pk" PRIMARY KEY("account_id","cosmetic_id"),
	CONSTRAINT "shrine_purchases_price_check" CHECK ("shrine_purchases"."price" > 0)
);
--> statement-breakpoint
ALTER TABLE "cosmetic_displays" ADD COLUMN "companion" text;--> statement-breakpoint
ALTER TABLE "shrine_accounts" ADD CONSTRAINT "shrine_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shrine_draw_grants" ADD CONSTRAINT "shrine_draw_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shrine_draw_grants" ADD CONSTRAINT "shrine_draw_grants_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shrine_draws" ADD CONSTRAINT "shrine_draws_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shrine_purchases" ADD CONSTRAINT "shrine_purchases_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shrine_draw_grants_key_idx" ON "shrine_draw_grants" USING btree ("account_id","source_key");--> statement-breakpoint
CREATE INDEX "shrine_draws_account_idx" ON "shrine_draws" USING btree ("account_id","drawn_at");--> statement-breakpoint
ALTER TABLE "cosmetic_displays" ADD CONSTRAINT "cosmetic_displays_companion_fk" FOREIGN KEY ("account_id","companion") REFERENCES "public"."cosmetic_unlocks"("account_id","cosmetic_id") ON DELETE no action ON UPDATE no action;