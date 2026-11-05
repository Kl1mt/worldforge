ALTER TABLE "item_instances" ADD COLUMN "upgrade_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "upgrade_pity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "forge_secret" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "forge_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "reroll_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "variant" text;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "effect_id" text;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "effect_roll" double precision;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "set_id" text;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "mythic_id" text;--> statement-breakpoint
ALTER TABLE "item_instances" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_upgrade_level_check" CHECK ("item_instances"."upgrade_level" >= 0 and "item_instances"."upgrade_level" <= 10);--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_forge_counters_check" CHECK ("item_instances"."upgrade_pity" >= 0 and "item_instances"."forge_counter" >= 0 and "item_instances"."reroll_count" >= 0);--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_variant_check" CHECK ("item_instances"."variant" is null or "item_instances"."variant" in ('void'));--> statement-breakpoint
ALTER TABLE "item_instances" ADD CONSTRAINT "item_instances_effect_roll_check" CHECK ("item_instances"."effect_roll" is null or ("item_instances"."effect_roll" >= 0 and "item_instances"."effect_roll" <= 1));