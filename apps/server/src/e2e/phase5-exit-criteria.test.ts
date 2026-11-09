/**
 * Phase 5 exit criteria, end to end through the HTTP API with a simulated server clock (ticket
 * 5.8, GDD §15 Phase 5): leaderboard values are reproducible and server-authoritative; PvP matches
 * are understandable, reasonably fair, and do not damage core PvE progression; trading (switched
 * on in the test) creates and destroys no value, and every trade is auditable and reversible
 * within its window.
 *
 * Several players on one clock, registered through invite-only registration, play the way players
 * would (`./journey.ts`). The only steps outside the API are the owner's documented CLI steps (the
 * first invite, the roles, finishing the Warehouse project for the shelf) and the season jobs the
 * server's scheduler runs (`runSeasonJobs`, called at the clock the scheduler would). Every random
 * outcome comes from the server's own `crypto` seeds; the run asserts only what holds for every
 * seed, and predicts awards from the stored standings with game-core.
 *
 * - Account security (5.7): every player verifies their email through the captured letter; a
 *   guesser is throttled (and an unknown address answers the same); a player logs out another
 *   device and resets the password through the mailed link.
 * - The owner schedules Season 1 in the admin panel. Three heroes farm to level 15 on one clock; a
 *   fourth, a friend, stays below 10.
 * - Boards (5.1/5.2, B.4's Gear Score 2): everyone ranked by their own recomputed scores, every
 *   stored value equals its formula at the current version, the hidden name rule.
 * - Duels (5.4–5.6, B.4/B.4b): no rated duels below 10; friendly challenges across brackets (the
 *   lower hero's bracket, no rating); ten rated duels a day from the server's list only (the
 *   eleventh refused, the next day open again); each rating moves once per duel, repeat pairs at
 *   1, ½, ¼, ¼ (never 0); nothing anyone owns changes.
 * - The season ends: the archive and the awards are taken exactly once (the arena's honours
 *   included), equal to game-core's `seasonAwards` over the stored standings, and shown.
 * - Trading (T.1–T.7) with the switches on in the test: binding, the shelf, offers with escrow, the
 *   hold, the release, a switch-off void, a moderator reversal; back to the defaults.
 *
 * Valid means: every hero's holdings and every shelf match the audit log; `reconcileWithAudit` and
 * the real `pnpm report:telemetry -- --reconcile` on this run's database match in every check; and
 * no response ever carried another player's email, account id or hero id.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import {
  FORMULA_VERSIONS,
  PAIR_FACTORS,
  PROVISIONAL_GAMES,
  RATED_DUELS_PER_DAY,
  friendlyBracket,
  ratingFactor,
  seasonAwards,
  type ClassId,
  type PrestigeMetric,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accounts,
  auditLog,
  leaderboardEntries,
  seasonAwards as seasonAwardRows,
  seasonStandings,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createMemoryMailer, tokenIn } from '../mail/mailer.js';
import { createPgliteDatabase } from '../test/db.js';
import { setAccountRole } from '../social/roles.js';
import { checkLeaderboards } from '../leaderboards/check.js';
import { cliDeps } from '../leaderboards/leaderboard-cli.js';
import { runSeasonJobs } from '../seasons/model.js';
import { reconcileWithAudit, type RollupRow, type TelemetryReport } from '../telemetry/report.js';
import {
  HOUR,
  MIN,
  expectHoldingsMatchAudit,
  holdingsOf,
  newPlayer,
  openInviteOnlyTown,
  playAccountSecurityStep,
  playLeaderboardStep,
  playTradingHardeningStep,
  playerOf,
  startJourney,
  townVisit,
  type Journey,
} from './journey.js';

const CAP = 3 * HOUR;
const DAY = 24 * HOUR;
/** Town visits (2 h each) before the run gives up on level 15. */
const MAX_TOWN_VISITS = 12 * 8;
const TRADE_LEVEL = 15;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

let dataDir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
// A Monday morning, 06:00 UTC.
let nowMs = Date.parse('2026-11-16T06:00:00Z');
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };
const now = () => new Date(nowMs);
/** A minute between two duels or social steps, as a player takes them (4.1's social class). */
const pause = () => clock.set(clock.now() + MIN);
const mailer = createMemoryMailer();

/** Every account and hero id and email seen; no response may carry another player's. */
const secrets = new Map<string, string>();
const leaks: string[] = [];

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wf-phase5-e2e-'));
  database = await createPgliteDatabase(join(dataDir, 'db'));
  app = buildApp({
    database,
    auth: { now, registrationMode: 'invite', mailer, publicBaseUrl: 'https://play.example.test' },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, offlineCapMs: CAP, now },
  });
  // The privacy guard (4.11): each account's email and id at registration, each hero's id at
  // creation; any response carrying one that belongs to someone else fails the run.
  app.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload !== 'string') return payload;
    let self = request.auth?.account.id;
    // A login answers with the account it opened (no session on the request yet).
    if (request.url === '/api/auth/login' && reply.statusCode === 200) {
      self = (JSON.parse(payload) as { account: { id: string } }).account.id;
    }
    if (request.url === '/api/auth/register' && reply.statusCode === 201) {
      const { account } = JSON.parse(payload) as { account: { id: string; email: string } };
      secrets.set(account.id, account.id);
      secrets.set(account.email, account.id);
      return payload;
    }
    if (request.url === '/api/characters' && request.method === 'POST' && self) {
      const { character } = JSON.parse(payload) as { character?: { id: string } };
      if (character) secrets.set(character.id, self);
    }
    for (const [secret, owner] of secrets) {
      if (owner !== self && payload.includes(secret)) {
        leaks.push(`${request.method} ${request.url} carried another player's ${secret}`);
      }
    }
    return payload;
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await database?.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
});

type Err = { error: { code: string; details?: Record<string, unknown> } };
interface Arena {
  hero: { level: number; ratedOpen: boolean; bracket: { id: string } };
  defence: { defenceId: string } | null;
  rated: {
    used: number;
    left: number;
    offer: { opponents: { defenceId: string; player: { handle: string } }[] } | null;
  };
  ladder: { you: { rating: number; games: number; standing: string }; rank: number | null };
}
interface Duel {
  id: string;
  kind: string;
  you: string;
  bracketId: string;
  foughtAt: string;
  rating: { before: number; after: number; factor: number } | null;
}

describe('Phase 5 exit criteria', () => {
  it('account security → a season → boards and recompute → friendly and rated duels → the season ends with prestige once → a full trade cycle → audit and telemetry reconcile', async () => {
    // 1. The owner opens the town invite-only (CLI invite and role), and appoints a moderator.
    const town = await openInviteOnlyTown(app, database, now());
    const owner = town.admin;
    const warden = await newPlayer(app, 'warden@graumark.test', 'Warden Brann', town.invite);
    expect(await setAccountRole(database.db, 'warden@graumark.test', 'moderator')).toMatchObject({
      to: 'moderator',
    });
    const enlist = (email: string, displayName: string, name: string, classId: ClassId) =>
      startJourney({ app, clock, classId, email, displayName, name, inviteCode: town.invite });
    const emails = {
      a: 'aldric@graumark.test',
      b: 'berit@graumark.test',
      c: 'cael@graumark.test',
      d: 'dagny@graumark.test',
      e: 'edda@graumark.test',
    };
    const a = await enlist(emails.a, 'Aldric Ashdown', 'Aldric', 'warrior');
    const b = await enlist(emails.b, 'Berit Brackwater', 'Berit', 'mage');
    const c = await enlist(emails.c, 'Cael Coldmere', 'Cael', 'hunter');
    const d = await enlist(emails.d, 'Dagny Duskwood', 'Dagny', 'warlock');
    const e = await enlist(emails.e, 'Edda Emberly', 'Edda', 'mage');
    const duellists = [a, b, c];
    const [pa, pb, pc, pd] = [
      await playerOf(a),
      await playerOf(b),
      await playerOf(c),
      await playerOf(d),
    ];

    // 2. Account security (5.7). Each player verifies the address through the mailed link.
    for (const [j, email] of [
      [a, emails.a],
      [b, emails.b],
      [c, emails.c],
      [d, emails.d],
    ] as const) {
      const letter = mailer.last(email, 'verify_email');
      expect(letter, `${email} got a verification letter`).toBeDefined();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/verify-email',
        payload: { token: tokenIn(letter!) },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((await j.api('GET', '/api/account')).json()).toMatchObject({
        account: { emailVerified: true },
      });
    }
    // A guesser at Edda's address: five free failures, then locked (per address, whatever the
    // network); an address nobody owns answers exactly the same, so the lock tells nothing.
    const login = (email: string, password: string, n: number) =>
      app.inject({
        remoteAddress: `10.9.${n}.1`,
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password },
      });
    const guesses = async (email: string) => {
      const out: { status: number; code: string | undefined; limit: unknown }[] = [];
      for (let n = 1; n <= 7; n++) {
        const res = await login(email, `wrong-guess-${n}-of-seven`, n);
        const body = res.json<Partial<Err>>();
        out.push({
          status: res.statusCode,
          code: body.error?.code,
          limit: body.error?.details?.limit,
        });
      }
      return out;
    };
    const known = await guesses(emails.e);
    const unknown = await guesses('nobody-here@graumark.test');
    // The sixth failure starts a 30-second lock; the seventh attempt is refused unchecked.
    expect(known.slice(0, 6).every((g) => g.status === 401)).toBe(true);
    expect(known[6]).toEqual({ status: 429, code: 'rate_limited', limit: 'account' });
    expect(unknown).toEqual(known);
    // Even the right password waits out the lock; afterwards it works and the count is cleared.
    expect((await login(emails.e, 'ashes-and-iron-42', 9)).statusCode).toBe(429);
    clock.set(clock.now() + 31_000);
    const through = await login(emails.e, 'ashes-and-iron-42', 10);
    expect(through.statusCode).toBe(200);
    const bye = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [SESSION_COOKIE]: through.cookies.find((x) => x.name === SESSION_COOKIE)!.value },
    });
    expect(bye.statusCode, bye.body).toBeLessThan(300);
    const locked = await database.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.event, 'auth.login_locked'));
    expect(locked.length).toBeGreaterThanOrEqual(1);
    // Edda farms a little, verifies, logs out the other device (the login above) and resets the
    // password through the mailed link; the hero is untouched (`playAccountSecurityStep`).
    await e.farmBestArea();
    await e.settle();
    await playAccountSecurityStep(app, mailer, e, emails.e);

    // 3. The owner schedules Season 1 in the admin panel: from the next minute, for a week.
    const seasonStart = clock.now() + MIN;
    const seasonEnd = seasonStart + 7 * DAY;
    const planned = await owner.api('POST', '/api/admin/seasons', {
      startsAt: new Date(seasonStart).toISOString(),
      endsAt: new Date(seasonEnd).toISOString(),
    });
    expect(planned.statusCode, planned.body).toBe(200);
    const plan = planned.json<{
      current: { number: number } | null;
      next: { number: number } | null;
    }>();
    const season = (plan.current ?? plan.next)!.number;
    // A player can't schedule one: the admin routes answer the not-found 404.
    expect(
      (
        await a.api('POST', '/api/admin/seasons', {
          startsAt: new Date(seasonEnd).toISOString(),
          endsAt: new Date(seasonEnd + DAY).toISOString(),
        })
      ).statusCode,
    ).toBe(404);
    clock.set(seasonStart + 1000);

    // 4. The three duellists farm on one clock to level 15 (trading's level, still in the 10–19
    // bracket) and rest there; Dagny plays one visit and rests below 10.
    const rest = async (j: Journey) => {
      const res = await j.api('POST', `${j.base}/activity/stop`);
      expect(res.statusCode, res.body).toBe(200);
      j.state.level = res.json<{ character: { level: number } }>().character.level;
    };
    for (const j of [...duellists, d]) await j.farmBestArea();
    await townVisit(clock, [...duellists, d]);
    await rest(d);
    let visits = 1;
    let farming = duellists.filter((j) => j.state.level < TRADE_LEVEL);
    while (farming.length > 0 && visits < MAX_TOWN_VISITS) {
      visits += 1;
      await townVisit(clock, farming);
      for (const j of farming) await j.visitTavern();
      for (const j of farming.filter((x) => x.state.level >= TRADE_LEVEL)) await rest(j);
      farming = farming.filter((j) => j.state.level < TRADE_LEVEL);
    }
    for (const j of duellists) {
      expect(j.state.level).toBeGreaterThanOrEqual(TRADE_LEVEL);
      expect(j.state.level).toBeLessThan(20);
    }
    expect(d.state.level).toBeLessThan(10);

    // 5. Boards (5.1/5.2): Aldric ranked by his own scores, seen by Dagny, reported from the
    // board; then every hero is on every board with its recomputed value at the current formula
    // version (Gear Score 2), and the recompute check finds nothing wrong.
    // (The step plays one more visit, so Aldric farms for it and rests again after.)
    await a.farmBestArea();
    await playLeaderboardStep(app, database, a, { companion: pd });
    await rest(a);
    const entries = await database.db.select().from(leaderboardEntries);
    for (const j of [...duellists, d]) {
      const scores = (await j.api('GET', `${j.base}/scores`)).json<{
        scores: Record<'level' | 'gearScore' | 'power' | 'pveProgress', { value: number }>;
      }>().scores;
      for (const metric of ['level', 'gearScore', 'power', 'pveProgress'] as const) {
        const row = entries.find((r) => r.characterId === j.characterId && r.metric === metric);
        expect(row, `${metric} of ${j.characterId}`).toBeDefined();
        expect(row!.formulaVersion).toBe(FORMULA_VERSIONS[metric]);
        expect(row!.value).toBe(scores[metric].value);
      }
    }
    expect(FORMULA_VERSIONS.gearScore).toBe(2);
    const recompute = await checkLeaderboards(cliDeps(database.db));
    expect(recompute.problems.filter((p) => p.kind === 'wrong')).toEqual([]);
    // The season board lists the four heroes who rose in it.
    const seasonBoard = (
      await b.api('GET', `/api/leaderboards/level?scope=season&season=${season}&limit=100`)
    ).json<{ board: { total: number; season: { status: string } } }>().board;
    expect(seasonBoard).toMatchObject({ season: { status: 'active' } });
    expect(seasonBoard.total).toBeGreaterThanOrEqual(4);

    // 6. Friendly challenges across brackets (5.5, the lower hero's bracket, no rating) and the
    // rated gate at 10. Aldric and Dagny become friends.
    const arena = async (j: Journey) => {
      const res = await j.api('GET', `/api/arena?characterId=${j.characterId}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Arena>();
    };
    const setDefence = async (j: Journey) => {
      const res = await j.api('POST', '/api/arena/defence', { characterId: j.characterId });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Arena>().defence!.defenceId;
    };
    const duel = (j: Journey, defenceId: string, kind: 'rated' | 'friendly', key = randomUUID()) =>
      j.keyed('/api/arena/duels', { characterId: j.characterId, defenceId, kind }, key);
    const owned = async () =>
      Promise.all(
        [...duellists, d].map(async (j) => {
          const inv = await j.inventory();
          const ids = [...inv.inventory, ...inv.equipped].map((i) => i.id).sort();
          return { held: await holdingsOf(j), ids };
        }),
      );
    const ownedFriendly = await owned();

    expect(
      (await a.api('POST', '/api/friends/requests', { handle: pd.account.handle })).statusCode,
    ).toBe(200);
    expect(
      (await d.api('POST', `/api/friends/requests/${pa.account.handle}/accept`)).statusCode,
    ).toBe(200);
    const below = await d.api('POST', '/api/arena/opponents', { characterId: d.characterId });
    expect(below.json<Err>().error.code).toBe('level_too_low');
    const defences = new Map<Journey, string>();
    for (const j of [...duellists, d]) defences.set(j, await setDefence(j));
    const lowBracket = friendlyBracket(a.state.level, d.state.level).id;
    expect(lowBracket).toBe('1-9');
    for (const [from, to] of [
      [a, d],
      [d, a],
    ] as const) {
      pause();
      const res = await duel(from, defences.get(to)!, 'friendly');
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json<{ duel: Duel }>().duel).toMatchObject({
        kind: 'friendly',
        bracketId: lowBracket,
        rating: null,
      });
    }
    // A friend is never a rated opponent; a stranger never a friendly one.
    const asRated = await duel(a, defences.get(d)!, 'rated');
    expect([404, 409]).toContain(asRated.statusCode);
    expect(['wrong_bracket', 'friendly_only', 'not_offered']).toContain(
      asRated.json<Err>().error.code,
    );
    const stranger = await duel(b, defences.get(c)!, 'friendly');
    expect(stranger.json<Err>().error.code).toBe('not_friend_or_guildmate');
    expect(await owned()).toEqual(ownedFriendly);

    // 7. Rated duels (5.5/5.6). For even bouts the duellists fight without their gear (bracket
    // Power is computed at the bracket's reference level, relative to the class, so ungeared
    // heroes of 10–19 are always within the first range of each other); the client's id must
    // come from the server's list.
    for (const j of duellists) {
      const inv = await j.inventory();
      for (const item of inv.equipped) {
        const res = await j.api('POST', `${j.base}/items/${item.id}/unequip`);
        expect(res.statusCode, res.body).toBe(200);
      }
      defences.set(j, await setDefence(j));
    }
    const ownedBefore = await owned();
    const notOffered = await duel(a, defences.get(b)!, 'rated');
    expect(notOffered.statusCode).toBe(404);
    expect(notOffered.json<Err>().error.code).toBe('not_offered');
    const handleOf = new Map([
      [a, pa.account.handle],
      [b, pb.account.handle],
      [c, pc.account.handle],
    ]);
    const accountOf = new Map([
      [a, pa.account.id],
      [b, pb.account.id],
      [c, pc.account.id],
    ]);
    const pairKey = (x: Journey, y: Journey) => [handleOf.get(x), handleOf.get(y)].sort().join('|');
    const pairs = new Map<string, number>();
    const fought: { duel: Duel; challenger: Journey; defender: Journey }[] = [];
    /** One rated duel day: each duellist fights its ten from fresh lists, the 11th is refused. */
    const ratedDay = async (perHero: number) => {
      for (const j of duellists) {
        for (let n = 0; n < perHero; n++) {
          pause();
          let state = await arena(j);
          if (!state.rated.offer || state.rated.offer.opponents.length === 0) {
            const drawn = await j.api('POST', '/api/arena/opponents', {
              characterId: j.characterId,
            });
            expect(drawn.statusCode, drawn.body).toBe(200);
            state = drawn.json<Arena>();
            // Matchmaking 3: one defence per account, never your own, Dagny (a friend and below
            // 10) never; everyone else in 10–19 is offered (fresh pairs first).
            const handles = state.rated.offer!.opponents.map((o) => o.player.handle);
            expect(new Set(handles).size).toBe(handles.length);
            expect([...handles].sort()).toEqual(
              duellists
                .filter((x) => x !== j)
                .map((x) => handleOf.get(x)!)
                .sort(),
            );
          }
          const pick = state.rated.offer!.opponents[0]!;
          const foe = duellists.find((x) => handleOf.get(x) === pick.player.handle)!;
          const key = randomUUID();
          const res = await duel(j, pick.defenceId, 'rated', key);
          expect(res.statusCode, res.body).toBe(201);
          const replay = await duel(j, pick.defenceId, 'rated', key);
          expect(replay.headers['idempotency-replayed']).toBe('true');
          const fight = res.json<{ duel: Duel }>().duel;
          // Repeat pairs (B.4b): 1, ½, ¼, then ¼ — never 0.
          const prior = pairs.get(pairKey(j, foe)) ?? 0;
          expect(fight.rating!.factor).toBe(ratingFactor(prior));
          expect(fight.rating!.factor).toBe(PAIR_FACTORS[Math.min(prior, PAIR_FACTORS.length - 1)]);
          pairs.set(pairKey(j, foe), prior + 1);
          fought.push({ duel: fight, challenger: j, defender: foe });
        }
        const spent = await arena(j);
        expect(spent.rated).toMatchObject({ used: RATED_DUELS_PER_DAY, left: 0 });
        if (!spent.rated.offer || spent.rated.offer.opponents.length === 0) {
          const drawn = await j.api('POST', '/api/arena/opponents', {
            characterId: j.characterId,
          });
          expect(drawn.statusCode, drawn.body).toBe(200);
        }
        const offer = (await arena(j)).rated.offer!.opponents[0]!;
        const eleventh = await duel(j, offer.defenceId, 'rated');
        expect(eleventh.statusCode, eleventh.body).toBe(409);
        expect(eleventh.json<Err>().error.code).toBe('no_duels_left');
      }
    };
    await ratedDay(RATED_DUELS_PER_DAY);
    // The next UTC day opens ten more; one each is enough here.
    const tomorrow = new Date(clock.now());
    tomorrow.setUTCHours(24, 5, 0, 0);
    clock.set(tomorrow.getTime());
    for (const j of duellists) {
      expect((await arena(j)).rated).toMatchObject({ used: 0, left: RATED_DUELS_PER_DAY });
    }
    for (const j of duellists) {
      pause();
      const state = await arena(j);
      let offer = state.rated.offer?.opponents[0];
      if (!offer) {
        const drawn = await j.api('POST', '/api/arena/opponents', { characterId: j.characterId });
        offer = drawn.json<Arena>().rated.offer!.opponents[0]!;
      }
      const foe = duellists.find((x) => handleOf.get(x) === offer.player.handle)!;
      const res = await duel(j, offer.defenceId, 'rated');
      expect(res.statusCode, res.body).toBe(201);
      const fight = res.json<{ duel: Duel }>().duel;
      const prior = pairs.get(pairKey(j, foe)) ?? 0;
      expect(fight.rating!.factor).toBe(ratingFactor(prior));
      pairs.set(pairKey(j, foe), prior + 1);
      fought.push({ duel: fight, challenger: j, defender: foe });
    }
    // Each hero's rating moved exactly once per duel it was in: the chain of its duels (as it
    // sees them) runs before → after → before without a gap, ending at the ladder's rating.
    for (const j of duellists) {
      const list = (await j.api('GET', '/api/arena/duels?limit=100')).json<{
        duels: { id: string; kind: string }[];
      }>().duels;
      const mine = fought.filter((f) => f.challenger === j || f.defender === j);
      const rated = list.filter((x) => x.kind === 'rated');
      expect(rated).toHaveLength(mine.length);
      const chain: Duel[] = [];
      for (const x of rated) {
        chain.push((await j.api('GET', `/api/arena/duels/${x.id}`)).json<{ duel: Duel }>().duel);
      }
      chain.sort((x, y) => Date.parse(x.foughtAt) - Date.parse(y.foughtAt));
      expect(chain[0]!.rating!.before).toBe(1500);
      for (let n = 1; n < chain.length; n++) {
        expect(chain[n]!.rating!.before).toBe(chain[n - 1]!.rating!.after);
      }
      const ladder = (await arena(j)).ladder;
      expect(ladder.you.games).toBe(mine.length);
      expect(ladder.you.games).toBeGreaterThanOrEqual(PROVISIONAL_GAMES);
      expect(ladder.you.standing).not.toBe('provisional');
      expect(Math.round(ladder.you.rating)).toBe(Math.round(chain.at(-1)!.rating!.after));
    }
    // A duel changes nothing anyone owns (gear taken off is still in the pack).
    expect(await owned()).toEqual(ownedBefore);
    for (const j of duellists) await j.equipBetterDrops();

    // 8. The season ends. Past the end and the grace, the server archives and awards once.
    clock.set(seasonEnd + 10 * MIN);
    const first = await runSeasonJobs(database.db, now(), now());
    expect(first.archived).toContain(season);
    const again = await runSeasonJobs(database.db, now(), now());
    expect(again.archived).toEqual([]);
    const standings = await database.db
      .select()
      .from(seasonStandings)
      .where(eq(seasonStandings.season, season));
    const arenaStandings = standings.filter((s) => s.metric === 'arena');
    expect(arenaStandings.map((s) => s.characterId).sort()).toEqual(
      duellists.map((j) => j.characterId).sort(),
    );
    const expected = seasonAwards(
      standings.map((s) => ({
        accountId: s.accountId,
        characterId: s.characterId,
        metric: s.metric as PrestigeMetric,
        rank: s.rank,
        level: s.level,
      })),
    );
    const awarded = await database.db
      .select()
      .from(seasonAwardRows)
      .where(eq(seasonAwardRows.season, season));
    const shape = (x: { accountId: string; metric: string; tier: string; rank: number }) =>
      `${x.accountId}|${x.metric}|${x.tier}|${x.rank}`;
    expect(awarded.map(shape).sort()).toEqual(expected.map(shape).sort());
    expect(awarded.some((x) => x.metric === 'arena' && x.tier === 'champion')).toBe(true);
    // A third run (the scheduler's next tick) gives nothing more.
    await runSeasonJobs(database.db, now(), now());
    expect(
      await database.db.select().from(seasonAwardRows).where(eq(seasonAwardRows.season, season)),
    ).toHaveLength(awarded.length);
    // The arena champion shows the Duellist title; another player sees it on the closed ladder.
    const champion = awarded.find((x) => x.metric === 'arena' && x.tier === 'champion')!;
    const champ = duellists.find((j) => accountOf.get(j) === champion.accountId)!;
    const chose = await champ.api('POST', '/api/account/prestige', {
      title: { season, metric: 'arena' },
      frame: { season, metric: 'arena' },
    });
    expect(chose.statusCode, chose.body).toBe(200);
    const unearned = await d.api('POST', '/api/account/prestige', {
      title: { season, metric: 'arena' },
      frame: null,
    });
    expect(unearned.json<Err>().error.code).toBe('award_not_earned');
    const closed = (
      await d.api('GET', `/api/leaderboards/level?scope=season&season=${season}&limit=100`)
    ).json<{ board: { season: { status: string } } }>().board;
    expect(closed.season.status).toBe('closed');
    const profile = await d.api('GET', `/api/players/${handleOf.get(champ)}/profile`);
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json()).toMatchObject({
      profile: {
        prestige: {
          title: { season, metric: 'arena', tier: 'champion' },
          frame: { season, metric: 'arena', tier: 'champion' },
        },
      },
    });

    // 9. A full trade cycle with the switches on in the test (T.1–T.7): no shortcuts, the players
    // earned eligibility by playing; the owner and the moderator are the town's.
    for (const j of duellists) await j.farmBestArea();
    const trade = await playTradingHardeningStep(app, database, clock, a, b, c, {
      played: true,
      owner,
      warden,
    });

    // 10. Everything held and recorded agrees; nothing leaked.
    for (const j of [...duellists, d, e]) await expectHoldingsMatchAudit(database, j.characterId);
    expect((await reconcileWithAudit(database.db)).filter((x) => !x.ok)).toEqual([]);
    const late = await checkLeaderboards(cliDeps(database.db));
    expect(late.problems.filter((p) => p.kind === 'wrong')).toEqual([]);
    const verified = await database.db
      .select({ v: accounts.emailVerifiedAt })
      .from(accounts)
      .where(
        inArray(
          accounts.id,
          [pa, pb, pc, pd].map((p) => p.account.id),
        ),
      );
    expect(verified.every((r) => r.v !== null)).toBe(true);
    const duelRows = await database.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.event, 'duel.fight')));
    expect(duelRows).toHaveLength(fought.length + 2);
    expect(leaks).toEqual([]);
    // Seven accounts (email and id each) and six heroes were watched.
    expect(secrets.size).toBeGreaterThanOrEqual(18);

    // The real report command on this run's database.
    await app.close();
    await database.close();
    const out = join(dataDir, 'report.json');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PLAYTEST_DATA_DIR: dataDir,
      INIT_CWD: REPO_ROOT,
    };
    delete env.DATABASE_URL;
    const text = execFileSync(
      'pnpm',
      ['--silent', 'report:telemetry', '--', '--reconcile', '--db', 'playtest', '--out', out],
      { cwd: REPO_ROOT, env, encoding: 'utf8' },
    );
    expect(text).toMatch(/Audit log reconciliation: all \d+ checks match/);
    const report = JSON.parse(readFileSync(out, 'utf8')) as TelemetryReport;
    expect(report.reconcile!.filter((x) => !x.ok)).toEqual([]);
    const sum = (metric: string, match: (dims: RollupRow['dims']) => boolean = () => true) =>
      report.rollups
        .filter((r) => r.metric === metric && match(r.dims))
        .reduce((s, r) => s + r.events, 0);
    expect(sum('duel.fight', (x) => x[0] === 'rated')).toBe(fought.length);
    expect(sum('duel.fight', (x) => x[0] === 'friendly')).toBe(2);
    expect(sum('trade.complete')).toBe(3);
    expect(sum('trade.reverse')).toBe(1);

    const record = JSON.stringify({
      townVisits: visits,
      levels: [...duellists, d].map((j) => j.state.level),
      ratedDuels: fought.length,
      ratings: arenaStandings.map((s) => s.value),
      awards: awarded.map((x) => `${x.metric}:${x.tier}`),
      tradeableVisits: trade.tradeableVisits,
      checks: report.reconcile!.length,
    });
    console.info(record);
    if (process.env.E2E_RECORD) appendFileSync(process.env.E2E_RECORD, `${record}\n`);
  }, 600_000);
});
