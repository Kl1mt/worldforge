import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENTS,
  AREA_IDS,
  DUNGEONS,
  FORGE_RECIPES,
  NO_WORLD_FLAGS,
  TOWN_UPGRADES,
  WORLD_ERAS,
  WORLD_ERA_IDS,
  WORLD_FLAGS,
  WORLD_FLAG_IDS,
  activeTownUpgrades,
  areaUnlockBlockers,
  dungeonUnlockBlockers,
  eraCrierLine,
  findCommunityProject,
  findForgeRecipe,
  getArea,
  isAreaUnlocked,
  isDungeonUnlocked,
  stageCap,
  townPricedRecipe,
  worldEra,
  worldEraIndex,
  type WorldFlags,
  type WorldProgress,
} from '../index.js';

/**
 * Ticket 6.7 (docs/COMMUNITY.md "The Forgeward Outpost", docs/WORLD.md "Eras of Graumark",
 * docs/ECONOMY.md "Town upgrades"): the chain's data and caps, the era derivation, the town
 * upgrade, and that the new flag takes no access away from anything players reach today.
 */
const FORGEWARD = findCommunityProject('forgewardOutpost')!;
/** The flags live has today: both earlier projects done. */
const LIVE: WorldFlags = { ...NO_WORLD_FLAGS, warehouseRestored: true, ashenPassCleared: true };
const ALL: WorldFlags = Object.fromEntries(WORLD_FLAG_IDS.map((f) => [f, true])) as WorldFlags;

describe('the Forgeward Outpost chain (ticket 6.7)', () => {
  it('opens after the Ashen Pass, sets its own flag and rewards a cosmetic achievement', () => {
    expect(FORGEWARD.requires).toBe('clearAshenPass');
    expect(FORGEWARD.grantsFlag).toBe('forgewardRaised');
    expect(WORLD_FLAG_IDS.at(-1)).toBe('forgewardRaised');
    expect(WORLD_FLAGS.map((f) => f.id)).toEqual([...WORLD_FLAG_IDS]);
    const a = ACHIEVEMENTS.find((x) => x.id === FORGEWARD.rewardAchievementId)!;
    expect(a.criterion).toEqual({ kind: 'communityProject', projectId: 'forgewardOutpost' });
    expect(FORGEWARD.stages.map((s) => s.id)).toEqual([
      'slagRoad',
      'forgewardWalls',
      'kindleBeacon',
    ]);
  });

  it('uses a tenth of each need on day one (ticket B.5b), growing by B.3’s rule to three fifths', () => {
    const caps = FORGEWARD.stages.map((s) =>
      s.needs.map(
        (n) =>
          `${n.resource} ${n.amount}: ${[0, 1, 2, 9].map((d) => stageCap(s, n.resource, d)).join('/')}`,
      ),
    );
    expect(caps).toEqual([
      [
        'gold 60000: 6000/18000/30000/36000',
        'ironOre 1000: 100/300/500/600',
        'soulShard 400: 40/120/200/240',
      ],
      [
        'gold 100000: 10000/30000/50000/60000',
        'ironOre 1500: 150/450/750/900',
        'abbeySilver 80: 8/24/40/48',
      ],
      [
        'gold 140000: 14000/42000/70000/84000',
        'soulShard 800: 80/240/400/480',
        'tyrantsEmber 10: 1/3/5/6',
      ],
    ]);
    for (const s of FORGEWARD.stages) expect(s.capShare).toBe(0.1);
  });
});

describe('no access removed (ticket 6.7)', () => {
  const progresses: WorldProgress[] = [
    { gravewardenDefeated: false },
    { gravewardenDefeated: true, cryptTierCleared: 3 },
    { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true },
    {
      gravewardenDefeated: true,
      cryptTierCleared: 4,
      ashenWardenDefeated: true,
      forgeTyrantDefeated: true,
    },
  ];
  const levels = [1, 10, 24, 28, 34, 36, 40, 50];

  it('no area or dungeon waits for the Forgeward flag', () => {
    for (const id of AREA_IDS) expect(getArea(id).unlock.worldFlag, id).not.toBe('forgewardRaised');
    for (const d of DUNGEONS) {
      for (const t of d.tiers)
        expect(t.unlock.worldFlag, `${d.id} ${t.tier}`).not.toBe('forgewardRaised');
    }
  });

  it('every area and dungeon tier opens exactly as before, with or without the new flag', () => {
    for (const progress of progresses) {
      for (const level of levels) {
        for (const id of AREA_IDS) {
          expect(areaUnlockBlockers(id, { level, world: ALL }, progress), id).toEqual(
            areaUnlockBlockers(id, { level, world: LIVE }, progress),
          );
        }
        for (const d of DUNGEONS) {
          for (const t of d.tiers) {
            expect(dungeonUnlockBlockers(d.id, { level, world: ALL }, progress, t.tier)).toEqual(
              dungeonUnlockBlockers(d.id, { level, world: LIVE }, progress, t.tier),
            );
          }
        }
      }
    }
  });

  it('the Verge, the Depths and the Tyrant’s Forge stay open on live’s flags today', () => {
    const top = progresses[3]!;
    expect(isAreaUnlocked('ashfallVerge', { level: 28, world: LIVE }, top)).toBe(true);
    expect(isAreaUnlocked('cinderDepths', { level: 34, world: LIVE }, top)).toBe(true);
    expect(isDungeonUnlocked('tyrantsForge', { level: 36, world: LIVE }, top)).toBe(true);
  });
});

describe('eras of Graumark (ticket 6.7)', () => {
  it('derives the era from the completed projects’ flags', () => {
    expect(worldEra(null).id).toBe('longDusk');
    expect(worldEra(NO_WORLD_FLAGS).id).toBe('longDusk');
    expect(worldEra({ ...NO_WORLD_FLAGS, warehouseRestored: true }).id).toBe('ashenSiege');
    // Live today: the Warehouse and the Ashen Pass are done.
    expect(worldEra(LIVE).id).toBe('rekindling');
    expect(worldEra(ALL).id).toBe('forgewardAge');
    // The latest era's flag decides, so an older flag cleared by hand never moves it back.
    expect(worldEra({ ...ALL, warehouseRestored: false }).id).toBe('forgewardAge');
  });

  it('only moves forward as the projects complete in order', () => {
    const order = ['warehouseRestored', 'ashenPassCleared', 'forgewardRaised'] as const;
    let flags: WorldFlags = NO_WORLD_FLAGS;
    let last = worldEraIndex(worldEra(flags).id);
    expect(last).toBe(0);
    for (const f of order) {
      flags = { ...flags, [f]: true };
      const now = worldEraIndex(worldEra(flags).id);
      expect(now).toBe(last + 1);
      last = now;
    }
    // Setting any flag never lowers the era (every subset, every added flag).
    for (let mask = 0; mask < 1 << WORLD_FLAG_IDS.length; mask++) {
      const set = Object.fromEntries(
        WORLD_FLAG_IDS.map((f, i) => [f, (mask & (1 << i)) !== 0]),
      ) as WorldFlags;
      for (const f of WORLD_FLAG_IDS) {
        expect(worldEraIndex(worldEra({ ...set, [f]: true }).id)).toBeGreaterThanOrEqual(
          worldEraIndex(worldEra(set).id),
        );
      }
    }
  });

  it('is words only: no era carries a number, so none can carry power', () => {
    expect(WORLD_ERAS.map((e) => e.id)).toEqual([...WORLD_ERA_IDS]);
    for (const era of WORLD_ERAS) {
      for (const [k, v] of Object.entries(era)) {
        const ok =
          v === null ||
          typeof v === 'string' ||
          (Array.isArray(v) && v.every((x) => typeof x === 'string'));
        expect(ok, `${era.id}.${k}`).toBe(true);
      }
      expect(era.title.startsWith('Era of ')).toBe(true);
      expect(era.crier.length).toBeGreaterThan(0);
    }
    // Each era but the first begins with a project's flag, in project order.
    expect(WORLD_ERAS.map((e) => e.beganBy)).toEqual([null, ...WORLD_FLAG_IDS]);
  });

  it('the crier calls one line a day, in turn', () => {
    const era = worldEra(LIVE);
    const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
    const lines = days.map((d) => eraCrierLine(era, d));
    for (const l of lines) expect(era.crier).toContain(l);
    expect(new Set(lines).size).toBe(Math.min(era.crier.length, days.length));
    expect(eraCrierLine(era, days[0]!)).toBe(lines[0]);
  });
});

describe('town upgrade: the Forgeward bellows (ticket 6.7)', () => {
  const recipe = findForgeRecipe('tyrantforgedWork')!;

  it('takes a fifth off Tyrantforged Work’s gold once the outpost stands, nothing else', () => {
    expect(activeTownUpgrades(LIVE)).toEqual([]);
    expect(activeTownUpgrades(ALL).map((u) => u.id)).toEqual(['forgewardBellows']);
    expect(townPricedRecipe(recipe, LIVE)).toBe(recipe);
    expect(townPricedRecipe(recipe, null)).toBe(recipe);
    const priced = townPricedRecipe(recipe, ALL);
    expect(priced.gold).toBe(2_400);
    expect({ ...priced, gold: recipe.gold }).toEqual(recipe);
    // Every other recipe is untouched, flags or not.
    for (const r of FORGE_RECIPES.filter((x) => x.id !== recipe.id)) {
      expect(townPricedRecipe(r, ALL)).toBe(r);
    }
  });

  it('is a price only: no upgrade touches stats, drops or rewards', () => {
    for (const u of TOWN_UPGRADES) {
      expect(Object.keys(u).sort()).toEqual([
        'description',
        'flag',
        'forgeGoldDiscount',
        'id',
        'name',
      ]);
      expect(u.forgeGoldDiscount!.share).toBeGreaterThan(0);
      expect(u.forgeGoldDiscount!.share).toBeLessThan(0.5);
    }
  });
});
