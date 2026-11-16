/**
 * Ticket B.7: the balance pass over skills and loadouts (docs/BALANCE.md "B.7"). Test and tooling
 * support only: excluded from the package build (`tsconfig.build.json`). Shared by
 * `skills-balance.test.ts` and `tools/balance/skills-balance.ts`.
 *
 * The town is not live, so there is no telemetry by loadout yet: like B.5, everything is game-core
 * from fixed seeds. B.7 widens 9.1's measurements in three ways:
 * - **kit samples:** 9.1 measured each job on one reference kit (`legendaryKit`, sample 0); B.7
 *   scores every loadout over three Legendary kits (`legendarySample` 0–2), so a loadout cannot
 *   lead on one kit's luck with its effects;
 * - **9.3's skill-aware Legendaries:** the two quest rewards (ring and neck) in place of the kit's,
 *   with each class's best effect pair (`tools/balance/skill-effects.ts`);
 * - **the older bands:** B.5's Tyrant and Heroic spread, 8.2's Sovereign, the farming and XP bands
 *   and the PvP bands, re-run with each class's leading loadouts.
 */
import {
  CLASS_IDS,
  SKILL_QUESTS,
  generateItem,
  getItemBase,
  simulateDungeonRun,
  type AreaId,
  type BossModifierId,
  type EquippedItem,
  type ClassId,
  type DungeonId,
  type DungeonTier,
  type GeneratedItem,
  type Loadout,
  type LoadoutHero,
} from '../index.js';
import { legendarySample, upgraded } from './kits.js';
import type { LoadoutBossJob, LoadoutFarmJob } from './loadouts.js';

export { CLASS_IDS };

const tyrant = { forgeTyrantSkillLearned: true };
const all = { forgeTyrantSkillLearned: true, hollowSovereignSkillLearned: true };

/** 9.1's jobs, with the kit's item level and upgrade named so a job can wear any kit sample. */
export interface SampledJob {
  id: string;
  kind: 'farm' | 'boss';
  label: string;
  level: number;
  itemLevel: number;
  upgrade: number;
  hero: LoadoutHero;
  areaId?: AreaId;
  dungeonId?: DungeonId;
  tier?: DungeonTier;
}

export const B7_JOBS: readonly SampledJob[] = [
  {
    id: 'pass26',
    kind: 'farm',
    label: 'Ashen Pass 26',
    level: 26,
    itemLevel: 25,
    upgrade: 5,
    hero: { level: 26 },
    areaId: 'ashenPass',
  },
  {
    id: 'depths37',
    kind: 'farm',
    label: 'Cinder Depths 37',
    level: 37,
    itemLevel: 33,
    upgrade: 10,
    hero: { level: 37 },
    areaId: 'cinderDepths',
  },
  {
    id: 'deep49',
    kind: 'farm',
    label: 'Hollow Deep 49',
    level: 49,
    itemLevel: 47,
    upgrade: 10,
    hero: { level: 49, progress: all },
    areaId: 'hollowDeep',
  },
  {
    id: 'crypt3',
    kind: 'boss',
    label: 'Gravewarden III 23',
    level: 23,
    itemLevel: 22,
    upgrade: 5,
    hero: { level: 23 },
    dungeonId: 'namelessCrypt',
    tier: 3,
  },
  {
    id: 'heroic34',
    kind: 'boss',
    label: 'Heroic 34',
    level: 34,
    itemLevel: 33,
    upgrade: 10,
    hero: { level: 34 },
    dungeonId: 'namelessCrypt',
    tier: 4,
  },
  {
    id: 'tyrant38',
    kind: 'boss',
    label: 'Forge Tyrant 38',
    level: 38,
    itemLevel: 33,
    upgrade: 10,
    hero: { level: 38, progress: tyrant },
    dungeonId: 'tyrantsForge',
    tier: 1,
  },
  {
    id: 'sovereign50',
    kind: 'boss',
    label: 'Hollow Sovereign 50',
    level: 50,
    itemLevel: 47,
    upgrade: 10,
    hero: { level: 50, progress: all },
    dungeonId: 'hollowThrone',
    tier: 1,
  },
];

/** The kit samples B.7 scores over (sample 0 is 9.1's reference kit). */
export const KIT_SAMPLES = [0, 1, 2] as const;

/** The skill-aware effect pair (ring, neck) that suits each class best (9.3's measurement). */
export const QUEST_EFFECTS: Record<ClassId, [string, string]> = {
  warrior: ['practiced-hand', 'deep-wellspring'],
  mage: ['practiced-hand', 'practiced-hand'],
  hunter: ['practiced-hand', 'deep-wellspring'],
  warlock: ['practiced-hand', 'festering-craft'],
};

function questItem(baseId: string, effectId: string, c: ClassId): GeneratedItem {
  const q = SKILL_QUESTS.find((x) => x.item.baseId === baseId)!;
  const item = generateItem({ seed: 1, ...q.item, classId: c })!;
  return { ...item, effectId, effectRoll: 1, upgradeLevel: 10 } as GeneratedItem;
}

/** The kit with its first ring and its neck swapped for the two quest rewards at +10. */
export function withQuestItems(c: ClassId, kit: GeneratedItem[]): GeneratedItem[] {
  const [ring, neck] = QUEST_EFFECTS[c];
  const items = [
    questItem('masters-ember-band', ring, c),
    questItem('masters-hollow-torc', neck, c),
  ];
  const slots = items.map((i) => getItemBase(i.baseId).slot);
  const done = new Set<string>();
  const out = kit.filter((i) => {
    const s = getItemBase(i.baseId).slot;
    if (slots.includes(s) && !done.has(s)) return !done.add(s);
    return true;
  });
  return [...out, ...items];
}

export type KitVariant = 'plain' | 'quest';

/** A job's kit for a class: kit sample `sample`, plain or with the quest rewards. */
export function jobGear(
  job: SampledJob,
  c: ClassId,
  sample: number,
  variant: KitVariant = 'plain',
): GeneratedItem[] {
  const kit = upgraded(legendarySample(c, job.itemLevel, sample), job.upgrade);
  return variant === 'quest' ? withQuestItems(c, kit) : kit;
}

/** 9.1's farming job shape (two 30-minute settlements) on a sampled kit. */
export function asFarmJob(
  job: SampledJob,
  sample: number,
  variant: KitVariant = 'plain',
): LoadoutFarmJob {
  return {
    id: job.id,
    label: job.label,
    areaId: job.areaId!,
    level: job.level,
    gear: (c) => jobGear(job, c, sample, variant),
    hero: job.hero,
    minutes: 30,
    seeds: ['l9-a', 'l9-b'],
  };
}

/** 9.1's boss job shape on a sampled kit; `runs` per kit sample. */
export function asBossJob(
  job: SampledJob,
  sample: number,
  variant: KitVariant = 'plain',
  runs = 48,
): LoadoutBossJob {
  return {
    id: job.id,
    label: job.label,
    dungeonId: job.dungeonId!,
    tier: job.tier!,
    level: job.level,
    gear: (c) => jobGear(job, c, sample, variant),
    hero: job.hero,
    runs,
  };
}

/** A loadout's skills, ignoring the priority order of slots 2 and 3 (B.2's "distinct"). */
export const distinctKey = (l: Loadout): string => {
  const [core, ...rest] = l.actives;
  return `${core}|${rest.filter(Boolean).sort().join(',')}|${l.passive ?? ''}`;
};

export interface BossRuns {
  /** Mean boss fight time in seconds, a loss counting as the 150 s limit (B.2's convention). */
  time: number;
  /** Mean time of the won fights alone (the speed of a kill, without the losses). */
  wonTime: number;
  wins: number;
}

/** `runs` runs of a dungeon from `prefix:i` seeds; `loadout` null = the default (today). */
export function bossRuns(
  c: ClassId,
  dungeonId: DungeonId,
  tier: DungeonTier,
  level: number,
  equipment: readonly EquippedItem[],
  loadout: Loadout | null,
  runs: number,
  prefix: string,
  bossModifier: BossModifierId | null = null,
): BossRuns {
  let total = 0;
  let won = 0;
  let wins = 0;
  for (let i = 0; i < runs; i++) {
    const r = simulateDungeonRun({
      dungeonId,
      tier,
      character: { classId: c, level, xp: 0 },
      equipment: [...equipment],
      seed: `${prefix}:${i}`,
      bossLootEligible: false,
      inventoryCount: 0,
      bossModifier,
      ...(loadout ? { loadout } : {}),
    });
    const boss = r.encounters.at(-1)!;
    if (r.bossDefeated && boss.room === null) {
      wins++;
      const t = boss.endMs - boss.startMs;
      total += t;
      won += t;
    } else total += 150_000;
  }
  return { time: total / runs / 1000, wonTime: wins ? won / wins / 1000 : NaN, wins: wins / runs };
}

/** `heavyStrike,charge,-/berserker` (`loadoutKey`'s form) back into a loadout. */
export function parseLoadout(key: string): Loadout {
  const [actives, passive] = key.split('/');
  return {
    actives: actives!.split(',').map((a) => (a === '-' ? null : a)),
    passive: !passive || passive === '-' ? null : passive,
  };
}

/**
 * Each class's leading loadouts as `tools/balance/skills-balance.ts leaders` found them (over the
 * kit samples, from the searches' own seeds, not the bands' seeds), pinned so the guard measures
 * the bands without searching again. A boss leader is the best a hero can field at that level
 * before the boss's own skill is taught (the Tyrant's active at the Tyrant, the Sovereign's
 * passive at the Sovereign); a duel leader beats every class's default best on average.
 */
export const B7_LEADERS: Readonly<Record<string, Readonly<Record<ClassId, string>>>> = {
  tyrant36: {
    warrior: 'heavyStrike,earthsplitter,execute/juggernaut',
    mage: 'firebolt,meteor,shatter/manaShield',
    hunter: 'aimedShot,volley,killShot/eagleEye',
    warlock: 'shadowBolt,doom,drainSoul/malice',
  },
  tyrant38: {
    warrior: 'heavyStrike,earthsplitter,execute/juggernaut',
    mage: 'firebolt,meteor,shatter/manaShield',
    hunter: 'aimedShot,volley,killShot/eagleEye',
    warlock: 'shadowBolt,doom,drainSoul/malice',
  },
  heroic32: {
    warrior: 'heavyStrike,execute,shieldSlam/juggernaut',
    mage: 'firebolt,shatter,arcaneBolt/manaWell',
    hunter: 'aimedShot,killShot,quickShot/eagleEye',
    warlock: 'shadowBolt,corruption,soulBurn/soulSiphon',
  },
  heroic34: {
    warrior: 'heavyStrike,execute,shieldSlam/juggernaut',
    mage: 'firebolt,shatter,pyroblast/manaWell',
    hunter: 'aimedShot,killShot,quickShot/eagleEye',
    warlock: 'shadowBolt,corruption,soulBurn/soulSiphon',
  },
  heroic36: {
    warrior: 'heavyStrike,earthsplitter,execute/juggernaut',
    mage: 'firebolt,meteor,shatter/manaShield',
    hunter: 'aimedShot,volley,killShot/eagleEye',
    warlock: 'shadowBolt,doom,drainSoul/malice',
  },
  sovereign: {
    warrior: 'heavyStrike,earthsplitter,execute/juggernaut',
    mage: 'firebolt,meteor,emberstorm/manaShield',
    hunter: 'aimedShot,volley,trueShot/eagleEye',
    warlock: 'agony,soulBurn,doom/malice',
  },
  crypt21: {
    warrior: 'heavyStrike,shieldSlam,charge/unyielding',
    mage: 'firebolt,arcaneBolt,pyroblast/manaWell',
    hunter: 'aimedShot,quickShot,firstBlood/steadyAim',
    warlock: 'shadowBolt,corruption,soulBurn/malice',
  },
  crypt26: {
    warrior: 'heavyStrike,shieldSlam,charge/battleRhythm',
    mage: 'firebolt,arcaneBolt,pyroblast/manaWell',
    hunter: 'aimedShot,quickShot,firstBlood/steadyAim',
    warlock: 'shadowBolt,corruption,soulBurn/malice',
  },
  deep: {
    warrior: 'heavyStrike,charge,execute/berserker',
    mage: 'firebolt,pyroblast,meteor/arcanePower',
    hunter: 'aimedShot,volley,killShot/skirmisher',
    warlock: 'shadowBolt,soulBurn,doom/darkPact',
  },
  depths: {
    warrior: 'heavyStrike,charge,execute/berserker',
    mage: 'firebolt,pyroblast,shatter/arcanePower',
    hunter: 'aimedShot,quickShot,firstBlood/skirmisher',
    warlock: 'shadowBolt,soulBurn,drainSoul/darkPact',
  },
  farm28: {
    warrior: 'heavyStrike,charge,execute/berserker',
    mage: 'firebolt,pyroblast,arcaneBolt/arcanePower',
    hunter: 'aimedShot,quickShot,firstBlood/skirmisher',
    warlock: 'shadowBolt,soulBurn,drainSoul/darkPact',
  },
  duel5: {
    warrior: 'heavyStrike,shieldSlam,-/-',
    mage: 'firebolt,arcaneBolt,-/-',
    hunter: 'aimedShot,quickShot,-/-',
    warlock: 'shadowBolt,-,-/-',
  },
  duel10: {
    warrior: 'heavyStrike,shieldSlam,-/unyielding',
    mage: 'firebolt,arcaneBolt,-/manaWell',
    hunter: 'aimedShot,quickShot,-/-',
    warlock: 'shadowBolt,corruption,-/-',
  },
  duel15: {
    warrior: 'heavyStrike,shieldSlam,charge/-',
    mage: 'firebolt,arcaneBolt,pyroblast/manaWell',
    hunter: 'aimedShot,quickShot,firstBlood/steadyAim',
    warlock: 'shadowBolt,corruption,soulBurn/-',
  },
  duel20: {
    warrior: 'heavyStrike,shieldSlam,charge/unyielding',
    mage: 'firebolt,arcaneBolt,pyroblast/manaWell',
    hunter: 'aimedShot,quickShot,firstBlood/predator',
    warlock: 'shadowBolt,corruption,soulBurn/malice',
  },
  duel25: {
    warrior: 'heavyStrike,shieldSlam,charge/battleRhythm',
    mage: 'firebolt,arcaneBolt,pyroblast/manaWell',
    hunter: 'aimedShot,quickShot,firstBlood/predator',
    warlock: 'shadowBolt,corruption,soulBurn/-',
  },
  duel30: {
    warrior: 'heavyStrike,charge,execute/-',
    mage: 'firebolt,pyroblast,shatter/manaWell',
    hunter: 'aimedShot,firstBlood,killShot/predator',
    warlock: 'shadowBolt,corruption,soulBurn/malice',
  },
  duel36: {
    warrior: 'heavyStrike,charge,earthsplitter/-',
    mage: 'firebolt,pyroblast,meteor/-',
    hunter: 'aimedShot,volley,killShot/predator',
    warlock: 'shadowBolt,corruption,soulBurn/malice',
  },
  duel46: {
    warrior: 'heavyStrike,charge,earthsplitter/hollowWrath',
    mage: 'firebolt,pyroblast,meteor/kindling',
    hunter: 'aimedShot,firstBlood,volley/predator',
    warlock: 'shadowBolt,corruption,soulBurn/hollowCovenant',
  },
};

export const leader = (name: string, c: ClassId): Loadout => parseLoadout(B7_LEADERS[name]![c]);

/** The duel leader a hero of `level` fields (the table's nearest level at or below). */
export function duelLeaderAt(c: ClassId, level: number): Loadout {
  const at = [46, 36, 30, 25, 20, 15, 10, 5].find((l) => level >= l) ?? 5;
  return leader(`duel${at}`, c);
}
