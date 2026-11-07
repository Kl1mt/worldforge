CREATE TABLE "guild_applications" (
	"guild_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_applications_guild_id_account_id_pk" PRIMARY KEY("guild_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "guild_invites" (
	"guild_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_invites_guild_id_account_id_pk" PRIMARY KEY("guild_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "guild_members" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	CONSTRAINT "guild_members_role_check" CHECK ("guild_members"."role" in ('leader', 'officer', 'member'))
);
--> statement-breakpoint
CREATE TABLE "guilds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"tag" text NOT NULL,
	"emblem" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disbanded_at" timestamp with time zone,
	"rename_required" boolean DEFAULT false NOT NULL,
	"rename_reason" text,
	"renamed_from" text
);
--> statement-breakpoint
ALTER TABLE "guild_applications" ADD CONSTRAINT "guild_applications_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_applications" ADD CONSTRAINT "guild_applications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_invites" ADD CONSTRAINT "guild_invites_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_invites" ADD CONSTRAINT "guild_invites_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_invites" ADD CONSTRAINT "guild_invites_invited_by_accounts_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_members" ADD CONSTRAINT "guild_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_members" ADD CONSTRAINT "guild_members_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guilds" ADD CONSTRAINT "guilds_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guild_applications_account_id_idx" ON "guild_applications" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "guild_invites_account_id_idx" ON "guild_invites" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "guild_members_guild_id_idx" ON "guild_members" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guild_members_one_leader_key" ON "guild_members" USING btree ("guild_id") WHERE "guild_members"."role" = 'leader';--> statement-breakpoint
CREATE UNIQUE INDEX "guilds_handle_key" ON "guilds" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "guilds_name_lower_key" ON "guilds" USING btree (lower("name")) WHERE "guilds"."disbanded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "guilds_tag_key" ON "guilds" USING btree ("tag") WHERE "guilds"."disbanded_at" is null;