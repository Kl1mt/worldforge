CREATE TABLE "account_shelf_materials" (
	"account_id" uuid NOT NULL,
	"material_id" text NOT NULL,
	"quantity" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_shelf_materials_account_id_material_id_pk" PRIMARY KEY("account_id","material_id"),
	CONSTRAINT "account_shelf_materials_quantity_check" CHECK ("account_shelf_materials"."quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "shelf_gold" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "on_shelf" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "shelf_account_id" uuid;--> statement-breakpoint
ALTER TABLE "account_shelf_materials" ADD CONSTRAINT "account_shelf_materials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_shelf_account_id_accounts_id_fk" FOREIGN KEY ("shelf_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_instances_shelf_account_id_idx" ON "item_instances" USING btree ("shelf_account_id") WHERE "item_instances"."shelf_account_id" is not null;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_shelf_gold_check" CHECK ("accounts"."shelf_gold" >= 0);--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_shelf_check" CHECK (("item_instances"."on_shelf" and "item_instances"."shelf_account_id" is not null and "item_instances"."equipped_slot" is null and not "item_instances"."in_warehouse") or (not "item_instances"."on_shelf" and "item_instances"."shelf_account_id" is null));