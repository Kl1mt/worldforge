import { xpToNextLevel } from '../combat/progression.js';
import type { ItemSlotKind } from '../items/bases.js';
import { offersRewardSlot, targetedItemReward } from './targeted.js';
import { createRng } from '../rng.js';
import { AREAS, areaUnlockBlockers, isAreaUnlocked } from '../world/areas.js';
import type { WorldFlags } from '../world/projects.js';
import type { UnlockBlocker, WorldProgress } from '../world/unlocks.js';
import {
  CONTRACT_TEMPLATES,
  STORY_QUESTS,
  type ContractTemplate,
  type QuestReward,
  type StoryQuestDefinition,
  type StoryQuestId,
} from './definitions.js';

/** Contracts posted per character per day (ticket 2.4). */
export const CONTRACTS_PER_DAY = 3;
/** Accepted contracts a character may hold at once. */
export const MAX_ACTIVE_CONTRACTS = 3;

/** The UTC day of a time, `YYYY-MM-DD`: the contract day. */
export function contractDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Why a story quest cannot be accepted yet. */
export type StoryBlocker =
  { kind: 'level'; required: number } | { kind: 'quest'; questId: StoryQuestId };

/** Story quest state the board needs: accepted (any status) and turned-in quest ids. */
export interface StoryProgress {
  accepted: ReadonlySet<StoryQuestId>;
  turnedIn: ReadonlySet<StoryQuestId>;
}

export interface StoryOffer {
  quest: StoryQuestDefinition;
  /** Empty when the quest can be accepted. */
  blockers: StoryBlocker[];
}

export function storyBlockers(
  quest: StoryQuestDefinition,
  level: number,
  turnedIn: ReadonlySet<StoryQuestId>,
): StoryBlocker[] {
  const blockers: StoryBlocker[] = [];
  if (quest.after && !turnedIn.has(quest.after)) {
    blockers.push({ kind: 'quest', questId: quest.after });
  }
  if (level < quest.level) blockers.push({ kind: 'level', required: quest.level });
  return blockers;
}

/**
 * The next story quest on the board: the first one in chain order that has not been accepted,
 * with what still blocks it. Null when the chain is accepted to the end.
 */
export function nextStoryOffer(level: number, progress: StoryProgress): StoryOffer | null {
  const quest = STORY_QUESTS.find((q) => !progress.accepted.has(q.id));
  if (!quest) return null;
  return { quest, blockers: storyBlockers(quest, level, progress.turnedIn) };
}

/**
 * Contract reward at a character level: a share of the level's XP and some gold, scaled by the
 * template. Fixed when the contract is accepted.
 */
export function contractReward(
  template: ContractTemplate,
  level: number,
  rewardSlot?: ItemSlotKind,
): QuestReward {
  const xp = Math.max(
    10,
    Math.round(xpToNextLevel(Math.max(1, level)) * 0.3 * template.rewardScale),
  );
  const gold = Math.round((20 + 6 * level) * template.rewardScale);
  // Ticket 3.6: a contract that offers a reward slot adds an item for the slot chosen.
  if (rewardSlot !== undefined && !offersRewardSlot(template)) {
    throw new RangeError(`Contract ${template.id} offers no reward slot.`);
  }
  const item = rewardSlot !== undefined ? targetedItemReward(rewardSlot, level) : null;
  return { xp, gold, materials: {}, item };
}

/** One of today's contract slots. */
export interface ContractOffer {
  day: string;
  /** 0..CONTRACTS_PER_DAY-1; a slot can be accepted once per day. */
  slot: number;
  template: ContractTemplate;
}

/**
 * Ticket F.1: what keeps a contract's area closed to the character, by the map's own unlock rules
 * (`areaUnlockBlockers`: level, Gravewarden, world flag). Empty when the hero can reach the area.
 * Accepting and turning in a contract both require it empty.
 */
export function contractAreaBlockers(
  template: ContractTemplate,
  level: number,
  progress: WorldProgress,
  world?: WorldFlags,
): UnlockBlocker[] {
  return areaUnlockBlockers(template.areaId, { level, ...(world ? { world } : {}) }, progress);
}

/**
 * Today's contracts for a character: `CONTRACTS_PER_DAY` distinct templates from the areas the
 * character has unlocked, chosen by a seed derived server-side from the character and the day.
 * Newer areas weigh more, so the board follows the hero's progress.
 *
 * Ticket F.1: `world` (the server's world flags) opens the areas behind a world flag (the Ashen
 * Pass) exactly when the map does. Without it those areas stay closed. Such areas come last in
 * `AREAS`, so a hero who cannot reach them draws from the same pool, with the same weights and the
 * same seed, as before: their offers do not change.
 */
export function dailyContracts(
  characterId: string,
  day: string,
  level: number,
  progress: WorldProgress,
  world?: WorldFlags,
): ContractOffer[] {
  const character = { level, ...(world ? { world } : {}) };
  const unlocked = AREAS.filter((a) => isAreaUnlocked(a.id, character, progress)).map((a) => a.id);
  const pool = CONTRACT_TEMPLATES.filter((t) => unlocked.includes(t.areaId)).map((template) => ({
    template,
    weight: 1 + unlocked.indexOf(template.areaId) * 2,
  }));
  const rng = createRng(`contracts:${characterId}:${day}`);
  const offers: ContractOffer[] = [];
  for (let slot = 0; slot < CONTRACTS_PER_DAY && pool.length > 0; slot++) {
    const pick = rng.weighted(pool, (p) => p.weight);
    pool.splice(pool.indexOf(pick), 1);
    offers.push({ day, slot, template: pick.template });
  }
  return offers;
}
