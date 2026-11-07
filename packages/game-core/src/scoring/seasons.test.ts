import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEASON_MS,
  NO_PRESTIGE,
  PRESTIGE_TIERS,
  SCORE_METRICS,
  SEASON_TITLES,
  VETERAN_MIN_LEVEL,
  bestAward,
  defaultBoardSeason,
  inSeasonWindow,
  nextAutomaticSeason,
  planEnd,
  planSchedule,
  prestigeTierFor,
  prestigeTitle,
  seasonAt,
  seasonAwards,
  seasonStatus,
  type FinalStanding,
  type SeasonWindow,
} from '../index.js';

/** Ticket 5.3: the season plan rules and prestige awards (docs/LEADERBOARDS.md "Seasons"). */

const DAY = 86_400_000;
const at = (iso: string) => new Date(iso);
const s1: SeasonWindow = {
  number: 1,
  startsAt: at('2026-11-09T00:00:00Z'),
  endsAt: at('2027-01-04T00:00:00Z'),
};
const s2: SeasonWindow = {
  number: 2,
  startsAt: s1.endsAt,
  endsAt: new Date(s1.endsAt.getTime() + DEFAULT_SEASON_MS),
};

describe('season windows', () => {
  it('a window holds its start and not its end (the window rule)', () => {
    expect(inSeasonWindow(s1, s1.startsAt)).toBe(true);
    expect(inSeasonWindow(s1, new Date(s1.endsAt.getTime() - 1))).toBe(true);
    expect(inSeasonWindow(s1, s1.endsAt)).toBe(false);
    expect(inSeasonWindow(s1, new Date(s1.startsAt.getTime() - 1))).toBe(false);
    // Back to back: the end moment belongs to the next season only.
    expect(seasonAt([s1, s2], s1.endsAt)?.number).toBe(2);
    expect(seasonAt([s1, s2], new Date(s1.endsAt.getTime() - 1))?.number).toBe(1);
  });

  it('default length is eight weeks', () => {
    expect(DEFAULT_SEASON_MS).toBe(8 * 7 * DAY);
    expect(s1.endsAt.getTime() - s1.startsAt.getTime()).toBe(DEFAULT_SEASON_MS);
  });

  it('status follows the clock and the awards', () => {
    expect(seasonStatus(s1, at('2026-11-08T00:00:00Z'))).toBe('scheduled');
    expect(seasonStatus(s1, s1.startsAt)).toBe('active');
    expect(seasonStatus(s1, s1.endsAt)).toBe('closing');
    expect(seasonStatus({ ...s1, awardedAt: s1.endsAt }, s1.endsAt)).toBe('closed');
  });

  it('the boards default to the season under way, else the latest begun', () => {
    expect(defaultBoardSeason([s1, s2], at('2026-11-01T00:00:00Z'))).toBeUndefined();
    expect(defaultBoardSeason([s2, s1], at('2026-12-01T00:00:00Z'))?.number).toBe(1);
    expect(defaultBoardSeason([s1, s2], s2.startsAt)?.number).toBe(2);
    expect(defaultBoardSeason([s1, s2], s2.endsAt)?.number).toBe(2);
  });
});

describe('season plans', () => {
  const now = at('2026-11-20T12:00:00Z');

  it('schedules the first season, then replaces the scheduled next one', () => {
    const first = planSchedule([], { startsAt: s1.startsAt, endsAt: s1.endsAt }, at('2026-11-08Z'));
    expect(first).toEqual({ ok: true, number: 1, replaces: null });
    const replace = planSchedule(
      [s1, s2],
      { startsAt: new Date(s2.startsAt.getTime() + DAY), endsAt: s2.endsAt },
      now,
    );
    expect(replace).toEqual({ ok: true, number: 2, replaces: s2 });
  });

  it('refuses bad plans', () => {
    const plan = (startsAt: Date, endsAt: Date, seasons = [s1]) =>
      planSchedule(seasons, { startsAt, endsAt }, now);
    expect(plan(s1.endsAt, s1.endsAt)).toEqual({ ok: false, problem: 'end_before_start' });
    expect(plan(s1.endsAt, new Date(s1.endsAt.getTime() + DAY - 1))).toEqual({
      ok: false,
      problem: 'too_short',
    });
    expect(plan(s1.endsAt, new Date(s1.endsAt.getTime() + 27 * 7 * DAY))).toEqual({
      ok: false,
      problem: 'too_long',
    });
    expect(plan(new Date(now.getTime() - DAY), s1.endsAt)).toEqual({
      ok: false,
      problem: 'starts_in_past',
    });
    // Overlapping the season under way.
    expect(plan(new Date(s1.endsAt.getTime() - DAY), s2.endsAt)).toEqual({
      ok: false,
      problem: 'not_after_previous',
    });
  });

  it('ends early: the back-to-back next season moves along, keeping its length', () => {
    const out = planEnd([s1, s2], 1, now, now);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.follower?.startsAt).toEqual(now);
    expect(out.follower!.endsAt.getTime() - out.follower!.startsAt.getTime()).toBe(
      s2.endsAt.getTime() - s2.startsAt.getTime(),
    );
  });

  it('extends; refuses the past, an ended season, an overlap with a gap-less next', () => {
    const later = new Date(s1.endsAt.getTime() + 7 * DAY);
    const out = planEnd([s1, s2], 1, later, now);
    expect(out.ok && out.follower?.startsAt).toEqual(later);
    expect(planEnd([s1], 1, new Date(now.getTime() - 1000), now)).toEqual({
      ok: false,
      problem: 'ends_in_past',
    });
    expect(planEnd([s1], 1, later, s1.endsAt)).toEqual({ ok: false, problem: 'already_ended' });
    const gapped: SeasonWindow = { ...s2, startsAt: new Date(s1.endsAt.getTime() + DAY) };
    expect(planEnd([s1, gapped], 1, new Date(gapped.startsAt.getTime() + 1), now)).toEqual({
      ok: false,
      problem: 'overlaps',
    });
    expect(planEnd([s1], 7, later, now)).toEqual({ ok: false, problem: 'not_editable' });
  });

  it('the next season follows on its own, back to back, once the latest has begun', () => {
    expect(nextAutomaticSeason([], now)).toBeNull();
    expect(nextAutomaticSeason([s1], at('2026-11-01Z'))).toBeNull();
    expect(nextAutomaticSeason([s1], now)).toEqual({
      number: 2,
      startsAt: s1.endsAt,
      endsAt: new Date(s1.endsAt.getTime() + DEFAULT_SEASON_MS),
    });
    // After a long outage the new season starts now (whole minute), not in the past.
    const late = new Date(s1.endsAt.getTime() + DEFAULT_SEASON_MS + 90_500);
    const next = nextAutomaticSeason([s1], late)!;
    expect(next.startsAt.getTime()).toBe(Math.floor(late.getTime() / 60_000) * 60_000);
  });
});

describe('prestige tiers', () => {
  it('places map to tiers; Veteran needs the minimum level', () => {
    expect(prestigeTierFor(1, 1)).toBe('champion');
    expect(prestigeTierFor(2, 1)).toBe('exalted');
    expect(prestigeTierFor(10, 1)).toBe('exalted');
    expect(prestigeTierFor(11, 1)).toBe('renowned');
    expect(prestigeTierFor(100, 1)).toBe('renowned');
    expect(prestigeTierFor(101, VETERAN_MIN_LEVEL - 1)).toBeNull();
    expect(prestigeTierFor(101, VETERAN_MIN_LEVEL)).toBe('veteran');
    expect(prestigeTierFor(5000, 40)).toBe('veteran');
    expect(prestigeTierFor(0, 40)).toBeNull();
    expect(prestigeTierFor(1.5, 40)).toBeNull();
  });

  it('every tier has a frame asset and every board a title badge (A.10 names)', () => {
    expect(PRESTIGE_TIERS.map((t) => t.frameAsset)).toEqual([
      'season-frame-champion',
      'season-frame-exalted',
      'season-frame-renowned',
      'season-frame-veteran',
    ]);
    expect(SCORE_METRICS.map((m) => SEASON_TITLES[m].badgeAsset)).toEqual([
      'title-badge-level',
      'title-badge-gear-score',
      'title-badge-power',
      'title-badge-pve-progress',
    ]);
    expect(prestigeTitle('pveProgress', 'exalted')).toBe('Exalted Pathfinder');
    expect(NO_PRESTIGE).toEqual({ title: null, frame: null });
  });

  it('awards each account its best tier per board, whatever the order of the standings', () => {
    const standings: FinalStanding[] = [
      { metric: 'level', rank: 1, accountId: 'a', characterId: 'a1', level: 30 },
      { metric: 'level', rank: 4, accountId: 'a', characterId: 'a2', level: 20 },
      { metric: 'level', rank: 2, accountId: 'b', characterId: 'b1', level: 3 },
      { metric: 'power', rank: 150, accountId: 'b', characterId: 'b1', level: 3 },
      { metric: 'power', rank: 151, accountId: 'c', characterId: 'c1', level: 12 },
      { metric: 'power', rank: 90, accountId: 'c', characterId: 'c2', level: 2 },
    ];
    const awards = seasonAwards(standings);
    expect(awards).toEqual([
      { accountId: 'a', metric: 'level', tier: 'champion', rank: 1, characterId: 'a1' },
      { accountId: 'b', metric: 'level', tier: 'exalted', rank: 2, characterId: 'b1' },
      { accountId: 'c', metric: 'power', tier: 'renowned', rank: 90, characterId: 'c2' },
    ]);
    // b's level-3 hero at 150 earns nothing (Veteran needs level 10).
    for (let i = 0; i < 20; i++) {
      const shuffled = [...standings].sort(() => (((i * 7919) % 13) / 13 > 0.5 ? 1 : -1));
      expect(seasonAwards(shuffled.reverse())).toEqual(awards);
    }
  });

  it('the default display is the best tier, then the newest season', () => {
    expect(
      bestAward([
        { season: 1, metric: 'power', tier: 'renowned' },
        { season: 2, metric: 'level', tier: 'exalted' },
        { season: 3, metric: 'gearScore', tier: 'exalted' },
      ]),
    ).toEqual({ season: 3, metric: 'gearScore', tier: 'exalted' });
    expect(bestAward([])).toBeUndefined();
  });
});
