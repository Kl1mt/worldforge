CREATE TABLE "cosmetic_displays" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"banner" text,
	"crest" text,
	"title_colour" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hero_appearances" (
	"character_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"appearance" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cosmetic_displays" ADD CONSTRAINT "cosmetic_displays_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cosmetic_displays" ADD CONSTRAINT "cosmetic_displays_banner_fk" FOREIGN KEY ("account_id","banner") REFERENCES "public"."cosmetic_unlocks"("account_id","cosmetic_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cosmetic_displays" ADD CONSTRAINT "cosmetic_displays_crest_fk" FOREIGN KEY ("account_id","crest") REFERENCES "public"."cosmetic_unlocks"("account_id","cosmetic_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cosmetic_displays" ADD CONSTRAINT "cosmetic_displays_title_colour_fk" FOREIGN KEY ("account_id","title_colour") REFERENCES "public"."cosmetic_unlocks"("account_id","cosmetic_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hero_appearances" ADD CONSTRAINT "hero_appearances_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hero_appearances" ADD CONSTRAINT "hero_appearances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hero_appearances" ADD CONSTRAINT "hero_appearances_unlock_fk" FOREIGN KEY ("account_id","appearance") REFERENCES "public"."cosmetic_unlocks"("account_id","cosmetic_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hero_appearances_account_idx" ON "hero_appearances" USING btree ("account_id");