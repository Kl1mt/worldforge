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

  it('B.3’s caps still prevent monopoly at every size', () => {
    for (const [k, m] of Object.entries(runs)) {
      for (const [n, r] of m) {
        expect(r.length, `${k} ${n}`).toBe(
          (k.startsWith('before') ? B3 : [FORGEWARD]).flatMap((p) => p.stages).length,
        );
        for (const x of r) {
          const label = `${k} ${n}: ${x.project}/${x.stage}`;
          expect(x.maxFirstDayShare, label).toBeLessThanOrEqual(0.2 + 1e-9);
          expect(x.maxDayShare, label).toBeLessThanOrEqual(
            COMMUNITY_PROJECT_CONFIG.capShareMax + 1e-9,
          );
          if (x.doneOn === x.firstDay) expect(x.givers, label).toBeGreaterThanOrEqual(5);
          // A stage finished on its first day: nobody carried more than a fifth of it. (A stage
          // that stands longer lets one player give 20 % + 40 % …, B.3's growing cap.)
          if (x.doneOn === x.firstDay) {
            expect(x.topGiverShare, label).toBeLessThanOrEqual(0.2 + 1e-9);
          }
          // The Forgeward with the realistic player from 20 players: about a fifth at most, too
          // (20.2 % measured at 20: a longer stage and the caps' rounding up).
          if (k === 'gather' && n >= 20) {
            expect(x.topGiverShare, label).toBeLessThanOrEqual(0.25);
          }
        }
      }
    }
    // Four accounts with endless means (embers included) can't finish a stage on its first day.
    for (const x of play(endless(4), [FORGEWARD]))
      expect(x.doneOn, x.stage).toBeGreaterThan(x.firstDay);
  });

  it('records the before/after table (docs/COMMUNITY.md)', () => {
    const table = [
      ...SIZES.map(
        (n) =>
          `before ${n}: cap-bound ${row(runs.beforeCap.get(n)!, B3)}; gathering ${row(runs.beforeGather.get(n)!, B3)}`,
      ),
      ...[...SMALL, ...SIZES].map(
        (n) =>
          `forgeward ${n}: cap-bound ${row(runs.cap.get(n)!, [FORGEWARD])}; gathering ${row(runs.gather.get(n)!, [FORGEWARD])}`,
      ),
    ].join('\n');
    expect(table).toMatchInlineSnapshot(`
      "before 20: cap-bound 1 + 2 d (stages 1/1/1/1/2/1; givers 5/5/5/5/5/5; top 20/20/20/20/20/20 %); gathering 1 + 2 d (stages 1/1/1/1/2/1; givers 5/6/5/6/5/8; top 20/20/20/20/38/20 %)
      before 100: cap-bound 1 + 1 d (stages 1/1/1/1/1/1; givers 5/5/5/5/5/5; top 20/20/20/20/20/20 %); gathering 1 + 1 d (stages 1/1/1/1/1/1; givers 5/6/5/5/5/10; top 20/20/20/20/20/17 %)
      before 500: cap-bound 1 + 1 d (stages 1/1/1/1/1/1; givers 5/5/5/5/5/5; top 20/20/20/20/20/20 %); gathering 1 + 1 d (stages 1/1/1/1/1/1; givers 5/6/5/5/5/10; top 20/20/20/20/20/17 %)
      forgeward 1: cap-bound 7 d (stages 3/3/3; givers 1/1/1; top 100/100/100 %); gathering 30 d (stages 6/16/10; givers 1/1/1; top 100/100/100 %)
      forgeward 3: cap-bound 4 d (stages 2/2/2; givers 3/3/3; top 60/60/60 %); gathering 20 d (stages 3/4/15; givers 3/3/3; top 40/54/69 %)
      forgeward 10: cap-bound 2 d (stages 1/1/2; givers 5/5/4; top 20/20/40 %); gathering 10 d (stages 1/3/8; givers 7/10/10; top 19/21/30 %)
      forgeward 20: cap-bound 1 d (stages 1/1/1; givers 5/5/5; top 20/20/20 %); gathering 8 d (stages 1/2/7; givers 6/16/20; top 19/16/20 %)
      forgeward 100: cap-bound 1 d (stages 1/1/1; givers 5/5/5; top 20/20/20 %); gathering 2 d (stages 1/1/2; givers 6/14/24; top 19/11/5 %)
      forgeward 500: cap-bound 1 d (stages 1/1/1; givers 5/5/5; top 20/20/20 %); gathering 2 d (stages 1/1/2; givers 6/16/20; top 19/11/10 %)"
    `);
  });
});
