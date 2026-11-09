CREATE TABLE "trade_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"character_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"gold" bigint DEFAULT 0 NOT NULL,
	"materials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"held_until" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trade_holds_gold_check" CHECK ("trade_holds"."gold" >= 0)
);
--> statement-breakpoint
CREATE TABLE "trade_offer_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"offer_id" uuid NOT NULL,
	"side" text NOT NULL,
	"kind" text NOT NULL,
	"item_id" uuid,
	"material_id" text,
	"amount" bigint NOT NULL,
	"snapshot" jsonb,
	CONSTRAINT "trade_offer_lines_side_check" CHECK ("trade_offer_lines"."side" in ('give', 'ask')),
	CONSTRAINT "trade_offer_lines_kind_check" CHECK (("trade_offer_lines"."kind" = 'item' and "trade_offer_lines"."item_id" is not null and "trade_offer_lines"."material_id" is null and "trade_offer_lines"."amount" = 1) or ("trade_offer_lines"."kind" = 'material' and "trade_offer_lines"."item_id" is null and "trade_offer_lines"."material_id" is not null and "trade_offer_lines"."amount" > 0) or ("trade_offer_lines"."kind" = 'gold' and "trade_offer_lines"."item_id" is null and "trade_offer_lines"."material_id" is null and "trade_offer_lines"."amount" > 0))
);
--> statement-breakpoint
CREATE TABLE "trade_offers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sender_account_id" uuid NOT NULL,
	"receiver_account_id" uuid NOT NULL,
	"sender_character_id" uuid NOT NULL,
	"receiver_character_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"relation" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"void_reason" text,
	"void_detail" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trade_offers_status_check" CHECK ("trade_offers"."status" in ('open', 'accepted', 'cancelled', 'declined', 'expired', 'void')),
	CONSTRAINT "trade_offers_void_check" CHECK (("trade_offers"."status" = 'void') = ("trade_offers"."void_reason" is not null)),
	CONSTRAINT "trade_offers_parties_check" CHECK ("trade_offers"."sender_account_id" <> "trade_offers"."receiver_account_id")
);
--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "escrow_offer_id" uuid;--> statement-breakpoint
ALTER TABLE "trade_holds" ADD CONSTRAINT "trade_holds_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_holds" ADD CONSTRAINT "trade_holds_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_holds" ADD CONSTRAINT "trade_holds_offer_id_trade_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."trade_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_offer_lines" ADD CONSTRAINT "trade_offer_lines_offer_id_trade_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."trade_offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD CONSTRAINT "trade_offers_sender_account_id_accounts_id_fk" FOREIGN KEY ("sender_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD CONSTRAINT "trade_offers_receiver_account_id_accounts_id_fk" FOREIGN KEY ("receiver_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD CONSTRAINT "trade_offers_sender_character_id_characters_id_fk" FOREIGN KEY ("sender_character_id") REFERENCES "public"."characters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD CONSTRAINT "trade_offers_receiver_character_id_characters_id_fk" FOREIGN KEY ("receiver_character_id") REFERENCES "public"."characters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trade_holds_character_id_idx" ON "trade_holds" USING btree ("character_id","held_until");--> statement-breakpoint
CREATE INDEX "trade_holds_unreleased_idx" ON "trade_holds" USING btree ("held_until") WHERE "trade_holds"."released_at" is null;--> statement-breakpoint
CREATE INDEX "trade_offer_lines_offer_id_idx" ON "trade_offer_lines" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "trade_offer_lines_item_id_idx" ON "trade_offer_lines" USING btree ("item_id") WHERE "trade_offer_lines"."item_id" is not null;--> statement-breakpoint
CREATE INDEX "trade_offers_sender_status_idx" ON "trade_offers" USING btree ("sender_account_id","status");--> statement-breakpoint
CREATE INDEX "trade_offers_receiver_status_idx" ON "trade_offers" USING btree ("receiver_account_id","status");--> statement-breakpoint
CREATE INDEX "trade_offers_open_expiry_idx" ON "trade_offers" USING btree ("expires_at") WHERE "trade_offers"."status" = 'open';--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_escrow_offer_id_trade_offers_id_fk" FOREIGN KEY ("escrow_offer_id") REFERENCES "public"."trade_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_instances_escrow_offer_id_idx" ON "item_instances" USING btree ("escrow_offer_id") WHERE "item_instances"."escrow_offer_id" is not null;--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_escrow_check" CHECK ("item_instances"."escrow_offer_id" is null or ("item_instances"."equipped_slot" is null and not "item_instances"."in_warehouse" and not "item_instances"."on_shelf"));