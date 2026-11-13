CREATE TABLE "account_growth_grants" (
	"account_id" uuid NOT NULL,
	"grant_id" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"character_id" uuid,
	"backfill" boolean DEFAULT false NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_growth_grants_account_id_grant_id_pk" PRIMARY KEY("account_id","grant_id"),
	CONSTRAINT "account_growth_grants_kind_check" CHECK ("account_growth_grants"."kind" in ('slot', 'offline'))
);
--> statement-breakpoint
ALTER TABLE "account_growth_grants" ADD CONSTRAINT "account_growth_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_growth_grants" ADD CONSTRAINT "account_growth_grants_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;