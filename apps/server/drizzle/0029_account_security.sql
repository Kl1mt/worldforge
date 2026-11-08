CREATE TABLE "account_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "account_tokens_purpose_check" CHECK ("account_tokens"."purpose" in ('verify_email', 'reset_password')),
	CONSTRAINT "account_tokens_expiry_check" CHECK ("account_tokens"."expires_at" > "account_tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_tokens_token_hash_key" ON "account_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "account_tokens_account_id_idx" ON "account_tokens" USING btree ("account_id","purpose");--> statement-breakpoint
CREATE INDEX "account_tokens_expires_at_idx" ON "account_tokens" USING btree ("expires_at");