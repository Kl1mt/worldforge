import type { ClassId } from '../classes.js';
import { ACTIVE_SKILLS, PASSIVE_SKILLS, type SkillDeed } from '../combat/skills.js';
import type { EnemyId } from '../world/enemies.js';
import type { MaterialId } from '../world/materials.js';
import type { WorldProgress } from '../world/unlocks.js';
import type { QuestItemReward } from './definitions.js';
import type { QuestObjective } from './objectives.js';

/**
 * Ticket 9.3 (docs/QUESTS.md "Skill quests", docs/SKILLS.md "Skill quests"): the later-content
 * skills are taught at the Tavern. Each quest needs a fresh kill of its boss (a `defeatBoss`
 * objective, advanced by the dungeon claim like any quest) and, at the turn-in, an older boss's
 * material (paid then, so the older boss gains a use). Turning it in sets the skill's deed flag
 * (`SkillUnlock.deed`) and grants a piece of the Masters' Lessons. Once per hero.
 */
export const SKILL_QUEST_IDS = ['theTyrantsLesson', 'theSovereignsLesson'] as const;
export type SkillQuestId = (typeof SKILL_QUEST_IDS)[number];

export interface SkillQuestDefinition {
  id: SkillQuestId;
  name: string;
  giver: string;
  description: string;
  /** Minimum level to take it: the taught skill's unlock level. */
  level: number;
  /** The boss whose fall the quest asks for. */
  bossId: EnemyId;
  objectives: readonly QuestObjective[];
  /** Paid at the turn-in (held then, not gathered after acceptance). */
  cost: { materials: Partial<Record<MaterialId, number>> };
  /** The deed flag set at the turn-in (what `SkillUnlock.deed` reads). */
  teaches: SkillDeed;
  /** Which kind of skill it teaches (every class has one of each). */
  skillKind: 'active' | 'passive';
  /** A Legendary piece of the Masters' Lessons (its effect rolls at the turn-in). */
  item: QuestItemReward;
}

export const SKILL_QUESTS: readonly SkillQuestDefinition[] = [
  {
    id: 'theTyrantsLesson',
    name: 'The Tyrant’s Lesson',
    giver: 'Brother Ansgar, the forge-scholar',
    description:
      'The Forge Tyrant fought with a craft no mortal teaches. Fell him once more and bring me two Gravewarden’s Seals: their old binding holds what his fire would burn away, and I will set his art in you.',
    level: 36,
    bossId: 'forgeTyrant',
    objectives: [{ kind: 'defeatBoss', bossId: 'forgeTyrant' }],
    cost: { materials: { gravewardenSeal: 2 } },
    teaches: 'forgeTyrantSkillLearned',
    skillKind: 'active',
    item: { baseId: 'masters-ember-band', rarityId: 'legendary', itemLevel: 41 },
  },
  {
    id: 'theSovereignsLesson',
    name: 'The Sovereign’s Lesson',
    giver: 'Brother Ansgar, the forge-scholar',
    description:
      'The Hollow Sovereign’s will outlived his crown. Bring him down in his throne hall, then bring me two of the Tyrant’s Embers: only that fire can temper what the Hollow taught him.',
    level: 46,
    bossId: 'hollowSovereign',
    objectives: [{ kind: 'defeatBoss', bossId: 'hollowSovereign' }],
    cost: { materials: { tyrantsEmber: 2 } },
    teaches: 'hollowSovereignSkillLearned',
    skillKind: 'passive',
    item: { baseId: 'masters-hollow-torc', rarityId: 'legendary', itemLevel: 53 },
  },
];

const BY_ID = new Map(SKILL_QUESTS.map((q) => [q.id, q]));

export function isSkillQuestId(value: unknown): value is SkillQuestId {
  return typeof value === 'string' && BY_ID.has(value as SkillQuestId);
}

export function getSkillQuest(id: SkillQuestId): SkillQuestDefinition {
  const q = BY_ID.get(id);
  if (!q) throw new Error(`Unknown skill quest: ${id}`);
  return q;
}

/** The skill a quest teaches a class (its Tyrant active or its Sovereign passive). */
export function skillTaughtBy(quest: SkillQuestDefinition, classId: ClassId) {
  const pool = quest.skillKind === 'active' ? ACTIVE_SKILLS : PASSIVE_SKILLS;
  const skill = pool.find((s) => s.classId === classId && s.unlock.deed === quest.teaches);
  if (!skill) throw new Error(`No ${classId} skill taught by ${quest.id}`);
  return { id: skill.id, name: skill.name, level: skill.unlock.level };
}

/** Why a skill quest cannot be taken yet. */
export type SkillQuestBlocker = { kind: 'level'; required: number };

export function skillQuestBlockers(
  quest: SkillQuestDefinition,
  level: number,
): SkillQuestBlocker[] {
  return level < quest.level ? [{ kind: 'level', required: quest.level }] : [];
}

/** Whether the hero already knows the skill (by the quest, or kept from 9.2's kill flag). */
export function skillQuestLearned(
  quest: SkillQuestDefinition,
  progress: Partial<WorldProgress>,
): boolean {
  return progress[quest.teaches] === true;
}

/** Materials the turn-in still lacks (empty: the hero holds enough). */
export function skillQuestMissing(
  quest: SkillQuestDefinition,
  held: Partial<Record<MaterialId, number>>,
): Partial<Record<MaterialId, number>> {
  const missing: Partial<Record<MaterialId, number>> = {};
  for (const [id, n] of Object.entries(quest.cost.materials) as [MaterialId, number][]) {
    const have = Math.max(0, Math.floor(held[id] ?? 0));
    if (have < n) missing[id] = n - have;
  }
  return missing;
}
