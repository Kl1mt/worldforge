import { describe, expect, it } from 'vitest';
import { achievementsEarned, findAchievement } from '../achievements/definitions.js';
import { MATERIAL_IDS } from './materials.js';
import {
  COMMUNITY_PROJECTS,
  COMMUNITY_PROJECT_CONFIG,
  NO_WORLD_FLAGS,
  WORLD_FLAG_IDS,
  contributionWindow,
  findCommunityProject,
  isProjectOpen,
  isStageComplete,
  planContribution,
  stageAgeDays,
  stageCap,
  stageCapShare,
  worldFlagsFrom,
  type ProjectStageDefinition,
} from './projects.js';
import { isUnlocked, unlockBlockers } from './unlocks.js';

const STAGE: ProjectStageDefinition = {
  id: 's',
  name: 'S',
  description: '',
  needs: [
    { resource: 'gold', amount: 1000 },
    { resource: 'timber', amount: 99 },
  ],
};

describe('community project data', () => {
  it('is well formed: unique ids, distinct positive needs, known prerequisites, flags and rewards', () => {
    const ids = COMMUNITY_PROJECTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(COMMUNITY_PROJECTS.map((p) => p.grantsFlag)).size).toBe(ids.length);
    for (const p of COMMUNITY_PROJECTS) {
      expect(WORLD_FLAG_IDS).toContain(p.grantsFlag);
      if (p.requires !== null) expect(ids.indexOf(p.requires)).toBeLessThan(ids.indexOf(p.id));
      const reward = findAchievement(p.rewardAchievementId);
      expect(reward?.criterion).toEqual({ kind: 'communityProject', projectId: p.id });
      expect(p.stages.length).toBeGreaterThan(0);
      expect(new Set(p.stages.map((s) => s.id)).size).toBe(p.stages.length);
      for (const s of p.stages) {
        const resources = s.needs.map((n) => n.resource);
        expect(new Set(resources).size).toBe(resources.length);
        for (const n of s.needs) {
          expect(
            n.resource === 'gold' || (MATERIAL_IDS as readonly string[]).includes(n.resource),
          ).toBe(true);
          expect(Number.isSafeInteger(n.amount) && n.amount > 0).toBe(true);
        }
      }
    }
  });

  it('opens the Warehouse first and the Ashen Pass after it (the fixed contract for 4.7 and 4.8)', () => {
    const warehouse = findCommunityProject('restoreWarehouse')!;
    const pass = findCommunityProject('clearAshenPass')!;
    expect(warehouse).toMatchObject({ requires: null, grantsFlag: 'warehouseRestored' });
    expect(pass).toMatchObject({ requires: 'restoreWarehouse', grantsFlag: 'ashenPassCleared' });
    expect(isProjectOpen(warehouse, new Set())).toBe(true);
    expect(isProjectOpen(pass, new Set())).toBe(false);
    expect(isProjectOpen(pass, new Set(['restoreWarehouse']))).toBe(true);
  });

  it('no monopoly: on its first day every stage needs at least five accounts', () => {
    expect(COMMUNITY_PROJECT_CONFIG.capShare).toBe(0.2);
    for (const p of COMMUNITY_PROJECTS) {
      for (const s of p.stages) {
        const days = Math.max(...s.needs.map((n) => Math.ceil(n.amount / stageCap(s, n.resource))));
        expect(days, `${p.id}/${s.id}`).toBeGreaterThanOrEqual(5);
      }
    }
  });
});

describe('the cap grows with the stage (ticket B.3)', () => {
  it('adds the growth per whole day since the first gift, up to the ceiling', () => {
    const { capShare, capGrowthPerDay, capShareMax } = COMMUNITY_PROJECT_CONFIG;
    expect([capShare, capGrowthPerDay, capShareMax]).toEqual([0.2, 0.2, 0.6]);
    expect([0, 1, 2, 3, 10].map((d) => stageCapShare(STAGE, d))).toEqual([0.2, 0.4, 0.6, 0.6, 0.6]);
    expect([0, 1, 2, 3].map((d) => stageCap(STAGE, 'gold', d))).toEqual([200, 400, 600, 600]);
    expect(stageCap(STAGE, 'timber', 1)).toBe(40); // ceil(39.6)
    // A stage's own share starts the growth; a share above the ceiling is kept, never cut.
    expect(stageCapShare({ ...STAGE, capShare: 0.1 }, 1)).toBeCloseTo(0.3);
    expect(stageCapShare({ ...STAGE, capShare: 0.8 }, 3)).toBe(0.8);
    // Another config (the balance test's "before"): no growth.
    const flat = { capShare: 0.2, capGrowthPerDay: 0, capShareMax: 0.2 };
    expect(stageCapShare(STAGE, 5, flat)).toBe(0.2);
    expect(() => stageCapShare(STAGE, -1)).toThrow(RangeError);
    expect(() => stageCapShare(STAGE, 1.5)).toThrow(RangeError);
  });

  it('counts the age in UTC days from the first gift', () => {
    expect(stageAgeDays(null, '2031-03-10')).toBe(0);
    expect(stageAgeDays('2031-03-10', '2031-03-10')).toBe(0);
    expect(stageAgeDays('2031-03-10', '2031-03-11')).toBe(1);
    expect(stageAgeDays('2031-02-27', '2031-03-02')).toBe(3);
    expect(stageAgeDays('2031-03-11', '2031-03-10')).toBe(0);
  });

  it('planContribution takes the grown cap', () => {
    expect(planContribution(STAGE, {}, { gold: 200 }, { gold: 500 }, 1)).toEqual({
      accepted: { gold: 200 },
      limited: { gold: 'cap' },
    });
    expect(planContribution(STAGE, {}, {}, { gold: 500 }, 2)).toEqual({
      accepted: { gold: 500 },
      limited: {},
    });
  });
});

describe('stageCap and planContribution', () => {
  it('caps at the rounded-up share of each need, at least 1', () => {
    expect(stageCap(STAGE, 'gold')).toBe(200);
    expect(stageCap(STAGE, 'timber')).toBe(20); // ceil(19.8)
    expect(stageCap(STAGE, 'ironOre')).toBe(0);
    expect(
      stageCap(
        { ...STAGE, needs: [{ resource: 'gravewardenSeal', amount: 2 }] },
        'gravewardenSeal',
      ),
    ).toBe(1);
    expect(stageCap({ ...STAGE, capShare: 0.5 }, 'gold')).toBe(500);
  });

  it('takes the offer when it fits', () => {
    expect(planContribution(STAGE, {}, {}, { gold: 150, timber: 5 })).toEqual({
      accepted: { gold: 150, timber: 5 },
      limited: {},
    });
  });

  it('never takes more than the account may still give in the window', () => {
    expect(planContribution(STAGE, { gold: 100 }, { gold: 150 }, { gold: 500 })).toEqual({
      accepted: { gold: 50 },
      limited: { gold: 'cap' },
    });
    expect(planContribution(STAGE, {}, { gold: 200 }, { gold: 1 })).toEqual({
      accepted: {},
      limited: { gold: 'cap' },
    });
  });

  it('never over-fills the stage', () => {
    expect(
      planContribution(STAGE, { gold: 950, timber: 99 }, {}, { gold: 200, timber: 3 }),
    ).toEqual({
      accepted: { gold: 50 },
      limited: { gold: 'stage', timber: 'stage' },
    });
  });

  it('rejects resources the stage does not need and bad amounts', () => {
    expect(() => planContribution(STAGE, {}, {}, { ironOre: 1 })).toThrow(RangeError);
    expect(() => planContribution(STAGE, {}, {}, { gold: 0 })).toThrow(RangeError);
    expect(() => planContribution(STAGE, {}, {}, { gold: 1.5 })).toThrow(RangeError);
  });

  it('a stage is complete when every need is met', () => {
    expect(isStageComplete(STAGE, { gold: 1000 })).toBe(false);
    expect(isStageComplete(STAGE, { gold: 1000, timber: 99 })).toBe(true);
  });
});

describe('contributionWindow', () => {
  it('is the UTC day of the game clock', () => {
    expect(contributionWindow(new Date('2031-03-10T23:59:59.999Z'))).toEqual({
      day: '2031-03-10',
      startsAt: new Date('2031-03-10T00:00:00Z'),
      endsAt: new Date('2031-03-11T00:00:00Z'),
    });
    expect(contributionWindow(new Date('2031-03-11T00:00:00Z')).day).toBe('2031-03-11');
  });
});

describe('world flags', () => {
  it('reads flags from ids, ignoring unknown ones', () => {
    expect(worldFlagsFrom([])).toEqual(NO_WORLD_FLAGS);
    expect(worldFlagsFrom(['warehouseRestored', 'retiredFlag'])).toEqual({
      warehouseRestored: true,
      ashenPassCleared: false,
    });
  });

  it('gates an unlock rule with a worldFlag, closed when the flags are not passed', () => {
    const rule = { level: 24, worldFlag: 'ashenPassCleared' as const };
    const progress = { gravewardenDefeated: true };
    expect(unlockBlockers(rule, { level: 24 }, progress)).toEqual([
      { kind: 'worldFlag', flag: 'ashenPassCleared' },
    ]);
    expect(unlockBlockers(rule, { level: 20, world: NO_WORLD_FLAGS }, progress)).toEqual([
      { kind: 'level', required: 24 },
      { kind: 'worldFlag', flag: 'ashenPassCleared' },
    ]);
    const open = worldFlagsFrom(['ashenPassCleared']);
    expect(isUnlocked(rule, { level: 24, world: open }, progress)).toBe(true);
    // Rules without a flag ignore the world.
    expect(isUnlocked({ level: 1 }, { level: 1 }, progress)).toBe(true);
  });

  it('awards the project achievement only for a completed project the account gave to', () => {
    expect(achievementsEarned({ communityProjects: [] })).toEqual([]);
    expect(achievementsEarned({ communityProjects: ['restoreWarehouse'] })).toEqual([
      'warehouseRestorer',
    ]);
  });
});
