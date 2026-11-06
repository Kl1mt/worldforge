CREATE TABLE "account_presence" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone,
	"hidden" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "blocks_not_self_check" CHECK ("blocks"."blocker_id" <> "blocks"."blocked_id")
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"account_low" uuid NOT NULL,
	"account_high" uuid NOT NULL,
	"status" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "friendships_account_low_account_high_pk" PRIMARY KEY("account_low","account_high"),
	CONSTRAINT "friendships_order_check" CHECK ("friendships"."account_low" < "friendships"."account_high"),
	CONSTRAINT "friendships_status_check" CHECK ("friendships"."status" in ('pending', 'friends')),
	CONSTRAINT "friendships_requested_by_check" CHECK ("friendships"."requested_by" in ("friendships"."account_low", "friendships"."account_high"))
);
--> statement-breakpoint
ALTER TABLE "account_presence" ADD CONSTRAINT "account_presence_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_accounts_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_accounts_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_account_low_accounts_id_fk" FOREIGN KEY ("account_low") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_account_high_accounts_id_fk" FOREIGN KEY ("account_high") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_blocked_id_idx" ON "blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "friendships_account_high_idx" ON "friendships" USING btree ("account_high");