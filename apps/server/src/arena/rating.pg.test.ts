/**
 * Real-PostgreSQL races for the arena rating (ticket 5.6, docs/PVP.md "Rating"). Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Asserts only what holds
 * in every order:
 * - many challengers against one defender: every duel moved the defender's rating from the one
 *   the previous commit left (one chain, nothing lost), as game-core predicts;
 * - a double submit with one key moves the ratings once;
 * - two accounts attacking each other at once never deadlock, and the repeat-pair factors are
 *   exactly 1, ½, ¼, 0 in commit order;
 * - duels racing the season's archive: the final standings equal the ratings, whichever came
 *   first, and nothing is written to the season after it; award runs racing give each award once;
 * - no transaction is retried.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, or } from 'drizzle-orm';
import {
  PROVISIONAL_GAMES,
  rateDuel,
  ratingFactor,
  seasonStartRating,
  type Rating,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  arenaRatings,
  duels,
  seasonAwards,
  seasonStandings,
  seasons,
  type Character,
} from '../db/schema.js';
import { transactionStats } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { archiveSeason, awardSeason } from '../seasons/model.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { arenaCalls, equipKit, setOffer } from '../test/arena.js';
import type { ArenaStateResponse } from './routes.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const N = 8;
const ROUNDS = 3;
const START = Date.parse('2026-11-09T12:00:00Z');
const DAY = 86_400_000;
const key = (r: Rating) => JSON.stringify([r.rating, r.deviation, r.volatility]);

describe.skipIf(!url)('real PostgreSQL: ratings race safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let api: ReturnType<typeof arenaCalls>;
  let nowMs = START;
  const now = () => new Date(nowMs);
  const db = () => database.db;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: N * 4 + 2 });
    app = buildApp({
      database,
      auth: { now, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    });
    await app.ready();
    api = arenaCalls(app);
    await db()
      .insert(seasons)
      .values({ number: 1, startsAt: new Date(START - DAY), endsAt: new Date(START + 20 * DAY) });
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  async function player(tag: string): Promise<{ who: TestAccount; hero: Character }> {
    const who = await insertAccount(db(), { now: now() });
    const hero = await insertCharacter(db(), who.id, { level: 15, classId: 'mage' });
    await equipKit(db(), hero.id, 'mage', 14, 'rare', tag);
    return { who, hero };
  }

  async function defend(p: { who: TestAccount; hero: Character }) {
    const res = await api.setDefence(p.who, p.hero.id);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ArenaStateResponse>().defence!.defenceId;
  }

  it('many challengers against one defender: one unbroken rating chain', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const foe = await player(`chain-foe-${round}`);
      const foeId = await defend(foe);
      const challengers = await Promise.all(
        Array.from({ length: N }, (_, i) => player(`chain-${round}-${i}`)),
      );
      for (const c of challengers)
        await setOffer(db(), c.who.id, c.hero.id, '10-19', [foeId], now());
      const results = await Promise.all(
        challengers.map((c) => api.duel(c.who, c.hero.id, foeId, 'rated')),
      );
      for (const r of results) expect(r.statusCode, r.body).toBe(201);
      const rows = await db().select().from(duels).where(eq(duels.defenceId, foeId));
      expect(rows).toHaveLength(N);
      // Walk the chain from the start: each duel's "before" is the previous one's "after".
      const byBefore = new Map(rows.map((r) => [key(r.rating!.defender.before), r]));
      expect(byBefore.size).toBe(N);
      let at = seasonStartRating(null);
      for (let i = 0; i < N; i++) {
        const row = byBefore.get(key(at));
        expect(row, `step ${i}`).toBeDefined();
        const rec = row!.rating!;
        expect(rec.factor).toBe(1);
        const predicted = rateDuel({
          challenger: { rating: rec.challenger.before, lastRatedAt: null },
          defender: { rating: rec.defender.before, lastRatedAt: null },
          outcome: row!.outcome,
          factor: 1,
          now: now(),
        });
        expect(rec.defender.after).toEqual(predicted.defender.after);
        expect(rec.challenger.after).toEqual(predicted.challenger.after);
        at = rec.defender.after;
      }
      const [final] = await db()
        .select()
        .from(arenaRatings)
        .where(and(eq(arenaRatings.season, 1), eq(arenaRatings.characterId, foe.hero.id)));
      expect(final).toMatchObject({ games: N, rating: at.rating, deviation: at.deviation });
      expect(final!.wins + final!.losses + final!.draws).toBe(N);
    }
    expect(transactionStats.retries).toBe(retries);
  });

  it('a double submit with one key moves the ratings once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const me = await player(`twice-${round}`);
      const foe = await player(`twice-foe-${round}`);
      const foeId = await defend(foe);
      await setOffer(db(), me.who.id, me.hero.id, '10-19', [foeId], now());
      const k = randomUUID();
      const results = await Promise.all(
        Array.from({ length: N }, () => api.duel(me.who, me.hero.id, foeId, 'rated', k)),
      );
      for (const r of results) expect(r.statusCode, r.body).toBe(201);
      const ratings = await db()
        .select()
        .from(arenaRatings)
        .where(inArray(arenaRatings.characterId, [me.hero.id, foe.hero.id]));
      expect(ratings.map((r) => r.games)).toEqual([1, 1]);
    }
  });

  it('two accounts attacking each other at once: no deadlock, exact repeat-pair factors', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const a = await player(`mutual-a-${round}`);
      const b = await player(`mutual-b-${round}`);
      const aId = await defend(a);
      const bId = await defend(b);
      // Each list holds the other (set up explicitly), refreshed before every pair of calls.
      const calls: Promise<{ statusCode: number; body: string }>[] = [];
      for (let i = 0; i < 3; i++) {
        await setOffer(db(), a.who.id, a.hero.id, '10-19', [bId], now());
        await setOffer(db(), b.who.id, b.hero.id, '10-19', [aId], now());
        calls.push(
          api.duel(a.who, a.hero.id, bId, 'rated'),
          api.duel(b.who, b.hero.id, aId, 'rated'),
        );
        await Promise.all(calls.slice(-2));
      }
      for (const r of await Promise.all(calls)) expect(r.statusCode, r.body).toBe(201);
      const rows = await db()
        .select()
        .from(duels)
        .where(
          or(
            and(eq(duels.challengerAccountId, a.who.id), eq(duels.defenderAccountId, b.who.id)),
            and(eq(duels.challengerAccountId, b.who.id), eq(duels.defenderAccountId, a.who.id)),
          ),
        );
      expect(rows).toHaveLength(6);
      const prior = rows.map((r) => r.rating!.priorPairDuels).sort((x, y) => x - y);
      expect(prior).toEqual([0, 1, 2, 3, 4, 5]);
      for (const r of rows) expect(r.rating!.factor).toBe(ratingFactor(r.rating!.priorPairDuels));
    }
    expect(transactionStats.retries).toBe(retries);
  });

  it('duels racing the archive: the final standings equal the ratings, nothing after', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const number = 10 + round;
      const endsAt = START + (30 + round * 10) * DAY;
      await db()
        .insert(seasons)
        .values({ number, startsAt: new Date(endsAt - 5 * DAY), endsAt: new Date(endsAt) });
      nowMs = endsAt - 60_000; // the duels' requests arrive just before the end
      const heroes = await Promise.all(
        Array.from({ length: N }, (_, i) => player(`arch-${round}-${i}`)),
      );
      // One duel short of established: whether a racing duel counts decides who is archived.
      for (const h of heroes)
        await db()
          .insert(arenaRatings)
          .values({
            season: number,
            characterId: h.hero.id,
            accountId: h.who.id,
            classId: h.hero.classId,
            level: h.hero.level,
            bracketId: '10-19',
            ratingVersion: 1,
            rating: 1500,
            deviation: 120,
            volatility: 0.06,
            games: PROVISIONAL_GAMES - 1,
            wins: PROVISIONAL_GAMES - 1,
            losses: 0,
            draws: 0,
            lastRatedAt: new Date(endsAt - DAY),
            updatedAt: new Date(endsAt - DAY),
          });
      const pairs = Array.from({ length: N / 2 }, (_, i) => [heroes[2 * i]!, heroes[2 * i + 1]!]);
      const ids = await Promise.all(pairs.map(([, d]) => defend(d!)));
      for (const [i, [c]] of pairs.entries())
        await setOffer(db(), c!.who.id, c!.hero.id, '10-19', [ids[i]!], now());
      const archive = () =>
        archiveSeason(db(), number, new Date(endsAt + 60_000), new Date(endsAt + 60_000), 0);
      const work: Promise<unknown>[] = pairs.map(([c], i) =>
        api.duel(c!.who, c!.hero.id, ids[i]!, 'rated'),
      );
      work.splice(round % (work.length + 1), 0, archive());
      await Promise.all(work);
      const ratings = await db().select().from(arenaRatings).where(eq(arenaRatings.season, number));
      const standings = await db()
        .select()
        .from(seasonStandings)
        .where(and(eq(seasonStandings.season, number), eq(seasonStandings.metric, 'arena')));
      const established = ratings.filter((r) => r.games >= PROVISIONAL_GAMES);
      expect(standings.map((s) => s.characterId).sort()).toEqual(
        established.map((r) => r.characterId).sort(),
      );
      for (const s of standings) {
        const r = established.find((x) => x.characterId === s.characterId)!;
        expect(Number(s.value)).toBe(Math.round(r.rating));
      }
      // A duel that committed after the archive wrote no rating into the season.
      const fought = await db().select().from(duels).where(inArray(duels.defenceId, ids));
      expect(fought).toHaveLength(pairs.length);
      const counted = fought.filter((d) => d.rating !== null);
      expect(counted.every((d) => d.rating!.season === number)).toBe(true);
      expect(established.length).toBe(counted.length * 2);
      // Award runs racing: each award once.
      await Promise.all([awardSeason(db(), number, now()), awardSeason(db(), number, now())]);
      const awards = await db()
        .select()
        .from(seasonAwards)
        .where(and(eq(seasonAwards.season, number), eq(seasonAwards.metric, 'arena')));
      expect(awards.map((a) => a.characterId).sort()).toEqual(
        standings.map((s) => s.characterId).sort(),
      );
    }
    nowMs = START;
  });
});
