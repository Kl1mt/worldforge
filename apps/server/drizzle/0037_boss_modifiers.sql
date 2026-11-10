ALTER TABLE "dungeon_runs" DROP CONSTRAINT "dungeon_runs_tier_check";--> statement-breakpoint
ALTER TABLE "dungeon_runs" ADD COLUMN "boss_modifier" text;--> statement-breakpoint
ALTER TABLE "guild_boss_attempts" ADD COLUMN "boss_modifier" text;--> statement-breakpoint
ALTER TABLE "dungeon_runs" ADD CONSTRAINT "dungeon_runs_tier_check" CHECK ("dungeon_runs"."tier" between 1 and 4);