import { isClassId, type ClassId } from '../classes.js';
import { DEFAULT_ACTIVITY_CONFIG, type ActivityConfig } from '../activity/config.js';
import { equipmentModifiers, type EquippedItem } from '../activity/equipment.js';
import { setBonusInstances } from '../items/sets.js';
import { hasCombatEffects } from '../effects/resolve.js';
import { deriveCharacterStats } from '../combat/characterStats.js';
import { DEFAULT_COMBAT_CONFIG, buildEncounter, type CombatConfig } from '../combat/encounter.js';
import { MAX_LEVEL } from '../combat/progression.js';
import { DEFAULT_LOOT_CONFIG, type LootConfig } from '../loot/config.js';
import { createRng } from '../rng.js';
import {
  resolveDungeonFight,
  resolveEnrage,
  scaleEnemy,
  type DungeonEvent,
} from '../dungeon/run.js';
import { getEnemy } from '../world/enemies.js';
import {
  BOSS_HEALTH,
  countedDamage,
  getGuildBoss,
  isGuildBossId,
  type GuildBossDefinition,
} from './definitions.js';

/**
 * One guild boss attempt (ticket 4.9): the hero, at full health, fights the boss alone until it
 * falls or the fight window ends. The boss cannot be killed in one attempt; the result is the
 * damage dealt. Pure and deterministic: the same input gives the same attempt, so the server
 * decides it once from a server-only seed and the hero's snapshot (like a crypt run,
 * docs/DUNGEONS.md), and timing, retries or replays cannot change it.
 *
 * RNG streams: the fight draws from `${seed}:fight`, the rage moment from `${seed}:enrage`, so
 * one never shifts the other.
 */
export interface GuildBossAttemptInput {
  bossId: string;
  /** Snapshot at the attempt (level and XP; XP does not change the fight, it is validated only). */
  character: { classId: ClassId; level: number };
  /** Equipped items at the attempt (persisted `GeneratedItem` columns incl. effects). */
  equipment?: readonly EquippedItem[];
  /** Server-only seed of this attempt. Never accept a seed from the client. */
  seed: string;
}

export interface GuildBossAttemptOptions {
  activity?: ActivityConfig;
  combat?: CombatConfig;
  loot?: LootConfig;
}

export type GuildBossAttemptEnd = 'fell' | 'endured';

export interface GuildBossAttemptResult {
  bossId: string;
  bossLevel: number;
  /** Damage dealt (attacks and thorns). */
  damage: number;
  /** What it adds to the guild's total (`countedDamage`: capped per attempt). */
  counted: number;
  /** `fell`: the hero fell; `endured`: the hero lasted the whole window. */
  end: GuildBossAttemptEnd;
  durationMs: number;
  enrageAtMs: number;
  startHealth: number;
  /** Hero health at the end (0 when it fell). */
  health: number;
  hits: number;
  crits: number;
  /** The fight's log (`t` in ms from the start; `enemyHealth` is meaningless here). */
  events: DungeonEvent[];
}

export function guildBossLevel(boss: GuildBossDefinition, heroLevel: number): number {
  return heroLevel + boss.levelOffset;
}

export function simulateGuildBossAttempt(
  input: GuildBossAttemptInput,
  options: GuildBossAttemptOptions = {},
): GuildBossAttemptResult {
  if (!isGuildBossId(input.bossId)) throw new RangeError(`Unknown guild boss: ${input.bossId}`);
  const { classId, level } = input.character;
  if (!isClassId(classId)) throw new RangeError(`Unknown class: ${String(classId)}`);
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL)
    throw new RangeError(`Invalid level: ${level}`);
  if (typeof input.seed !== 'string' || input.seed.length === 0)
    throw new RangeError('A guild boss attempt needs a server seed.');
  const activity = options.activity ?? DEFAULT_ACTIVITY_CONFIG;
  const combat = options.combat ?? DEFAULT_COMBAT_CONFIG;
  const loot = options.loot ?? DEFAULT_LOOT_CONFIG;
  const boss = getGuildBoss(input.bossId);
  const equipment = input.equipment ?? [];
  const modifiers = equipmentModifiers(equipment, activity.modifierCaps, loot, {
    classId,
    extraEffects: setBonusInstances(equipment),
  });
  const effects = hasCombatEffects(modifiers.effects) ? modifiers.effects : undefined;
  const stats = deriveCharacterStats(classId, level, modifiers.stats);
  const bossLevel = guildBossLevel(boss, level);
  const enemy = scaleEnemy(getEnemy(boss.enemyId), boss.scale);
  const setup = {
    ...buildEncounter(
      enemy,
      bossLevel,
      classId,
      level,
      stats,
      combat,
      {
        xpGain: modifiers.xpGain,
        skillDamage: modifiers.skillDamage,
        bossDamage: modifiers.bossDamage,
      },
      effects ? { effects, momentum: 0 } : undefined,
    ),
    enemyHealth: BOSS_HEALTH,
    maxFightMs: boss.fightMs,
  };
  const enrage = resolveEnrage(boss.enrage, createRng(`${input.seed}:enrage`));
  const events: DungeonEvent[] = [];
  const outcome = resolveDungeonFight(
    setup,
    stats.health,
    createRng(`${input.seed}:fight`),
    0,
    events,
    enrage,
  );
  let damage = 0;
  let hits = 0;
  let crits = 0;
  for (const e of events) {
    if (e.type === 'attack') {
      damage += e.damage;
      hits++;
      if (e.crit) crits++;
    } else if (e.type === 'thorns') damage += e.damage;
  }
  const end: GuildBossAttemptEnd = outcome.kind === 'death' ? 'fell' : 'endured';
  return {
    bossId: boss.id,
    bossLevel,
    damage,
    counted: countedDamage(boss, damage),
    end,
    durationMs: outcome.offsetMs,
    enrageAtMs: enrage.atMs,
    startHealth: stats.health,
    health: outcome.health,
    hits,
    crits,
    events,
  };
}
