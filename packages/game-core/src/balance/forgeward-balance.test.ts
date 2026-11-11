import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_PROJECTS,
  COMMUNITY_PROJECT_CONFIG,
  findCommunityProject,
  type CommunityProjectDefinition,
} from '../index.js';
import { ENDLESS, largeTown, playTown, town, type StageResult } from './community-town.js';

/**
 * Ticket 6.7, the larger-town scaling check (docs/COMMUNITY.md "The Forgeward Outpost"): how the
 * Forgeward Outpost paces at 20, 100 and 500 active players with the realistic player
 * (`largeTown`: a sixth endgame players with Tyrant's Embers, a third veterans, the rest
 * newcomers), and whether B.3's caps still keep a few players from carrying a stage. "Before" is
 * the town before 6.7 (the Warehouse and the Ashen Pass, B.3's town) at the same sizes.
 *
 * The chain is modelled from the day it opens (on live the Ashen Pass is already done).
 */
const FORGEWARD = findCommunityProject('forgewardOutpost')!;
/** Ticket B.5b: the Outpost as 6.7 shipped it (the default fifth on every stage's first day). */
const FORGEWARD_6_7: CommunityProjectDefinition = {
  ...FORGEWARD,
  stages: FORGEWARD.stages.map((s) => ({ ...s, capShare: 0.2 })),
};
/** A stage's first-day share (B.3's fifth, the Outpost's tenth since ticket B.5b). */
const firstDayShare = (project: string, stage: string) =>
  COMMUNITY_PROJECTS.find((p) => p.id === project)!.stages.find((s) => s.id === stage)!.capShare ??
  COMMUNITY_PROJECT_CONFIG.capShare;
const B3 = COMMUNITY_PROJECTS.slice(0, 2);
const SIZES = [20, 100, 500];
const SMALL = [1, 3, 10];
const endless = (n: number) => Array.from({ length: n }, () => ENDLESS);
const play = (players: (typeof ENDLESS)[], projects: readonly CommunityProjectDefinition[]) =>
  playTown(players, COMMUNITY_PROJECT_CONFIG, projects, 200);

/** Days (1-based) from the first project's opening until each project is done. */
const doneDays = (r: StageResult[], projects: readonly CommunityProjectDefinition[]) =>
  projects.map((def) => {
    const last = r.filter((x) => x.project === def.id).at(-1);
    return last && last.stage === def.stages.at(-1)!.id ? last.doneOn + 1 : Infinity;
  });
const stageDays = (r: StageResult[]) => r.map((x) => x.doneOn - x.firstDay + 1).join('/');

describe('the Forgeward Outpost at scale (ticket 6.7)', () => {
  const runs = {
    beforeCap: new Map(SIZES.map((n) => [n, play(endless(n), B3)])),
    beforeGather: new Map(SIZES.map((n) => [n, play(town(n), B3)])),
    cap: new Map([...SMALL, ...SIZES].map((n) => [n, play(endless(n), [FORGEWARD])])),
    gather: new Map([...SMALL, ...SIZES].map((n) => [n, play(largeTown(n), [FORGEWARD])])),
  };
  const gather67 = new Map(SIZES.map((n) => [n, play(largeTown(n), [FORGEWARD_6_7])]));
  const row = (r: StageResult[], projects: readonly CommunityProjectDefinition[]) =>
    `${doneDays(r, projects).join(' + ')} d (stages ${stageDays(r)}; givers ${r.map((x) => x.givers).join('/')}; top ${r.map((x) => Math.round(x.topGiverShare * 100)).join('/')} %)`;

  it('is sparing with the Tyrant’s Ember and sized as a late-game sink', () => {
    const embers = FORGEWARD.stages.flatMap((s) =>
      s.needs.filter((n) => n.resource === 'tyrantsEmber').map((n) => ({ s: s.id, n: n.amount })),
    );
    expect(embers).toEqual([{ s: 'kindleBeacon', n: 10 }]);
    expect(FORGEWARD.requires).toBe('clearAshenPass');
    expect(FORGEWARD.stages).toHaveLength(3);
    const gold = FORGEWARD.stages.reduce(
      (sum, s) => sum + (s.needs.find((n) => n.resource === 'gold')?.amount ?? 0),
      0,
    );
    expect(gold).toBe(300_000);
  });

  it('paces: about a week at 20 players, a day or two at 100 and 500', () => {
    const label = SIZES.map((n) => `${n}: ${row(runs.gather.get(n)!, [FORGEWARD])}`).join('\n');
    const [d20] = doneDays(runs.gather.get(20)!, [FORGEWARD]);
    const [d100] = doneDays(runs.gather.get(100)!, [FORGEWARD]);
    const [d500] = doneDays(runs.gather.get(500)!, [FORGEWARD]);
    expect(d20, label).toBeGreaterThanOrEqual(5);
    expect(d20, label).toBeLessThanOrEqual(14);
    expect(d100, label).toBeLessThanOrEqual(3);
    expect(d500, label).toBeLessThanOrEqual(3);
    // A small town still gets there, held by embers and gold rather than the cap.
    for (const n of SMALL) expect(doneDays(runs.gather.get(n)!, [FORGEWARD])[0]).toBeLessThan(45);
  });

  it('B.3’s caps still prevent monopoly at every size; the Outpost needs ten on a first day (B.5b)', () => {
    expect(FORGEWARD.stages.map((s) => s.capShare)).toEqual([0.1, 0.1, 0.1]);
    for (const [k, m] of Object.entries(runs)) {
      for (const [n, r] of m) {
        expect(r.length, `${k} ${n}`).toBe(
          (k.startsWith('before') ? B3 : [FORGEWARD]).flatMap((p) => p.stages).length,
        );
        for (const x of r) {
          const label = `${k} ${n}: ${x.project}/${x.stage}`;
          const share = firstDayShare(x.project, x.stage);
          expect(share, label).toBe(x.project === FORGEWARD.id ? 0.1 : 0.2);
          expect(x.maxFirstDayShare, label).toBeLessThanOrEqual(share + 1e-9);
          expect(x.maxDayShare, label).toBeLessThanOrEqual(
            COMMUNITY_PROJECT_CONFIG.capShareMax + 1e-9,
          );
          // A stage finished on its first day: at least 1 / share givers (five, the Outpost ten),
          // and nobody carried more than that share of it. (A stage that stands longer lets one
          // player give more each day, B.3's growing cap.)
          if (x.doneOn === x.firstDay) {
            expect(x.givers, label).toBeGreaterThanOrEqual(Math.round(1 / share));
            expect(x.topGiverShare, label).toBeLessThanOrEqual(share + 1e-9);
          }
          // The Forgeward with the realistic player from 20 players: about a fifth at most, too.
          if (k === 'gather' && n >= 20) {
            expect(x.topGiverShare, label).toBeLessThanOrEqual(0.25);
          }
        }
      }
    }
    // Nine accounts with endless means (embers included) can't finish a stage on its first day.
    for (const x of play(endless(9), [FORGEWARD]))
      expect(x.doneOn, x.stage).toBeGreaterThan(x.firstDay);
  });

  it('the tenth changes no pace at 20, 100 and 500 players (ticket B.5b, as B.5 measured)', () => {
    for (const n of SIZES) {
      const label = `${n}: 6.7 ${row(gather67.get(n)!, [FORGEWARD])}; B.5b ${row(runs.gather.get(n)!, [FORGEWARD])}`;
      expect(doneDays(runs.gather.get(n)!, [FORGEWARD]), label).toEqual(
        doneDays(gather67.get(n)!, [FORGEWARD]),
      );
      // The first stage goes on day one either way, now from ten accounts at a tenth at most.
      const road = runs.gather.get(n)![0]!;
      expect(road.doneOn, label).toBe(road.firstDay);
      expect(road.givers, label).toBeGreaterThanOrEqual(10);
      expect(road.topGiverShare, label).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });

  it('records the before/after table (docs/COMMUNITY.md)', () => {
    const table = [
      ...SIZES.map(
        (n) =>
          `before ${n}: cap-bound ${row(runs.beforeCap.get(n)!, B3)}; gathering ${row(runs.beforeGather.get(n)!, B3)}`,
      ),
      ...SIZES.map((n) => `forgeward 6.7 ${n}: gathering ${row(gather67.get(n)!, [FORGEWARD])}`),
      ...[...SMALL, ...SIZES].map(
        (n) =>
          `forgeward ${n}: cap-bound ${row(runs.cap.get(n)!, [FORGEWARD])}; gathering ${row(runs.gather.get(n)!, [FORGEWARD])}`,
      ),
    ].join('\n');
    expect(table).toMatchInlineSnapshot(`
      "before 20: cap-bound 1 + 2 d (stages 1/1/1/1/2/1; givers 5/5/5/5/5/5; top 20/20/20/20/20/20 %); gathering 1 + 2 d (stages 1/1/1/1/2/1; givers 5/6/5/6/5/8; top 20/20/20/20/38/20 %)
      before 100: cap-bound 1 + 1 d (stages 1/1/1/1/1/1; givers 5/5/5/5/5/5; top 20/20/20/20/20/20 %); gathering 1 + 1 d (stages 1/1/1/1/1/1; givers 5/6/5/5/5/10; top 20/20/20/20/20/17 %)
      before 500: cap-bound 1 + 1 d (stages 1/1/1/1/1/1; givers 5/5/5/5/5/5; top 20/20/20/20/20/20 %); gathering 1 + 1 d (stages 1/1/1/1/1/1; givers 5/6/5/5/5/10; top 20/20/20/20/20/17 %)
      forgeward 6.7 20: gathering 8 d (stages 1/2/7; givers 6/16/20; top 19/16/20 %)
      forgeward 6.7 100: gathering 2 d (stages 1/1/2; givers 6/14/24; top 19/11/5 %)
      forgeward 6.7 500: gathering 2 d (stages 1/1/2; givers 6/16/20; top 19/11/10 %)
      forgeward 1: cap-bound 10 d (stages 4/4/4; givers 1/1/1; top 100/100/100 %); gathering 31 d (stages 7/16/10; givers 1/1/1; top 100/100/100 %)
      forgeward 3: cap-bound 4 d (stages 2/2/2; givers 3/3/3; top 40/40/40 %); gathering 20 d (stages 3/4/15; givers 3/3/3; top 45/54/68 %)
      forgeward 10: cap-bound 3 d (stages 1/2/2; givers 10/4/9; top 10/30/20 %); gathering 10 d (stages 2/2/8; givers 10/10/10; top 19/29/27 %)
      forgeward 20: cap-bound 2 d (stages 1/1/2; givers 10/10/5; top 10/10/30 %); gathering 8 d (stages 1/2/7; givers 10/16/20; top 10/18/17 %)
      forgeward 100: cap-bound 1 d (stages 1/1/1; givers 10/10/10; top 10/10/10 %); gathering 2 d (stages 1/1/2; givers 10/13/24; top 10/10/5 %)
      forgeward 500: cap-bound 1 d (stages 1/1/1; givers 10/10/10; top 10/10/10 %); gathering 2 d (stages 1/1/2; givers 10/16/20; top 10/9/7 %)"
    `);
  });
});
