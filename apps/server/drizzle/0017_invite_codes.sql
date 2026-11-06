CREATE TABLE "invite_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"note" text DEFAULT '' NOT NULL,
	"created_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_codes_max_uses_check" CHECK ("invite_codes"."max_uses" >= 1),
	CONSTRAINT "invite_codes_uses_check" CHECK ("invite_codes"."uses" >= 0 and "invite_codes"."uses" <= "invite_codes"."max_uses")
);
--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invite_codes_code_hash_key" ON "invite_codes" USING btree ("code_hash");