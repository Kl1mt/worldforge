/**
 * Test support for the PvP balance suite (ticket 5.4, `pvp-balance.test.ts`, docs/PVP.md).
 * Excluded from the package build (`tsconfig.build.json`).
 *
 * Gear tiers a hero of a level can wear, worst to best, each sampled with several kit seeds
 * ("build samples"): nothing, then one item per droppable slot (both rings) of the best regular
 * base the class can use at item level = level − 1 (B.1's "geared" kit) in common, rare, epic and
 * Legendary rarity (Legendaries with their rolled effect), then the Legendary kit at +5 and at +10
 * Void. Late brackets add B.2's late-game builds (set layouts, affix packages, Legendary effects).
 */
import {
  CLASS_IDS,
  ITEM_BASES,
  canClassUseItem,
  createRng,
  generateItem,
  simulateDuel,
  type ClassId,
  type DuelInput,
  type EquippedItem,
  type GeneratedItem,
  type PvpConfig,
  type PvpBracket,
  type PvpFighterInput,
  DEFAULT_PVP_CONFIG,
  type RarityId,
} from '../index.js';
import {
  AFFIX_PACKAGES,
  buildItems,
  effectPool,
  buildSlots,
  setChassis,
  type Build,
  type SlotPick,
} from './builds.js';

export { CLASS_IDS };

/** One item per droppable slot (both rings) of the best regular tier, as in `balance.test.ts`. */
export function kit(
  classId: ClassId,
  itemLevel: number,
  rarityId: RarityId,
  sample: number,
): GeneratedItem[] {
  const level = Math.max(1, itemLevel);
  const rng = createRng(`pvp-kit:${classId}:${level}:${rarityId}:${sample}`);
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= level && canClassUseItem(b, classId),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set<string>();
  const out: GeneratedItem[] = [];
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (let i = 0; i < (base.slot === 'ring' ? 2 : 1); i++) {
      out.push(
        generateItem({
          seed: rng.int(0, 2 ** 31),
          itemLevel: level,
          baseId: base.id,
          rarityId,
          classId,
        })!,
      );
    }
  }
  return out;
}

export const GEAR_TIERS = [
  'naked',
  'common',
  'rare',
  'epic',
  'legendary',
  'legendary+5',
  'legendary+10void',
] as const;
export type GearTier = (typeof GEAR_TIERS)[number];

export function gear(
  classId: ClassId,
  level: number,
  tier: GearTier,
  sample: number,
): EquippedItem[] {
  const il = Math.max(1, level - 1);
  switch (tier) {
    case 'naked':
      return [];
    case 'common':
    case 'rare':
    case 'epic':
    case 'legendary':
      return kit(classId, il, tier, sample);
    case 'legendary+5':
      return kit(classId, il, 'legendary', sample).map((i) => ({ ...i, upgradeLevel: 5 }));
    case 'legendary+10void':
      return kit(classId, il, 'legendary', sample).map((i) => ({
        ...i,
        upgradeLevel: 10,
        variant: 'void' as const,
      }));
  }
}

export const fighter = (
  classId: ClassId,
  level: number,
  equipment: readonly EquippedItem[],
): PvpFighterInput => ({ classId, level, equipment });

/**
 * A random late-game build (B.2's shape): a set layout, an affix package and a distinct
 * Legendary effect drawn for every free slot, from a fixed sample seed.
 */
export function sampleBuild(classId: ClassId, itemLevel: number, sample: number): EquippedItem[] {
  const rng = createRng(`pvp-build:${classId}:${itemLevel}:${sample}`);
  const layouts = setChassis(classId);
  const ch = layouts[rng.int(0, layouts.length - 1)]!;
  const pkg = AFFIX_PACKAGES[rng.int(0, AFFIX_PACKAGES.length - 1)]!;
  const slots = buildSlots(classId);
  const used = new Set<string>();
  const picks: SlotPick[] = ch.fixed.map((f, i) => {
    if (f) return f;
    const pool = effectPool(classId, slots[i]!, itemLevel).filter((e) => !used.has(e));
    const effectId = pool.length > 0 ? pool[rng.int(0, pool.length - 1)]! : null;
    if (effectId) used.add(effectId);
    return { kind: 'legendary', effectId };
  });
  const build: Build = { classId, chassis: ch.name, picks, pkg };
  return buildItems(build, itemLevel);
}

/** Win share of `a` over `seeds` duels (a draw counts half), alternating who challenges. */
export function winShare(
  a: PvpFighterInput,
  b: PvpFighterInput,
  seeds: number,
  prefix: string,
  bracketId?: string,
  config: PvpConfig = DEFAULT_PVP_CONFIG,
): { share: number; draws: number; timeLimits: number; meanMs: number } {
  let wins = 0;
  let draws = 0;
  let timeLimits = 0;
  let ms = 0;
  for (let s = 0; s < seeds; s++) {
    const aChallenges = s % 2 === 0;
    const input: DuelInput = {
      challenger: aChallenges ? a : b,
      defender: aChallenges ? b : a,
      seed: `${prefix}:${s}`,
      ...(bracketId ? { bracketId } : {}),
    };
    const r = simulateDuel(input, config);
    const aSide = aChallenges ? 'challenger' : 'defender';
    if (r.outcome === 'draw') draws++;
    else if (r.outcome === aSide) wins++;
    if (r.reason === 'timeLimit') timeLimits++;
    ms += r.durationMs;
  }
  return { share: (wins + draws / 2) / seeds, draws, timeLimits, meanMs: ms / seeds };
}

/* --- Measurements shared by the balance suite and the docs ----------------------------------- */

/** Equal-gear tiers for the class matchups; late brackets add B.2-shaped builds. */
export const MATCHUP_TIERS = ['common', 'rare', 'epic', 'legendary'] as const;
export type MatchupTier = (typeof MATCHUP_TIERS)[number] | 'build';

export function matchupTiers(bracket: PvpBracket): MatchupTier[] {
  return bracket.min >= 20 ? [...MATCHUP_TIERS, 'build'] : [...MATCHUP_TIERS];
}

function matchupGear(c: ClassId, level: number, tier: MatchupTier, sample: number) {
  return tier === 'build' ? sampleBuild(c, level - 1, sample) : gear(c, level, tier, sample);
}

/**
 * Win share of class `a` over class `d` in a bracket: both at the reference level in the same
 * gear tier, `samples` kit samples per side per tier (different rolls), `seeds` duels each.
 */
export function matchupShare(
  bracket: PvpBracket,
  a: ClassId,
  d: ClassId,
  samples: number,
  seeds: number,
  config: PvpConfig = DEFAULT_PVP_CONFIG,
): number {
  const L = bracket.referenceLevel;
  const tiers = matchupTiers(bracket);
  let share = 0;
  for (const tier of tiers) {
    for (let s = 0; s < samples; s++) {
      share += winShare(
        fighter(a, L, matchupGear(a, L, tier, s)),
        fighter(d, L, matchupGear(d, L, tier, s + 100)),
        seeds,
        `pvp-matchup:${bracket.id}:${a}:${d}:${tier}:${s}`,
        undefined,
        config,
      ).share;
    }
  }
  return share / (tiers.length * samples);
}

/**
 * The typical opponent of a bracket: a hero of the reference level in B.1's "geared" kit (one
 * common per slot at item level − 1: what a player who equips their drops wears).
 */
export const typical = (c: ClassId, bracket: PvpBracket, sample: number) =>
  fighter(c, bracket.referenceLevel, gear(c, bracket.referenceLevel, 'common', sample + 200));

/**
 * A fresh hero of a bracket: just arrived at its lowest level, in B.1's geared kit for that
 * level (nothing at level 1).
 */
export const fresh = (c: ClassId, bracket: PvpBracket, sample: number) =>
  fighter(c, bracket.min, gear(c, bracket.min, bracket.min === 1 ? 'naked' : 'common', sample));

/** Win share of `hero` against the typical opponent of every class. */
export function shareVsTypical(
  hero: PvpFighterInput,
  bracket: PvpBracket,
  samples: number,
  seeds: number,
  label: string,
): number {
  let share = 0;
  for (const c of CLASS_IDS) {
    for (let s = 0; s < samples; s++) {
      share += winShare(
        hero,
        typical(c, bracket, s),
        seeds,
        `pvp-typical:${label}:${c}:${s}`,
      ).share;
    }
  }
  return share / (CLASS_IDS.length * samples);
}
