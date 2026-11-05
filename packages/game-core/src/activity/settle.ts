import { simulateFarmingAggregate, type FarmingCharacter } from '../combat/farming.js';
import { DEFAULT_COMBAT_CONFIG, type CombatConfig } from '../combat/encounter.js';
import { DEFAULT_LOOT_CONFIG, getLootTable, type LootConfig } from '../loot/config.js';
import { rollLoot, type GeneratedItem } from '../loot/generate.js';
import { createRng } from '../rng.js';
import { getArea, type AreaId } from '../world/areas.js';
import type { EnemyId } from '../world/enemies.js';
import { getMaterial, type MaterialId, type ProfessionId } from '../world/materials.js';
import { DEFAULT_PROFESSION_CONFIG, type ProfessionConfig } from '../professions/config.js';
import { rollGathering } from '../professions/gathering.js';
import {
  applyProfessionXp,
  normalizeProfessions,
  type ProfessionLevels,
  type ProfessionState,
} from '../professions/progression.js';
import { DEFAULT_ACTIVITY_CONFIG, type ActivityConfig, type InventoryConfig } from './config.js';
import { equipmentModifiers } from './equipment.js';

export interface SettleFarmingInput {
  character: FarmingCharacter;
  /** The equipped items (persisted `GeneratedItem` columns). */
  equipment?: readonly Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel' | 'affixes'>[];
  areaId: AreaId;
  /** Server-derived seed, constant for the activity. Never accept a seed from the client. */
  seed: string;
  /**
   * Global index of the first cycle in this window: the number of cycles the activity has
   * completed so far. Advance it by `encounters` after each settlement.
   */
  firstCycle: number;
  /** Window to settle in ms, including time carried over from the previous settlement. */
  durationMs: number;
  /** Unequipped items the character already holds (for the capacity rule). */
  inventoryCount: number;
  /**
   * A pending area switch (ticket 2.2). The first cycle of the window — the cycle that was in
   * progress when the switch was requested — still runs in `areaId`; every later cycle runs here.
   * If the window ends before that first cycle completes, nothing switches (`areaId` of the result
   * stays the old area) and the whole window is carried, as usual.
   */
  switchToAreaId?: AreaId;
  /** Profession levels at the window start (ticket 2.3); missing professions are level 1. */
  professions?: Partial<Record<ProfessionId, ProfessionState>>;
}

export interface SettleFarmingOptions {
  activity?: ActivityConfig;
  combat?: CombatConfig;
  loot?: LootConfig;
  professions?: ProfessionConfig;
}

export interface FarmingSettlement {
  /** Area farmed at the end of the window (the switch target once a pending switch happened). */
  areaId: AreaId;
  /** Whether a pending switch (`switchToAreaId`) took effect in this window. */
  switched: boolean;
  /** With `switched`: ms from the window start until the switch (the first cycle's length). */
  switchedAtMs: number | null;
  durationMs: number;
  simulatedMs: number;
  /** Time of an unfinished cycle at the end of the window; carry it into the next settlement. */
  unusedMs: number;
  encounters: number;
  kills: number;
  killsByEnemy: Partial<Record<EnemyId, number>>;
  deaths: number;
  timeouts: number;
  damageTaken: number;
  xpGained: number;
  startLevel: number;
  level: number;
  xp: number;
  levelsGained: number;
  health: number;
  maxHealth: number;
  /** Gold dropped by kills (after gold find). */
  goldLooted: number;
  /** Gold from items salvaged because the inventory was full. */
  goldSalvaged: number;
  /** Items to add to the inventory, in drop order. */
  items: GeneratedItem[];
  /** Items that did not fit and were salvaged to gold. */
  salvaged: GeneratedItem[];
  /** Gold find used for the drops (already capped). */
  goldFind: number;
  /** Materials gathered or dropped (ticket 2.3); only ids with a positive quantity. */
  materials: Partial<Record<MaterialId, number>>;
  /** Profession levels at the window end. */
  professions: ProfessionLevels;
  /** Profession XP earned in the window (before the cap discards any). */
  professionXpGained: Partial<Record<ProfessionId, number>>;
}

function addCounts<K extends string>(
  a: Partial<Record<K, number>>,
  b: Partial<Record<K, number>>,
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = { ...a };
  for (const [k, n] of Object.entries(b) as [K, number][]) out[k] = (out[k] ?? 0) + n;
  return out;
}

/** Gold an overflow item is salvaged for. */
export function salvageValue(
  item: Pick<GeneratedItem, 'rarityId' | 'itemLevel'>,
  config: InventoryConfig = DEFAULT_ACTIVITY_CONFIG.inventory,
): number {
  const { base, perItemLevel, rarityMultiplier } = config.salvage;
  return Math.max(
    1,
    Math.round((base + perItemLevel * item.itemLevel) * rarityMultiplier[item.rarityId]),
  );
}

/**
 * Settles a farming window: aggregate combat (`simulateFarmingAggregate`) plus one `rollLoot` per
 * kill. Pure and deterministic for the same input.
 *
 * Every cycle draws from its own RNG streams, keyed by its global index (`firstCycle` + position):
 * combat `${seed}:${index}`, loot `${seed}:loot:${index}`. An unfinished cycle at the window end is
 * not applied; its time comes back as `unusedMs` and the next settlement (starting at
 * `firstCycle + encounters`) replays it with the same streams. So the result of a span of farming
 * does not depend on how it was split into settlements: settling every second gives exactly what
 * one settlement at the end gives (ticket 1.9; before, each window re-rolled the unfinished cycle,
 * which favoured short cycles and let frequent settling avoid deaths).
 *
 * Gathering (ticket 2.3): every committed cycle the hero survives rolls the area's material yields
 * from `${seed}:gather:${index}` with the profession levels at the start of that cycle; profession
 * XP is applied per cycle, so later cycles of the same window use the new levels. Like loot, it is
 * split-invariant: the unfinished cycle gathers nothing until it is committed.
 *
 * Kills roll the area's loot table (`AreaDefinition.lootTableId`, ticket 2.1). The loot source
 * level is the character's level at the start of the killing cycle, clamped to the area's enemy
 * levels.
 */
export function settleFarming(
  input: SettleFarmingInput,
  options: SettleFarmingOptions = {},
): FarmingSettlement {
  const { switchToAreaId, ...rest } = input;
  if (switchToAreaId === undefined || switchToAreaId === input.areaId) {
    return settleSegment(rest, options);
  }
  // The cycle in progress finishes where it started, then the character travels.
  const first = settleSegment(rest, options, 1);
  if (first.encounters === 0) return first;
  const second = settleSegment(
    {
      ...rest,
      areaId: switchToAreaId,
      character: {
        classId: input.character.classId,
        level: first.level,
        xp: first.xp,
        health: first.health,
      },
      professions: first.professions,
      firstCycle: input.firstCycle + first.encounters,
      durationMs: first.unusedMs,
      inventoryCount: input.inventoryCount + first.items.length,
    },
    options,
  );
  const killsByEnemy = addCounts(first.killsByEnemy, second.killsByEnemy);
  return {
    areaId: switchToAreaId,
    switched: true,
    switchedAtMs: first.simulatedMs,
    durationMs: input.durationMs,
    simulatedMs: first.simulatedMs + second.simulatedMs,
    unusedMs: second.unusedMs,
    encounters: first.encounters + second.encounters,
    kills: first.kills + second.kills,
    killsByEnemy,
    deaths: first.deaths + second.deaths,
    timeouts: first.timeouts + second.timeouts,
    damageTaken: first.damageTaken + second.damageTaken,
    xpGained: first.xpGained + second.xpGained,
    startLevel: first.startLevel,
    level: second.level,
    xp: second.xp,
    levelsGained: second.level - first.startLevel,
    health: second.health,
    maxHealth: second.maxHealth,
    goldLooted: first.goldLooted + second.goldLooted,
    goldSalvaged: first.goldSalvaged + second.goldSalvaged,
    items: [...first.items, ...second.items],
    salvaged: [...first.salvaged, ...second.salvaged],
    goldFind: second.goldFind,
    materials: addCounts(first.materials, second.materials),
    professions: second.professions,
    professionXpGained: addCounts(first.professionXpGained, second.professionXpGained),
  };
}

/** One area, at most `maxCycles` cycles. */
function settleSegment(
  input: Omit<SettleFarmingInput, 'switchToAreaId'>,
  options: SettleFarmingOptions,
  maxCycles?: number,
): FarmingSettlement {
  const activity = options.activity ?? DEFAULT_ACTIVITY_CONFIG;
  const combat = options.combat ?? DEFAULT_COMBAT_CONFIG;
  const lootConfig = options.loot ?? DEFAULT_LOOT_CONFIG;
  const professionConfig = options.professions ?? DEFAULT_PROFESSION_CONFIG;
  if (!Number.isInteger(input.durationMs) || input.durationMs < 0) {
    throw new RangeError(`Invalid duration: ${input.durationMs}`);
  }
  if (!Number.isInteger(input.inventoryCount) || input.inventoryCount < 0) {
    throw new RangeError(`Invalid inventoryCount: ${input.inventoryCount}`);
  }
  if (!Number.isSafeInteger(input.firstCycle) || input.firstCycle < 0) {
    throw new RangeError(`Invalid firstCycle: ${input.firstCycle}`);
  }

  const area = getArea(input.areaId);
  const lootTable = getLootTable(area.lootTableId);
  const modifiers = equipmentModifiers(input.equipment ?? [], activity.modifierCaps, lootConfig);
  const items: GeneratedItem[] = [];
  const salvaged: GeneratedItem[] = [];
  let goldLooted = 0;
  let goldSalvaged = 0;
  let free = Math.max(0, activity.inventory.capacity - input.inventoryCount);
  const professions = normalizeProfessions(input.professions, professionConfig);
  const materials: Partial<Record<MaterialId, number>> = {};
  const professionXpGained: Partial<Record<ProfessionId, number>> = {};

  const r = simulateFarmingAggregate(
    {
      character: input.character,
      equipment: modifiers.stats,
      modifiers: {
        xpGain: modifiers.xpGain,
        skillDamage: modifiers.skillDamage,
        bossDamage: modifiers.bossDamage,
      },
      areaId: input.areaId,
      seed: input.seed,
      durationMs: input.durationMs,
      firstCycle: input.firstCycle,
      ...(maxCycles !== undefined ? { maxCycles } : {}),
    },
    {
      config: combat,
      onCycle: (cycle) => {
        const finds = rollGathering(
          { areaId: input.areaId, outcome: cycle.outcome, enemyId: cycle.enemyId },
          professions,
          createRng(`${input.seed}:gather:${cycle.index}`),
          professionConfig,
          modifiers.resourceYield,
        );
        for (const f of finds) {
          materials[f.materialId] = (materials[f.materialId] ?? 0) + f.quantity;
          if (!f.professionId) continue;
          const xp = f.quantity * professionConfig.xpPerUnit[getMaterial(f.materialId).rarity];
          professionXpGained[f.professionId] = (professionXpGained[f.professionId] ?? 0) + xp;
          professions[f.professionId] = applyProfessionXp(
            professions[f.professionId],
            xp,
            professionConfig,
          );
        }
        if (cycle.outcome !== 'kill') return;
        const sourceLevel = Math.min(area.maxLevel, Math.max(area.minLevel, cycle.level));
        const drop = rollLoot(
          {
            rng: createRng(`${input.seed}:loot:${cycle.index}`),
            sourceLevel,
            lootTable,
            goldFind: modifiers.goldFind,
            itemFind: modifiers.itemFind,
            classId: input.character.classId,
          },
          lootConfig,
        );
        goldLooted += drop.gold;
        for (const item of drop.items) {
          if (free > 0) {
            items.push(item);
            free--;
          } else {
            salvaged.push(item);
            goldSalvaged += salvageValue(item, activity.inventory);
          }
        }
      },
    },
  );

  return {
    areaId: input.areaId,
    switched: false,
    switchedAtMs: null,
    durationMs: input.durationMs,
    simulatedMs: r.simulatedMs,
    unusedMs: r.unusedMs,
    encounters: r.encounters,
    kills: r.kills,
    killsByEnemy: r.killsByEnemy,
    deaths: r.deaths,
    timeouts: r.timeouts,
    damageTaken: r.damageTaken,
    xpGained: r.xpGained,
    startLevel: r.startLevel,
    level: r.level,
    xp: r.xp,
    levelsGained: r.levelsGained,
    health: r.health,
    maxHealth: r.maxHealth,
    goldLooted,
    goldSalvaged,
    items,
    salvaged,
    goldFind: modifiers.goldFind,
    materials,
    professions,
    professionXpGained,
  };
}
