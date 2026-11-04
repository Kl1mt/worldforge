CREATE TABLE "character_materials" (
	"character_id" uuid NOT NULL,
	"material_id" text NOT NULL,
	"quantity" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_materials_character_id_material_id_pk" PRIMARY KEY("character_id","material_id"),
	CONSTRAINT "character_materials_quantity_check" CHECK ("character_materials"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "character_professions" (
	"character_id" uuid NOT NULL,
	"profession_id" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"experience" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_professions_character_id_profession_id_pk" PRIMARY KEY("character_id","profession_id"),
	CONSTRAINT "character_professions_level_check" CHECK ("character_professions"."level" >= 1),
	CONSTRAINT "character_professions_experience_check" CHECK ("character_professions"."experience" >= 0)
);
--> statement-breakpoint
ALTER TABLE "character_materials" ADD CONSTRAINT "character_materials_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_professions" ADD CONSTRAINT "character_professions_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;