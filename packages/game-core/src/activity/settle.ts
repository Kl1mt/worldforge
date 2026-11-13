import { setBonusInstances } from '../items/sets.js';
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
import { DEFAULT_ACTIVITY_CONFIG, type ActivityConfig } from './config.js';
import { equipmentModifiers, type EquippedItem } from './equipment.js';
import { createDropPlacer, type FilteredDrop } from './placement.js';
import type { LootFilterRules } from '../economy/lootFilter.js';
import type { Loadout } from '../combat/kit.js';

export interface SettleFarmingInput {
  character: FarmingCharacter;
  /** The equipped items (persisted `GeneratedItem` columns, effect columns included). */
  equipment?: readonly EquippedItem[];
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
  /**
   * Ticket 3.7: the character's loot filter, read once for the whole window (the server snapshots
   * it under the character lock). Null or absent = no filter: the result is exactly as before.
   */
  lootFilter?: LootFilterRules | null;
  /** Ticket 9.1 (prototype): the hero's loadout; read only while the skills prototype is on. */
  loadout?: Loadout | null;
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
  /** Bloodrush stacks at the window end (ticket 3.2); carry it into the next settlement. */
  momentum: number;
  /** Ticket 9.1 (prototype): Soul Fragments carried to the next window (only with a kit that uses them). */
  soulFragments?: number;
  /** Gold dropped by kills (after gold find). */
  goldLooted: number;
  /** Gold from items salvaged because the inventory was full. */
  goldSalvaged: number;
  /** Items to add to the inventory, in drop order. */
  items: GeneratedItem[];
  /**
   * Ticket B.2: valuable drops (Legendary, Mythic, set, Void) among `items` that found no room and
   * were kept beyond the pack's capacity.
   */
  overCapacity: GeneratedItem[];
  /** Ordinary items that did not fit and were salvaged to gold. */
  salvaged: GeneratedItem[];
  /**
   * Ticket 3.7: drops the loot filter sold or salvaged, in drop order (they took no pack space).
   * Present only when a filter was given. Their gold and materials are not in `goldLooted`,
   * `goldSalvaged` or `materials` (which feed quests): see `filteredTotals`.
   */
  filtered?: FilteredDrop[];
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
        momentum: first.momentum,
        ...(first.soulFragments !== undefined ? { soulFragments: first.soulFragments } : {}),
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
    momentum: second.momentum,
    ...(second.soulFragments !== undefined ? { soulFragments: second.soulFragments } : {}),
    goldLooted: first.goldLooted + second.goldLooted,
    goldSalvaged: first.goldSalvaged + second.goldSalvaged,
    items: [...first.items, ...second.items],
    overCapacity: [...first.overCapacity, ...second.overCapacity],
    salvaged: [...first.salvaged, ...second.salvaged],
    ...(first.filtered ? { filtered: [...first.filtered, ...(second.filtered ?? [])] } : {}),
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
  const equipment = input.equipment ?? [];
  const modifiers = equipmentModifiers(equipment, activity.modifierCaps, lootConfig, {
    classId: input.character.classId,
    extraEffects: setBonusInstances(equipment),
  });
  const placer = createDropPlacer(input.inventoryCount, activity.inventory, input.lootFilter);
  let goldLooted = 0;
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
      effects: modifiers.effects,
      areaId: input.areaId,
      seed: input.seed,
      durationMs: input.durationMs,
      firstCycle: input.firstCycle,
      ...(maxCycles !== undefined ? { maxCycles } : {}),
      ...(input.loadout ? { loadout: input.loadout } : {}),
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
        for (const item of drop.items) placer.place(item);
      },
    },
  );

  const { items, overCapacity, salvaged, goldSalvaged, filtered } = placer.result();
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
    momentum: r.momentum,
    ...(r.soulFragments !== undefined ? { soulFragments: r.soulFragments } : {}),
    goldLooted,
    goldSalvaged,
    items,
    overCapacity,
    salvaged,
    ...(filtered ? { filtered } : {}),
    goldFind: modifiers.goldFind,
    materials,
    professions,
    professionXpGained,
  };
}
