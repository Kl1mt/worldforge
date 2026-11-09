ALTER TABLE "trade_offers" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD COLUMN "reversed_by" uuid;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD COLUMN "reverse_reason" text;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD CONSTRAINT "trade_offers_reversed_by_accounts_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_trade_offer_idx" ON "audit_log" USING btree (("data"->>'offerId')) WHERE "audit_log"."event" like 'trade.%';--> statement-breakpoint
CREATE INDEX "trade_offers_accepted_closed_idx" ON "trade_offers" USING btree ("closed_at") WHERE "trade_offers"."status" = 'accepted';--> statement-breakpoint
CREATE INDEX "trade_offers_reversed_idx" ON "trade_offers" USING btree ("reversed_at") WHERE "trade_offers"."reversed_at" is not null;--> statement-breakpoint
ALTER TABLE "trade_offers" ADD CONSTRAINT "trade_offers_reversed_check" CHECK (("trade_offers"."reversed_at" is null or "trade_offers"."status" = 'accepted') and (("trade_offers"."reversed_at" is null) = ("trade_offers"."reverse_reason" is null)));