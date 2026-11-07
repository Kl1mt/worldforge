CREATE TABLE "community_contributions" (
	"project_id" text NOT NULL,
	"stage_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"resource" text NOT NULL,
	"amount" bigint NOT NULL,
	CONSTRAINT "community_contributions_project_id_stage_id_account_id_day_resource_pk" PRIMARY KEY("project_id","stage_id","account_id","day","resource"),
	CONSTRAINT "community_contributions_amount_check" CHECK ("community_contributions"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "community_project_progress" (
	"project_id" text NOT NULL,
	"stage_id" text NOT NULL,
	"resource" text NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "community_project_progress_project_id_stage_id_resource_pk" PRIMARY KEY("project_id","stage_id","resource"),
	CONSTRAINT "community_project_progress_amount_check" CHECK ("community_project_progress"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "community_projects" (
	"project_id" text PRIMARY KEY NOT NULL,
	"stage_index" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "community_projects_stage_index_check" CHECK ("community_projects"."stage_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "world_flags" (
	"flag_id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"set_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "community_contributions" ADD CONSTRAINT "community_contributions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "community_contributions_account_id_idx" ON "community_contributions" USING btree ("account_id");