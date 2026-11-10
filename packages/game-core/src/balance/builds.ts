/**
 * Build search for the build-diversity check (ticket B.2, `builds-*.test.ts`). Test support only:
 * excluded from the package build (`tsconfig.build.json`).
 *
 * A **build** is what a late-game hero wears in the 8 slots (9 for the warrior: the shield):
 * - a **chassis**: which set pieces it wears (none, 2, 4 or 6 of a set, or two sets mixed), and
 *   optionally a Mythic;
 * - a Legendary with one effect in every other slot, effects chosen by a greedy search for the
 *   job (each slot once, in slot order, keeping the best effect; copies of an effect count once
 *   since B.2, so the search never picks one twice);
 * - an **affix package** for every item's affixes (see `AFFIX_PACKAGES`), at the middle of the
 *   highest tier the item level unlocks: what forge rerolls and improvements aim for;
 * - optionally upgrades and a variant (Void, or Prismatic since 6.4) on every piece.
 *
 * Bases are the class's best regular base per slot (they are the same in every build), so the
 * pieces that differ between builds are set pieces and Mythics.
 */
import {
  AFFIXES,
  CLASS_IDS,
  DEFAULT_LOOT_CONFIG,
  ITEM_BASES,
  ITEM_SETS,
  MYTHIC_ITEMS,
  affixAllowedOn,
  canClassUseItem,
  generateItem,
  getItemBase,
  legendaryEffectPool,
  settleFarming,
  tiersForItemLevel,
  simulateDungeonRun,
  type AreaId,
  type ClassId,
  type DungeonId,
  type DungeonTier,
  type EquippedItem,
  type GeneratedItem,
  type RarityId,
} from '../index.js';

export { CLASS_IDS };

const SLOTS_ALL = ['weapon', 'offhand', 'head', 'chest', 'hands', 'feet', 'neck', 'ring', 'ring'];
/** The slots a build fills: only the warrior has an off-hand base. */
export const buildSlots = (c: ClassId): string[] =>
  c === 'warrior' ? SLOTS_ALL : SLOTS_ALL.filter((s) => s !== 'offhand');

const DAMAGE_AFFIX: Record<ClassId, string> = {
  warrior: 'physical-damage',
  hunter: 'physical-damage',
  mage: 'magic-damage',
  warlock: 'magic-damage',
};
const SKILL_AFFIX: Record<ClassId, string> = {
  warrior: 'rage-heavy-strike',
  mage: 'mana-firebolt',
  hunter: 'focus-aimed-shot',
  warlock: 'soul-shadow-bolt',
};

/**
 * Affix packages: each item takes the first affixes of the list that may roll on its slot, as
 * many as its rarity has. `crit` stacks crit chance and damage, `speed` attack speed, `power`
 * flat damage and the class skill, `guard` health and defences.
 */
export const AFFIX_PACKAGES = ['crit', 'speed', 'power', 'guard'] as const;
export type AffixPackage = (typeof AFFIX_PACKAGES)[number];
/** The affix order of a package (ticket 6.5: exported for the awakening evaluation). */
export function affixOrder(c: ClassId, p: AffixPackage): string[] {
  const d = DAMAGE_AFFIX[c];
  const s = SKILL_AFFIX[c];
  switch (p) {
    case 'crit':
      return ['crit-chance', 'crit-damage', s, 'attack-speed', d, 'health', 'armor', 'resistance'];
    case 'speed':
      return ['attack-speed', d, s, 'crit-chance', 'health', 'crit-damage', 'armor', 'resistance'];
    case 'power':
      return [d, s, 'crit-damage', 'attack-speed', 'health', 'crit-chance', 'armor', 'resistance'];
    case 'guard':
      return ['health', 'armor', 'resistance', d, s, 'attack-speed', 'crit-chance', 'crit-damage'];
  }
}

function packageAffixes(
  c: ClassId,
  baseId: string,
  itemLevel: number,
  rarityId: RarityId,
  pkg: AffixPackage,
): GeneratedItem['affixes'] {
  const base = getItemBase(baseId);
  const rarity = DEFAULT_LOOT_CONFIG.rarities[rarityId];
  const out: GeneratedItem['affixes'] = [];
  for (const id of affixOrder(c, pkg)) {
    if (out.length >= rarity.affixCount) break;
    const affix = AFFIXES.find((a) => a.id === id)!;
    if (!affixAllowedOn(affix, base, c)) continue;
    const tier = tiersForItemLevel(affix, itemLevel, rarity.affixLevelBonus).at(-1)!;
    const value = Math.round((tier.min + tier.max) / 2 / affix.step) * affix.step;
    out.push({ affixId: id, tier: tier.tier, value: Number(value.toFixed(4)) });
  }
  return out;
}

/** The best regular base of a slot for a class at an item level. */
export function bestBase(c: ClassId, slot: string, itemLevel: number) {
  return ITEM_BASES.filter(
    (b) => !b.unique && b.slot === slot && b.minItemLevel <= itemLevel && canClassUseItem(b, c),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel)[0]!;
}

/** The Legendary effects a slot can carry for a class. */
export const effectPool = (c: ClassId, slot: string, itemLevel: number): string[] =>
  legendaryEffectPool(bestBase(c, slot, itemLevel), c).map((e) => e.id);

export type SlotPick =
  | { kind: 'legendary'; effectId: string | null }
  | { kind: 'set'; setId: string }
  | { kind: 'mythic'; mythicId: string };

export interface Chassis {
  /** e.g. `drowned-vigil 4 + ashen-choir 2`, `none`, `+ widowmaker`. */
  name: string;
  /** Per slot (see `buildSlots`): a fixed set piece or Mythic, or null for a Legendary. */
  fixed: (SlotPick | null)[];
}

export interface Build {
  classId: ClassId;
  chassis: string;
  picks: SlotPick[];
  pkg: AffixPackage;
  upgradeLevel?: number;
  void?: boolean;
  /** Ticket 6.4: Prismatic on every piece (ignored when `void` is set: one variant per item). */
  prismatic?: boolean;
}

/** A chassis from set pieces (in the set's slot order) and Mythics. */
export function chassis(c: ClassId, sets: [string, number][], mythics: string[] = []): Chassis {
  const slots = buildSlots(c);
  const fixed: (SlotPick | null)[] = slots.map(() => null);
  for (const [setId, n] of sets) {
    const set = ITEM_SETS.find((s) => s.id === setId)!;
    let placed = 0;
    for (const pieceId of set.pieces) {
      if (placed >= n) break;
      const slot = getItemBase(pieceId).slot;
      const i = fixed.findIndex((f, j) => f === null && slots[j] === slot);
      if (i >= 0) {
        fixed[i] = { kind: 'set', setId };
        placed++;
      }
    }
    if (placed < n) throw new Error(`${setId} ${n}: no room`);
  }
  for (const mythicId of mythics) {
    const slot = getItemBase(MYTHIC_ITEMS.find((m) => m.id === mythicId)!.baseId).slot;
    const i = fixed.findIndex((f, j) => f === null && slots[j] === slot);
    if (i < 0) throw new Error(`${mythicId}: no room`);
    fixed[i] = { kind: 'mythic', mythicId };
  }
  const name =
    [...sets.map(([s, n]) => `${s} ${n}`), ...mythics.map((m) => `+ ${m}`)].join(' + ') || 'none';
  return { name, fixed };
}

/** The set layouts searched: none, each set at 2/4/6 pieces, and the two-set mixes. */
export function setChassis(c: ClassId): Chassis[] {
  return [
    chassis(c, []),
    chassis(c, [['drowned-vigil', 6]]),
    chassis(c, [['ashen-choir', 6]]),
    chassis(c, [['bloodmoon-hunt', 4]]),
    chassis(c, [['drowned-vigil', 4]]),
    chassis(c, [['ashen-choir', 4]]),
    chassis(c, [['ashen-choir', 2]]),
    chassis(c, [['drowned-vigil', 2]]),
    chassis(c, [
      ['drowned-vigil', 4],
      ['ashen-choir', 2],
    ]),
    chassis(c, [
      ['ashen-choir', 4],
      ['drowned-vigil', 2],
    ]),
    chassis(c, [
      ['bloodmoon-hunt', 4],
      ['drowned-vigil', 2],
    ]),
    chassis(c, [
      ['bloodmoon-hunt', 4],
      ['ashen-choir', 2],
    ]),
  ];
}

/** The class's own Mythic weapon. */
export const classMythic = (c: ClassId): string =>
  MYTHIC_ITEMS.find((m) => {
    const b = getItemBase(m.baseId);
    return b.slot === 'weapon' && canClassUseItem(b, c);
  })!.id;

/** The items of a build at an item level. */
export function buildItems(b: Build, itemLevel: number): EquippedItem[] {
  const slots = buildSlots(b.classId);
  return b.picks.map((p, i) => {
    const slot = slots[i]!;
    let item: EquippedItem & GeneratedItem;
    if (p.kind === 'set') {
      const baseId = ITEM_SETS.find((s) => s.id === p.setId)!.pieces.find(
        (id) => getItemBase(id).slot === slot,
      )!;
      item = generateItem({ seed: 100 + i, itemLevel, baseId, classId: b.classId })!;
      item = { ...item, affixes: packageAffixes(b.classId, baseId, itemLevel, 'legendary', b.pkg) };
    } else if (p.kind === 'mythic') {
      const baseId = MYTHIC_ITEMS.find((m) => m.id === p.mythicId)!.baseId;
      item = generateItem({ seed: 100 + i, itemLevel, baseId, classId: b.classId })!;
      item = { ...item, affixes: packageAffixes(b.classId, baseId, itemLevel, 'mythic', b.pkg) };
    } else {
      const baseId = bestBase(b.classId, slot, itemLevel).id;
      item = generateItem({
        seed: 100 + i,
        itemLevel,
        baseId,
        rarityId: 'legendary',
        classId: b.classId,
      })!;
      const plain: EquippedItem & GeneratedItem = { ...item };
      delete plain.effectId;
      delete plain.effectRoll;
      item = {
        ...plain,
        affixes: packageAffixes(b.classId, baseId, itemLevel, 'legendary', b.pkg),
      };
      if (p.effectId) item = { ...item, effectId: p.effectId, effectRoll: 0.5 };
    }
    if (b.upgradeLevel) item = { ...item, upgradeLevel: b.upgradeLevel };
    if (b.void) item = { ...item, variant: 'void' };
    else if (b.prismatic) item = { ...item, variant: 'prismatic' };
    return item;
  });
}

/** What a build is made of, for the "no single X in all top builds" checks. */
export function buildParts(b: Build) {
  const unique = new Set<string>();
  const effects = new Set<string>();
  b.picks.forEach((p) => {
    if (p.kind === 'set') unique.add(`set:${p.setId}`);
    else if (p.kind === 'mythic') unique.add(`mythic:${p.mythicId}`);
    else if (p.effectId) effects.add(p.effectId);
  });
  // The build's leading affixes: the three most frequent across its items (ties by package order),
  // as in the 3.8 telemetry build signature.
  const counts = new Map<string, number>();
  for (const item of buildItems(b, 22)) {
    for (const a of item.affixes) counts.set(a.affixId, (counts.get(a.affixId) ?? 0) + 1);
  }
  const order = affixOrder(b.classId, b.pkg);
  const affixes = [...counts.entries()]
    .sort(([a, x], [c, y]) => y - x || order.indexOf(a) - order.indexOf(c))
    .slice(0, 3)
    .map(([id]) => id);
  return { unique: [...unique], effects: [...effects], affixes };
}

export const describeBuild = (b: Build) => {
  const slots = buildSlots(b.classId);
  const legs = b.picks
    .map((p, i) => (p.kind === 'legendary' && p.effectId ? `${slots[i]}:${p.effectId}` : null))
    .filter(Boolean);
  return `[${b.pkg}] ${b.chassis}${legs.length ? ` · ${legs.join(' ')}` : ''}`;
};

/* --- Jobs ------------------------------------------------------------------------------------ */

export interface BossJob {
  dungeonId: DungeonId;
  tier: DungeonTier;
  level: number;
  itemLevel: number;
  runs: number;
}

/** The tier III Gravewarden at level 23 (item level 22): mean boss fight time, a loss = 150 s. */
export const BOSS_JOB: BossJob = {
  dungeonId: 'namelessCrypt',
  level: 23,
  itemLevel: 22,
  tier: 3,
  runs: 16,
};
/** Ticket 4.8: the Ashen Warden at level 28 (item level 27), the top-end boss. */
export const WARDEN_JOB: BossJob = {
  dungeonId: 'ashenWatch',
  level: 28,
  itemLevel: 27,
  tier: 1,
  runs: 16,
};
export function bossTime(
  c: ClassId,
  items: EquippedItem[],
  runs = BOSS_JOB.runs,
  job: BossJob = BOSS_JOB,
): number {
  let total = 0;
  for (let i = 0; i < runs; i++) {
    const r = simulateDungeonRun({
      dungeonId: job.dungeonId,
      tier: job.tier,
      character: { classId: c, level: job.level, xp: 0 },
      equipment: items,
      seed: `b2-build:${i}`,
      bossLootEligible: false,
      inventoryCount: 0,
    });
    const boss = r.encounters.at(-1)!;
    total += r.bossDefeated ? boss.endMs - boss.startMs : 150_000;
  }
  return total / runs;
}

export interface FarmJob {
  areaId: AreaId;
  level: number;
  itemLevel: number;
  minutes: number;
  seeds: string[];
}

/** Farming the Sunken Abbey at level 19 (item level 18): kills per minute. */
export const FARM_JOB: FarmJob = {
  areaId: 'sunkenAbbey',
  level: 19,
  itemLevel: 18,
  minutes: 40,
  seeds: ['b2-a', 'b2-b'],
};
/** Ticket 4.8: farming the Ashen Pass at level 26 (item level 25), past the Abbey's breakpoint. */
export const PASS_FARM_JOB: FarmJob = {
  ...FARM_JOB,
  areaId: 'ashenPass',
  level: 26,
  itemLevel: 25,
  minutes: 20,
};
export function farmRate(c: ClassId, items: EquippedItem[], job: FarmJob = FARM_JOB): number {
  let kills = 0;
  for (const seed of job.seeds) {
    kills += settleFarming({
      character: { classId: c, level: job.level, xp: 0 },
      equipment: items,
      areaId: job.areaId,
      seed,
      firstCycle: 0,
      durationMs: job.minutes * 60_000,
      inventoryCount: 0,
    }).kills;
  }
  return kills / (job.minutes * job.seeds.length);
}

export interface Scored {
  build: Build;
  /** Higher is better (kills/min, or −boss time). */
  score: number;
}

/**
 * Searches the builds of a class for a job: for every chassis and affix package, the greedy
 * effect search (with `perPackage`; otherwise once with `crit`, the other packages reusing its
 * effects). Returns all candidates, best first.
 */
export function searchBuilds(
  c: ClassId,
  itemLevel: number,
  score: (items: EquippedItem[], build: Build) => number,
  chassisList: Chassis[],
  perPackage = false,
): Scored[] {
  const slots = buildSlots(c);
  const out: Scored[] = [];
  for (const ch of chassisList) {
    let effects: SlotPick[] | null = null;
    for (const pkg of AFFIX_PACKAGES) {
      // The effect search runs with `crit`, and again per package when `perPackage` is set.
      const picks: SlotPick[] =
        effects && !perPackage
          ? effects.slice()
          : ch.fixed.map((f) => f ?? { kind: 'legendary', effectId: null });
      const make = (): Build => ({ classId: c, chassis: ch.name, picks: picks.slice(), pkg });
      let best = score(buildItems(make(), itemLevel), make());
      if (!effects || perPackage) {
        for (let i = 0; i < slots.length; i++) {
          if (ch.fixed[i]) continue;
          const used = new Set(picks.map((p) => (p.kind === 'legendary' ? p.effectId : null)));
          for (const effectId of effectPool(c, slots[i]!, itemLevel)) {
            if (used.has(effectId)) continue;
            const before = picks[i]!;
            picks[i] = { kind: 'legendary', effectId };
            const s = score(buildItems(make(), itemLevel), make());
            if (s > best) best = s;
            else picks[i] = before;
          }
        }
        effects = picks.slice();
      }
      out.push({ build: make(), score: best });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The builds within `share` of the best (scores are "higher is better"). */
export function topBuilds(scored: Scored[], share: number): Scored[] {
  const best = scored[0]!.score;
  const limit = best >= 0 ? best * (1 - share) : best * (1 + share);
  return scored.filter((s) => s.score >= limit);
}
