ALTER TABLE "item_instances" ADD COLUMN "binding" text;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "bound_account_id" uuid;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "traded_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "first_equipped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "unprovenanced" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_bound_account_id_accounts_id_fk" FOREIGN KEY ("bound_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_binding_check" CHECK ("item_instances"."binding" is null or "item_instances"."binding" in ('account', 'equip'));--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_traded_count_check" CHECK ("item_instances"."traded_count" >= 0);