import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENTS,
  AREA_IDS,
  COSMETICS,
  DUNGEONS,
  FORGE_RECIPES,
  NO_WORLD_FLAGS,
  WORLD_ERAS,
  WORLD_FLAGS,
  activeTownUpgrades,
  areaUnlockBlockers,
  dungeonUnlockBlockers,
  findCommunityProject,
  findForgeRecipe,
  getWorldFlag,
  isProjectOpen,
  milestoneCosmeticsEarned,
  stageCap,
  townPricedRecipe,
  worldEra,
  type WorldFlags,
  type WorldProgress,
} from '../index.js';

/**
 * Ticket 8.2 (docs/COMMUNITY.md "The lanterns of the deep", docs/WORLD.md "Eras of Graumark",
 * docs/ECONOMY.md "Town upgrades"): the Hollow Reach's community gate. Unlike 6.7's chain it gates
 * content from its release, but only the new content (the Hollow Deep and the Hollow Throne):
 * every place players reach today opens exactly as before with or without its flag.
 */
const LANTERNS = findCommunityProject('deepLanterns')!;
/** Every flag before 8.2 set (the Forgeward Outpost done), and with the lanterns lit too. */
const FORGEWARD: WorldFlags = {
  ...NO_WORLD_FLAGS,
  warehouseRestored: true,
  ashenPassCleared: true,
  forgewardRaised: true,
};
const LIT: WorldFlags = { ...FORGEWARD, deepLanternsLit: true };
const TYRANT: WorldProgress = {
  gravewardenDefeated: true,
  cryptTierCleared: 4,
  ashenWardenDefeated: true,
  forgeTyrantDefeated: true,
};

describe('the lanterns of the deep (ticket 8.2)', () => {
  it('opens after the Forgeward Outpost, sets its own flag and rewards a cosmetic achievement', () => {
    expect(LANTERNS.requires).toBe('forgewardOutpost');
    expect(isProjectOpen(LANTERNS, new Set(['restoreWarehouse', 'clearAshenPass']))).toBe(false);
    expect(isProjectOpen(LANTERNS, new Set(['forgewardOutpost']))).toBe(true);
    expect(LANTERNS.grantsFlag).toBe('deepLanternsLit');
    expect(getWorldFlag('deepLanternsLit').opens).toBe('The Hollow Deep');
    expect(WORLD_FLAGS.map((f) => f.id).at(-1)).toBe('deepLanternsLit');
    const a = ACHIEVEMENTS.find((x) => x.id === LANTERNS.rewardAchievementId)!;
    expect(a.criterion).toEqual({ kind: 'communityProject', projectId: 'deepLanterns' });
    expect(LANTERNS.stages.map((s) => s.id)).toEqual([
      'lanternPosts',
      'lanternChains',
      'kindleLanterns',
    ]);
  });

  it('uses a tenth of each need on day one (B.5b), growing by B.3’s rule to three fifths', () => {
    const caps = LANTERNS.stages.map((s) =>
      s.needs.map(
        (n) =>
          `${n.resource} ${n.amount}: ${[0, 1, 2, 9].map((d) => stageCap(s, n.resource, d)).join('/')}`,
      ),
    );
    expect(caps).toEqual([
      [
        'gold 90000: 9000/27000/45000/54000',
        'ironOre 1200: 120/360/600/720',
        'soulShard 500: 50/150/250/300',
      ],
      [
        'gold 130000: 13000/39000/65000/78000',
        'ironOre 1800: 180/540/900/1080',
        'abbeySilver 90: 9/27/45/54',
      ],
      [
        'gold 180000: 18000/54000/90000/108000',
        'soulShard 900: 90/270/450/540',
        'tyrantsEmber 10: 1/3/5/6',
      ],
    ]);
    // Ten givers on a stage's first day: no need fills from fewer than ten first-day caps.
    for (const s of LANTERNS.stages) {
      expect(s.capShare).toBe(0.1);
      for (const n of s.needs) expect(Math.ceil(n.amount / stageCap(s, n.resource, 0))).toBe(10);
    }
  });
});

describe('the gate takes nothing live away (ticket 8.2)', () => {
  const progresses: WorldProgress[] = [
    { gravewardenDefeated: false },
    { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true },
    TYRANT,
    { ...TYRANT, hollowSovereignDefeated: true },
  ];
  const levels = [1, 24, 28, 36, 40, 46, 48, 52, 60];

  it('only the Hollow Deep and the Hollow Throne wait for it', () => {
    for (const id of AREA_IDS) {
      expect(areaUnlockBlockers(id, { level: 60, world: FORGEWARD }, TYRANT).length, id).toBe(
        id === 'hollowDeep' ? 1 : 0,
      );
    }
    for (const d of DUNGEONS) {
      for (const t of d.tiers) {
        const flagged = t.unlock.worldFlag === 'deepLanternsLit';
        expect(flagged, `${d.id} ${t.tier}`).toBe(d.id === 'hollowThrone');
      }
    }
  });

  it('every other area and dungeon tier opens exactly as before, with or without the flag', () => {
    for (const progress of progresses) {
      for (const level of levels) {
        for (const id of AREA_IDS.filter((x) => x !== 'hollowDeep')) {
          expect(areaUnlockBlockers(id, { level, world: LIT }, progress), id).toEqual(
            areaUnlockBlockers(id, { level, world: FORGEWARD }, progress),
          );
        }
        for (const d of DUNGEONS.filter((x) => x.id !== 'hollowThrone')) {
          for (const t of d.tiers) {
            expect(dungeonUnlockBlockers(d.id, { level, world: LIT }, progress, t.tier)).toEqual(
              dungeonUnlockBlockers(d.id, { level, world: FORGEWARD }, progress, t.tier),
            );
          }
        }
      }
    }
  });

  it('the Hollow Sovereign gates nothing: his flag opens no place', () => {
    const slain = { ...TYRANT, hollowSovereignDefeated: true };
    for (const level of levels) {
      for (const id of AREA_IDS) {
        expect(areaUnlockBlockers(id, { level, world: LIT }, slain), id).toEqual(
          areaUnlockBlockers(id, { level, world: LIT }, TYRANT),
        );
      }
    }
  });
});

describe('the Lantern Vigil (ticket 8.2)', () => {
  it('follows the Forgeward Age once the lanterns are lit', () => {
    expect(worldEra(FORGEWARD).id).toBe('forgewardAge');
    expect(worldEra(LIT).id).toBe('lanternVigil');
    expect(worldEra(LIT).title).toBe('Era of the Lantern Vigil');
    expect(WORLD_ERAS.at(-1)!.beganBy).toBe('deepLanternsLit');
    // The latest era's flag decides, so an older flag cleared by hand never moves it back.
    expect(worldEra({ ...LIT, forgewardRaised: false }).id).toBe('lanternVigil');
  });
});

describe('town upgrade: the lantern smithy (ticket 8.2)', () => {
  const recipe = findForgeRecipe('crownforgedWork')!;

  it('takes a fifth off Crownforged Work’s gold once the lanterns are lit, nothing else', () => {
    expect(activeTownUpgrades(FORGEWARD).map((u) => u.id)).toEqual(['forgewardBellows']);
    expect(activeTownUpgrades(LIT).map((u) => u.id)).toEqual(['forgewardBellows', 'lanternSmithy']);
    expect(townPricedRecipe(recipe, FORGEWARD)).toBe(recipe);
    const priced = townPricedRecipe(recipe, LIT);
    expect(priced.gold).toBe(3_600);
    expect({ ...priced, gold: recipe.gold }).toEqual(recipe);
    // The bellows still price only the Tyrantforged Work; nothing else moves.
    expect(townPricedRecipe(findForgeRecipe('tyrantforgedWork')!, LIT).gold).toBe(2_400);
    for (const r of FORGE_RECIPES.filter(
      (x) => x.id !== recipe.id && x.id !== 'tyrantforgedWork',
    )) {
      expect(townPricedRecipe(r, LIT)).toBe(r);
    }
  });
});

describe('the Sovereign’s milestone cosmetic (ticket 8.2)', () => {
  it('a hero who slew him earns the Hollow pale title colour, no one else', () => {
    const c = COSMETICS.find((x) => x.id === 'title-colour.hollow-pale')!;
    expect(c.source).toEqual({
      kind: 'milestone',
      milestone: { kind: 'bossDefeated', boss: 'hollowSovereign' },
    });
    expect(milestoneCosmeticsEarned({ level: 52, progress: TYRANT })).not.toContain(c.id);
    expect(
      milestoneCosmeticsEarned({
        level: 48,
        progress: { ...TYRANT, hollowSovereignDefeated: true },
      }),
    ).toContain(c.id);
  });
});
