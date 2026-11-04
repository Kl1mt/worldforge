import { simulateFarmingAggregate, type FarmingCharacter } from '../combat/farming.js';
import { DEFAULT_COMBAT_CONFIG, type CombatConfig } from '../combat/encounter.js';
import { DEFAULT_LOOT_CONFIG, STANDARD_LOOT_TABLE, type LootConfig } from '../loot/config.js';
import { rollLoot, type GeneratedItem } from '../loot/generate.js';
import { createRng } from '../rng.js';
import { getArea, type AreaId } from '../world/areas.js';
import type { EnemyId } from '../world/enemies.js';
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
}

export interface SettleFarmingOptions {
  activity?: ActivityConfig;
  combat?: CombatConfig;
  loot?: LootConfig;
}

export interface FarmingSettlement {
  durationMs: number;
  simulatedMs: number;
  /** Time of an unfinished cycle at the end of the window; carry it into the next settlement. */
  unusedMs: number;
  encounters: number;
  kills: number;
  killsByEnemy: Record<EnemyId, number>;
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
 * The loot source level is the character's level at the start of the killing cycle, clamped to
 * the area's enemy levels.
 */
export function settleFarming(
  input: SettleFarmingInput,
  options: SettleFarmingOptions = {},
): FarmingSettlement {
  const activity = options.activity ?? DEFAULT_ACTIVITY_CONFIG;
  const combat = options.combat ?? DEFAULT_COMBAT_CONFIG;
  const lootConfig = options.loot ?? DEFAULT_LOOT_CONFIG;
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
  const modifiers = equipmentModifiers(input.equipment ?? [], activity.modifierCaps, lootConfig);
  const items: GeneratedItem[] = [];
  const salvaged: GeneratedItem[] = [];
  let goldLooted = 0;
  let goldSalvaged = 0;
  let free = Math.max(0, activity.inventory.capacity - input.inventoryCount);

  const r = simulateFarmingAggregate(
    {
      character: input.character,
      equipment: modifiers.stats,
      areaId: input.areaId,
      seed: input.seed,
      durationMs: input.durationMs,
      firstCycle: input.firstCycle,
    },
    {
      config: combat,
      onCycle: (cycle) => {
        if (cycle.outcome !== 'kill') return;
        const sourceLevel = Math.min(area.maxLevel, Math.max(area.minLevel, cycle.level));
        const drop = rollLoot(
          {
            rng: createRng(`${input.seed}:loot:${cycle.index}`),
            sourceLevel,
            lootTable: STANDARD_LOOT_TABLE,
            goldFind: modifiers.goldFind,
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
  };
}
