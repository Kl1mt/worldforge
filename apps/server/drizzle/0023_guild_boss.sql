CREATE TABLE "guild_boss_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"week" date NOT NULL,
	"attempt_no" smallint NOT NULL,
	"guild_id" uuid NOT NULL,
	"character_id" uuid,
	"boss_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"damage" integer NOT NULL,
	"counted" integer NOT NULL,
	"end" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_boss_attempts_no_check" CHECK ("guild_boss_attempts"."attempt_no" >= 1),
	CONSTRAINT "guild_boss_attempts_counted_check" CHECK ("guild_boss_attempts"."counted" >= 0 and "guild_boss_attempts"."counted" <= "guild_boss_attempts"."damage"),
	CONSTRAINT "guild_boss_attempts_end_check" CHECK ("guild_boss_attempts"."end" in ('fell', 'endured'))
);
--> statement-breakpoint
CREATE TABLE "guild_boss_rewards" (
	"account_id" uuid NOT NULL,
	"week" date NOT NULL,
	"stage" smallint NOT NULL,
	"guild_id" uuid NOT NULL,
	"boss_id" text NOT NULL,
	"status" text NOT NULL,
	"gold" integer NOT NULL,
	"materials" jsonb NOT NULL,
	"earned_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"character_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_boss_rewards_account_id_week_stage_pk" PRIMARY KEY("account_id","week","stage"),
	CONSTRAINT "guild_boss_rewards_status_check" CHECK ("guild_boss_rewards"."status" in ('pending', 'earned')),
	CONSTRAINT "guild_boss_rewards_claim_check" CHECK ("guild_boss_rewards"."claimed_at" is null or ("guild_boss_rewards"."status" = 'earned' and "guild_boss_rewards"."earned_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "guild_boss_stages" (
	"guild_id" uuid NOT NULL,
	"week" date NOT NULL,
	"stage" smallint NOT NULL,
	"reached_at" timestamp with time zone NOT NULL,
	"attempt_id" uuid NOT NULL,
	CONSTRAINT "guild_boss_stages_guild_id_week_stage_pk" PRIMARY KEY("guild_id","week","stage")
);
--> statement-breakpoint
CREATE TABLE "guild_boss_streams" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"seed_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_boss_weeks" (
	"guild_id" uuid NOT NULL,
	"week" date NOT NULL,
	"boss_id" text NOT NULL,
	"total" bigint DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"stage" smallint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "guild_boss_weeks_guild_id_week_pk" PRIMARY KEY("guild_id","week"),
	CONSTRAINT "guild_boss_weeks_total_check" CHECK ("guild_boss_weeks"."total" >= 0)
);
--> statement-breakpoint
ALTER TABLE "guild_boss_attempts" ADD CONSTRAINT "guild_boss_attempts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_boss_attempts" ADD CONSTRAINT "guild_boss_attempts_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_boss_attempts" ADD CONSTRAINT "guild_boss_attempts_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_boss_rewards" ADD CONSTRAINT "guild_boss_rewards_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_boss_rewards" ADD CONSTRAINT "guild_boss_rewards_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_boss_rewards" ADD CONSTRAINT "guild_boss_rewards_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_boss_stages" ADD CONSTRAINT "guild_boss_stages_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_boss_stages" ADD CONSTRAINT "guild_boss_stages_attempt_id_guild_boss_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."guild_boss_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_boss_streams" ADD CONSTRAINT "guild_boss_streams_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_boss_weeks" ADD CONSTRAINT "guild_boss_weeks_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guild_boss_attempts_account_week_no_key" ON "guild_boss_attempts" USING btree ("account_id","week","attempt_no");--> statement-breakpoint
CREATE INDEX "guild_boss_attempts_guild_week_idx" ON "guild_boss_attempts" USING btree ("guild_id","week");--> statement-breakpoint
CREATE INDEX "guild_boss_rewards_guild_week_idx" ON "guild_boss_rewards" USING btree ("guild_id","week");