CREATE TABLE "telemetry_daily" (
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"dim1" text DEFAULT '' NOT NULL,
	"dim2" text DEFAULT '' NOT NULL,
	"dim3" text DEFAULT '' NOT NULL,
	"events" bigint DEFAULT 0 NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "telemetry_daily_day_metric_dim1_dim2_dim3_pk" PRIMARY KEY("day","metric","dim1","dim2","dim3"),
	CONSTRAINT "telemetry_daily_events_check" CHECK ("telemetry_daily"."events" >= 0)
);
