import type { LootFocus } from '../loot/config.js';
import { createRng } from '../rng.js';
import { WEEK_MS, guildBossWeek, type GuildBossWeek } from '../guild-boss/week.js';
import type { BossEnrage, BossMechanics, EnemyScale } from '../world/dungeons.js';

/**
 * Weekly rotating boss modifiers (ticket 6.3, docs/DUNGEONS.md "Weekly boss modifiers"). Data:
 * each modifier changes how every boss fights (the crypt's Gravewarden from tier II on: tier I
 * never takes one, owner decision; the Ashen
 * Warden, the Forge Tyrant and the guild boss) and gives the boss hoards a small loot focus. One
 * modifier holds per week (the guild boss's window: Monday 00:00 UTC to the next Monday, start
 * inclusive), picked from the week alone (`bossModifierOfWeek`), so it is public and announced.
 * A run or attempt stores the modifier of the week it started in and replays with it; a stored
 * `null` (everything before 6.3) fights exactly as before.
 *
 * No modifier draws a random number: they reshape the blows and timelines the fight has anyway,
 * so a seed's other streams (rooms, loot, enrage) are untouched.
 */
export const BOSS_MODIFIER_IDS = [
  'burning',
  'warded',
  'frenzied',
  'unyielding',
  'relentless',
] as const;

export type BossModifierId = (typeof BOSS_MODIFIER_IDS)[number];

export interface BossModifierDefinition {
  id: BossModifierId;
  name: string;
  /** What it does, in plain words (the Tavern, the dungeon doors, the guild boss). */
  effect: string;
  /** Extra mechanics on the boss's fight (merged with the tier's own). */
  mechanics?: Pick<BossMechanics, 'burn' | 'ward' | 'frenzy'>;
  /** Multiplies the boss's health (a boss that cannot fall, the guild boss, ignores it). */
  healthMultiplier?: number;
  /** Multiplies how often the boss strikes (below 1: slower). */
  attackSpeedMultiplier?: number;
  /** Moves the boss's enrage window this much earlier (ms). */
  enrageEarlierMs?: number;
  /** The hoard's small loot focus while it holds (on top of the dungeon's own focus). */
  lootFocus: LootFocus;
}

export const BOSS_MODIFIERS: readonly BossModifierDefinition[] = [
  {
    id: 'burning',
    name: 'Burning',
    effect:
      'The boss smoulders: every 4 seconds its flames burn you for a third of one of its blows, whatever your armour.',
    mechanics: { burn: { everyMs: 4_000, damageShare: 1 / 3 } },
    lootFocus: {
      id: 'mod-burning',
      name: 'Fire-hardened mail',
      description: 'Helms and chest pieces drop half again as often from the hoard.',
      slots: ['head', 'chest'],
      slotWeight: 1.5,
    },
  },
  {
    id: 'warded',
    name: 'Warded',
    effect:
      'A ward rises when the boss falls to 60 % health and holds until 45 %: while it stands your blows deal 25 % less damage.',
    mechanics: { ward: { fromHealthShare: 0.6, toHealthShare: 0.45, damageTakenMultiplier: 0.75 } },
    lootFocus: {
      id: 'mod-warded',
      name: 'Warding trinkets',
      description: 'Rings and amulets drop half again as often from the hoard.',
      slots: ['ring', 'neck'],
      slotWeight: 1.5,
    },
  },
  {
    id: 'frenzied',
    name: 'Frenzied',
    effect: 'Below 40 % health the boss strikes a quarter faster.',
    mechanics: { frenzy: { belowHealthShare: 0.4, attackSpeedMultiplier: 1.25 } },
    lootFocus: {
      id: 'mod-frenzied',
      name: 'Quick hands and feet',
      description: 'Gloves and boots drop half again as often from the hoard.',
      slots: ['hands', 'feet'],
      slotWeight: 1.5,
    },
  },
  {
    id: 'unyielding',
    name: 'Unyielding',
    effect:
      'The boss has 15 % more health but strikes 15 % slower. (The guild boss cannot fall anyway: there it only strikes slower.)',
    healthMultiplier: 1.15,
    attackSpeedMultiplier: 0.85,
    lootFocus: {
      id: 'mod-unyielding',
      name: 'Siege arms',
      description: 'Weapons and off-hands drop half again as often from the hoard.',
      slots: ['weapon', 'offhand'],
      slotWeight: 1.5,
    },
  },
  {
    id: 'relentless',
    name: 'Relentless',
    effect: 'The boss’s rage comes 5 seconds sooner.',
    enrageEarlierMs: 5_000,
    lootFocus: {
      id: 'mod-relentless',
      name: 'Slayer’s lore',
      description: 'Legendaries from the hoard favour Tyrant’s Bane and Headsman’s Due.',
      effects: ['tyrants-bane', 'headsmans-due'],
      effectWeight: 2,
    },
  },
];

const BY_ID = new Map(BOSS_MODIFIERS.map((m) => [m.id, m]));

export function isBossModifierId(value: unknown): value is BossModifierId {
  return typeof value === 'string' && BY_ID.has(value as BossModifierId);
}

export function getBossModifier(id: BossModifierId): BossModifierDefinition {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`Unknown boss modifier: ${id}`);
  return def;
}

/** Monday 1970-01-05 00:00 UTC: week 0 of the rotation. */
const ROTATION_EPOCH_MS = 4 * 24 * 60 * 60 * 1000;

/** The rotation's week number of a week (0 = the week of 1970-01-05). */
export function rotationWeekIndex(week: GuildBossWeek): number {
  return Math.round((week.startMs - ROTATION_EPOCH_MS) / WEEK_MS);
}

/** One cycle's order: every modifier once, shuffled by the cycle number (Fisher–Yates). */
function cycleOrder(cycle: number): BossModifierId[] {
  const order = [...BOSS_MODIFIER_IDS];
  const rng = createRng(`boss-modifiers:${cycle}`);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/**
 * The modifier of a week (any moment in it, or the week itself). Deterministic and public: weeks
 * come in cycles of one week per modifier, each cycle in its own seeded order, so every modifier
 * holds once per cycle; a cycle never opens with the modifier the previous one closed with, so no
 * modifier holds two weeks in a row.
 */
export function bossModifierOfWeek(week: GuildBossWeek | number): BossModifierDefinition {
  const w = typeof week === 'number' ? guildBossWeek(week) : week;
  const n = rotationWeekIndex(w);
  const k = BOSS_MODIFIER_IDS.length;
  const cycle = Math.floor(n / k);
  const pos = n - cycle * k;
  const order = cycleOrder(cycle);
  // Swapping the first two never moves the last (k > 2), so the previous cycle's raw last holds.
  if (order[0] === cycleOrder(cycle - 1)[k - 1]) [order[0], order[1]] = [order[1]!, order[0]!];
  return getBossModifier(order[pos]!);
}

/** A boss's numbers before the modifier: its scale, enrage and mechanics as data has them. */
export interface BossFightData {
  scale?: EnemyScale | undefined;
  enrage: BossEnrage;
  mechanics?: BossMechanics | undefined;
}

/** The same with the modifier applied, plus how much faster the boss strikes (1 = unchanged). */
export interface ModifiedBossFight extends BossFightData {
  attackSpeedMultiplier: number;
}

/** The earliest enrage a modifier can move a window to. */
const MIN_ENRAGE_MS = 5_000;

/**
 * Applies a modifier (or none) to a boss's data. Without one it returns the data as given, so
 * every pre-6.3 fight builds exactly the same numbers.
 */
export function applyBossModifier(
  data: BossFightData,
  modifierId: BossModifierId | null | undefined,
): ModifiedBossFight {
  if (!modifierId) return { ...data, attackSpeedMultiplier: 1 };
  const m = getBossModifier(modifierId);
  const scale: EnemyScale | undefined = m.healthMultiplier
    ? {
        health: (data.scale?.health ?? 1) * m.healthMultiplier,
        damage: data.scale?.damage ?? 1,
        ...(data.scale?.resistance !== undefined ? { resistance: data.scale.resistance } : {}),
        ...(data.scale?.armor !== undefined ? { armor: data.scale.armor } : {}),
      }
    : data.scale;
  const shift = m.enrageEarlierMs ?? 0;
  const enrage: BossEnrage =
    shift > 0
      ? {
          ...data.enrage,
          atMs: {
            min: Math.max(MIN_ENRAGE_MS, data.enrage.atMs.min - shift),
            max: Math.max(MIN_ENRAGE_MS, data.enrage.atMs.max - shift),
          },
        }
      : data.enrage;
  const mechanics: BossMechanics | undefined = m.mechanics
    ? { ...data.mechanics, ...m.mechanics }
    : data.mechanics;
  return {
    ...(scale ? { scale } : {}),
    enrage,
    ...(mechanics ? { mechanics } : {}),
    attackSpeedMultiplier: m.attackSpeedMultiplier ?? 1,
  };
}
