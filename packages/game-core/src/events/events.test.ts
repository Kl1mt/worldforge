import { describe, expect, it } from 'vitest';
import { ENEMIES } from '../world/enemies.js';
import { MATERIALS } from '../world/materials.js';
import { DUNGEONS } from '../world/dungeons.js';
import type { QuestEvent } from '../quests/events.js';
import { COSMETICS, cosmeticShownToday, findCosmetic } from '../cosmetics/catalogue.js';
import {
  EVENT_CLOSE_GRACE_MS,
  EVENT_DEFINITIONS,
  applyEventProgress,
  completedEventQuests,
  eventAt,
  eventStatus,
  eventTallies,
  getEventDefinition,
  inEventWindow,
  initialEventProgress,
  killBounty,
  nextEvent,
  planEventCancel,
  planEventEnd,
  planEventSchedule,
  tiersReached,
  validateEventDefinition,
  type EventWindow,
} from './index.js';
import { createRng } from '../rng.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const t0 = new Date('2030-03-04T00:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const harvest = getEventDefinition('harvestOfBones');

describe('event content', () => {
  it('every definition is valid and its cosmetics exist', () => {
    const known = {
      enemies: new Set(ENEMIES.map((e) => e.id as string)),
      bosses: new Set(DUNGEONS.map((d) => d.bossId as string)),
      materials: new Set(MATERIALS.map((m) => m.id as string)),
      cosmetics: new Set(COSMETICS.map((c) => c.id)),
    };
    for (const def of EVENT_DEFINITIONS) expect(validateEventDefinition(def, known)).toEqual([]);
    // Every event cosmetic names its event and kind prefix (6.8 adds other sources).
    for (const c of COSMETICS) {
      expect(c.id.startsWith(c.kind === 'titleColour' ? 'title-colour.' : `${c.kind}.`)).toBe(true);
      const s = c.source;
      if (s.kind === 'event') expect(EVENT_DEFINITIONS.some((d) => d.id === s.eventId)).toBe(true);
    }
  });

  it('Harvest of Bones: four quests, three tiers, every keepsake shown (6.8)', () => {
    expect(harvest.quests).toHaveLength(4);
    expect(harvest.track.map((t) => t.tallies)).toEqual([10, 25, 50]);
    expect(harvest.track.map((t) => t.cosmeticId)).toEqual([
      'banner.harvest-sheaf',
      'title-colour.bone-white',
      'title.reaper-of-the-harvest',
    ]);
    const title = findCosmetic('title.reaper-of-the-harvest')!;
    expect(cosmeticShownToday(title)).toBe(true);
    // Ticket 6.8: the collection book shows banners and title colours too.
    expect(cosmeticShownToday(findCosmetic('banner.harvest-sheaf')!)).toBe(true);
    // The modifier counts only undead of the first areas.
    for (const id of harvest.modifier.enemyIds) {
      expect(ENEMIES.find((e) => e.id === id)!.undead).toBe(true);
    }
  });
});

describe('the event calendar', () => {
  const ev = (n: number, start: number, end: number, extra: Partial<EventWindow> = {}) => ({
    number: n,
    definitionId: 'harvestOfBones',
    startsAt: at(start),
    endsAt: at(end),
    ...extra,
  });

  it('the window rule: [start, end), the end moment belongs to no event', () => {
    const e = ev(1, 0, 7 * DAY);
    expect(inEventWindow(e, at(-1))).toBe(false);
    expect(inEventWindow(e, at(0))).toBe(true);
    expect(inEventWindow(e, at(7 * DAY - 1))).toBe(true);
    expect(inEventWindow(e, at(7 * DAY))).toBe(false);
    expect(eventStatus(e, at(-1))).toBe('scheduled');
    expect(eventStatus(e, at(0))).toBe('active');
    expect(eventStatus(e, at(7 * DAY))).toBe('closing');
    expect(eventStatus({ ...e, closedAt: at(7 * DAY + EVENT_CLOSE_GRACE_MS) }, at(8 * DAY))).toBe(
      'closed',
    );
    expect(eventStatus({ ...e, cancelledAt: at(-5) }, at(1))).toBe('cancelled');
    expect(inEventWindow({ ...e, cancelledAt: at(-5) }, at(1))).toBe(false);
  });

  it('schedules one at a time', () => {
    const plan = (events: EventWindow[], s: number, e: number, now = at(0)) =>
      planEventSchedule(
        events,
        { definitionId: 'harvestOfBones', startsAt: at(s), endsAt: at(e) },
        now,
      );
    expect(plan([], 0, 7 * DAY)).toEqual({ ok: true, number: 1 });
    expect(plan([], DAY, DAY + HOUR - 1)).toEqual({ ok: false, problem: 'too_short' });
    expect(plan([], DAY, DAY + 29 * DAY)).toEqual({ ok: false, problem: 'too_long' });
    expect(plan([], -2 * HOUR, DAY)).toEqual({ ok: false, problem: 'starts_in_past' });
    expect(plan([], DAY, DAY)).toEqual({ ok: false, problem: 'end_before_start' });
    expect(
      planEventSchedule([], { definitionId: 'nope', startsAt: at(0), endsAt: at(DAY) }, at(0)),
    ).toEqual({ ok: false, problem: 'unknown_event' });
    // An event under way: the next may start at its end, not before.
    const running = [ev(1, -DAY, 6 * DAY)];
    expect(plan(running, 5 * DAY, 9 * DAY)).toEqual({ ok: false, problem: 'overlaps' });
    expect(plan(running, 6 * DAY, 9 * DAY)).toEqual({ ok: true, number: 2 });
    // Only one waiting.
    const waiting = [...running, ev(2, 6 * DAY, 9 * DAY)];
    expect(plan(waiting, 20 * DAY, 21 * DAY)).toEqual({ ok: false, problem: 'one_scheduled' });
    // A cancelled one frees its window and its place; numbers are never reused.
    const cancelled = [...running, ev(2, 6 * DAY, 9 * DAY, { cancelledAt: at(0) })];
    expect(plan(cancelled, 6 * DAY, 9 * DAY)).toEqual({ ok: true, number: 3 });
  });

  it('end early, extend and cancel', () => {
    const list = [ev(1, -DAY, 6 * DAY), ev(2, 8 * DAY, 10 * DAY)];
    const now = at(0);
    expect(planEventEnd(list, 1, now, now)).toMatchObject({ ok: true });
    expect(planEventEnd(list, 1, at(7 * DAY), now)).toMatchObject({ ok: true });
    expect(planEventEnd(list, 1, at(9 * DAY), now)).toEqual({ ok: false, problem: 'overlaps' });
    expect(planEventEnd(list, 1, at(-1000), now)).toEqual({ ok: false, problem: 'ends_in_past' });
    expect(planEventEnd(list, 2, at(8 * DAY + HOUR - 1), now)).toEqual({
      ok: false,
      problem: 'too_short',
    });
    expect(planEventEnd(list, 9, now, now)).toEqual({ ok: false, problem: 'not_found' });
    expect(planEventEnd([ev(1, -2 * DAY, -DAY)], 1, now, now)).toEqual({
      ok: false,
      problem: 'already_ended',
    });
    expect(planEventCancel(list, 2, now)).toMatchObject({ ok: true });
    expect(planEventCancel(list, 1, now)).toEqual({ ok: false, problem: 'already_begun' });
    expect(planEventCancel([ev(2, DAY, 2 * DAY, { cancelledAt: now })], 2, now)).toEqual({
      ok: false,
      problem: 'cancelled',
    });
    expect(eventAt(list, at(0))?.number).toBe(1);
    expect(nextEvent(list, at(0))?.number).toBe(2);
  });
});

describe('event progress', () => {
  const kills = (enemyId: string, count: number): QuestEvent =>
    ({ type: 'enemyKilled', enemyId, count }) as QuestEvent;

  it('advances matching quests, caps, and completes each once', () => {
    let p = initialEventProgress(harvest);
    const a = applyEventProgress(harvest, p, [
      kills('risenFarmhand', 50),
      kills('carrionWolf', 30),
    ]);
    expect(a.progress).toEqual([50, 0, 80, 0]);
    expect(a.completed).toEqual([]);
    const b = applyEventProgress(harvest, a.progress, [
      kills('risenSkeleton', 20),
      { type: 'materialGathered', materialId: 'soulShard', count: 30 },
      { type: 'bossDefeated', bossId: 'gravewarden' },
    ]);
    expect(b.progress).toEqual([60, 12, 100, 1]);
    expect(b.completed).toEqual(['turnTheFurrows', 'ossuaryTithe', 'stillAWarden']);
    const c = applyEventProgress(harvest, b.progress, [
      { type: 'bossDefeated', bossId: 'ashenWarden' },
      kills('risenFarmhand', 1000),
    ]);
    expect(c.completed).toEqual(['theLongReaping']);
    p = c.progress;
    expect(completedEventQuests(harvest, p)).toHaveLength(4);
    expect(eventTallies(harvest, p)).toBe(50);
    expect(tiersReached(harvest, 50).map((t) => t.tier)).toEqual([1, 2, 3]);
    expect(tiersReached(harvest, 24).map((t) => t.tier)).toEqual([1]);
    expect(tiersReached(harvest, 9)).toEqual([]);
  });

  it('progress and the kill bounty are split-invariant', () => {
    const rng = createRng('event-split').next;
    for (let trial = 0; trial < 200; trial++) {
      const chunks = Array.from({ length: 1 + Math.floor(rng() * 8) }, () => ({
        risenFarmhand: Math.floor(rng() * 50),
        boneScarecrow: Math.floor(rng() * 20),
        carrionWolf: Math.floor(rng() * 30),
      }));
      // All at once.
      const all = { risenFarmhand: 0, boneScarecrow: 0, carrionWolf: 0 };
      for (const c of chunks) for (const k of Object.keys(c) as (keyof typeof c)[]) all[k] += c[k];
      const once = killBounty(harvest.modifier, 0, all);
      // In pieces.
      let counted = 0;
      let bonus = 0;
      let p = initialEventProgress(harvest);
      for (const c of chunks) {
        const r = killBounty(harvest.modifier, counted, c);
        counted = r.counted;
        bonus += r.bonus.soulShard ?? 0;
        p = applyEventProgress(
          harvest,
          p,
          Object.entries(c).map(([id, n]) => kills(id, n)),
        ).progress;
      }
      expect(counted).toBe(once.counted);
      expect(bonus).toBe(once.bonus.soulShard ?? 0);
      expect(bonus).toBe(Math.floor((all.risenFarmhand + all.boneScarecrow) / 40));
      expect(p).toEqual(
        applyEventProgress(
          harvest,
          initialEventProgress(harvest),
          Object.entries(all).map(([id, n]) => kills(id, n)),
        ).progress,
      );
    }
  });

  it('the bounty ignores foes it does not name and is modest', () => {
    expect(killBounty(harvest.modifier, 0, { carrionWolf: 1000, ashWraith: 1000 })).toEqual({
      counted: 0,
      bonus: {},
    });
    // One shard per 40 risen: at most 2.5 % of a kill's worth, under the Burial Grounds' own 3 %.
    expect(1 / harvest.modifier.every).toBeLessThanOrEqual(0.025);
  });
});
