import { simulateFarmingAggregate, type FarmingCharacter } from '../combat/farming.js';
import { DEFAULT_COMBAT_CONFIG, type CombatConfig } from '../combat/encounter.js';
import { DEFAULT_LOOT_CONFIG, STANDARD_LOOT_TABLE, type LootConfig } from '../loot/config.js';
import { rollLoot, type GeneratedItem } from '../loot/generate.js';
import { createRng } from '../rng.js';
import { getArea, type AreaId } from '../world/areas.js';
import { ENEMY_IDS, type EnemyId } from '../world/enemies.js';
import { DEFAULT_ACTIVITY_CONFIG, type ActivityConfig, type InventoryConfig } from './config.js';
import { equipmentModifiers } from './equipment.js';

export interface SettleFarmingInput {
  character: FarmingCharacter;
  /** The equipped items (persisted `GeneratedItem` columns). */
  equipment?: readonly Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel' | 'affixes'>[];
  areaId: AreaId;
  /** Server-derived seed. Never accept a seed from the client. */
  seed: string;
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
 * kill. Pure and deterministic for the same input. The window is simulated in `chunkMs` chunks so
 * that the loot source level (the character's level, clamped to the area's enemy levels) follows
 * level-ups; unfinished cycle time is carried between chunks and returned as `unusedMs`.
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
  if (!Number.isInteger(activity.chunkMs) || activity.chunkMs <= 0) {
    throw new RangeError(`Invalid chunkMs: ${activity.chunkMs}`);
  }

  const area = getArea(input.areaId);
  const modifiers = equipmentModifiers(input.equipment ?? [], activity.modifierCaps, lootConfig);
  const killsByEnemy = Object.fromEntries(ENEMY_IDS.map((id) => [id, 0])) as Record<
    EnemyId,
    number
  >;
  const totals = {
    simulatedMs: 0,
    encounters: 0,
    kills: 0,
    deaths: 0,
    timeouts: 0,
    damageTaken: 0,
    xpGained: 0,
    goldLooted: 0,
    goldSalvaged: 0,
  };
  const items: GeneratedItem[] = [];
  const salvaged: GeneratedItem[] = [];
  let character: FarmingCharacter = { ...input.character };
  let maxHealth = 0;
  let pending = 0;
  let remaining = input.durationMs;
  let free = Math.max(0, activity.inventory.capacity - input.inventoryCount);

  for (let chunk = 0; remaining > 0 || chunk === 0; chunk++) {
    const take = Math.min(activity.chunkMs, remaining);
    remaining -= take;
    const r = simulateFarmingAggregate(
      {
        character,
        equipment: modifiers.stats,
        areaId: input.areaId,
        seed: `${input.seed}:combat:${chunk}`,
        durationMs: pending + take,
      },
      { config: combat },
    );
    pending = r.unusedMs;
    maxHealth = r.maxHealth;
    totals.simulatedMs += r.simulatedMs;
    totals.encounters += r.encounters;
    totals.kills += r.kills;
    totals.deaths += r.deaths;
    totals.timeouts += r.timeouts;
    totals.damageTaken += r.damageTaken;
    totals.xpGained += r.xpGained;
    for (const id of ENEMY_IDS) killsByEnemy[id] += r.killsByEnemy[id];

    const sourceLevel = Math.min(area.maxLevel, Math.max(area.minLevel, character.level));
    const rng = createRng(`${input.seed}:loot:${chunk}`);
    for (let k = 0; k < r.kills; k++) {
      const drop = rollLoot(
        { rng, sourceLevel, lootTable: STANDARD_LOOT_TABLE, goldFind: modifiers.goldFind },
        lootConfig,
      );
      totals.goldLooted += drop.gold;
      for (const item of drop.items) {
        if (free > 0) {
          items.push(item);
          free--;
        } else {
          salvaged.push(item);
          totals.goldSalvaged += salvageValue(item, activity.inventory);
        }
      }
    }
    character = { classId: character.classId, level: r.level, xp: r.xp, health: r.health };
    if (remaining === 0) break;
  }

  return {
    durationMs: input.durationMs,
    ...totals,
    unusedMs: pending,
    killsByEnemy,
    startLevel: input.character.level,
    level: character.level,
    xp: character.xp,
    levelsGained: character.level - input.character.level,
    health: character.health ?? maxHealth,
    maxHealth,
    items,
    salvaged,
    goldFind: modifiers.goldFind,
  };
}
