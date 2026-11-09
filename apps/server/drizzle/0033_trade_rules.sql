CREATE TABLE "trade_counters" (
	"account_id" uuid NOT NULL,
	"period" text NOT NULL,
	"window_start" date NOT NULL,
	"metric" text NOT NULL,
	"direction" text NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trade_counters_account_id_period_window_start_metric_direction_pk" PRIMARY KEY("account_id","period","window_start","metric","direction"),
	CONSTRAINT "trade_counters_amount_check" CHECK ("trade_counters"."amount" >= 0),
	CONSTRAINT "trade_counters_period_check" CHECK ("trade_counters"."period" in ('day', 'week')),
	CONSTRAINT "trade_counters_direction_check" CHECK ("trade_counters"."direction" in ('given', 'received', 'any'))
);
--> statement-breakpoint
ALTER TABLE "sanctions" DROP CONSTRAINT "sanctions_kind_check";--> statement-breakpoint
ALTER TABLE "trade_counters" ADD CONSTRAINT "trade_counters_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanctions" ADD CONSTRAINT "sanctions_kind_check" CHECK ("sanctions"."kind" in ('mute', 'suspend', 'rename', 'hide', 'trade'));