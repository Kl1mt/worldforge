import { getClass, isClassId, type ClassId } from '../classes.js';
import { DEFAULT_ACTIVITY_CONFIG } from '../activity/config.js';
import { equipmentModifiers, type EquippedItem } from '../activity/equipment.js';
import { setBonusInstances } from '../items/sets.js';
import { ITEM_BASES, canClassUseItem } from '../items/bases.js';
import { itemStatContribution } from '../equipment.js';
import {
  STAT_LIMITS,
  deriveCharacterStats,
  type EquipmentStatContribution,
  type StatBlock,
} from '../combat/characterStats.js';
import { MAX_LEVEL } from '../combat/progression.js';
import { DEFAULT_LOOT_CONFIG } from '../loot/config.js';
import type { RarityId } from '../rarity.js';
import { CORE_STAT_IDS } from '../stats.js';
import type { CombatEffects } from '../effects/types.js';
import { LEVEL_BRACKETS, type LevelBracket } from '../scoring/boards.js';

/**
 * PvP normalisation (ticket 5.4, docs/PVP.md). Duels are fought inside a level bracket, and every
 * fighter's stats are pulled toward the bracket's reference hero of their class: every hero
 * fights as a hero of the reference level (`levelKeep` 0), and keeps `keep` of what their gear
 * adds beyond (or below) the reference kit. Gear still matters, a fresh hero in the bracket still
 * has a chance, and a class keeps its own shape.
 *
 * This layer only ever reads PvE rules (stats, items, effects); nothing here is used by farming,
 * the crypt, the guild boss or a score, so PvP tuning never moves a PvE number.
 */

/**
 * Version of the duel rules (normalisation and engine). Bump it whenever a duel can end
 * differently for the same input (a factor, a bracket, a reference, the engine or a combat rule
 * the duel runs through): 5.5/5.6 store it with every duel. `pvp.test.ts` pins a log hash.
 */
export const PVP_RULES_VERSION = 1;

/** A PvP bracket: a 5.2 leaderboard bracket plus its reference hero. */
export interface PvpBracket extends LevelBracket {
  /** The reference hero's level; also the attacker level in the mitigation formula. */
  referenceLevel: number;
}

/**
 * The reference hero of a bracket, per class: the class at `referenceLevel`, wearing the class's
 * best regular base in every slot at item level `referenceLevel − 1`, `rarity`, implicit stats
 * only (no affixes, no effects, +0). Pure data, no random rolls, so no class gets a lucky
 * reference.
 */
export interface PvpReferenceKit {
  rarity: RarityId;
  itemLevelOffset: number;
}

export interface PvpConfig {
  /**
   * Share of their gear's difference to the reference kit a fighter keeps (0 = gear does not
   * count, 1 = it counts fully, as in PvE).
   */
  keep: number;
  /**
   * Share of their level's difference to the reference level a fighter keeps (0 = every hero
   * fights as a hero of the reference level; gear of a higher item level still counts).
   */
  levelKeep: number;
  /**
   * Share of their gear's effect magnitudes and skill-damage bonus a fighter keeps (the
   * reference has none, so this is the same pull toward the reference).
   */
  effectKeep: number;
  referenceKit: PvpReferenceKit;
  /** Reference level per bracket id. */
  referenceLevels: Readonly<Record<string, number>>;
  /**
   * Armour and resistance count together in a duel: every blow is reduced by their mean. In PvE
   * the two face different foes; between heroes, physical classes would otherwise always meet
   * the higher defence (armour scales ~2× resistance) and casters the lower.
   */
  blendDefences: boolean;
  /**
   * Luck of the blow: every hit (not thorns) deals × a uniform roll in [1 − spread, 1 + spread].
   * Without it a duel is nearly decided before it starts (only crits are random), so any edge,
   * however small, would always win.
   */
  damageSpread: number;
  /**
   * PvP-only class tuning per bracket, applied after the pull: the class's primary damage × this.
   * PvE class profiles are tuned against monsters (armour-heavy brutes, warded casters), and a
   * class's shape changes with level; between heroes they are not even, and this is where that is
   * fixed without touching PvE.
   */
  classDamage: Readonly<Record<string, Readonly<Record<ClassId, number>>>>;
  /** The duel's time limit. */
  maxDuelMs: number;
  /**
   * Sudden death: from `atMs` on, every hit deals × (1 + `perSecond` · seconds past `atMs`), so a
   * stalemate of two walls still ends.
   */
  suddenDeath: { atMs: number; perSecond: number };
}

export const DEFAULT_PVP_CONFIG: Readonly<PvpConfig> = {
  keep: 0.25,
  levelKeep: 0,
  effectKeep: 0.25,
  referenceKit: { rarity: 'rare', itemLevelOffset: -1 },
  referenceLevels: { '1-9': 5, '10-19': 15, '20-29': 25, '30-plus': 30 },
  blendDefences: true,
  damageSpread: 0.5,
  // Measured with the build samples of `pvp-balance.test.ts` (docs/PVP.md "Class tuning").
  classDamage: {
    '1-9': { warrior: 1, mage: 1.1, hunter: 0.91, warlock: 1.12 },
    '10-19': { warrior: 0.95, mage: 1.11, hunter: 0.92, warlock: 1.13 },
    '20-29': { warrior: 0.96, mage: 1.09, hunter: 0.92, warlock: 1.14 },
    '30-plus': { warrior: 0.94, mage: 1.11, hunter: 0.91, warlock: 1.14 },
  },
  maxDuelMs: 60_000,
  suddenDeath: { atMs: 30_000, perSecond: 0.1 },
};

/**
 * The PvP brackets: exactly the 5.2 leaderboard brackets (so a board's bracket filter is the
 * arena's bracket), each with its reference level.
 */
export function pvpBrackets(config: PvpConfig = DEFAULT_PVP_CONFIG): PvpBracket[] {
  return LEVEL_BRACKETS.map((b) => {
    const referenceLevel = config.referenceLevels[b.id];
    if (referenceLevel === undefined) throw new RangeError(`No PvP reference for bracket ${b.id}`);
    return { ...b, referenceLevel };
  });
}

export const PVP_BRACKETS: readonly PvpBracket[] = pvpBrackets();

export function pvpBracketOf(level: number, config: PvpConfig = DEFAULT_PVP_CONFIG): PvpBracket {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL)
    throw new RangeError(`Invalid level: ${level}`);
  const brackets = config === DEFAULT_PVP_CONFIG ? PVP_BRACKETS : pvpBrackets(config);
  return brackets.find((b) => level >= b.min && (b.max === null || level <= b.max))!;
}

export function findPvpBracket(
  id: string,
  config: PvpConfig = DEFAULT_PVP_CONFIG,
): PvpBracket | undefined {
  const brackets = config === DEFAULT_PVP_CONFIG ? PVP_BRACKETS : pvpBrackets(config);
  return brackets.find((b) => b.id === id);
}

/** The reference kit's items (implicit stats only). */
function referenceKitStats(
  classId: ClassId,
  itemLevel: number,
  rarityId: RarityId,
): EquipmentStatContribution[] {
  const il = Math.max(1, itemLevel);
  const best = new Map<string, (typeof ITEM_BASES)[number]>();
  for (const b of ITEM_BASES) {
    if (b.unique || b.minItemLevel > il || !canClassUseItem(b, classId)) continue;
    const cur = best.get(b.slot);
    if (!cur || b.tier > cur.tier || (b.tier === cur.tier && b.minItemLevel > cur.minItemLevel))
      best.set(b.slot, b);
  }
  const out: EquipmentStatContribution[] = [];
  for (const base of best.values()) {
    const contribution = itemStatContribution(
      { baseId: base.id, rarityId, itemLevel: il, affixes: [] },
      DEFAULT_LOOT_CONFIG,
    );
    out.push(contribution);
    if (base.slot === 'ring') out.push(contribution);
  }
  return out;
}

const referenceCache = new Map<string, StatBlock>();
const classCache = new Map<string, StatBlock>();

/** The class at a level with nothing equipped. */
function classStats(classId: ClassId, level: number): StatBlock {
  const key = `${classId}:${level}`;
  let stats = classCache.get(key);
  if (!stats) {
    stats = deriveCharacterStats(classId, level, []);
    classCache.set(key, stats);
  }
  return stats;
}

/** The reference hero's stats for a class in a bracket. */
export function pvpReferenceStats(
  classId: ClassId,
  bracket: PvpBracket,
  config: PvpConfig = DEFAULT_PVP_CONFIG,
): StatBlock {
  const { rarity, itemLevelOffset } = config.referenceKit;
  const key = `${classId}:${bracket.referenceLevel}:${rarity}:${itemLevelOffset}`;
  let stats = referenceCache.get(key);
  if (!stats) {
    stats = deriveCharacterStats(
      classId,
      bracket.referenceLevel,
      referenceKitStats(classId, bracket.referenceLevel + itemLevelOffset, rarity),
    );
    referenceCache.set(key, stats);
  }
  return { ...stats };
}

/** A hero as a duel reads them: class, level and the items of their defence or attack snapshot. */
export interface PvpFighterInput {
  classId: ClassId;
  level: number;
  equipment: readonly EquippedItem[];
}

/** A fighter after normalisation: what the duel engine fights with. */
export interface PvpFighter {
  classId: ClassId;
  level: number;
  /** The stats the hero has in PvE, as equipped (for display: "your 812 health counts as 640"). */
  pveStats: StatBlock;
  /** The normalised stats (the class tuning included). */
  stats: StatBlock;
  /** Max health in the duel (`stats.health`). */
  maxHealth: number;
  /** The class-skill damage bonus after `effectKeep`. */
  skillDamage: number;
  /** Combined effects after `effectKeep`; PvE-only mechanics are off. */
  effects: CombatEffects;
}

/**
 * The effects a fighter brings into PvP. Damage bonuses keep `effectKeep` of their magnitude
 * (pulled toward the reference's none); thresholds, stack counts and the surge's power are
 * mechanics, not bonuses, and stay. PvE-only mechanics are off: boss slayer (no boss in a duel),
 * and life on kill and bloodrush (they act after a kill, and a duel ends at the first).
 */
export function pvpEffects(fx: CombatEffects, effectKeep: number): CombatEffects {
  const scale = (v: number) => Math.round(v * effectKeep * 10_000) / 10_000;
  return {
    critBurn: scale(fx.critBurn),
    execute: { threshold: fx.execute.threshold, bonus: scale(fx.execute.bonus) },
    bossSlayer: 0,
    lifeOnKill: 0,
    bloodrush: { perStack: 0, maxStacks: 0, decayMs: 0 },
    thorns: scale(fx.thorns),
    fortitude: { threshold: fx.fortitude.threshold, bonus: scale(fx.fortitude.bonus) },
    skillRage: scale(fx.skillRage),
    skillSurge: fx.skillSurge,
    skillOpener: scale(fx.skillOpener),
    skillRot: scale(fx.skillRot),
  };
}

/**
 * Normalises a hero for a duel in `bracket`. The hero's PvE stats come from the PvE rules
 * unchanged (`equipmentModifiers` with the set bonuses, `deriveCharacterStats`). For every core
 * stat: `reference + levelKeep · (own level's class value − reference level's) + keep · (what the
 * hero's gear adds − what the reference kit adds)`, within the stat limits. Then the PvP class
 * tuning. Secondary modifiers other than the class-skill bonus (gold, item and XP find, boss
 * damage) do nothing in a duel.
 */
export function normaliseFighter(
  input: PvpFighterInput,
  bracket: PvpBracket,
  config: PvpConfig = DEFAULT_PVP_CONFIG,
): PvpFighter {
  const { classId, level } = input;
  if (!isClassId(classId)) throw new RangeError(`Unknown class: ${String(classId)}`);
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL)
    throw new RangeError(`Invalid level: ${level}`);
  const modifiers = equipmentModifiers(
    input.equipment,
    DEFAULT_ACTIVITY_CONFIG.modifierCaps,
    DEFAULT_LOOT_CONFIG,
    { classId, extraEffects: setBonusInstances(input.equipment) },
  );
  const pveStats = deriveCharacterStats(classId, level, modifiers.stats);
  const own = classStats(classId, level);
  const refBase = classStats(classId, bracket.referenceLevel);
  const reference = pvpReferenceStats(classId, bracket, config);
  const stats = { ...pveStats };
  for (const id of CORE_STAT_IDS) {
    // What the hero's gear adds, against what the reference kit adds.
    const gearGap = pveStats[id] - own[id] - (reference[id] - refBase[id]);
    const levelGap = own[id] - refBase[id];
    const value = reference[id] + config.levelKeep * levelGap + config.keep * gearGap;
    const { min, max } = STAT_LIMITS[id];
    stats[id] = Math.min(max, Math.max(min, value));
  }
  stats.health = Math.max(STAT_LIMITS.health.min, Math.floor(stats.health));
  const tuning = config.classDamage[bracket.id]?.[classId] ?? 1;
  const primary = getClass(classId).primaryDamage === 'physical' ? 'physicalDamage' : 'magicDamage';
  stats[primary] = Math.min(STAT_LIMITS[primary].max, stats[primary] * tuning);
  return {
    classId,
    level,
    pveStats,
    stats,
    maxHealth: stats.health,
    skillDamage: modifiers.skillDamage * config.effectKeep,
    effects: pvpEffects(modifiers.effects, config.effectKeep),
  };
}
