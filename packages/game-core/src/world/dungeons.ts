import type { AreaEnemyEntry } from './areas.js';
import type { EnemyId } from './enemies.js';
import type { RarityId } from '../rarity.js';
import type { MaterialId } from './materials.js';
import {
  isUnlocked,
  unlockBlockers,
  type UnlockBlocker,
  type UnlockCharacter,
  type UnlockRule,
  type WorldProgress,
} from './unlocks.js';

/**
 * Dungeons (GDD §11.2). Data from ticket 2.1; rooms, the boss mechanic and boss loot are ticket 2.5
 * (rules in `src/dungeon/`).
 */
export const DUNGEON_IDS = ['namelessCrypt', 'ashenWatch', 'tyrantsForge'] as const;

export type DungeonId = (typeof DUNGEON_IDS)[number];

/** One room of a run: this many enemies from `DungeonDefinition.enemies`, fought one after another. */
export interface DungeonRoom {
  enemies: number;
}

/**
 * The boss's enrage timer (ticket 2.5): from `atMs` into the fight its hits deal
 * `damageMultiplier` × damage and come `attackSpeedMultiplier` × as often. A hero who cannot kill
 * the boss before then rarely survives long after.
 *
 * Ticket 3.6: `atMs` is a window. Each run draws its enrage moment from it (whole seconds, from its
 * own seed stream), so a hero who needs about as long as the window's middle wins some runs and
 * loses others: the entry is a curve instead of a cliff (docs/DUNGEONS.md, "Tiers and balance").
 */
export interface BossEnrage {
  atMs: { min: number; max: number };
  damageMultiplier: number;
  attackSpeedMultiplier: number;
}

/**
 * Ticket 6.2: extra boss mechanics on the existing fight engine (`resolveDungeonFight`). Data on a
 * tier; absent = none, so every earlier boss fights exactly as before. Neither draws a random
 * number: they reshape blows the fight makes anyway, so replays and seed streams are unchanged.
 */
export interface BossMechanics {
  /**
   * Every `every`-th blow of the boss strikes `damageMultiplier` × as hard (on top of the enrage).
   * A health check: a hero who can only just outlast its ordinary blows falls to the heavy one.
   */
  heavyBlow?: { every: number; damageMultiplier: number };
  /**
   * While the boss holds more than `untilHealthShare` of its health, the hero's blows (and thorns)
   * deal `damageTakenMultiplier` × damage. The shell breaks once, at that share (a `shellBroken`
   * event). A damage check at the start of the fight, before the enrage window opens.
   */
  shell?: { untilHealthShare: number; damageTakenMultiplier: number };
  /**
   * Ticket 6.3 (the weekly modifier "Burning"): from the start of the fight, every `everyMs` the
   * hero burns for `damageShare` × the boss's ordinary blow (after mitigation, never enraged).
   * Burns are their own timeline (`burn` events): no random draw.
   */
  burn?: { everyMs: number; damageShare: number };
  /**
   * Ticket 6.3 ("Warded"): while the boss's health share is at or below `fromHealthShare` and
   * above `toHealthShare`, the hero's blows (and thorns) deal `damageTakenMultiplier` × damage
   * (`wardRaised` / `wardBroken` events). A boss that cannot fall (the guild boss) reads the share
   * from the fight's clock instead (1 at the start, 0 at its end).
   */
  ward?: { fromHealthShare: number; toHealthShare: number; damageTakenMultiplier: number };
  /**
   * Ticket 6.3 ("Frenzied"): once the boss's health share is at or below `belowHealthShare`, its
   * blows come `attackSpeedMultiplier` × as often (a `frenzy` event; the share as for the ward).
   */
  frenzy?: { belowHealthShare: number; attackSpeedMultiplier: number };
}

/** One run's enrage: the moment drawn from `BossEnrage.atMs`. */
export interface ResolvedEnrage {
  atMs: number;
  damageMultiplier: number;
  attackSpeedMultiplier: number;
}

/** What the boss drops on a kill while boss loot is off cooldown (ticket 2.5). */
export interface DungeonBossLoot {
  /** Loot table of the boss items (`getLootTable`); its `focus` is the tier's loot focus. */
  lootTableId: string;
  /** Items rolled from it per kill. */
  items: number;
  /** Rarity weights for boss items (better odds than ordinary kills). */
  rarityWeights: Readonly<Record<RarityId, number>>;
  /** Gold range of the boss's purse. */
  gold: { min: number; max: number };
}

/** Ticket 6.3: tier IV is the crypt's Heroic tier. */
export const DUNGEON_TIERS = [1, 2, 3, 4] as const;
export type DungeonTier = (typeof DUNGEON_TIERS)[number];

/** Multipliers on an enemy's health and damage (a deeper tier's boss is more than a level up). */
export interface EnemyScale {
  health: number;
  damage: number;
  /**
   * Ticket B.2: multiplies the enemy's resistance (magic mitigation), default 1. The deeper tiers'
   * Gravewarden resists magic less, so the casters (slowest there with farmed gear) catch up.
   */
  resistance?: number;
}

/**
 * One difficulty tier of a dungeon (ticket 3.6). Every tier reuses the dungeon's rooms, enemies,
 * boss and art; a tier is only numbers and loot.
 */
export interface DungeonTierDefinition {
  tier: DungeonTier;
  /** "Tier I", … */
  name: string;
  /** Inclusive enemy level range of the rooms. */
  minLevel: number;
  maxLevel: number;
  /**
   * Character level and progress needed. Tier n > 1 also needs tier n − 1 cleared
   * (`WorldProgress.cryptTierCleared`).
   */
  unlock: UnlockRule;
  /**
   * Ticket 6.3: multipliers on the chamber enemies' stats (absent = 1: every tier before Heroic).
   * The enemy and level draws are the same; only the drawn foe is tougher.
   */
  roomScale?: EnemyScale;
  /** Ticket 6.3: the tier is a Heroic variant (drawn with the Heroic treatment). */
  heroic?: boolean;
  /** Boss level: the tier's top level. */
  bossLevel: number;
  /** Multipliers on the boss's stats at `bossLevel` (absent = 1). */
  bossScale?: EnemyScale;
  /** A boss fight that lasts longer is lost. */
  bossMaxFightMs: number;
  bossEnrage: BossEnrage;
  /** Ticket 6.2: the boss's extra mechanics in this tier (absent = none). */
  bossMechanics?: BossMechanics;
  bossLoot: DungeonBossLoot;
  /** Loot table rolled for room kills (`getLootTable`; its `focus` is the tier's loot focus). */
  lootTableId: string;
}

export interface DungeonDefinition {
  id: DungeonId;
  name: string;
  region: string;
  description: string;
  /** Asset id of the backdrop in the asset manifest. */
  assetId: string;
  /** Room enemies, picked by weight. */
  enemies: readonly AreaEnemyEntry[];
  /** Rooms before the boss, in order. */
  rooms: readonly DungeonRoom[];
  /** Walk into each room and into the boss chamber (out-of-combat regeneration applies). */
  travelMs: number;
  /** The boss at the end of a run (an enemy of rank `boss`). */
  bossId: EnemyId;
  /**
   * Ticket 6.2: the `WorldProgress` flag a boss kill sets (each dungeon keeps its own boss progress;
   * the crypt also records its tier in `cryptTierCleared`).
   */
  bossProgress: BossProgressFlag;
  /** Materials the boss always drops (one each) while boss loot is off cooldown. */
  bossDrops: readonly MaterialId[];
  /**
   * Hours until boss loot can drop again for the same character (counted from run start). One
   * cooldown for all tiers (ticket 3.6): the player chooses which tier's hoard to take.
   */
  bossLootCooldownHours: number;
  /** Difficulty tiers, in order (ticket 3.6). Tier I is the Phase 2 crypt. */
  tiers: readonly DungeonTierDefinition[];
}

/** The progress flags a dungeon boss kill sets (ticket 6.2). */
export type BossProgressFlag =
  'gravewardenDefeated' | 'ashenWardenDefeated' | 'forgeTyrantDefeated';

export const DUNGEONS: readonly DungeonDefinition[] = [
  {
    id: 'namelessCrypt',
    name: 'The Nameless Crypt',
    region: 'Graumark',
    description:
      'No one remembers whose crypt it was. Its warden remembers everyone who tried to leave.',
    assetId: 'area.nameless-crypt',
    enemies: [
      { enemyId: 'cryptGhoul', weight: 55 },
      { enemyId: 'boneAcolyte', weight: 45 },
    ],
    rooms: [{ enemies: 2 }, { enemies: 2 }, { enemies: 2 }, { enemies: 2 }],
    travelMs: 20_000,
    bossId: 'gravewarden',
    bossProgress: 'gravewardenDefeated',
    bossDrops: ['gravewardenSeal'],
    bossLootCooldownHours: 20,
    tiers: [
      {
        tier: 1,
        name: 'Tier I',
        minLevel: 12,
        maxLevel: 16,
        unlock: { level: 12 },
        bossLevel: 16,
        bossMaxFightMs: 150_000,
        bossEnrage: {
          atMs: { min: 30_000, max: 70_000 },
          damageMultiplier: 1.8,
          attackSpeedMultiplier: 1.4,
        },
        bossLoot: {
          lootTableId: 'gravewarden',
          items: 2,
          rarityWeights: {
            common: 0,
            uncommon: 3000,
            rare: 3500,
            epic: 1800,
            legendary: 250,
            mythic: 20,
          },
          gold: { min: 120, max: 180 },
        },
        lootTableId: 'namelessCrypt',
      },
      {
        tier: 2,
        name: 'Tier II',
        minLevel: 18,
        maxLevel: 21,
        unlock: { level: 18, cryptTierCleared: 1 },
        bossLevel: 21,
        bossScale: { health: 1.8, damage: 1.3, resistance: 0.5 },
        bossMaxFightMs: 150_000,
        bossEnrage: {
          atMs: { min: 30_000, max: 70_000 },
          damageMultiplier: 1.8,
          attackSpeedMultiplier: 1.4,
        },
        bossLoot: {
          lootTableId: 'gravewardenII',
          items: 2,
          rarityWeights: {
            common: 0,
            uncommon: 2000,
            rare: 3500,
            epic: 2400,
            legendary: 350,
            mythic: 30,
          },
          gold: { min: 260, max: 380 },
        },
        lootTableId: 'namelessCryptII',
      },
      {
        tier: 3,
        name: 'Tier III',
        minLevel: 21,
        maxLevel: 24,
        unlock: { level: 21, cryptTierCleared: 2 },
        bossLevel: 24,
        // Ticket 4.8: damage × 1.5 → × 2.4 (3.9: tier III fell at its entry to every hero in
        // upgraded Abbey gear). The enrage phase decides it now: upgraded epics have a chance at
        // 21, not a certainty; builds that kill before the enrage (Legendaries, BiS) are unchanged.
        bossScale: { health: 2.4, damage: 2.4, resistance: 0.5 },
        bossMaxFightMs: 150_000,
        bossEnrage: {
          atMs: { min: 30_000, max: 70_000 },
          damageMultiplier: 1.8,
          attackSpeedMultiplier: 1.4,
        },
        bossLoot: {
          lootTableId: 'gravewardenIII',
          items: 2,
          rarityWeights: {
            common: 0,
            uncommon: 1000,
            rare: 3500,
            epic: 3000,
            legendary: 500,
            mythic: 45,
          },
          gold: { min: 420, max: 600 },
        },
        lootTableId: 'namelessCryptIII',
      },
      {
        // Ticket 6.3: the Heroic crypt (owner decision: tier III stays the Legendary tier). The same
        // crypt at levels 32–36 with tougher chambers and a harder Gravewarden variant (scaled and
        // with a tolling heavy blow), for upgraded Verge Legendaries. It pays in odds, not in power:
        // item levels 32–36 sit inside the Verge's and the Depths' bands (no new item level or
        // affix tier), with far better Legendary, Mythic, set and Void odds than tier III.
        tier: 4,
        name: 'Heroic',
        heroic: true,
        minLevel: 32,
        maxLevel: 36,
        unlock: { level: 32, cryptTierCleared: 3 },
        roomScale: { health: 1.6, damage: 1.6 },
        bossLevel: 36,
        bossScale: { health: 3.4, damage: 2.6, resistance: 0.5 },
        bossMaxFightMs: 150_000,
        bossEnrage: {
          atMs: { min: 30_000, max: 60_000 },
          damageMultiplier: 2,
          attackSpeedMultiplier: 1.4,
        },
        bossMechanics: { heavyBlow: { every: 4, damageMultiplier: 3 } },
        bossLoot: {
          lootTableId: 'gravewardenIV',
          items: 2,
          rarityWeights: {
            common: 0,
            uncommon: 0,
            rare: 2500,
            epic: 3500,
            legendary: 1100,
            mythic: 110,
          },
          gold: { min: 1_000, max: 1_500 },
        },
        lootTableId: 'namelessCryptIV',
      },
    ],
  },
  {
    // Ticket 4.8: the Ashen Pass's boss. A boss-only run (no chambers): the walk up the tower, then
    // the Ashen Warden, with the crypt's rules (snapshot, seed streams, enrage window, claim, its
    // own hoard cooldown). Opens with the Ashen Pass (the community's world flag) at level 26.
    id: 'ashenWatch',
    name: 'The Warden’s Watch',
    region: 'Graumark',
    description:
      'The last watchtower of the pass. Its warden never left the fire, and the fire never left him.',
    assetId: 'area.ashen-pass',
    enemies: [],
    rooms: [],
    travelMs: 30_000,
    bossId: 'ashenWarden',
    bossProgress: 'ashenWardenDefeated',
    bossDrops: [],
    bossLootCooldownHours: 20,
    tiers: [
      {
        tier: 1,
        name: 'The Watch',
        minLevel: 26,
        maxLevel: 28,
        unlock: { level: 26, gravewardenDefeated: true, worldFlag: 'ashenPassCleared' },
        bossLevel: 28,
        bossMaxFightMs: 150_000,
        bossEnrage: {
          atMs: { min: 25_000, max: 55_000 },
          damageMultiplier: 2,
          attackSpeedMultiplier: 1.4,
        },
        bossLoot: {
          lootTableId: 'ashenWarden',
          items: 2,
          rarityWeights: {
            common: 0,
            uncommon: 500,
            rare: 3000,
            epic: 3500,
            legendary: 700,
            mythic: 60,
          },
          gold: { min: 700, max: 1_000 },
        },
        lootTableId: 'ashenPass',
      },
    ],
  },
  {
    // Ticket 6.2: the Cinderwastes' region boss. A boss-only run like the Watch (the descent to
    // the furnace, then the Forge Tyrant), with its rules (snapshot, seed streams, enrage window,
    // claim, its own hoard cooldown) plus two mechanics: a slag shell and a hammer. Opens with
    // the Cinder Depths at level 36. His hoard is always bound (source `hoard:tyrantsForge`) and
    // carries his ember, the input of the Tyrantforged Work recipe (docs/ECONOMY.md).
    id: 'tyrantsForge',
    name: 'The Tyrant’s Forge',
    region: 'The Cinderwastes',
    description:
      'At the bottom of the Depths a furnace older than Graumark still burns. Its smith wears the slag as armour.',
    assetId: 'area.cinder-depths',
    enemies: [],
    rooms: [],
    travelMs: 30_000,
    bossId: 'forgeTyrant',
    bossProgress: 'forgeTyrantDefeated',
    bossDrops: ['tyrantsEmber'],
    bossLootCooldownHours: 20,
    tiers: [
      {
        tier: 1,
        name: 'The Forge',
        minLevel: 36,
        maxLevel: 40,
        unlock: { level: 36, ashenWardenDefeated: true },
        bossLevel: 40,
        bossMaxFightMs: 150_000,
        bossEnrage: {
          atMs: { min: 35_000, max: 65_000 },
          damageMultiplier: 2,
          attackSpeedMultiplier: 1.4,
        },
        bossMechanics: {
          shell: { untilHealthShare: 0.7, damageTakenMultiplier: 0.6 },
          heavyBlow: { every: 3, damageMultiplier: 4 },
        },
        bossLoot: {
          lootTableId: 'forgeTyrant',
          items: 2,
          rarityWeights: {
            common: 0,
            uncommon: 500,
            rare: 3000,
            epic: 3500,
            legendary: 700,
            mythic: 60,
          },
          gold: { min: 1_400, max: 2_000 },
        },
        lootTableId: 'cinderDepths',
      },
    ],
  },
];

const DUNGEONS_BY_ID = new Map(DUNGEONS.map((d) => [d.id, d]));

export function isDungeonId(value: unknown): value is DungeonId {
  return typeof value === 'string' && (DUNGEON_IDS as readonly string[]).includes(value);
}

export function getDungeon(id: DungeonId): DungeonDefinition {
  const def = DUNGEONS_BY_ID.get(id);
  if (!def) throw new Error(`Unknown dungeon: ${id}`);
  return def;
}

export function isDungeonTier(value: unknown): value is DungeonTier {
  return typeof value === 'number' && (DUNGEON_TIERS as readonly number[]).includes(value);
}

/** Whether the dungeon has this tier (ticket 4.8: the Warden's Watch has only tier I). */
export function hasDungeonTier(id: DungeonId, tier: DungeonTier): boolean {
  return getDungeon(id).tiers.some((t) => t.tier === tier);
}

/** A tier of a dungeon (ticket 3.6). */
export function getDungeonTier(id: DungeonId, tier: DungeonTier = 1): DungeonTierDefinition {
  const def = getDungeon(id).tiers.find((t) => t.tier === tier);
  if (!def) throw new Error(`Unknown tier ${tier} of dungeon ${id}`);
  return def;
}

/** Whether a dungeon tier is open to a character (tier I: the dungeon's own unlock). */
export function isDungeonUnlocked(
  dungeonId: DungeonId,
  character: UnlockCharacter,
  progress: WorldProgress,
  tier: DungeonTier = 1,
): boolean {
  return isUnlocked(getDungeonTier(dungeonId, tier).unlock, character, progress);
}

export function dungeonUnlockBlockers(
  dungeonId: DungeonId,
  character: UnlockCharacter,
  progress: WorldProgress,
  tier: DungeonTier = 1,
): UnlockBlocker[] {
  return unlockBlockers(getDungeonTier(dungeonId, tier).unlock, character, progress);
}
