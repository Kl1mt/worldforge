/**
 * Ticket 9.1: loadout measurements and the loadout build search (`docs/SKILLS.md`). Test and
 * tooling support only: excluded from the package build (`tsconfig.build.json`). Every function
 * here needs the skills prototype on (`withSkillsPrototype`).
 *
 * Jobs are today's balance situations, with today's reference kits (the kits of the bands they
 * come from), at a level where the job's skills are unlocked:
 * - farming: the Ashen Pass at 26, the Cinder Depths at 37, the Hollow Deep at 49 (kills/min);
 * - bosses: the tier III Gravewarden at 23, the Heroic Gravewarden at 34, the Forge Tyrant at 38
 *   and the Hollow Sovereign at 50 (mean boss fight time, a loss counts as the 150 s limit).
 */
import {
  ACTIVE_SKILLS,
  CLASS_IDS,
  PASSIVE_SKILLS,
  defaultLoadout,
  loadoutKey,
  setSkillsPrototype,
  settleFarming,
  simulateDungeonRun,
  skillUnlocked,
  skillsPrototypeMode,
  type AreaId,
  type ClassId,
  type DungeonId,
  type DungeonTier,
  type GeneratedItem,
  type Loadout,
  type LoadoutHero,
  type SkillsPrototypeMode,
} from '../index.js';
import { legendaryKit, upgraded } from './kits.js';

export { CLASS_IDS };

/** Runs `f` with the prototype switched to `mode`, then restores the previous mode. */
export function withSkillsPrototype<T>(f: () => T, mode: SkillsPrototypeMode = 'on'): T {
  const before = skillsPrototypeMode();
  setSkillsPrototype(mode);
  try {
    return f();
  } finally {
    setSkillsPrototype(before);
  }
}

export interface LoadoutFarmJob {
  id: string;
  label: string;
  areaId: AreaId;
  level: number;
  gear: (c: ClassId) => GeneratedItem[];
  hero: LoadoutHero;
  minutes: number;
  seeds: string[];
}

export interface LoadoutBossJob {
  id: string;
  label: string;
  dungeonId: DungeonId;
  tier: DungeonTier;
  level: number;
  gear: (c: ClassId) => GeneratedItem[];
  hero: LoadoutHero;
  runs: number;
}

const tyrant = { forgeTyrantDefeated: true };
const all = { forgeTyrantDefeated: true, hollowSovereignDefeated: true };

export const FARM_JOBS: readonly LoadoutFarmJob[] = [
  {
    id: 'pass26',
    label: 'Ashen Pass 26 (Legendaries 25 +5)',
    areaId: 'ashenPass',
    level: 26,
    gear: (c) => upgraded(legendaryKit(c, 25), 5),
    hero: { level: 26 },
    minutes: 30,
    seeds: ['l9-a', 'l9-b'],
  },
  {
    id: 'depths37',
    label: 'Cinder Depths 37 (Legendaries 33 +10)',
    areaId: 'cinderDepths',
    level: 37,
    gear: (c) => upgraded(legendaryKit(c, 33), 10),
    hero: { level: 37 },
    minutes: 30,
    seeds: ['l9-a', 'l9-b'],
  },
  {
    id: 'deep49',
    label: 'Hollow Deep 49 (Legendaries 47 +10)',
    areaId: 'hollowDeep',
    level: 49,
    gear: (c) => upgraded(legendaryKit(c, 47), 10),
    hero: { level: 49, progress: all },
    minutes: 30,
    seeds: ['l9-a', 'l9-b'],
  },
];

export const BOSS_JOBS: readonly LoadoutBossJob[] = [
  {
    id: 'crypt3',
    label: 'Gravewarden III 23 (Legendaries 22 +5)',
    dungeonId: 'namelessCrypt',
    tier: 3,
    level: 23,
    gear: (c) => upgraded(legendaryKit(c, 22), 5),
    hero: { level: 23 },
    runs: 48,
  },
  {
    id: 'heroic34',
    label: 'Heroic Gravewarden 34 (Legendaries 33 +10)',
    dungeonId: 'namelessCrypt',
    tier: 4,
    level: 34,
    gear: (c) => upgraded(legendaryKit(c, 33), 10),
    hero: { level: 34 },
    runs: 48,
  },
  {
    id: 'tyrant38',
    label: 'Forge Tyrant 38 (Legendaries 33 +10)',
    dungeonId: 'tyrantsForge',
    tier: 1,
    level: 38,
    gear: (c) => upgraded(legendaryKit(c, 33), 10),
    hero: { level: 38 },
    runs: 48,
  },
  {
    id: 'sovereign50',
    label: 'Hollow Sovereign 50 (Legendaries 47 +10)',
    dungeonId: 'hollowThrone',
    tier: 1,
    level: 50,
    gear: (c) => upgraded(legendaryKit(c, 47), 10),
    hero: { level: 50, progress: { ...tyrant, hollowSovereignDefeated: true } },
    runs: 48,
  },
];

/**
 * Every loadout a hero can field: each unlocked core skill in slot 1; slots 2 and 3 empty, one
 * spender, or an ordered pair (order is priority); no passive or one unlocked passive.
 */
export function allLoadouts(c: ClassId, hero: LoadoutHero, complete = false): Loadout[] {
  const cores = ACTIVE_SKILLS.filter(
    (s) => s.classId === c && s.kind === 'core' && skillUnlocked(s, hero),
  );
  const spenders = ACTIVE_SKILLS.filter(
    (s) => s.classId === c && s.kind === 'spender' && skillUnlocked(s, hero),
  ).map((s) => s.id);
  const passives: (string | null)[] = PASSIVE_SKILLS.filter(
    (s) => s.classId === c && skillUnlocked(s, hero),
  ).map((s) => s.id);
  const pairs: (string | null)[][] = [];
  for (const a of spenders) for (const b of spenders) if (a !== b) pairs.push([a, b]);
  if (!complete) {
    pairs.push([null, null]);
    for (const a of spenders) pairs.push([a, null]);
  }
  const out: Loadout[] = [];
  for (const core of cores)
    for (const pair of pairs)
      for (const passive of complete ? passives : [null, ...passives])
        out.push({ actives: [core.id, ...pair], passive });
  return out;
}

export function farmRate(c: ClassId, job: LoadoutFarmJob, loadout: Loadout): number {
  const equipment = job.gear(c);
  let kills = 0;
  for (const seed of job.seeds) {
    kills += settleFarming({
      character: { classId: c, level: job.level, xp: 0 },
      equipment,
      areaId: job.areaId,
      seed,
      firstCycle: 0,
      durationMs: job.minutes * 60_000,
      inventoryCount: 0,
      loadout,
    }).kills;
  }
  return kills / (job.minutes * job.seeds.length);
}

export interface BossMeasure {
  /** Mean boss fight time in seconds, a loss counting as the 150 s limit. */
  time: number;
  wins: number;
}

export function bossTime(c: ClassId, job: LoadoutBossJob, loadout: Loadout): BossMeasure {
  const equipment = job.gear(c);
  let total = 0;
  let wins = 0;
  for (let i = 0; i < job.runs; i++) {
    const r = simulateDungeonRun({
      dungeonId: job.dungeonId,
      tier: job.tier,
      character: { classId: c, level: job.level, xp: 0 },
      equipment,
      seed: `l9-boss:${i}`,
      bossLootEligible: false,
      inventoryCount: 0,
      loadout,
    });
    const boss = r.encounters.at(-1)!;
    const reached = boss.room === null;
    if (r.bossDefeated) wins++;
    total += r.bossDefeated && reached ? boss.endMs - boss.startMs : 150_000;
  }
  return { time: total / job.runs / 1000, wins: wins / job.runs };
}

export interface ScoredLoadout {
  loadout: Loadout;
  key: string;
  /** Higher is better: kills/min, or −boss time. */
  score: number;
}

export function scoreAll(
  c: ClassId,
  loadouts: Loadout[],
  score: (l: Loadout) => number,
): ScoredLoadout[] {
  return loadouts
    .map((l) => ({ loadout: l, key: loadoutKey(l), score: score(l) }))
    .sort((a, b) => b.score - a.score);
}

/** The loadouts within `share` of the best (B.2's "viable": 7 %). */
export function viable(scored: ScoredLoadout[], share = 0.07): ScoredLoadout[] {
  const best = scored[0]!.score;
  const limit = best >= 0 ? best * (1 - share) : best * (1 + share);
  return scored.filter((s) => s.score >= limit);
}

export { defaultLoadout, loadoutKey };
