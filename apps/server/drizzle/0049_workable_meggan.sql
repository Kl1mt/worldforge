ALTER TABLE "character_quests" DROP CONSTRAINT "character_quests_kind_check";--> statement-breakpoint
CREATE UNIQUE INDEX "character_quests_skill_key" ON "character_quests" USING btree ("character_id","quest_id") WHERE "character_quests"."kind" = 'skill';--> statement-breakpoint
ALTER TABLE "character_quests" ADD CONSTRAINT "character_quests_kind_check" CHECK ("character_quests"."kind" in ('story', 'contract', 'skill'));--> statement-breakpoint
-- Ticket 9.3 (docs/SKILLS.md "Skill quests", docs/DATA_MODEL.md): heroes who learned a later-content
-- skill under 9.2's kill-flag rule keep it. Every hero who had felled the Forge Tyrant (or the
-- Hollow Sovereign) before the skill quests gets the quest's deed flag, with a `skill.kept` audit row.
-- Additive (it only adds a key) and safe to run twice: a hero who already has the flag is skipped,
-- so a second run changes nothing and writes no audit row.
WITH kept AS (
	UPDATE "characters" SET "progress" = "progress" || '{"forgeTyrantSkillLearned": true}'::jsonb
	WHERE "progress" @> '{"forgeTyrantDefeated": true}'::jsonb
		AND NOT ("progress" @> '{"forgeTyrantSkillLearned": true}'::jsonb)
	RETURNING "id", "account_id"
)
INSERT INTO "audit_log" ("id", "account_id", "character_id", "event", "data")
SELECT gen_random_uuid(), "account_id", "id", 'skill.kept',
	'{"deed": "forgeTyrantSkillLearned", "via": "migration 0049", "rule": "9.2 kill flag"}'::jsonb
FROM kept;--> statement-breakpoint
WITH kept AS (
	UPDATE "characters" SET "progress" = "progress" || '{"hollowSovereignSkillLearned": true}'::jsonb
	WHERE "progress" @> '{"hollowSovereignDefeated": true}'::jsonb
		AND NOT ("progress" @> '{"hollowSovereignSkillLearned": true}'::jsonb)
	RETURNING "id", "account_id"
)
INSERT INTO "audit_log" ("id", "account_id", "character_id", "event", "data")
SELECT gen_random_uuid(), "account_id", "id", 'skill.kept',
	'{"deed": "hollowSovereignSkillLearned", "via": "migration 0049", "rule": "9.2 kill flag"}'::jsonb
FROM kept;
