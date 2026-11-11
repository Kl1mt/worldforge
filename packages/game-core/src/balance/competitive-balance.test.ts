import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  DEFAULT_MATCHMAKING,
  PRESTIGE_TIERS,
  PROVISIONAL_GAMES,
  SETTLED_DEVIATION,
  bracketPower,
  createRng,
  duelFighter,
  duelSnapshot,
  findPvpBracket,
  initialRating,
  matchmakingConfig,
  pickOpponents,
  prestigeTierFor,
  rateDuel,
  ratingFactor,
  seasonStartRating,
  simulateDuel,
  tierCutoffs,
  type ClassId,
  type MatchmakingConfig,
  type PvpFighterInput,
  type Rating,
  type ScoredItem,
} from '../index.js';
import { winShare } from './pvp-fixtures.js';
import fixture from './realistic-arena.json' with { type: 'json' };

/**
 * Ticket B.4: the competitive systems on **realistic** heroes (docs/LEADERBOARDS.md and
 * docs/PVP.md "Balance pass: competitive systems"). `realistic-arena.json` holds defences of a
 * simulated 500-player season (`telemetry:simulate --days 56 --snapshots`, three runs, exported
 * by `tools/balance/export-arena-fixture.ts`): realistic players' worn gear on days 14, 28 and 56,
 * per rated bracket. Every duel draws from a fixed seed, so each number is a measurement that is
 * the same in every run; a band fails only when a rule, a constant or content changes (then
 * re-measure, and regenerate the fixture if content moved).
 */

type FixtureItem = [
  string,
  number,
  string,
  ScoredItem['rarityId'],
  number,
  [string, number, number][],
  number | null,
  Exclude<ScoredItem['variant'], undefined>,
  string | null,
  number | null,
  string | null,
  string | null,
];
type FixtureHero = [ClassId, number, FixtureItem[]];
const FIXTURE = fixture as unknown as Record<string, FixtureHero[]>;

interface Hero {
  index: number;
  defenceId: string;
  accountId: string;
  classId: ClassId;
  level: number;
  power: number;
  rating: number;
  deviation: number;
  fighter: PvpFighterInput;
  rejected: number;
}

const heroMemo = new Map<string, Hero[]>();
/**
 * Ticket B.5: `version` is the bracket Power the heroes are ranked by (3 = today's; 2 = B.4's,
 * Character Power, which B.4's comparisons with 5.6 were measured on).
 */
function realistic(bracketId: string, version: 2 | 3 = 3): Hero[] {
  const memoKey = `${bracketId}:${version}`;
  const hit = heroMemo.get(memoKey);
  if (hit) return hit;
  const bracket = findPvpBracket(bracketId)!;
  const heroes = FIXTURE[bracketId]!.map(([classId, level, items], index) => {
    const equipment: ScoredItem[] = items.map((i) => ({
      slot: i[0],
      seed: i[1],
      baseId: i[2],
      rarityId: i[3],
      itemLevel: i[4],
      affixes: i[5].map(([affixId, tier, value]) => ({ affixId, tier, value })),
      upgradeLevel: i[6],
      variant: i[7],
      effectId: i[8],
      effectRoll: i[9],
      mythicId: i[10],
      setId: i[11],
    }));
    const fighter = duelFighter(duelSnapshot({ classId, level, xp: 0, name: 'x', equipment }));
    return {
      index,
      defenceId: `d${index}`,
      accountId: `a${index}`,
      classId,
      level,
      power: bracketPower(fighter, bracket, version),
      rating: 1500,
      deviation: 350,
      fighter,
      rejected: equipment.length - fighter.equipment.length,
    };
  });
  heroMemo.set(memoKey, heroes);
  return heroes;
}

/** 5.6's matchmaking (version 1): raw Power, no preference for fresh pairs. */
const MATCHMAKING_V1: MatchmakingConfig = {
  ...DEFAULT_MATCHMAKING,
  freshPairsFirst: false,
  freshBelow: 3,
  classPowerScale: { warrior: 1, mage: 1, hunter: 1, warlock: 1 },
};

/** Every hero asks for a list; each offered pair is fought `seeds` times. */
function offered(bracketId: string, config: MatchmakingConfig, seeds = 16, version: 2 | 3 = 3) {
  const heroes = realistic(bracketId, version);
  const cells = new Map<string, { s: number; n: number }>();
  const fav: number[] = [];
  let empty = 0;
  for (const seeker of heroes) {
    const others = heroes.filter((h) => h.accountId !== seeker.accountId);
    const res = pickOpponents(seeker, others, `b4-offer:${bracketId}:${seeker.index}`, 5, config);
    if (res.picks.length === 0) empty++;
    for (const { candidate: d } of res.picks) {
      const share = winShare(
        seeker.fighter,
        d.fighter,
        seeds,
        `b4-pair:${bracketId}:${seeker.index}:${d.index}`,
      ).share;
      fav.push(Math.max(share, 1 - share));
      if (d.classId === seeker.classId) continue;
      const [x, y, s] =
        seeker.classId < d.classId
          ? [seeker.classId, d.classId, share]
          : [d.classId, seeker.classId, 1 - share];
      const c = cells.get(`${x}:${y}`) ?? { s: 0, n: 0 };
      c.s += s;
      c.n++;
      cells.set(`${x}:${y}`, c);
    }
  }
  // Each class's mean over its three class pairs (every pair weighs the same, as in 5.4).
  const sums = Object.fromEntries(CLASS_IDS.map((c) => [c, [0, 0]])) as Record<
    ClassId,
    [number, number]
  >;
  for (const [k, v] of cells) {
    const [x, y] = k.split(':') as [ClassId, ClassId];
    sums[x][0] += v.s / v.n;
    sums[x][1]++;
    sums[y][0] += 1 - v.s / v.n;
    sums[y][1]++;
  }
  const classMean = Object.fromEntries(
    CLASS_IDS.map((c) => [c, sums[c][0] / Math.max(1, sums[c][1])]),
  ) as Record<ClassId, number>;
  const spread = Math.max(...CLASS_IDS.map((c) => Math.abs(classMean[c] - 0.5)));
  return {
    classMean,
    spread,
    meanFavourite: fav.reduce((a, b) => a + b, 0) / fav.length,
    over95: fav.filter((x) => x >= 0.95).length / fav.length,
    empty,
  };
}

const SLOW = { timeout: 120_000 };

describe('the realistic arena fixture', () => {
  it('holds valid defences of realistic players in every rated bracket', () => {
    for (const id of ['10-19', '20-29', '30-plus']) {
      const heroes = realistic(id);
      expect(heroes.length, id).toBeGreaterThan(10);
      // Items still pass the server's checks (else regenerate the fixture after a content change).
      expect(heroes.every((h) => h.rejected === 0)).toBe(true);
      const bracket = findPvpBracket(id)!;
      for (const h of heroes) {
        expect(h.level).toBeGreaterThanOrEqual(bracket.min);
        expect(h.level).toBeLessThanOrEqual(bracket.max ?? 99);
      }
    }
    // A realistic season fills 30+ (the bracket every busy player reaches within a week or two).
    expect(realistic('30-plus').length).toBeGreaterThanOrEqual(100);
  });
});

describe('matchmaking on realistic heroes (B.4, B.5)', () => {
  for (const id of ['20-29', '30-plus']) {
    it(`${id}: Power relative to the class evens the classes over offered pairs`, SLOW, () => {
      // B.4's comparison, on the Power it was fitted on (bracket Power 2): matchmaking 2 against 5.6.
      const v2 = offered(id, DEFAULT_MATCHMAKING, 16, 2);
      const v1 = offered(id, MATCHMAKING_V1, 16, 2);
      // Measured (docs/PVP.md): 5.6 left the warrior at 37–41 % and the warlock at 60–62 %; now
      // every class is 44–56 %.
      for (const c of CLASS_IDS) {
        expect(v2.classMean[c], `${id} ${c}`).toBeGreaterThanOrEqual(0.42);
        expect(v2.classMean[c], `${id} ${c}`).toBeLessThanOrEqual(0.58);
      }
      // Ticket 6.1: the 30+ class factors were re-fitted (tier-4 gear), which evens the classes
      // under matchmaking 1 too, so the gain there is 2.7 points (was over 3).
      expect(v1.spread).toBeGreaterThan(v2.spread + (id === '30-plus' ? 0.02 : 0.03));
      // Fairness is no worse than 5.6's band (mean favourite, 95 %+ favourites).
      expect(v2.meanFavourite).toBeLessThanOrEqual(0.72);
      expect(v2.over95).toBeLessThanOrEqual(0.05);
      expect(v2.empty).toBe(0);
      // Ticket B.5: today's matchmaking (4, with bracket Power 3: duel Power in 30+) keeps every
      // class inside the band and is at least as fair as B.4's on the same heroes (30+: classes
      // 44.5–53.4 %, mean favourite 70.3 % → 65.1 %, 90 %+ 8.2 % → 2.3 %, 95 %+ 3.3 % → 0.3 %).
      const now = offered(id, matchmakingConfig(id));
      for (const c of CLASS_IDS) {
        expect(now.classMean[c], `${id} ${c} (B.5)`).toBeGreaterThanOrEqual(0.42);
        expect(now.classMean[c], `${id} ${c} (B.5)`).toBeLessThanOrEqual(0.58);
      }
      expect(now.meanFavourite).toBeLessThanOrEqual(v2.meanFavourite + 0.005);
      expect(now.over95).toBeLessThanOrEqual(Math.max(v2.over95, 0.01));
      expect(now.empty).toBe(0);
      if (id === '20-29') expect(now).toEqual(v2);
    });
  }
});

/**
 * A week of rated duels among the 30+ heroes (fixed gear): each hero challenges 3, 6 or 10 times
 * a day (casual, regular, dedicated) an opponent drawn from its list, both ratings move, the
 * repeat-pair factors apply.
 */
function ratedWeeks(
  config: MatchmakingConfig,
  days: number,
  carry?: Map<number, Rating>,
  /** 5.6's rule (before B.4b): a pair's fourth duel counted 0 and the pair was not offered. */
  blockAtFourth = false,
  /** Only the first `size` heroes (a small town). */
  size?: number,
  /** Ticket B.5: the bracket Power the heroes are ranked by (2 = B.4's measurements). */
  version: 2 | 3 = 3,
) {
  const heroes = realistic('30-plus', version).slice(0, size);
  const state = new Map(
    heroes.map((h) => [
      h.index,
      {
        r: carry ? seasonStartRating(carry.get(h.index)!) : initialRating(),
        at: null as Date | null,
        games: 0,
        settledAt: null as number | null,
      },
    ]),
  );
  const pairs = new Map<string, number[]>();
  const factors = [0, 0, 0, 0];
  let attempts = 0;
  let empty = 0;
  const start = Date.UTC(2027, 0, 4);
  const DAY = 86_400_000;
  for (let day = 1; day <= days; day++) {
    const now = new Date(start + day * DAY);
    for (let round = 0; round < 10; round++) {
      for (const h of heroes) {
        // Casual, regular and dedicated players: 3, 6 or 10 rated duels a day.
        if (round >= [3, 6, 10][h.index % 3]!) continue;
        const key = (o: Hero) =>
          h.index < o.index ? `${h.index}:${o.index}` : `${o.index}:${h.index}`;
        const recent = (o: Hero) =>
          (pairs.get(key(o)) ?? []).filter((t) => t > now.getTime() - 7 * DAY).length;
        const me = state.get(h.index)!;
        const cands = heroes
          .filter((o) => o.index !== h.index && !(blockAtFourth && recent(o) >= 3))
          .map((o) => ({
            ...o,
            rating: state.get(o.index)!.r.rating,
            deviation: state.get(o.index)!.r.deviation,
            recentDuels: recent(o),
          }));
        const res = pickOpponents(
          { ...h, rating: me.r.rating, deviation: me.r.deviation },
          cands,
          `b4-week:${day}:${round}:${h.index}`,
          5,
          config,
        );
        attempts++;
        if (res.picks.length === 0) {
          empty++;
          continue;
        }
        const pick = createRng(`b4-pick:${day}:${round}:${h.index}`).int(0, res.picks.length - 1);
        const d = res.picks[pick]!.candidate;
        const prior = recent(d);
        factors[Math.min(3, prior)]!++;
        const duel = simulateDuel({
          challenger: h.fighter,
          defender: d.fighter,
          seed: `b4-duel:${day}:${round}:${h.index}`,
        });
        const them = state.get(d.index)!;
        const out = rateDuel({
          challenger: { rating: me.r, lastRatedAt: me.at },
          defender: { rating: them.r, lastRatedAt: them.at },
          outcome: duel.outcome,
          factor: blockAtFourth && prior >= 3 ? 0 : ratingFactor(prior),
          now,
        });
        for (const [s, after] of [
          [me, out.challenger.after],
          [them, out.defender.after],
        ] as const) {
          s.r = after;
          s.at = now;
          s.games++;
          if (s.settledAt === null && after.deviation <= SETTLED_DEVIATION) s.settledAt = s.games;
        }
        pairs.set(key(d), [...(pairs.get(key(d)) ?? []), now.getTime()]);
      }
    }
  }
  const total = factors.reduce((a, b) => a + b, 0);
  const settled = [...state.values()].map((s) => s.settledAt ?? Infinity).sort((a, b) => a - b);
  return {
    fullShare: factors[0]! / total,
    /** Duels at a quarter: the third, and (B.4b) every later one. */
    quarterShare: (factors[2]! + factors[3]!) / total,
    emptyShare: empty / attempts,
    duels: total,
    established: [...state.values()].filter((s) => s.games >= PROVISIONAL_GAMES).length,
    medianSettledGames: settled[settled.length >> 1]!,
    ratings: new Map([...state.entries()].map(([i, s]) => [i, s.r])),
  };
}

describe('the rating over a season (B.4)', () => {
  it(
    'fresh pairs first: most rated duels count in full; ratings settle within a few days',
    SLOW,
    () => {
      // Ticket B.5: 5.6 against B.4 on the Power both were measured on (bracket Power 2); today's
      // matchmaking (4, duel Power in 30+) is checked against the same bands below.
      const v1 = ratedWeeks(MATCHMAKING_V1, 7, undefined, true, undefined, 2);
      const b4 = ratedWeeks(DEFAULT_MATCHMAKING, 7, undefined, false, undefined, 2);
      expect(b4.fullShare - v1.fullShare).toBeGreaterThanOrEqual(0.04);
      expect(v1.quarterShare - b4.quarterShare).toBeGreaterThanOrEqual(0.08);
      const mm = matchmakingConfig('30-plus');
      const v2 = ratedWeeks(mm, 7);
      // B.4b: the same matchmaking with 5.6's block (a pair's fourth duel counted 0, not offered).
      const blocked = ratedWeeks(mm, 7, undefined, true);
      // Measured on these 120 heroes (5.6 → B.4): in full 39 % → 45 %, at a quarter 28 % → 17 %
      // (500-player season, ~480 heroes in 30+: 30 % → 88 % in full). Ticket B.5 (duel Power in
      // 30+, compressed by its exponent 0.6): 51 % in full, 9 % at a quarter.
      expect(v2.fullShare).toBeGreaterThanOrEqual(0.42);
      expect(v2.quarterShare).toBeLessThanOrEqual(0.2);
      // Repeat pairs never block (owner decision, B.4b): no list is empty, and keeping them costs
      // at most 2 points of full-value duels against blocking them (46 %).
      expect(v2.emptyShare).toBe(0);
      expect(v2.duels).toBeGreaterThanOrEqual(blocked.duels);
      expect(blocked.fullShare - v2.fullShare).toBeLessThanOrEqual(0.02);
      // Every hero leaves "provisional" in its first week; ratings settle after ~15–30 games.
      expect(v2.established).toBe(realistic('30-plus').length);
      expect(v2.medianSettledGames).toBeLessThanOrEqual(30);
      // The soft reset: a season started from the last one's ratings settles in fewer games.
      const next = ratedWeeks(mm, 7, v2.ratings);
      expect(next.medianSettledGames).toBeLessThan(v2.medianSettledGames);
    },
  );
});

describe('a small town (B.4b)', () => {
  it('repeat pairs never block: sixteen duellists keep finding rated opponents', SLOW, () => {
    const floor = ratedWeeks(matchmakingConfig('30-plus'), 7, undefined, false, 16);
    const block = ratedWeeks(matchmakingConfig('30-plus'), 7, undefined, true, 16);
    // 5.6's block emptied most lists within the week; with the ¼ floor none is empty, and the
    // repeats count for a quarter.
    expect(block.emptyShare).toBeGreaterThanOrEqual(0.3);
    expect(floor.emptyShare).toBe(0);
    expect(floor.duels).toBeGreaterThan(block.duels);
    expect(floor.quarterShare).toBeGreaterThan(0.5);
  });
});

describe('prestige pacing (B.4)', () => {
  it('each tier stays a small share of a board at every town size', () => {
    for (const size of [20, 50, 100, 200, 500, 1000, 5000]) {
      const tiers = Array.from({ length: size }, (_, i) => prestigeTierFor(i + 1, 30, size));
      const share = (t: string) => tiers.filter((x) => x === t).length / size;
      expect(share('champion')).toBeCloseTo(1 / size);
      // At least two Exalted and two Renowned beyond the places above them, however small.
      expect(tiers.filter((x) => x === 'exalted').length).toBeGreaterThanOrEqual(2);
      expect(tiers.filter((x) => x === 'renowned').length).toBeGreaterThanOrEqual(2);
      // Before B.4 a board of 20 made everyone Exalted or Renowned; of 100, 99 % (no Veteran).
      expect(share('champion') + share('exalted')).toBeLessThanOrEqual(0.15 + 1e-9);
      expect(share('champion') + share('exalted') + share('renowned')).toBeLessThanOrEqual(
        0.25 + 1e-9,
      );
      expect(share('veteran')).toBeGreaterThanOrEqual(0.75);
      const cut = tierCutoffs(size);
      expect(cut.exalted).toBeLessThanOrEqual(10);
      expect(cut.renowned).toBeLessThanOrEqual(100);
    }
    expect(PRESTIGE_TIERS.map((t) => t.id)).toEqual(['champion', 'exalted', 'renowned', 'veteran']);
  });
});
