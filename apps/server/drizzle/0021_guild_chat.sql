CREATE TABLE "guild_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"author_id" uuid,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"removed_as" text,
	CONSTRAINT "guild_messages_kind_check" CHECK ("guild_messages"."kind" in ('chat', 'notice')),
	CONSTRAINT "guild_messages_removed_as_check" CHECK ("guild_messages"."removed_as" is null or "guild_messages"."removed_as" in ('withdrawn', 'removed'))
);
--> statement-breakpoint
ALTER TABLE "guilds" ADD COLUMN "notice_message_id" uuid;--> statement-breakpoint
ALTER TABLE "guild_messages" ADD CONSTRAINT "guild_messages_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_messages" ADD CONSTRAINT "guild_messages_author_id_accounts_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_messages" ADD CONSTRAINT "guild_messages_removed_by_accounts_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guild_messages_guild_id_seq_key" ON "guild_messages" USING btree ("guild_id","seq");