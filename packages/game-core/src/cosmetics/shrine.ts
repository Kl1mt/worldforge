import { createRng } from '../rng.js';
import { PRESTIGE_TIER_IDS, type PrestigeTier } from '../scoring/prestige.js';
import {
  COSMETICS,
  findCosmetic,
  type CosmeticDefinition,
  type ShrineRarity,
} from './catalogue.js';

/**
 * The Reward Shrine (ticket 9.5, GDD §13.2, docs/SHRINE.md). Cosmetic only: a draw grants a
 * catalogue cosmetic of the Shrine's pool, or Shrine marks when the account already owns it, and
 * marks buy a chosen cosmetic of the pool. Nothing here is read by a gameplay rule (the import scan
 * in `cosmetics.test.ts` covers this file), and nothing here has a price in money: draws come from
 * a free one a day (banked up to `SHRINE_BANK_LIMIT`) and from play (`SHRINE_PLAY_DRAWS`). Every
 * draw grant records its source; `shop` is reserved for ROADMAP 8.8 and granted by nothing yet.
 *
 * A draw is a pure function of its seed (`drawShrine`), so the server stores the `crypto` seed with
 * the draw and anyone can replay it. The pick ignores what the account owns, so the published odds
 * are exactly the odds of every draw; owning it only turns the grant into marks.
 */

/** The rarities, commonest first. */
export const SHRINE_RARITIES: readonly ShrineRarity[] = ['common', 'rare', 'hallowed'];

/**
 * Each rarity's weight out of `SHRINE_WEIGHT_TOTAL`: the chance a draw lands in it. Within a
 * rarity every cosmetic is equally likely.
 */
export const SHRINE_RARITY_WEIGHTS: Readonly<Record<ShrineRarity, number>> = {
  common: 700,
  rare: 250,
  hallowed: 50,
};
export const SHRINE_WEIGHT_TOTAL = 1000;

/** Marks a duplicate of each rarity turns into. */
export const SHRINE_DUPLICATE_MARKS: Readonly<Record<ShrineRarity, number>> = {
  common: 2,
  rare: 5,
  hallowed: 15,
};

/** Marks that buy a chosen cosmetic of each rarity (the marks shop). */
export const SHRINE_MARK_PRICES: Readonly<Record<ShrineRarity, number>> = {
  common: 10,
  rare: 25,
  hallowed: 75,
};

/** Free daily draws kept unclaimed at most: a missed day is never lost within the bank. */
export const SHRINE_BANK_LIMIT = 7;

/**
 * Where a draw comes from: `daily` (the free draw of each UTC day), `play` (event tiers, season
 * honours, deeds) and, reserved for ROADMAP 8.8 after its legal review, `shop` (nothing grants it).
 */
export type ShrineDrawSource = 'daily' | 'play' | 'shop';
export const SHRINE_DRAW_SOURCES: readonly ShrineDrawSource[] = ['daily', 'play', 'shop'];

/** Draws earned in play (data; the server grants them once per source key). */
export const SHRINE_PLAY_DRAWS = {
  /** Each tier of an event's reward track reached. */
  eventTier: 1,
  /** A deed (achievement) awarded. */
  deed: 1,
  /** A season's honours, by the account's best tier that season. */
  season: { veteran: 1, renowned: 2, exalted: 3, champion: 4 } as Readonly<
    Record<PrestigeTier, number>
  >,
} as const;

/** The draws an account's best honour tiers of one season earn (0 without one). */
export function shrineSeasonDraws(tiers: Iterable<PrestigeTier>): number {
  let best = Infinity;
  for (const t of tiers) best = Math.min(best, PRESTIGE_TIER_IDS.indexOf(t));
  if (!Number.isFinite(best)) return 0;
  return SHRINE_PLAY_DRAWS.season[PRESTIGE_TIER_IDS[best]!];
}

export interface ShrineEntry {
  cosmeticId: string;
  kind: CosmeticDefinition['kind'];
  rarity: ShrineRarity;
}

/** The pool in catalogue order. */
export const SHRINE_POOL: readonly ShrineEntry[] = COSMETICS.flatMap((c) =>
  c.source.kind === 'shrine' ? [{ cosmeticId: c.id, kind: c.kind, rarity: c.source.rarity }] : [],
);

const BY_RARITY: Readonly<Record<ShrineRarity, readonly ShrineEntry[]>> = {
  common: SHRINE_POOL.filter((e) => e.rarity === 'common'),
  rare: SHRINE_POOL.filter((e) => e.rarity === 'rare'),
  hallowed: SHRINE_POOL.filter((e) => e.rarity === 'hallowed'),
};

export function shrineEntry(cosmeticId: string): ShrineEntry | undefined {
  return SHRINE_POOL.find((e) => e.cosmeticId === cosmeticId);
}

export function isShrineCosmetic(cosmeticId: string): boolean {
  return findCosmetic(cosmeticId)?.source.kind === 'shrine';
}

export interface ShrineOdds {
  cosmeticId: string;
  rarity: ShrineRarity;
  /** Exact chance as a fraction (`weight / SHRINE_WEIGHT_TOTAL / count in the rarity`). */
  chance: number;
}

/** The published odds: every cosmetic's exact chance (they sum to 1). */
export function shrineOdds(): ShrineOdds[] {
  return SHRINE_POOL.map((e) => ({
    cosmeticId: e.cosmeticId,
    rarity: e.rarity,
    chance: SHRINE_RARITY_WEIGHTS[e.rarity] / SHRINE_WEIGHT_TOTAL / BY_RARITY[e.rarity].length,
  }));
}

/** A rarity's chance (the sum of its cosmetics'). */
export function shrineRarityChance(rarity: ShrineRarity): number {
  return SHRINE_RARITY_WEIGHTS[rarity] / SHRINE_WEIGHT_TOTAL;
}

export interface ShrineDraw {
  cosmeticId: string;
  rarity: ShrineRarity;
}

/**
 * The cosmetic a seed draws. Pure: the server stores the seed (from `crypto`) with the draw and
 * replays it with this. Two rolls from one stream: the rarity by weight, then one of its cosmetics.
 */
export function drawShrine(seed: string): ShrineDraw {
  const rng = createRng(`shrine:${seed}`);
  const roll = rng.int(0, SHRINE_WEIGHT_TOTAL - 1);
  let rarity: ShrineRarity = 'common';
  let acc = 0;
  for (const r of SHRINE_RARITIES) {
    acc += SHRINE_RARITY_WEIGHTS[r];
    if (roll < acc) {
      rarity = r;
      break;
    }
  }
  const entries = BY_RARITY[rarity];
  const entry = entries[rng.int(0, entries.length - 1)]!;
  return { cosmeticId: entry.cosmeticId, rarity };
}

export interface ShrineOutcome extends ShrineDraw {
  /** `grant`: the cosmetic is new to the account; `marks`: a duplicate, paid in marks. */
  outcome: 'grant' | 'marks';
  marks: number;
}

/** What a draw pays an account that owns `owned` (cosmetic ids). */
export function shrineOutcome(seed: string, owned: ReadonlySet<string>): ShrineOutcome {
  const d = drawShrine(seed);
  return owned.has(d.cosmeticId)
    ? { ...d, outcome: 'marks', marks: SHRINE_DUPLICATE_MARKS[d.rarity] }
    : { ...d, outcome: 'grant', marks: 0 };
}

/** The marks a pool cosmetic costs, or null for one not in the pool. */
export function shrineMarkPrice(cosmeticId: string): number | null {
  const e = shrineEntry(cosmeticId);
  return e ? SHRINE_MARK_PRICES[e.rarity] : null;
}

/** Why the marks shop refuses `cosmeticId`, or null when it can be bought. */
export function shrinePurchaseProblem(
  cosmeticId: string,
  owned: ReadonlySet<string>,
  marks: number,
): 'unknown_offer' | 'already_owned' | 'insufficient_marks' | null {
  const price = shrineMarkPrice(cosmeticId);
  if (price === null) return 'unknown_offer';
  if (owned.has(cosmeticId)) return 'already_owned';
  return marks < price ? 'insufficient_marks' : null;
}

/** A UTC day number (days since 1970-01-01). */
export function shrineDay(at: Date | number): number {
  return Math.floor((typeof at === 'number' ? at : at.getTime()) / 86_400_000);
}

/**
 * The free-draw bank's accrual. `through` is the last UTC day already accrued, `unspent` the free
 * draws not yet used. Each day after `through` up to `today` adds one free draw while fewer than
 * `SHRINE_BANK_LIMIT` are unspent; days while the bank is full add nothing. Returns the draws to
 * grant now (≥ 0) and the new `through` (`today`, or `through` when the clock went back).
 */
export function shrineAccrual(
  through: number,
  unspent: number,
  today: number,
): { grant: number; through: number } {
  if (today <= through) return { grant: 0, through };
  const room = Math.max(0, SHRINE_BANK_LIMIT - unspent);
  return { grant: Math.min(room, today - through), through: today };
}

/**
 * Where a new account's bank starts: the day before the account was made, so the day it is made
 * already holds a free draw (and an older account opens the Shrine with a full bank).
 */
export function shrineBankStart(accountCreatedAt: Date): number {
  return shrineDay(accountCreatedAt) - 1;
}

/**
 * Which kind of draw a draw spends: free daily draws first (so the bank makes room for tomorrow's),
 * then play draws, then (later) shop draws. Null when the account holds none.
 */
export function shrineSpendSource(
  unspent: Readonly<Record<ShrineDrawSource, number>>,
): ShrineDrawSource | null {
  return SHRINE_DRAW_SOURCES.find((s) => unspent[s] > 0) ?? null;
}
