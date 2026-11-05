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
    for (const a of AREAS.filter((x) => x.id !== 'sunkenAbbey')) {
      expect(a.unlock.gravewardenDefeated, a.id).toBeFalsy();
    }
  });

  it('defines the Nameless Crypt with its roster, boss and boss drop', () => {
    const [id, min, max, unlock, enemies, boss, drop] = CONTRACT.dungeon;
    expect(DUNGEONS.map((d) => d.id)).toEqual([id]);
    const d = getDungeon(id);
    expect([d.minLevel, d.maxLevel, d.unlock.level]).toEqual([min, max, unlock]);
    expect(d.enemies.map((e) => e.enemyId)).toEqual(enemies);
    expect(d.bossId).toBe(boss);
    expect(d.bossDrops).toEqual([drop]);
    expect(d.bossLevel).toBeGreaterThanOrEqual(d.minLevel);
    expect(d.bossLevel).toBeLessThanOrEqual(d.maxLevel);
  });

  it('defines exactly the contract enemies and materials', () => {
    const rostered = [
      ...CONTRACT.areas.flatMap((a) => a[4]),
      ...CONTRACT.dungeon[4],
      CONTRACT.dungeon[5],
    ];
    expect([...ENEMY_IDS].sort()).toEqual([...rostered].sort());
    expect(ENEMIES.map((e) => e.id)).toEqual([...ENEMY_IDS]);
    expect([...MATERIAL_IDS].sort()).toEqual(
      [...new Set([...CONTRACT.areas.flatMap((a) => a[5]), CONTRACT.dungeon[6]])].sort(),
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
    for (const a of AREAS.filter((x) => x.materials.includes('soulShard'))) {
      expect(
        a.enemies.every((e) => getEnemy(e.enemyId).undead),
        a.id,
      ).toBe(true);
    }
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
    for (let i = 1; i < AREAS.length; i++) {
      const prev = AREAS[i - 1]!;
      const next = AREAS[i]!;
      expect(next.minLevel, next.id).toBe(prev.maxLevel - 1);
    }
    // The crypt sits between the Burial Grounds and Blackwater.
    const crypt = getDungeon('namelessCrypt');
    expect(crypt.minLevel).toBeGreaterThan(getArea('oldBurialGrounds').minLevel);
    expect(crypt.maxLevel).toBeLessThan(getArea('sunkenAbbey').minLevel);
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
    expect(DUNGEONS.flatMap((d) => d.bossDrops)).toEqual(['gravewardenSeal']);
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
  const places = [...AREAS, ...DUNGEONS];

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
      expect(t.itemLevel, p.id).toEqual({ min: Math.max(1, p.minLevel - v), max: p.maxLevel + v });
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
    for (let i = 1; i < means.length; i++) expect(means[i]).toBeGreaterThan(means[i - 1]!);
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
    for (const t of AREA_LOOT_TABLES.filter((x) => x.id !== 'namelessCrypt')) {
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

  it('gates the crypt by level', () => {
    expect(isDungeonUnlocked('namelessCrypt', { level: 11 }, NO_PROGRESS)).toBe(false);
    expect(isDungeonUnlocked('namelessCrypt', { level: 12 }, NO_PROGRESS)).toBe(true);
    expect(dungeonUnlockBlockers('namelessCrypt', { level: 1 }, NO_PROGRESS)).toEqual([
      { kind: 'level', required: 12 },
    ]);
  });

  it('only ever needs the level for the first four areas, and rejects bad levels', () => {
    for (const id of AREA_IDS) {
      if (id === 'sunkenAbbey') continue;
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
    for (const area of AREAS) {
      const level = mid(area.id);
      for (const classId of CLASS_IDS) {
        for (const equipment of [[], commonKit(classId, area.lootTableId, level)]) {
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
            expect(bases.has(item.baseId), `${label} ${item.baseId}`).toBe(true);
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
    const crypt = getDungeon('namelessCrypt');
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
        killChance(crypt.bossId, crypt.bossLevel, classId, false, crypt.bossEnrage.atMs),
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
