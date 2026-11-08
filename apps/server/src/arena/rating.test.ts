/**
 * The arena rating, matchmaking and win-trading rules through the API (ticket 5.6, docs/PVP.md
 * "Rating", "Matchmaking", "Win-trading", "The ladder"). Never asserts who wins a duel: every
 * rating is predicted from the duel's stored outcome and the ratings before it with game-core
 * (`rateDuel`), and the ladder and archive tests set up their ratings explicitly.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import {
  PAIR_WINDOW_MS,
  PROVISIONAL_GAMES,
  PVP_BRACKETS,
  bracketPower,
  duelFighter,
  powerGap,
  rateDuel,
  ratingFactor,
  seasonStartRating,
  type ClassId,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accounts,
  arenaRatings,
  auditLog,
  characters,
  duelDefences,
  duels,
  itemInstances,
  seasonAwards,
  seasonStandings,
  seasons,
  type Character,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { arenaCalls, befriend, equipKit, sanction, setOffer } from '../test/arena.js';
import { archiveSeason, awardSeason } from '../seasons/model.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import type { ArenaStateResponse, DuelView } from './routes.js';
import type { LadderView } from './ladder.js';
import type { PatternPairView } from './patterns.js';

const START = Date.parse('2026-11-09T12:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;

describe('arena rating (ticket 5.6)', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let api: ReturnType<typeof arenaCalls>;
  let nowMs = START;
  const now = () => new Date(nowMs);
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: { now, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    });
    await app.ready();
    api = arenaCalls(app);
    // Season 1 holds every test of this file (except "outside a season" and the archive tests,
    // which use their own windows far away).
    await db()
      .insert(seasons)
      .values({ number: 1, startsAt: new Date(START - DAY), endsAt: new Date(START + 40 * DAY) });
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  beforeEach(() => {
    nowMs = START;
  });

  /** Puts every other test's 10–19 defences out of the bracket (explicit capacity). */
  async function onlyThese(...people: { who: TestAccount }[]) {
    await db()
      .update(duelDefences)
      .set({ bracketId: 'elsewhere' })
      .where(
        and(
          eq(duelDefences.bracketId, '10-19'),
          notInArray(
            duelDefences.accountId,
            people.map((p) => p.who.id),
          ),
        ),
      );
  }

  async function player(
    level = 15,
    classId: ClassId = 'warrior',
    opts: { name?: string; rarity?: 'rare' | 'legendary'; tag?: string } = {},
  ): Promise<{ who: TestAccount; hero: Character }> {
    const who = await insertAccount(db(), {
      now: now(),
      ...(opts.name ? { name: opts.name } : {}),
    });
    const hero = await insertCharacter(db(), who.id, { classId, level });
    await equipKit(
      db(),
      hero.id,
      classId,
      Math.max(1, Math.min(29, level - 1)),
      opts.rarity ?? 'rare',
      opts.tag ?? 'kit',
    );
    return { who, hero };
  }

  async function defend(p: { who: TestAccount; hero: Character }): Promise<string> {
    const res = await api.setDefence(p.who, p.hero.id);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ArenaStateResponse>().defence!.defenceId;
  }

  const code = (res: { json: () => unknown }) =>
    (res.json() as { error?: { code: string } }).error?.code;

  async function rated(
    me: { who: TestAccount; hero: Character },
    defenceId: string,
    key = randomUUID(),
  ) {
    await setOffer(db(), me.who.id, me.hero.id, '10-19', [defenceId], now());
    const res = await api.duel(me.who, me.hero.id, defenceId, 'rated', key);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ duel: DuelView }>().duel;
  }

  const ratingRow = async (season: number, characterId: string) =>
    (
      await db()
        .select()
        .from(arenaRatings)
        .where(and(eq(arenaRatings.season, season), eq(arenaRatings.characterId, characterId)))
    )[0];

  describe('a rated duel', () => {
    it('moves both ratings in its transaction, as game-core predicts', async () => {
      const me = await player();
      const foe = await player();
      const foeId = await defend(foe);
      const duel = await rated(me, foeId);
      const [row] = await db().select().from(duels).where(eq(duels.id, duel.id));
      const record = row!.rating!;
      expect(record).toMatchObject({ season: 1, factor: 1, priorPairDuels: 0 });
      // Both start fresh; the stored "after" is game-core's rateDuel for the stored outcome.
      const expected = rateDuel({
        challenger: { rating: seasonStartRating(null), lastRatedAt: null },
        defender: { rating: seasonStartRating(null), lastRatedAt: null },
        outcome: row!.outcome,
        factor: 1,
        now: now(),
      });
      expect(record.challenger).toEqual({
        before: expected.challenger.before,
        after: expected.challenger.after,
      });
      expect(record.defender.after).toEqual(expected.defender.after);
      const mine = await ratingRow(1, me.hero.id);
      const theirs = await ratingRow(1, foe.hero.id);
      expect(mine).toMatchObject({
        games: 1,
        rating: expected.challenger.after.rating,
        deviation: expected.challenger.after.deviation,
        accountId: me.who.id,
        bracketId: '10-19',
        lastRatedAt: now(),
      });
      expect(theirs).toMatchObject({ games: 1, rating: expected.defender.after.rating });
      expect(mine!.wins + theirs!.wins + mine!.draws).toBe(1);
      expect(mine!.wins).toBe(theirs!.losses);
      // The result shows the viewer's own change, from either side.
      expect(duel.rating).toEqual({
        season: 1,
        before: 1500,
        after: Math.round(expected.challenger.after.rating),
        change: Math.round(expected.challenger.after.rating) - 1500,
        factor: 1,
      });
      expect(duel.unrated).toBe(false);
      const asDefender = (await api.view(foe.who, duel.id)).json<{ duel: DuelView }>().duel;
      expect(asDefender.rating!.after).toBe(Math.round(expected.defender.after.rating));
      // The arena screen shows the hero's rating, provisional, and no rank yet.
      const state = (await api.state(me.who, me.hero.id)).json<ArenaStateResponse>();
      expect(state.ladder).toMatchObject({
        season: { number: 1, status: 'active' },
        you: { games: 1, standing: 'provisional' },
        rank: null,
      });
      // Audit and telemetry carry the change; the rollups reconcile.
      const [audit] = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.event, 'duel.fight'), eq(auditLog.accountId, me.who.id)));
      expect(audit!.data).toMatchObject({ rating: { season: 1, factor: 1 } });
      expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
    });

    it('the next duel starts from the stored rating, aged by idle days', async () => {
      const me = await player();
      const foe = await player();
      const foeId = await defend(foe);
      const first = await rated(me, foeId);
      nowMs += 3 * DAY;
      const second = await rated(me, foeId);
      const rows = await db()
        .select()
        .from(duels)
        .where(inArray(duels.id, [first.id, second.id]))
        .orderBy(asc(duels.foughtAt));
      const [a, b] = rows.map((r) => r.rating!);
      const expected = rateDuel({
        challenger: { rating: a!.challenger.after, lastRatedAt: new Date(START) },
        defender: { rating: a!.defender.after, lastRatedAt: new Date(START) },
        outcome: rows[1]!.outcome,
        factor: ratingFactor(1),
        now: now(),
      });
      expect(b).toMatchObject({ factor: 0.5, priorPairDuels: 1 });
      expect(b!.challenger).toEqual({
        before: expected.challenger.before,
        after: expected.challenger.after,
      });
      expect(b!.challenger.before.deviation).toBeGreaterThan(a!.challenger.after.deviation);
    });

    it('a retry with the same key replays the duel: the ratings move once', async () => {
      const me = await player();
      const foe = await player();
      const foeId = await defend(foe);
      const key = randomUUID();
      const first = await rated(me, foeId, key);
      const again = await api.duel(me.who, me.hero.id, foeId, 'rated', key);
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.json<{ duel: DuelView }>().duel.rating).toEqual(first.rating);
      expect((await ratingRow(1, me.hero.id))!.games).toBe(1);
      expect((await ratingRow(1, foe.hero.id))!.games).toBe(1);
    });

    it('outside a season, a rated duel counts toward the ten but moves no rating', async () => {
      nowMs = START + 45 * DAY; // between season 1 and season 2
      const me = await player();
      const foe = await player();
      const foeId = await defend(foe);
      const duel = await rated(me, foeId);
      expect(duel.rating).toBeNull();
      expect(duel.unrated).toBe(true);
      const state = (await api.state(me.who, me.hero.id)).json<ArenaStateResponse>();
      expect(state.ladder.season).toBeNull();
      expect(state.rated.used).toBe(1);
      expect(await ratingRow(1, me.hero.id)).toBeUndefined();
    });

    it('a friendly challenge never touches a rating', async () => {
      const me = await player();
      const friend = await player();
      const friendId = await defend(friend);
      await befriend(db(), me.who.id, friend.who.id, 'friends');
      const res = await api.duel(me.who, me.hero.id, friendId, 'friendly');
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json<{ duel: DuelView }>().duel).toMatchObject({ rating: null, unrated: false });
      expect(await ratingRow(1, me.hero.id)).toBeUndefined();
      expect(await ratingRow(1, friend.hero.id)).toBeUndefined();
    });
  });

  describe('matchmaking', () => {
    it('offers by bracket Power range: a far stronger kit is not offered, a close one is', async () => {
      const me = await player(15);
      const close = await player(15);
      const strong = await player(15, 'warrior', { rarity: 'legendary', tag: 'strong' });
      await db()
        .update(itemInstances)
        .set({ upgradeLevel: 10, variant: 'void' })
        .where(eq(itemInstances.characterId, strong.hero.id));
      const closeId = await defend(close);
      const strongId = await defend(strong);
      await onlyThese(me, close, strong);
      // The guard: by game-core, the strong kit is beyond the widest range, the close one equal.
      const [rows] = [
        await db()
          .select()
          .from(duelDefences)
          .where(inArray(duelDefences.id, [closeId, strongId])),
      ];
      const b = PVP_BRACKETS.find((x) => x.id === '10-19')!;
      const powerOf = (id: string) =>
        bracketPower(duelFighter(rows.find((r) => r.id === id)!.snapshot), b);
      expect(rows.every((r) => r.power === powerOf(r.id))).toBe(true);
      expect(powerGap(powerOf(closeId), powerOf(strongId))).toBeGreaterThan(0.2);
      const res = await api.draw(me.who, me.hero.id);
      expect(res.statusCode, res.body).toBe(200);
      const ids = res.json<ArenaStateResponse>().rated.offer!.opponents.map((o) => o.defenceId);
      expect(ids).toEqual([closeId]);
      // The strong hero, asking itself, finds nobody in range: an empty list, never a mismatch.
      const lonely = (await api.draw(strong.who, strong.hero.id)).json<ArenaStateResponse>();
      expect(lonely.rated.offer!.opponents).toEqual([]);
      // Telemetry: one list per draw, by the range used.
      const reconcile = await reconcileWithAudit(db());
      expect(reconcile.filter((c) => !c.ok)).toEqual([]);
    });

    it('a defence set before 5.6 (no stored Power) is still matched, by its computed Power', async () => {
      const me = await player(15);
      const old = await player(15);
      const oldId = await defend(old);
      await db()
        .update(duelDefences)
        .set({ power: null, powerVersion: null })
        .where(eq(duelDefences.id, oldId));
      await onlyThese(me, old);
      const ids = (await api.draw(me.who, me.hero.id))
        .json<ArenaStateResponse>()
        .rated.offer!.opponents.map((o) => o.defenceId);
      expect(ids).toEqual([oldId]);
    });
  });

  describe('win-trading', () => {
    it('diminishing returns against the same account; repeat pairs stay offered at ¼ (B.4b); the window ends', async () => {
      const me = await player();
      const foe = await player();
      // A second hero of the same foe account: the pair is per account.
      const foeHero2 = await insertCharacter(db(), foe.who.id, { classId: 'warrior', level: 15 });
      await equipKit(db(), foeHero2.id, 'warrior', 14);
      const foeId = await defend(foe);
      const foeId2 = await defend({ who: foe.who, hero: foeHero2 });
      const factors: number[] = [];
      for (const [i, id] of [foeId, foeId2, foeId, foeId2, foeId].entries()) {
        nowMs = START + i * 10 * MIN;
        const d = await rated(me, id);
        const [row] = await db().select().from(duels).where(eq(duels.id, d.id));
        factors.push(row!.rating!.factor);
      }
      // B.4b (owner decision): from the fourth duel on the factor stays at a quarter, never 0.
      expect(factors).toEqual([1, 0.5, 0.25, 0.25, 0.25]);
      // The foe challenging back counts on the same pair, and the pair is still offered both ways.
      await defend(me);
      await onlyThese(me, foe);
      const back = (await api.draw(foe.who, foe.hero.id)).json<ArenaStateResponse>();
      expect(back.rated.offer!.opponents).toHaveLength(1);
      nowMs = START + 5 * 10 * MIN;
      const again = await rated(foe, back.rated.offer!.opponents[0]!.defenceId);
      expect(again.rating!.factor).toBe(0.25);
      expect(
        (await api.draw(me.who, me.hero.id)).json<ArenaStateResponse>().rated.offer!.opponents,
      ).toHaveLength(1);
      // Once the window has passed, the pair counts in full again.
      nowMs = START + 5 * 10 * MIN + PAIR_WINDOW_MS + MIN;
      const fresh = (await api.draw(me.who, me.hero.id)).json<ArenaStateResponse>();
      expect(fresh.rated.offer!.opponents.map((o) => o.defenceId).sort()).toHaveLength(1);
      const d = await rated(me, foeId);
      expect(d.rating!.factor).toBe(1);
    });

    it('friends, guildmates and accounts sharing a mailbox are never offered nor rated', async () => {
      const me = await player();
      const friend = await player();
      const mate = await player();
      const alt = await player();
      const stranger = await player();
      await befriend(db(), me.who.id, friend.who.id, 'friends');
      await insertGuild(db(), me.who.id, { members: [{ accountId: mate.who.id }] });
      const [mine] = await db().select().from(accounts).where(eq(accounts.id, me.who.id));
      const [local, domain] = mine!.email.split('@');
      await db()
        .update(accounts)
        .set({ email: `${local}+alt@${domain!.toUpperCase()}` })
        .where(eq(accounts.id, alt.who.id));
      const ids = {
        friend: await defend(friend),
        mate: await defend(mate),
        alt: await defend(alt),
        stranger: await defend(stranger),
      };
      await onlyThese(me, friend, mate, alt, stranger);
      const offered = (await api.draw(me.who, me.hero.id))
        .json<ArenaStateResponse>()
        .rated.offer!.opponents.map((o) => o.defenceId);
      expect(offered).toEqual([ids.stranger]);
      // Named directly (an old list): refused, and the shared signal is never announced.
      for (const [who, want] of [
        ['friend', 'friendly_only'],
        ['mate', 'friendly_only'],
        ['alt', 'not_offered'],
      ] as const) {
        await setOffer(db(), me.who.id, me.hero.id, '10-19', [ids[who]], now());
        const res = await api.duel(me.who, me.hero.id, ids[who], 'rated');
        expect(code(res), `${who}: ${res.body}`).toBe(want);
        expect(res.body).not.toContain('mail');
      }
      // Friendly challenges stay open to friends and guildmates.
      for (const who of ['friend', 'mate'] as const) {
        const res = await api.duel(me.who, me.hero.id, ids[who], 'friendly');
        expect(res.statusCode, res.body).toBe(201);
      }
      // No email in any answer or audit row.
      const audits = await db().select().from(auditLog).where(eq(auditLog.accountId, me.who.id));
      expect(JSON.stringify(audits)).not.toContain(domain!);
    });

    it('the pattern report lists repeated, lopsided pairs to staff only', async () => {
      const me = await player();
      const foe = await player();
      const foeId = await defend(foe);
      for (let i = 0; i < 5; i++) {
        nowMs = START + i * MIN;
        await rated(me, foeId);
      }
      const moderator = await insertAccount(db(), { role: 'moderator', now: now() });
      const res = await api.inject(moderator, 'GET', '/api/mod/arena/patterns?days=14');
      expect(res.statusCode, res.body).toBe(200);
      const pair = res
        .json<{ pairs: PatternPairView[] }>()
        .pairs.find(
          (p) =>
            [p.a.handle, p.b.handle].sort().join() ===
            [me.who.handle, foe.who.handle].sort().join(),
        )!;
      expect(pair).toMatchObject({
        duels: 5,
        flags: expect.arrayContaining(['repeated', 'oneWay']),
      });
      expect(pair.winsA + pair.winsB + pair.draws).toBe(5);
      // Predicted from the stored duels: lopsided exactly when one side won ≥ 80 % of them.
      const rows = await db()
        .select()
        .from(duels)
        .where(
          and(eq(duels.challengerAccountId, me.who.id), eq(duels.defenderAccountId, foe.who.id)),
        );
      const myWins = rows.filter((r) => r.outcome === 'challenger').length;
      const foeWins = rows.filter((r) => r.outcome === 'defender').length;
      expect(pair.flags.includes('lopsided')).toBe(Math.max(myWins, foeWins) / 5 >= 0.8);
      // B.4b: the fourth and fifth duel count for a quarter, not for nothing.
      expect(pair.uncounted).toBe(0);
      expect(res.body).not.toContain(me.who.id);
      expect(res.body).not.toContain('@');
      const audit = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.event, 'mod.arena.patterns'), eq(auditLog.accountId, moderator.id)));
      expect(audit).toHaveLength(1);
      // Players (and anonymous visitors) get the not-found answer.
      expect((await api.inject(me.who, 'GET', '/api/mod/arena/patterns')).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/mod/arena/patterns' })).statusCode).toBe(
        404,
      );
    });
  });

  describe('the ladder', () => {
    /** A rated hero set up directly (explicit capacity: the ladder, not the duels). */
    async function ranked(
      season: number,
      rating: number,
      games: number,
      opts: { classId?: ClassId; level?: number; deviation?: number; at?: number } = {},
    ) {
      const p = await player(opts.level ?? 15, opts.classId ?? 'warrior');
      await db()
        .insert(arenaRatings)
        .values({
          season,
          characterId: p.hero.id,
          accountId: p.who.id,
          classId: p.hero.classId,
          level: p.hero.level,
          bracketId: '10-19',
          ratingVersion: 1,
          rating,
          deviation: opts.deviation ?? 80,
          volatility: 0.06,
          games,
          wins: games,
          losses: 0,
          draws: 0,
          lastRatedAt: new Date(opts.at ?? START),
          updatedAt: new Date(START),
        });
      return p;
    }

    it('ranks established heroes by rating, keeps provisional ones to their owner, with the board rules', async () => {
      await db()
        .insert(seasons)
        .values({
          number: 2,
          startsAt: new Date(START + 50 * DAY),
          endsAt: new Date(START + 90 * DAY),
        });
      nowMs = START + 51 * DAY;
      const top = await ranked(2, 1800, 12);
      const tieEarly = await ranked(2, 1700, 12, { at: START + 51 * DAY - 2 * MIN });
      const tieLate = await ranked(2, 1700, 12, { at: START + 51 * DAY - MIN });
      const mage = await ranked(2, 1650, 10, { classId: 'mage', level: 22 });
      const provisional = await ranked(2, 2000, PROVISIONAL_GAMES - 1);
      const sanctioned = await ranked(2, 1900, 15);
      await sanction(db(), sanctioned.who.id, 'mute', new Date(START + 60 * DAY));
      const hidden = await ranked(2, 1600, 11);
      await db()
        .update(accounts)
        .set({ profileVisibility: 'hidden' })
        .where(eq(accounts.id, hidden.who.id));

      const read = (who: TestAccount, q = '') => api.inject(who, 'GET', `/api/arena/ladder${q}`);
      const res = await read(provisional.who);
      expect(res.statusCode, res.body).toBe(200);
      const ladder = res.json<{ ladder: LadderView }>().ladder;
      expect(ladder.season!.number).toBe(2);
      expect(ladder.entries.map((e) => e.player.handle)).toEqual(
        [top, tieEarly, tieLate, mage, hidden].map((p) => p.who.handle),
      );
      expect(ladder.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5]);
      expect(ladder.entries[0]!.rating).toMatchObject({
        rating: 1800,
        low: 1640,
        high: 1960,
        standing: 'settled',
        games: 12,
      });
      // A hidden profile: listed by name, but no profile link and no hero name.
      const h = ladder.entries[4]!;
      expect(h.player).toMatchObject({ displayName: hidden.who.displayName, profile: false });
      expect(h.hero.name).toBeNull();
      // The provisional viewer sees its own hero, unranked.
      expect(ladder.yours).toEqual([
        expect.objectContaining({
          rank: null,
          you: true,
          rating: expect.objectContaining({
            standing: 'provisional',
            games: PROVISIONAL_GAMES - 1,
          }),
        }),
      ]);
      // The sanctioned account is left out and sees itself excluded.
      const own = (await read(sanctioned.who)).json<{ ladder: LadderView }>().ladder;
      expect(own.youExcluded).toBe(true);
      expect(own.entries.some((e) => e.you)).toBe(false);
      // Filters, pages, ETag.
      const mages = (await read(top.who, '?class=mage')).json<{ ladder: LadderView }>().ladder;
      expect(mages.entries.map((e) => e.player.handle)).toEqual([mage.who.handle]);
      const bracket = (await read(top.who, '?bracket=20-29')).json<{ ladder: LadderView }>().ladder;
      expect(bracket.entries.map((e) => e.player.handle)).toEqual([mage.who.handle]);
      const page1 = (await read(top.who, '?limit=2')).json<{ ladder: LadderView }>().ladder;
      expect(page1.entries).toHaveLength(2);
      const page2 = (await read(top.who, `?limit=2&cursor=${page1.nextCursor}`)).json<{
        ladder: LadderView;
      }>().ladder;
      expect(page2.entries.map((e) => e.rank)).toEqual([3, 4]);
      const first = await read(top.who);
      const again = await app.inject({
        method: 'GET',
        url: '/api/arena/ladder',
        headers: { 'if-none-match': String(first.headers.etag) },
        cookies: { wf_session: top.who.token },
      });
      expect([200, 304]).toContain(again.statusCode);
      // The arena screen's rank equals the ladder's.
      const state = (await api.state(tieLate.who, tieLate.hero.id)).json<ArenaStateResponse>();
      expect(state.ladder.rank).toBe(3);
      // Unknown or future seasons, the 1–9 bracket and bad cursors are refused.
      expect((await read(top.who, '?season=99')).statusCode).toBe(404);
      expect((await read(top.who, '?bracket=1-9')).statusCode).toBe(400);
      expect((await read(top.who, '?cursor=nope')).statusCode).toBe(400);
      // No ids in the answer.
      expect(res.body).not.toContain(top.hero.id);
      expect(res.body).not.toContain(top.who.id);
    });
  });

  describe('season end: archive, awards, reset', () => {
    it('archives the established ratings, honours them once, and starts the next season soft', async () => {
      const s = {
        number: 3,
        startsAt: new Date(START + 100 * DAY),
        endsAt: new Date(START + 110 * DAY),
      };
      await db().insert(seasons).values(s);
      const at = START + 105 * DAY;
      nowMs = at;
      const insert = async (
        p: { who: TestAccount; hero: Character },
        rating: number,
        games: number,
      ) =>
        db()
          .insert(arenaRatings)
          .values({
            season: 3,
            characterId: p.hero.id,
            accountId: p.who.id,
            classId: p.hero.classId,
            level: p.hero.level,
            bracketId: '10-19',
            ratingVersion: 1,
            rating,
            deviation: 70,
            volatility: 0.06,
            games,
            wins: games,
            losses: 0,
            draws: 0,
            lastRatedAt: new Date(at),
            updatedAt: new Date(at),
          });
      const champ = await player();
      const second = await player();
      const shy = await player();
      await insert(champ, 1850.4, 14);
      await insert(second, 1720, 10);
      await insert(shy, 1990, PROVISIONAL_GAMES - 1); // provisional: never archived
      // The ladder read just before the end is what the archive holds.
      nowMs = s.endsAt.getTime() - MIN;
      const before = (await api.inject(champ.who, 'GET', '/api/arena/ladder?season=3')).json<{
        ladder: LadderView;
      }>().ladder;
      nowMs = s.endsAt.getTime() + 10 * MIN;
      // Season 3 only (the scheduler's step, without touching this file's other seasons).
      expect(await archiveSeason(db(), 3, now(), now())).toBe('archived');
      expect(await awardSeason(db(), 3, now())).toMatchObject({ kind: 'awarded' });
      const standings = await db()
        .select()
        .from(seasonStandings)
        .where(and(eq(seasonStandings.season, 3), eq(seasonStandings.metric, 'arena')))
        .orderBy(asc(seasonStandings.rank));
      expect(standings.map((r) => [r.rank, r.characterId, Number(r.value)])).toEqual([
        [1, champ.hero.id, 1850],
        [2, second.hero.id, 1720],
      ]);
      expect(standings.map((r) => r.characterId)).toEqual(
        before.entries.map((e) =>
          e.player.handle === champ.who.handle ? champ.hero.id : second.hero.id,
        ),
      );
      // The archived ladder reads the final standings.
      const after = (await api.inject(champ.who, 'GET', '/api/arena/ladder?season=3')).json<{
        ladder: LadderView;
      }>().ladder;
      expect(after.season!.archivedAt).not.toBeNull();
      expect(after.entries.map((e) => [e.rank, e.player.handle, e.rating.rating])).toEqual(
        before.entries.map((e) => [e.rank, e.player.handle, e.rating.rating]),
      );
      // Honours: Champion and Exalted Duellist, exactly once (a second run gives nothing).
      const awards = async () =>
        db()
          .select()
          .from(seasonAwards)
          .where(and(eq(seasonAwards.season, 3), eq(seasonAwards.metric, 'arena')))
          .orderBy(asc(seasonAwards.rank));
      expect((await awards()).map((a) => [a.accountId, a.tier])).toEqual([
        [champ.who.id, 'champion'],
        [second.who.id, 'exalted'],
      ]);
      expect(await archiveSeason(db(), 3, now(), now())).toBe('already');
      expect(await awardSeason(db(), 3, now())).toEqual({ kind: 'already' });
      expect(await awards()).toHaveLength(2);
      const honours = await api.inject(champ.who, 'GET', '/api/account/prestige');
      expect(honours.statusCode, honours.body).toBe(200);
      expect(honours.body).toContain('"metric":"arena"');
      // Nothing written to a sealed season: a later duel goes to the next one (soft reset).
      const next = {
        number: 4,
        startsAt: s.endsAt,
        endsAt: new Date(s.endsAt.getTime() + 30 * DAY),
      };
      await db().insert(seasons).values(next).onConflictDoNothing();
      nowMs = next.startsAt.getTime() + 20 * MIN;
      const foe = await player();
      const foeId = await defend(foe);
      const d = await rated(champ, foeId);
      const [row] = await db().select().from(duels).where(eq(duels.id, d.id));
      expect(row!.rating!.season).toBe(4);
      expect(row!.rating!.challenger.before).toEqual(
        seasonStartRating({ rating: 1850.4, deviation: 70, volatility: 0.06 }),
      );
      expect(row!.rating!.challenger.before).toMatchObject({ deviation: 250 });
      expect(row!.rating!.challenger.before.rating).toBeCloseTo(1675.2, 9);
      // Season 3's rows are untouched.
      expect((await ratingRow(3, champ.hero.id))!.games).toBe(14);
    });
  });

  describe('invariance', () => {
    it('ratings change nothing a player owns', async () => {
      const me = await player();
      const foe = await player();
      const foeId = await defend(foe);
      const read = async () =>
        JSON.stringify([
          await db()
            .select()
            .from(characters)
            .where(inArray(characters.id, [me.hero.id, foe.hero.id]))
            .orderBy(asc(characters.id)),
          await db()
            .select()
            .from(itemInstances)
            .where(inArray(itemInstances.characterId, [me.hero.id, foe.hero.id]))
            .orderBy(asc(itemInstances.id)),
        ]);
      const before = await read();
      for (let i = 0; i < 3; i++) {
        nowMs = START + i * MIN;
        await rated(me, foeId);
      }
      expect(await read()).toBe(before);
      expect((await ratingRow(1, me.hero.id))!.games).toBe(3);
    });
  });
});
