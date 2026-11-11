import { describe, expect, it } from 'vitest';
import {
  AREA_LOOT_TABLES,
  AREAS,
  AREA_IDS,
  CLASS_IDS,
  DEFAULT_COMBAT_CONFIG,
  DEFAULT_LOOT_CONFIG,
  DUNGEONS,
  ENEMIES,
  ENEMY_IDS,
  ITEM_BASES,
  LOOT_TABLES,
  MATERIALS,
  MATERIAL_IDS,
  PROFESSION_IDS,
  STANDARD_LOOT_TABLE,
  areaUnlockBlockers,
  buildEncounter,
  canClassUseItem,
  deriveEquippedStats,
  dungeonUnlockBlockers,
  eligibleBases,
  findItemBase,
  findLootTable,
  getArea,
  getDungeon,
  getDungeonTier,
  getEnemy,
  getLootTable,
  getMaterial,
  hitsToKillDistribution,
  isAreaId,
  isAreaUnlocked,
  isDungeonId,
  isDungeonUnlocked,
  isEnemyId,
  isMaterialId,
  isProfessionId,
  rollLoot,
  createRng,
  settleFarming,
  type AreaId,
  type ClassId,
  type GeneratedItem,
  MYTHIC_ITEMS,
  ITEM_SETS,
  NO_WORLD_FLAGS,
} from '../index.js';

/** The Phase 2 content contract (`docs/ROADMAP.md`), verbatim. */
const CONTRACT = {
  areas: [
    [
      'abandonedFields',
      1,
      6,
      1,
      ['risenFarmhand', 'carrionWolf', 'boneScarecrow'],
      ['timber', 'ashwort'],
    ],
    ['crowwood', 5, 10, 5, ['banditCutthroat', 'corruptedCrow'], ['timber', 'rawHide']],
    ['oldBurialGrounds', 9, 14, 9, ['risenSkeleton', 'graveCrawler'], ['soulShard']],
    ['blackwater', 13, 18, 13, ['drownedThrall', 'bogHorror'], ['ashwort', 'ironOre']],
    ['sunkenAbbey', 17, 22, 17, ['fallenKnight', 'abbeyWraith'], ['ironOre', 'abbeySilver']],
    // Ticket 4.8 (fixed ids from A.7).
    [
      'ashenPass',
      24,
      28,
      24,
      ['ashWraith', 'cinderHound', 'pyreCultist', 'emberGolem'],
      ['ironOre', 'soulShard'],
    ],
    // Ticket 6.1 (fixed asset names from A.11: cinder-revenant, slag-hound, ember-wisp, ash-colossus).
    [
      'ashfallVerge',
      28,
      34,
      28,
      ['cinderRevenant', 'slagHound', 'emberWisp', 'ashColossus'],
      ['ironOre', 'soulShard'],
    ],
    // Ticket 6.2: the Cinderwastes' second area (variants of the Verge's foes).
    [
      'cinderDepths',
      34,
      40,
      34,
      ['forgeRevenant', 'slagMastiff', 'ashflameWisp', 'slagColossus'],
      ['ironOre', 'soulShard'],
    ],
    // Ticket 8.1: Region III, the Hollow Reach (fixed asset names from A.17: hollow-knight,
    // reach-stalker, pale-choir, husk-titan).
    [
      'paleMarches',
      40,
      46,
      40,
      ['hollowKnight', 'reachStalker', 'paleChoir', 'huskTitan'],
      ['ironOre', 'soulShard'],
    ],
  ],
  dungeon: [
    'namelessCrypt',
    12,
    16,
    12,
    ['cryptGhoul', 'boneAcolyte'],
    'gravewarden',
    'gravewardenSeal',
  ],
  /** Ticket 4.8: the Ashen Pass's boss, fought alone (no chambers) in the Warden's Watch. */
  watch: ['ashenWatch', 26, 28, 26, 'ashenWarden'],
  /** Ticket 6.2: the Cinderwastes' region boss, fought alone in the Tyrant's Forge. */
  forge: ['tyrantsForge', 36, 40, 36, 'forgeTyrant', 'tyrantsEmber'],
  professions: {
    timber: 'woodcutting',
    ashwort: 'herbalism',
    rawHide: 'skinning',
    ironOre: 'mining',
    abbeySilver: 'mining',
  },
} as const;

const NO_PROGRESS = { gravewardenDefeated: false };
const BOSS_DOWN = { gravewardenDefeated: true };

describe('content contract', () => {
  it('defines exactly the contract areas, in progression order', () => {
    expect([...AREA_IDS]).toEqual(CONTRACT.areas.map((a) => a[0]));
    expect(AREAS.map((a) => a.id)).toEqual([...AREA_IDS]);
    for (const [id, min, max, unlock, enemies, materials] of CONTRACT.areas) {
      const area = getArea(id);
      expect([area.minLevel, area.maxLevel, area.unlock.level], id).toEqual([min, max, unlock]);
      expect(area.enemies.map((e) => e.enemyId)).toEqual(enemies);
      expect(area.materials).toEqual(materials);
    }
    expect(getArea('sunkenAbbey').unlock.gravewardenDefeated).toBe(true);
    expect(getArea('ashenPass').unlock.gravewardenDefeated).toBe(true);
    for (const a of AREAS.filter((x) => x.id !== 'sunkenAbbey' && x.id !== 'ashenPass')) {
      expect(a.unlock.gravewardenDefeated, a.id).toBeFalsy();
    }
    // Ticket 4.8: only the Ashen Pass waits for a world flag (the community's second project).
    // Ticket 6.1: the Verge needs no flag (6.7 kept it so: no access is taken away); the Warden it
    // needs guards the Pass's.
    expect(getArea('ashenPass').unlock.worldFlag).toBe('ashenPassCleared');
    for (const a of AREAS.filter((x) => x.id !== 'ashenPass')) {
      expect(a.unlock.worldFlag, a.id).toBeUndefined();
    }
    expect(getArea('ashfallVerge').unlock.ashenWardenDefeated).toBe(true);
    expect(getArea('ashfallVerge').region).toBe('The Cinderwastes');
    expect(getArea('ashfallVerge').assetId).toBe('area.cinderwastes');
    // Ticket 6.2: the Depths behind the Verge's top (level 34 and the Warden), A.11's backdrop.
    expect(getArea('cinderDepths').unlock.ashenWardenDefeated).toBe(true);
    expect(getArea('cinderDepths').region).toBe('The Cinderwastes');
    expect(getArea('cinderDepths').assetId).toBe('area.cinder-depths');
    expect(getArea('cinderDepths').unlock.level).toBe(getArea('ashfallVerge').maxLevel);
    for (const a of AREAS.filter((x) => x.id !== 'ashfallVerge' && x.id !== 'cinderDepths')) {
      expect(a.unlock.ashenWardenDefeated, a.id).toBeUndefined();
    }
    // Ticket 8.1: the Pale Marches behind the Forge Tyrant (level 40), A.17's backdrop.
    expect(getArea('paleMarches').unlock.forgeTyrantDefeated).toBe(true);
    expect(getArea('paleMarches').region).toBe('The Hollow Reach');
    expect(getArea('paleMarches').assetId).toBe('area.hollow-reach');
    expect(getArea('paleMarches').unlock.level).toBe(getArea('cinderDepths').maxLevel);
    for (const a of AREAS.filter((x) => x.id !== 'paleMarches')) {
      expect(a.unlock.forgeTyrantDefeated, a.id).toBeUndefined();
    }
  });

  it('defines the Nameless Crypt with its roster, boss and boss drop', () => {
    const [id, min, max, unlock, enemies, boss, drop] = CONTRACT.dungeon;
    expect(DUNGEONS.map((d) => d.id)).toEqual([id, CONTRACT.watch[0], CONTRACT.forge[0]]);
    const d = getDungeon(id);
    const t1 = getDungeonTier(id, 1);
    expect([t1.minLevel, t1.maxLevel, t1.unlock.level]).toEqual([min, max, unlock]);
    expect(d.enemies.map((e) => e.enemyId)).toEqual(enemies);
    expect(d.bossId).toBe(boss);
    expect(d.bossDrops).toEqual([drop]);
    // Ticket 3.6: tiers I–III, each deeper one higher and gated by the one before; 6.3 Heroic.
    expect(d.tiers.map((t) => t.tier)).toEqual([1, 2, 3, 4]);
    for (const [i, t] of d.tiers.entries()) {
      expect(t.bossLevel, t.name).toBeGreaterThanOrEqual(t.minLevel);
      expect(t.bossLevel, t.name).toBeLessThanOrEqual(t.maxLevel);
      expect(t.bossEnrage.atMs.min, t.name).toBeLessThanOrEqual(t.bossEnrage.atMs.max);
      expect(t.bossEnrage.atMs.max, t.name).toBeLessThan(t.bossMaxFightMs);
      if (i === 0) continue;
      const prev = d.tiers[i - 1]!;
      expect(t.minLevel, t.name).toBeGreaterThan(prev.minLevel);
      expect(t.bossLevel, t.name).toBeGreaterThan(prev.bossLevel);
      expect(t.unlock.level, t.name).toBeGreaterThan(prev.unlock.level);
      expect(t.unlock.cryptTierCleared, t.name).toBe(prev.tier);
    }
  });

  it('defines the Warden’s Watch: one tier, no chambers, the Ashen Warden, the world flag', () => {
    const [id, min, max, unlock, boss] = CONTRACT.watch;
    const d = getDungeon(id);
    expect(d.rooms).toEqual([]);
    expect(d.enemies).toEqual([]);
    expect(d.bossId).toBe(boss);
    expect(d.assetId).toBe('area.ashen-pass');
    expect(d.tiers.map((t) => t.tier)).toEqual([1]);
    const t = getDungeonTier(id, 1);
    expect([t.minLevel, t.maxLevel, t.unlock.level, t.bossLevel]).toEqual([min, max, unlock, max]);
    expect(t.unlock.worldFlag).toBe('ashenPassCleared');
    expect(t.bossEnrage.atMs.max).toBeLessThan(t.bossMaxFightMs);
    // Inside the Ashen Pass's range, and its own hoard (not the crypt's).
    expect(t.minLevel).toBeGreaterThan(getArea('ashenPass').minLevel);
    expect(t.maxLevel).toBe(getArea('ashenPass').maxLevel);
    expect(t.bossLoot.lootTableId).toBe('ashenWarden');
    expect(t.lootTableId).toBe('ashenPass');
    expect(() => getDungeonTier(id, 2)).toThrow();
    expect(getDungeon('namelessCrypt').bossId).toBe('gravewarden');
    // The crypt tiers never need a world flag.
    for (const ct of getDungeon('namelessCrypt').tiers) expect(ct.unlock.worldFlag).toBeUndefined();
  });

  it('defines exactly the contract enemies and materials', () => {
    const rostered = [
      ...CONTRACT.areas.flatMap((a) => a[4]),
      ...CONTRACT.dungeon[4],
      CONTRACT.dungeon[5],
      CONTRACT.watch[4],
      CONTRACT.forge[4],
    ];
    expect([...ENEMY_IDS].sort()).toEqual([...rostered].sort());
    expect(ENEMIES.map((e) => e.id)).toEqual([...ENEMY_IDS]);
    expect([...MATERIAL_IDS].sort()).toEqual(
      [
        ...new Set([
          ...CONTRACT.areas.flatMap((a) => a[5]),
          CONTRACT.dungeon[6],
          CONTRACT.forge[5],
        ]),
      ].sort(),
    );
    expect(MATERIALS.map((m) => m.id)).toEqual([...MATERIAL_IDS]);
  });
});

describe('enemies', () => {
  it('has positive, finite stats and the Phase 2 asset id convention', () => {
    for (const e of ENEMIES) {
      expect(e.attackSpeed).toBeGreaterThan(0);
      for (const s of [e.health, e.damage, e.armor, e.resistance, e.xp]) {
        expect(Number.isFinite(s.base) && s.base > 0, e.id).toBe(true);
        expect(s.perLevel).toBeGreaterThanOrEqual(0);
      }
      expect(e.assetId).toMatch(/^enemy\.[a-z]+(-[a-z]+)*$/);
    }
    const kebab = (id: string) => id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const phase1 = new Set(['risenFarmhand', 'carrionWolf', 'boneScarecrow']);
    for (const e of ENEMIES.filter((x) => !phase1.has(x.id))) {
      expect(e.assetId).toBe(`enemy.${kebab(e.id)}`);
    }
  });

  it('places every enemy in exactly one roster, bosses only as dungeon bosses', () => {
    const rosters = [
      ...AREAS.map((a) => a.enemies.map((e) => e.enemyId)),
      ...DUNGEONS.map((d) => d.enemies.map((e) => e.enemyId)),
      ...DUNGEONS.map((d) => [d.bossId]),
    ];
    for (const id of ENEMY_IDS) {
      expect(rosters.filter((r) => r.includes(id)).length, id).toBe(1);
    }
    for (const d of DUNGEONS) expect(getEnemy(d.bossId).rank).toBe('boss');
    for (const r of [...AREAS, ...DUNGEONS].flatMap((x) => x.enemies)) {
      expect(getEnemy(r.enemyId).rank, r.enemyId).toBe('normal');
      expect(r.weight).toBeGreaterThan(0);
    }
  });

  it('has both damage families and undead in every area that lists soul shards', () => {
    expect(new Set(ENEMIES.map((e) => e.damageType))).toEqual(new Set(['physical', 'magic']));
    // Soul shards drop only from undead: an area that lists them has undead (in the Old Burial
    // Grounds every enemy; in the Ashen Pass the wraiths, ticket 4.8).
    for (const a of AREAS.filter((x) => x.materials.includes('soulShard'))) {
      expect(
        a.enemies.some((e) => getEnemy(e.enemyId).undead),
        a.id,
      ).toBe(true);
    }
    expect(getArea('oldBurialGrounds').enemies.every((e) => getEnemy(e.enemyId).undead)).toBe(true);
    expect(
      getArea('ashenPass')
        .enemies.filter((e) => getEnemy(e.enemyId).undead)
        .map((e) => e.enemyId),
    ).toEqual(['ashWraith']);
    // Every area has both damage families from the Ashen Pass on, too.
    expect(
      new Set(getArea('ashenPass').enemies.map((e) => getEnemy(e.enemyId).damageType)),
    ).toEqual(new Set(['physical', 'magic']));
    expect(getEnemy('gravewarden').undead).toBe(true);
    expect(getEnemy('carrionWolf').undead).toBe(false);
  });

  it('keeps the Abandoned Fields enemies at their B.1 numbers', () => {
    expect(getEnemy('risenFarmhand')).toMatchObject({
      attackSpeed: 0.8,
      health: { base: 60, perLevel: 14 },
      damage: { base: 5.3, perLevel: 1.45 },
      armor: { base: 10, perLevel: 2 },
      resistance: { base: 5, perLevel: 1 },
      xp: { base: 12, perLevel: 3 },
    });
    expect(getEnemy('carrionWolf').health).toEqual({ base: 45, perLevel: 10 });
    expect(getEnemy('boneScarecrow').damage).toEqual({ base: 7, perLevel: 1.8 });
  });

  it('looks up and guards ids', () => {
    expect(getEnemy('carrionWolf').name).toBe('Carrion Wolf');
    expect(isEnemyId('gravewarden')).toBe(true);
    expect(isEnemyId('dragon')).toBe(false);
    expect(() => getEnemy('dragon' as never)).toThrow();
  });
});

describe('areas and level ranges', () => {
  it('orders the areas by level, each overlapping the next by one step', () => {
    for (const a of AREAS) {
      expect(a.minLevel).toBeGreaterThanOrEqual(1);
      expect(a.maxLevel).toBeGreaterThan(a.minLevel);
      expect(a.unlock.level, a.id).toBe(a.minLevel);
    }
    // Graumark's areas overlap the next by one step. Ticket 4.8: the Ashen Pass starts two levels
    // above the Abbey's top instead; crypt tier III (21–24) bridges the gap.
    const graumark = AREAS.filter(
      (a) =>
        a.id !== 'ashenPass' &&
        a.id !== 'ashfallVerge' &&
        a.id !== 'cinderDepths' &&
        a.id !== 'paleMarches',
    );
    // Ticket 8.1: the Hollow Reach starts at the Depths' top (and the Forge Tyrant's level, 40).
    expect(getArea('paleMarches').minLevel).toBe(getArea('cinderDepths').maxLevel);
    // Ticket 6.2: the Depths start at the Verge's top.
    expect(getArea('cinderDepths').minLevel).toBe(getArea('ashfallVerge').maxLevel);
    // Ticket 6.1: the Cinderwastes start at the Pass's top (and the Ashen Warden's level, 28).
    expect(getArea('ashfallVerge').minLevel).toBe(getArea('ashenPass').maxLevel);
    for (let i = 1; i < graumark.length; i++) {
      const prev = graumark[i - 1]!;
      const next = graumark[i]!;
      expect(next.minLevel, next.id).toBe(prev.maxLevel - 1);
    }
    const tierIII = getDungeonTier('namelessCrypt', 3);
    expect(getArea('ashenPass').minLevel).toBe(getArea('sunkenAbbey').maxLevel + 2);
    expect(tierIII.minLevel).toBeLessThanOrEqual(getArea('sunkenAbbey').maxLevel);
    expect(tierIII.maxLevel).toBeGreaterThanOrEqual(getArea('ashenPass').minLevel);
    // The crypt sits between the Burial Grounds and Blackwater.
    const crypt = getDungeonTier('namelessCrypt', 1);
    expect(crypt.minLevel).toBeGreaterThan(getArea('oldBurialGrounds').minLevel);
    expect(crypt.maxLevel).toBeLessThan(getArea('sunkenAbbey').minLevel);
    // Ticket 3.6: the deeper tiers are late-game content beside the Abbey.
    expect(getDungeonTier('namelessCrypt', 2).minLevel).toBeGreaterThan(
      getArea('sunkenAbbey').minLevel,
    );
  });

  it('guards ids', () => {
    expect(isAreaId('crowwood')).toBe(true);
    expect(isAreaId('namelessCrypt')).toBe(false);
    expect(isDungeonId('namelessCrypt')).toBe(true);
    expect(isDungeonId('crowwood')).toBe(false);
    expect(() => getArea('narnia' as never)).toThrow();
    expect(() => getDungeon('narnia' as never)).toThrow();
  });
});

describe('materials', () => {
  it('matches the areas that list them and the contract professions', () => {
    for (const m of MATERIALS) {
      const listing = AREAS.filter((a) => a.materials.includes(m.id)).map((a) => a.id);
      expect([...m.areas].sort(), m.id).toEqual(listing.sort());
      expect(m.icon).toMatch(/^material\.[a-z]+(-[a-z]+)*$/);
    }
    for (const [id, profession] of Object.entries(CONTRACT.professions)) {
      const m = getMaterial(id as keyof typeof CONTRACT.professions);
      expect([m.source, m.profession], id).toEqual(['gathering', profession]);
    }
    expect([getMaterial('soulShard').source, getMaterial('soulShard').profession]).toEqual([
      'undeadDrop',
      null,
    ]);
    expect(getMaterial('gravewardenSeal').source).toBe('bossDrop');
    expect(DUNGEONS.flatMap((d) => d.bossDrops)).toEqual(['gravewardenSeal', 'tyrantsEmber']);
    expect(getMaterial('tyrantsEmber').source).toBe('bossDrop');
    expect(getMaterial('abbeySilver').rarity).toBe('rare');
    for (const m of MATERIALS) {
      if (m.profession) expect(isProfessionId(m.profession)).toBe(true);
    }
    expect([...PROFESSION_IDS].sort()).toEqual(
      [...new Set(Object.values(CONTRACT.professions))].sort(),
    );
  });

  it('guards ids', () => {
    expect(isMaterialId('timber')).toBe(true);
    expect(isMaterialId('wood')).toBe(false);
    expect(() => getMaterial('wood' as never)).toThrow();
  });
});

describe('loot tables', () => {
  // Ticket 3.6: every crypt tier is a place with its own chamber table. Ticket 4.8: the Warden's
  // Watch has no chambers, so its tier rolls no chamber table (only the boss's hoard).
  const places = [
    ...AREAS,
    ...DUNGEONS.filter((d) => d.rooms.length > 0).flatMap((d) =>
      d.tiers.map((t) => ({ ...t, id: `${d.id}:${t.tier}` })),
    ),
  ];

  it('gives every area and the dungeon its own table whose bases all exist', () => {
    expect(new Set(places.map((p) => p.lootTableId)).size).toBe(places.length);
    expect(new Set(LOOT_TABLES.map((t) => t.id)).size).toBe(LOOT_TABLES.length);
    for (const t of LOOT_TABLES) {
      expect(t.entries.length, t.id).toBeGreaterThan(0);
      expect(t.itemDropChance).toBeGreaterThan(0);
      expect(t.itemDropChance).toBeLessThanOrEqual(1);
      for (const e of t.entries) {
        expect(findItemBase(e.baseId), `${t.id}: ${e.baseId}`).toBeDefined();
        expect(e.weight).toBeGreaterThan(0);
      }
      expect(new Set(t.entries.map((e) => e.baseId)).size).toBe(t.entries.length);
    }
    for (const p of places) expect(findLootTable(p.lootTableId), p.id).toBeDefined();
    expect(() => getLootTable('nope')).toThrow();
  });

  it('covers the reachable item levels of each place, and every level in it can drop', () => {
    const v = DEFAULT_LOOT_CONFIG.itemLevelVariance;
    for (const p of places) {
      const t = getLootTable(p.lootTableId);
      // Ticket 6.1: the Verge drops from item level 29 (the tier-4 bases' first level, one above
      // the Pass's), not 27: its whole range is above every earlier source.
      // Ticket 6.2: the Depths likewise from 35, one above the Verge's top.
      // Ticket 8.1: the Pale Marches from 41, one above the Depths' top.
      const above = ['ashfallVerge', 'cinderDepths', 'paleMarches'].includes(p.id);
      const min = above ? p.minLevel + v : Math.max(1, p.minLevel - v);
      expect(t.itemLevel, p.id).toEqual({ min, max: p.maxLevel + v });
      for (let level = t.itemLevel!.min; level <= t.itemLevel!.max; level++) {
        expect(eligibleBases(t, level).length, `${p.id} @${level}`).toBeGreaterThan(0);
      }
    }
  });

  it('shifts drops to higher tiers in higher areas', () => {
    const meanTier = (tableId: string, itemLevel: number) => {
      const c = eligibleBases(getLootTable(tableId), itemLevel);
      const total = c.reduce((s, x) => s + x.weight, 0);
      return c.reduce((s, x) => s + x.base.tier * x.weight, 0) / total;
    };
    const means = AREAS.map((a) => meanTier(a.lootTableId, a.maxLevel));
    // Ticket 6.2: the Depths stay on tier 4 (the Verge's), one band of item levels higher.
    for (let i = 1; i < means.length; i++) {
      if (AREAS[i]!.id === 'cinderDepths') expect(means[i]).toBe(means[i - 1]);
      else expect(means[i]).toBeGreaterThan(means[i - 1]!);
    }
    expect(getLootTable('cinderDepths').itemLevel!.min).toBe(
      getLootTable('ashfallVerge').itemLevel!.max,
    );
    // Ticket 8.1: the Marches' tier 5 starts where the Depths' item levels end.
    expect(getLootTable('paleMarches').itemLevel!.min).toBe(
      getLootTable('cinderDepths').itemLevel!.max,
    );
    expect(meanTier('abandonedFields', 7)).toBe(1);
    // Every base can drop somewhere (Mythic bases through the Mythic roll, ticket 3.2; set pieces
    // through the set roll, ticket 3.3).
    const dropping = new Set([
      ...LOOT_TABLES.flatMap((t) => t.entries.map((e) => e.baseId)),
      ...MYTHIC_ITEMS.map((m) => m.baseId),
      ...ITEM_SETS.flatMap((s) => s.pieces),
    ]);
    for (const b of ITEM_BASES) expect(dropping.has(b.id), b.id).toBe(true);
  });

  it('keeps the Abandoned Fields bases equal to the Phase 1 standard table, at half its drop rate', () => {
    const fields = getLootTable('abandonedFields');
    expect(fields.entries).toEqual(STANDARD_LOOT_TABLE.entries);
    // Ticket B.1: area kills drop an item 6 % of the time (the standard table keeps 12 %).
    expect(fields.itemDropChance).toBe(0.06);
    for (const t of AREA_LOOT_TABLES.filter((x) => !x.id.startsWith('namelessCrypt'))) {
      expect(t.itemDropChance, t.id).toBe(0.06);
    }
    for (let level = 1; level <= 6; level++) {
      const a = rollLoot({
        rng: createRng(`f${level}`),
        sourceLevel: level,
        lootTable: { ...fields, itemDropChance: STANDARD_LOOT_TABLE.itemDropChance },
      });
      const b = rollLoot({ rng: createRng(`f${level}`), sourceLevel: level });
      expect(a).toEqual(b);
    }
  });

  it('clamps rolled item levels to the table range', () => {
    const t = getLootTable('crowwood');
    const levels = new Set<number>();
    const rng = createRng('clamp');
    for (let i = 0; i < 3000; i++) {
      for (const item of rollLoot({ rng, sourceLevel: 40, lootTable: t }).items) {
        levels.add(item.itemLevel);
      }
    }
    expect([...levels]).toEqual([t.itemLevel!.max]);
  });
});

describe('unlock rules', () => {
  it('gates areas by level', () => {
    expect(isAreaUnlocked('abandonedFields', { level: 1 }, NO_PROGRESS)).toBe(true);
    expect(isAreaUnlocked('crowwood', { level: 4 }, NO_PROGRESS)).toBe(false);
    expect(isAreaUnlocked('crowwood', { level: 5 }, NO_PROGRESS)).toBe(true);
    expect(isAreaUnlocked('oldBurialGrounds', { level: 9 }, NO_PROGRESS)).toBe(true);
    expect(isAreaUnlocked('blackwater', { level: 12 }, NO_PROGRESS)).toBe(false);
    expect(areaUnlockBlockers('blackwater', { level: 12 }, NO_PROGRESS)).toEqual([
      { kind: 'level', required: 13 },
    ]);
    expect(areaUnlockBlockers('blackwater', { level: 60 }, NO_PROGRESS)).toEqual([]);
  });

  it('gates the Sunken Abbey by level and the Gravewarden', () => {
    expect(isAreaUnlocked('sunkenAbbey', { level: 30 }, NO_PROGRESS)).toBe(false);
    expect(isAreaUnlocked('sunkenAbbey', { level: 16 }, BOSS_DOWN)).toBe(false);
    expect(isAreaUnlocked('sunkenAbbey', { level: 17 }, BOSS_DOWN)).toBe(true);
    expect(areaUnlockBlockers('sunkenAbbey', { level: 3 }, NO_PROGRESS)).toEqual([
      { kind: 'level', required: 17 },
      { kind: 'gravewardenDefeated' },
    ]);
    expect(areaUnlockBlockers('sunkenAbbey', { level: 20 }, NO_PROGRESS)).toEqual([
      { kind: 'gravewardenDefeated' },
    ]);
  });

  it('gates the Ashen Pass and the Warden’s Watch by level, the Gravewarden and the world flag', () => {
    const open = { ...NO_WORLD_FLAGS, ashenPassCleared: true };
    // Closed for everyone until the community clears the pass: no flags passed = closed.
    expect(isAreaUnlocked('ashenPass', { level: 60 }, BOSS_DOWN)).toBe(false);
    expect(isAreaUnlocked('ashenPass', { level: 60, world: NO_WORLD_FLAGS }, BOSS_DOWN)).toBe(
      false,
    );
    expect(
      isAreaUnlocked(
        'ashenPass',
        { level: 60, world: { ...NO_WORLD_FLAGS, warehouseRestored: true } },
        BOSS_DOWN,
      ),
    ).toBe(false);
    expect(areaUnlockBlockers('ashenPass', { level: 3 }, NO_PROGRESS)).toEqual([
      { kind: 'level', required: 24 },
      { kind: 'gravewardenDefeated' },
      { kind: 'worldFlag', flag: 'ashenPassCleared' },
    ]);
    expect(areaUnlockBlockers('ashenPass', { level: 24 }, BOSS_DOWN)).toEqual([
      { kind: 'worldFlag', flag: 'ashenPassCleared' },
    ]);
    // Open: the flag, the level and the Gravewarden.
    expect(isAreaUnlocked('ashenPass', { level: 24, world: open }, BOSS_DOWN)).toBe(true);
    expect(isAreaUnlocked('ashenPass', { level: 23, world: open }, BOSS_DOWN)).toBe(false);
    expect(isAreaUnlocked('ashenPass', { level: 30, world: open }, NO_PROGRESS)).toBe(false);
    expect(areaUnlockBlockers('ashenPass', { level: 20, world: open }, BOSS_DOWN)).toEqual([
      { kind: 'level', required: 24 },
    ]);
    // The Watch opens with the pass, two levels later.
    expect(isDungeonUnlocked('ashenWatch', { level: 60 }, BOSS_DOWN)).toBe(false);
    expect(isDungeonUnlocked('ashenWatch', { level: 25, world: open }, BOSS_DOWN)).toBe(false);
    expect(isDungeonUnlocked('ashenWatch', { level: 26, world: open }, BOSS_DOWN)).toBe(true);
    expect(dungeonUnlockBlockers('ashenWatch', { level: 26 }, BOSS_DOWN)).toEqual([
      { kind: 'worldFlag', flag: 'ashenPassCleared' },
    ]);
    // The flag opens nothing else: every other place answers the same with and without it.
    for (const id of AREA_IDS.filter((x) => x !== 'ashenPass')) {
      for (const level of [1, 17, 24]) {
        for (const progress of [NO_PROGRESS, BOSS_DOWN]) {
          expect(areaUnlockBlockers(id, { level, world: open }, progress), id).toEqual(
            areaUnlockBlockers(id, { level }, progress),
          );
        }
      }
    }
    for (const tier of [1, 2, 3] as const) {
      const progress = { gravewardenDefeated: true, cryptTierCleared: 3 };
      expect(
        dungeonUnlockBlockers('namelessCrypt', { level: 24, world: open }, progress, tier),
      ).toEqual(dungeonUnlockBlockers('namelessCrypt', { level: 24 }, progress, tier));
    }
  });

  it('gates the Ashfall Verge by level 28 and the Ashen Warden (ticket 6.1)', () => {
    const warden = { gravewardenDefeated: true, ashenWardenDefeated: true };
    expect(isAreaUnlocked('ashfallVerge', { level: 28 }, warden)).toBe(true);
    expect(isAreaUnlocked('ashfallVerge', { level: 27 }, warden)).toBe(false);
    expect(isAreaUnlocked('ashfallVerge', { level: 60 }, BOSS_DOWN)).toBe(false);
    expect(areaUnlockBlockers('ashfallVerge', { level: 20 }, NO_PROGRESS)).toEqual([
      { kind: 'level', required: 28 },
      { kind: 'ashenWardenDefeated' },
    ]);
    // No world flag (6.7 left the seam unused): the flags change nothing for it.
    const open = { ...NO_WORLD_FLAGS, ashenPassCleared: true, warehouseRestored: true };
    for (const progress of [NO_PROGRESS, BOSS_DOWN, warden]) {
      for (const level of [27, 28, 40]) {
        expect(areaUnlockBlockers('ashfallVerge', { level, world: open }, progress)).toEqual(
          areaUnlockBlockers('ashfallVerge', { level }, progress),
        );
      }
    }
    // The Warden opens nothing else (but the Depths, at 34: ticket 6.2).
    for (const id of AREA_IDS.filter((x) => x !== 'ashfallVerge' && x !== 'cinderDepths')) {
      for (const level of [1, 24, 28]) {
        expect(areaUnlockBlockers(id, { level, world: open }, warden), id).toEqual(
          areaUnlockBlockers(id, { level, world: open }, BOSS_DOWN),
        );
      }
    }
  });

  it('gates the Pale Marches by level 40 and the Forge Tyrant (ticket 8.1)', () => {
    const tyrant = {
      gravewardenDefeated: true,
      ashenWardenDefeated: true,
      forgeTyrantDefeated: true,
    };
    const warden = { gravewardenDefeated: true, ashenWardenDefeated: true };
    expect(isAreaUnlocked('paleMarches', { level: 40 }, tyrant)).toBe(true);
    expect(isAreaUnlocked('paleMarches', { level: 39 }, tyrant)).toBe(false);
    expect(isAreaUnlocked('paleMarches', { level: 60 }, warden)).toBe(false);
    expect(areaUnlockBlockers('paleMarches', { level: 20 }, NO_PROGRESS)).toEqual([
      { kind: 'level', required: 40 },
      { kind: 'forgeTyrantDefeated' },
    ]);
    // Live from its release: no world flag (8.2's community gate is for the region's later
    // places), so every flag leaves it as it is.
    const all = Object.fromEntries(Object.keys(NO_WORLD_FLAGS).map((k) => [k, true]));
    for (const progress of [NO_PROGRESS, warden, tyrant]) {
      for (const level of [39, 40, 46]) {
        expect(
          areaUnlockBlockers('paleMarches', { level, world: all as typeof NO_WORLD_FLAGS }, progress),
        ).toEqual(areaUnlockBlockers('paleMarches', { level }, progress));
      }
    }
    // The Tyrant opens nothing else: every other place reads the same with and without him.
    for (const id of AREA_IDS.filter((x) => x !== 'paleMarches')) {
      for (const level of [1, 28, 40, 60]) {
        expect(areaUnlockBlockers(id, { level, world: all as typeof NO_WORLD_FLAGS }, tyrant), id).toEqual(
          areaUnlockBlockers(id, { level, world: all as typeof NO_WORLD_FLAGS }, warden),
        );
      }
    }
  });

  it('gates the crypt by level', () => {
    expect(isDungeonUnlocked('namelessCrypt', { level: 11 }, NO_PROGRESS)).toBe(false);
    expect(isDungeonUnlocked('namelessCrypt', { level: 12 }, NO_PROGRESS)).toBe(true);
    expect(dungeonUnlockBlockers('namelessCrypt', { level: 1 }, NO_PROGRESS)).toEqual([
      { kind: 'level', required: 12 },
    ]);
  });

  it('only ever needs the level for the first four areas, and rejects bad levels', () => {
    for (const id of AREA_IDS) {
      if (['sunkenAbbey', 'ashenPass', 'ashfallVerge', 'cinderDepths', 'paleMarches'].includes(id))
        continue;
      const level = getArea(id).unlock.level;
      expect(isAreaUnlocked(id, { level }, NO_PROGRESS)).toBe(true);
      expect(isAreaUnlocked(id, { level }, BOSS_DOWN)).toBe(true);
    }
    for (const level of [0, -1, 1.5, Number.NaN]) {
      expect(() => isAreaUnlocked('crowwood', { level }, NO_PROGRESS)).toThrow(RangeError);
    }
  });
});

/** A full set of common items of the best base per slot the table can drop at `itemLevel`. */
function commonKit(classId: ClassId, tableId: string, itemLevel: number): GeneratedItem[] {
  const best = new Map<string, (typeof ITEM_BASES)[number]>();
  for (const { base } of eligibleBases(getLootTable(tableId), itemLevel)) {
    if (!canClassUseItem(base, classId)) continue;
    const cur = best.get(base.slot);
    const better =
      !cur ||
      base.tier > cur.tier ||
      (base.tier === cur.tier && base.minItemLevel > cur.minItemLevel);
    if (better) best.set(base.slot, base);
  }
  const items = [...best.values()].map((b, i) => ({
    seed: i,
    baseId: b.id,
    rarityId: 'common' as const,
    itemLevel,
    affixes: [],
  }));
  const ring = items.find((i) => findItemBase(i.baseId)!.slot === 'ring');
  return ring ? [...items, { ...ring, seed: 99 }] : items;
}

describe('farming every area', () => {
  const HOUR = 60 * 60 * 1000;
  const mid = (id: AreaId) => Math.round((getArea(id).minLevel + getArea(id).maxLevel) / 2);

  it('a mid-level character of every class farms each area without timeouts', () => {
    // Ticket 6.2: a common kit cannot kill the Depths' slag colossus (it is tuned for Verge
    // Legendaries and builds: balance.test.ts "the Cinder Depths"), so the Depths are left out here.
    // Ticket 8.1: likewise the Pale Marches (tuned for today's best gear, balance.test.ts).
    for (const area of AREAS.filter((a) => a.id !== 'cinderDepths' && a.id !== 'paleMarches')) {
      const level = mid(area.id);
      for (const classId of CLASS_IDS) {
        // Ticket 4.8: the Ashen Pass is top-end content; a bare hero is not meant to farm it (it
        // falls again and again, balance.test.ts), so only the kit is checked there.
        const kits = [[], commonKit(classId, area.lootTableId, level)];
        const topEnd = ['ashenPass', 'ashfallVerge', 'cinderDepths'].includes(area.id);
        for (const equipment of topEnd ? kits.slice(1) : kits) {
          const r = settleFarming({
            character: { classId, level, xp: 0 },
            equipment,
            areaId: area.id,
            seed: `world:${area.id}:${classId}`,
            durationMs: HOUR,
            inventoryCount: 0,
            firstCycle: 0,
          });
          const label = `${area.id} ${classId} L${level} ${equipment.length ? 'kit' : 'bare'}`;
          expect(r.timeouts, label).toBe(0);
          expect(r.kills, label).toBeGreaterThan(100);
          expect(Object.keys(r.killsByEnemy).sort(), label).toEqual(
            area.enemies.map((e) => e.enemyId).sort(),
          );
          for (const id of Object.keys(r.killsByEnemy)) {
            expect(
              r.killsByEnemy[id as keyof typeof r.killsByEnemy],
              `${label} ${id}`,
            ).toBeGreaterThan(0);
          }
          // Drops come from this area's table, at its item levels.
          const t = getLootTable(area.lootTableId);
          const bases = new Set(t.entries.map((e) => e.baseId));
          for (const item of [...r.items, ...r.salvaged]) {
            // Set pieces and named Mythics come from their own rolls, on their fixed bases.
            const special = item.setId !== undefined || item.rarityId === 'mythic';
            expect(special || bases.has(item.baseId), `${label} ${item.baseId}`).toBe(true);
            expect(item.itemLevel).toBeGreaterThanOrEqual(t.itemLevel!.min);
            expect(item.itemLevel).toBeLessThanOrEqual(t.itemLevel!.max);
          }
        }
      }
    }
  });

  it('drops tier-2 and tier-3 gear in the later areas', () => {
    const tiers = (areaId: AreaId) => {
      const r = settleFarming({
        character: { classId: 'warrior', level: getArea(areaId).maxLevel, xp: 0 },
        equipment: commonKit('warrior', getArea(areaId).lootTableId, getArea(areaId).maxLevel),
        areaId,
        seed: `tiers:${areaId}`,
        durationMs: 3 * HOUR,
        inventoryCount: 0,
        firstCycle: 0,
      });
      return new Set([...r.items, ...r.salvaged].map((i) => findItemBase(i.baseId)!.tier));
    };
    expect(tiers('abandonedFields')).toEqual(new Set([1]));
    expect(tiers('oldBurialGrounds').has(2)).toBe(true);
    expect(tiers('sunkenAbbey').has(3)).toBe(true);
    expect(tiers('sunkenAbbey').has(1)).toBe(false);
  });

  it('crypt enemies die within the fight timeout; the Gravewarden needs gear', () => {
    const dungeon = getDungeon('namelessCrypt');
    const crypt = { ...dungeon, ...getDungeonTier('namelessCrypt', 1) };
    const level = Math.round((crypt.minLevel + crypt.maxLevel) / 2);
    const killChance = (
      enemyId: string,
      enemyLevel: number,
      classId: ClassId,
      gear: boolean,
      maxFightMs = DEFAULT_COMBAT_CONFIG.maxFightMs,
    ) => {
      const items = gear ? commonKit(classId, crypt.lootTableId, enemyLevel) : [];
      const stats = deriveEquippedStats(classId, level, items);
      const setup = buildEncounter(
        getEnemy(enemyId as never),
        enemyLevel,
        classId,
        level,
        stats,
        DEFAULT_COMBAT_CONFIG,
      );
      return hitsToKillDistribution({ ...setup, maxFightMs }).reduce((s, p) => s + p, 0);
    };
    for (const classId of CLASS_IDS) {
      for (const e of crypt.enemies) {
        expect(
          killChance(e.enemyId, level, classId, false),
          `${classId} ${e.enemyId}`,
        ).toBeGreaterThan(0.999);
      }
      // Ticket B.1: the boss outlasts its enrage unless the hero is geared (the run outcome
      // itself is covered by the balance test).
      expect(
        killChance(crypt.bossId, crypt.bossLevel, classId, false, crypt.bossEnrage.atMs.max),
      ).toBeLessThan(0.5);
      expect(
        killChance(crypt.bossId, crypt.bossLevel, classId, true, crypt.bossMaxFightMs),
      ).toBeGreaterThan(0.999);
    }
  });

  it('keeps an Abandoned Fields settlement pinned to its B.1 result', () => {
    const r = settleFarming({
      character: { classId: 'mage', level: 2, xp: 0 },
      areaId: 'abandonedFields',
      seed: 'phase1-pin',
      durationMs: HOUR,
      inventoryCount: 0,
      firstCycle: 3,
    });
    expect({
      kills: r.kills,
      deaths: r.deaths,
      xpGained: r.xpGained,
      gold: r.goldLooted,
      items: r.items.length,
      firstItems: r.items.slice(0, 4).map((i) => `${i.baseId}@${i.itemLevel}:${i.rarityId}`),
    }).toMatchInlineSnapshot(`
      {
        "deaths": 2,
        "firstItems": [
          "leather-jerkin@2:common",
          "skull-staff@1:common",
          "bone-amulet@3:uncommon",
          "chainmail@3:common",
        ],
        "gold": 197,
        "items": 27,
        "kills": 448,
        "xpGained": 7996,
      }
    `);
  });
});
