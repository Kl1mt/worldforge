import { describe, expect, it } from 'vitest';
import { findCosmetic } from '../cosmetics/catalogue.js';
import { createRng } from '../rng.js';
import type { QuestEvent } from '../quests/events.js';
import { getArea } from '../world/areas.js';
import {
  EVENT_WEEK_MS,
  LANTERN_DEEP_ROAD_LEVEL,
  applyEventProgress,
  eventBounty,
  eventMinDays,
  planEventEnd,
  planEventSchedule,
  eventQuestOpen,
  eventQuestOpensAt,
  eventTallies,
  eventWeekAt,
  eventWeeks,
  gatherBounty,
  getEventDefinition,
  initialEventProgress,
  tiersReached,
} from './index.js';

/** Ticket 8.3: the Lantern Procession (docs/EVENTS.md "The second event"). */
const proc = getEventDefinition('lanternProcession');
const mod = (() => {
  const m = proc.modifier;
  if (m.kind !== 'gatherBounty') throw new Error('the Procession has a gather bounty');
  return m;
})();
const DAY = 24 * 60 * 60 * 1000;
const start = new Date('2030-06-03T00:00:00Z');
const at = (ms: number) => new Date(start.getTime() + ms);

const kills = (count: number, enemyId = 'risenFarmhand'): QuestEvent =>
  ({ type: 'enemyKilled', enemyId, count }) as QuestEvent;
const gathered = (count: number, materialId = 'timber'): QuestEvent =>
  ({ type: 'materialGathered', materialId, count }) as QuestEvent;
const boss: QuestEvent = { type: 'bossDefeated', bossId: 'gravewarden' };

/** Everything a hero could ever do, at once (every task's target several times over). */
const everything: QuestEvent[] = [
  kills(20_000),
  kills(20_000, 'hollowKnight'),
  gathered(5_000),
  ...Array.from({ length: 10 }, () => boss),
];

describe('the Lantern Procession', () => {
  it('runs four weeks: three tasks a week, the third on the deeper road (28+)', () => {
    expect(proc.defaultDays).toBe(28);
    expect(eventWeeks(proc)).toBe(4);
    for (let w = 1; w <= 4; w += 1) {
      const week = proc.quests.filter((q) => (q.week ?? 1) === w);
      expect(week).toHaveLength(3);
      expect(week.filter((q) => q.minLevel === LANTERN_DEEP_ROAD_LEVEL)).toHaveLength(1);
      expect(week.filter((q) => q.minLevel === undefined)).toHaveLength(2);
    }
    // Seven keepsakes; existing kinds only (no new art): palette, banners, crest, colours, title.
    expect(proc.track.map((t) => t.tallies)).toEqual([10, 30, 60, 100, 140, 190, 230]);
    expect(proc.track.map((t) => findCosmetic(t.cosmeticId)!.kind)).toEqual([
      'titleColour',
      'banner',
      'crest',
      'titleColour',
      'appearance',
      'banner',
      'title',
    ]);
    // The deeper road's kill tasks count only the Cinderwastes' and the Hollow Reach's foes.
    const deep = proc.quests.find((q) => q.id === 'throughTheCinders')!.objective;
    expect(deep.kind).toBe('kill');
    const foes = new Set((deep as unknown as { enemyIds: string[] }).enemyIds);
    for (const id of ['ashfallVerge', 'cinderDepths', 'paleMarches', 'hollowDeep'] as const)
      for (const e of getArea(id).enemies) expect(foes.has(e.enemyId)).toBe(true);
    for (const e of getArea('abandonedFields').enemies) expect(foes.has(e.enemyId)).toBe(false);
  });

  it('weeks open at the start + 7, 14 and 21 days, to the millisecond', () => {
    expect(eventWeekAt(start, at(-1))).toBe(0);
    expect(eventWeekAt(start, start)).toBe(1);
    expect(eventWeekAt(start, at(EVENT_WEEK_MS - 1))).toBe(1);
    expect(eventWeekAt(start, at(EVENT_WEEK_MS))).toBe(2);
    expect(eventWeekAt(start, at(3 * EVENT_WEEK_MS))).toBe(4);
    for (const q of proc.quests)
      expect(eventQuestOpensAt(start, q).getTime()).toBe(
        start.getTime() + ((q.week ?? 1) - 1) * 7 * DAY,
      );
  });

  it('a request advances only the weeks begun when it arrived; nothing earlier carries over', () => {
    let progress = initialEventProgress(proc);
    const endgame = { level: 50 };
    // Week 1: everything at once completes the three week-1 tasks only.
    let out = applyEventProgress(proc, progress, everything, {
      week: eventWeekAt(start, at(EVENT_WEEK_MS - 1)),
      ...endgame,
    });
    expect(out.completed).toEqual(['clearTheGateRoad', 'wickAndFrame', 'wardensAtTheGate']);
    expect(eventTallies(proc, out.progress)).toBe(35);
    progress = out.progress;
    // Week 2 opens: the same request moves week 2 and nothing of weeks 3–4 (they stay at 0).
    out = applyEventProgress(proc, progress, everything, {
      week: eventWeekAt(start, at(EVENT_WEEK_MS)),
      ...endgame,
    });
    expect(out.completed).toEqual(['theAshenRoad', 'oilForTheLanterns', 'throughTheCinders']);
    proc.quests.forEach((q, i) => {
      if ((q.week ?? 1) > 2) expect(out.progress[i]).toBe(0);
    });
    expect(eventTallies(proc, out.progress)).toBe(85);
    out = applyEventProgress(proc, out.progress, everything, { week: 4, ...endgame });
    expect(eventTallies(proc, out.progress)).toBe(230);
    expect(tiersReached(proc, 230)).toHaveLength(7);
  });

  it('the deeper road needs level 28 when the request arrives; below it, it waits at 0', () => {
    const q = proc.quests.find((x) => x.id === 'wardensAtTheGate')!;
    expect(eventQuestOpen(q, { week: 1, level: 27 })).toBe(false);
    expect(eventQuestOpen(q, { week: 1, level: 28 })).toBe(true);
    const i = proc.quests.indexOf(q);
    const low = applyEventProgress(proc, initialEventProgress(proc), [boss, boss], {
      week: 1,
      level: 27,
    });
    expect(low.progress[i]).toBe(0);
    // Reaching 28 later: only bosses from then on count.
    const high = applyEventProgress(proc, low.progress, [boss], { week: 1, level: 28 });
    expect(high.progress[i]).toBe(1);
  });

  it('participation tiers: a newcomer alone reaches tier 5, the deeper road the top', () => {
    const newcomer = applyEventProgress(proc, initialEventProgress(proc), everything, {
      week: 4,
      level: 6,
    });
    const tallies = eventTallies(proc, newcomer.progress);
    expect(tallies).toBe(140);
    expect(tiersReached(proc, tallies).map((t) => t.tier)).toEqual([1, 2, 3, 4, 5]);
    // Weekly pacing for an endgame hero who does every task as it opens.
    let p = initialEventProgress(proc);
    const byWeek: number[] = [];
    for (let w = 1; w <= 4; w += 1) {
      p = applyEventProgress(proc, p, everything, { week: w, level: 50 }).progress;
      byWeek.push(tiersReached(proc, eventTallies(proc, p)).length);
    }
    // Not the whole track in a week (B.5b): 35 / 85 / 150 / 230 marks, the top only in week 4.
    expect(byWeek).toEqual([2, 3, 5, 7]);
  });

  it('the gather bounty: one Iron Ore per 25 gathered, split-invariant, never its own bonus', () => {
    expect(mod.materialId).toBe('ironOre');
    expect(mod.every).toBe(25);
    expect(gatherBounty(mod, 0, { timber: 24 })).toEqual({ counted: 24, bonus: {} });
    expect(gatherBounty(mod, 24, { ashwort: 1 })).toEqual({ counted: 25, bonus: { ironOre: 1 } });
    // Soul Shards and boss materials are not gathered materials.
    expect(gatherBounty(mod, 0, { soulShard: 100, crownShard: 5 })).toEqual({
      counted: 0,
      bonus: {},
    });
    expect(eventBounty(mod, 0, { killsByEnemy: { risenFarmhand: 999 } }).bonus).toEqual({});
    const rng = createRng('8.3-gather-split');
    for (let trial = 0; trial < 200; trial += 1) {
      const parts = Array.from({ length: 1 + rng.int(0, 9) }, () => ({
        timber: rng.int(0, 40),
        ironOre: rng.int(0, 30),
        soulShard: rng.int(0, 3),
      }));
      let counted = 0;
      let bonus = 0;
      for (const part of parts) {
        const out = gatherBounty(mod, counted, part);
        counted = out.counted;
        bonus += out.bonus.ironOre ?? 0;
      }
      const all = parts.reduce((s, x) => s + x.timber + x.ironOre, 0);
      expect(counted).toBe(all);
      expect(bonus).toBe(Math.floor(all / 25));
    }
  });

  it('8.3b: is never shorter than its four weeks (by hand or by moving its end); ending now is', () => {
    expect(eventMinDays(proc)).toBe(28);
    expect(eventMinDays(getEventDefinition('harvestOfBones'))).toBe(0);
    const plan = (days: number) =>
      planEventSchedule(
        [],
        { definitionId: 'lanternProcession', startsAt: start, endsAt: at(days * DAY) },
        start,
      );
    expect(plan(27)).toEqual({ ok: false, problem: 'length_too_short' });
    expect(plan(28)).toEqual({ ok: true, number: 1 });
    const running = [
      { number: 1, definitionId: 'lanternProcession', startsAt: start, endsAt: at(28 * DAY) },
    ];
    expect(planEventEnd(running, 1, at(21 * DAY), at(DAY))).toEqual({
      ok: false,
      problem: 'length_too_short',
    });
    expect(planEventEnd(running, 1, at(DAY), at(DAY)).ok).toBe(true);
  });

  it('the Harvest of Bones keeps every quest open (no weeks, no level gates: 6.6 unchanged)', () => {
    const harvest = getEventDefinition('harvestOfBones');
    for (const q of harvest.quests) {
      expect(q.week ?? 1).toBe(1);
      expect(q.minLevel).toBeUndefined();
      expect(eventQuestOpen(q, { week: 1, level: 1 })).toBe(true);
    }
    const events = [kills(1000), gathered(100, 'soulShard'), boss];
    expect(applyEventProgress(harvest, [0, 0, 0, 0], events)).toEqual(
      applyEventProgress(harvest, [0, 0, 0, 0], events, { week: 1, level: 1 }),
    );
  });
});
