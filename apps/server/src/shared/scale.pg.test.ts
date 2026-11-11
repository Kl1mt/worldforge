/**
 * Ticket 6.9: two API instances against one real PostgreSQL (docs/DEPLOY.md "Running two API
 * instances"). Runs when `DATABASE_URL` is set (CI's `test:pg`), skipped otherwise. Two `buildApp`
 * instances on one database stand for two containers: every limit holds across both (account,
 * social, per-IP, the per-address login lock with parallel guesses, the mail class), exactly one
 * leads each scheduled job with failover when its connection drops, and a cache change on one
 * reaches the other by NOTIFY or, when the notify is missed, by the version check. Assertions hold
 * in every order of the parallel requests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp, type AppOptions } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_LOGIN_THROTTLE } from '../auth/login-throttle.js';
import { worldFlags } from '../db/schema.js';
import { queryRows } from '../db/query.js';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { bumpCacheVersion } from './cache-sync.js';
import { createPostgresLimitStore, makeLimiterTablesUnlogged } from './limit-store.js';
import { SchedulerLeader } from './leader.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}
const GENEROUS = { max: 10_000, timeWindowMs: 60_000 };
const PASSWORD = 'ashes-and-iron-42';
const free = DEFAULT_LOGIN_THROTTLE.freeAttempts;

/** Polls `check` until it holds (state, not the wall clock), at most `ms`. */
async function until(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!url)('two API instances on one real PostgreSQL (ticket 6.9)', () => {
  let database: DatabaseHandle;
  const apps: FastifyInstance[] = [];
  const mailer = createMemoryMailer();
  // The injected auth clock (never compared with the database's now()).
  let offset = 0;
  const now = () => new Date(Date.now() + offset);
  let seq = 0;

  const instance = async (extra: Partial<AppOptions> = {}, auth: AppOptions['auth'] = {}) => {
    const a = buildApp({
      database,
      shared: { limits: 'postgres' },
      auth: {
        registerRateLimit: GENEROUS,
        loginRateLimit: GENEROUS,
        forgotRateLimit: GENEROUS,
        tokenRateLimit: GENEROUS,
        mailer,
        publicBaseUrl: 'https://play.example.test',
        forgotFloorMs: 0,
        now,
        ...auth,
      },
      testRoutes: async (api) => {
        api.post('/test/social', { preHandler: api.requireAccount }, async (request, reply) => {
          await api.socialWriteLimit(request.auth!.account.id, reply);
          return { ok: true };
        });
      },
      ...extra,
    });
    apps.push(a);
    await a.ready();
    return a;
  };

  const register = async (app: FastifyInstance) => {
    seq += 1;
    const email = `scale-${seq}-${Date.now()}@graumark.test`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      remoteAddress: `198.51.100.${seq % 250}`,
      payload: { email, displayName: `Scaler ${'abcdefghjk'[seq % 10]}${seq}`, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(201);
    const token = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    return { email, token, id: res.json<{ account: { id: string } }>().account.id };
  };
  const login = (app: FastifyInstance, email: string, password: string, ip = '203.0.113.9') =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: ip,
      payload: { email, password },
    });
  const codes = (rs: LightMyRequestResponse[]) => rs.map((r) => r.statusCode);
  const count = (rs: LightMyRequestResponse[], code: number) =>
    rs.filter((r) => r.statusCode === code).length;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 20 });
  });
  // Each test's instances close after it (connections are shared with the other pg test files).
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });
  afterAll(async () => {
    await database?.close();
  });

  describe('shared limits', () => {
    it('the account class holds across both instances, in parallel', async () => {
      const limit = { requests: 30, actions: 10, windowMs: 60 * 60_000 };
      const a = await instance({}, { accountRateLimit: limit });
      const b = await instance({}, { accountRateLimit: limit });
      const p = await register(a);
      const rs = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          (i % 2 ? a : b).inject({
            method: 'GET',
            url: '/api/account',
            cookies: { [SESSION_COOKIE]: p.token },
          }),
        ),
      );
      expect(count(rs, 200)).toBe(30);
      expect(count(rs, 429)).toBe(10);
      const refused = rs.find((r) => r.statusCode === 429)!;
      expect(refused.json().error.details).toMatchObject({ limit: 'requests' });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('the social class holds across both instances, in parallel, refused writes uncounted', async () => {
      const social = { windows: [{ windowMs: 60 * 60_000, max: 5 }] };
      const a = await instance({}, { socialWriteLimit: social });
      const b = await instance({}, { socialWriteLimit: social });
      const p = await register(a);
      const post = (app: FastifyInstance) =>
        app.inject({
          method: 'POST',
          url: '/api/test/social',
          cookies: { [SESSION_COOKIE]: p.token },
        });
      const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => post(i % 2 ? a : b)));
      expect(count(rs, 200)).toBe(5);
      expect(count(rs, 429)).toBe(7);
      expect(rs.find((r) => r.statusCode === 429)!.json().error.details.limit).toBe('social');
      const [row] = await queryRows<{ hits: number[] }>(
        database.db,
        sql`select hits from rate_limit_counters where key like ${`social|%|${p.id}`}`,
      );
      expect(row!.hits.map(Number)).toEqual([5]);
    });

    it('the per-IP login limit holds across both instances', async () => {
      const ipLimit = { max: 4, timeWindowMs: 60 * 60_000 };
      const a = await instance({}, { loginRateLimit: ipLimit });
      const b = await instance({}, { loginRateLimit: ipLimit });
      const rs: LightMyRequestResponse[] = [];
      for (let i = 0; i < 6; i += 1)
        rs.push(
          await login(i % 2 ? a : b, `nobody-${i}@graumark.test`, 'wrong-guess-1', '192.0.2.77'),
        );
      expect(codes(rs)).toEqual([401, 401, 401, 401, 429, 429]);
      // Counted under a hash: no client address is stored.
      const keys = await queryRows<{ key: string }>(
        database.db,
        sql`select key from rate_limit_counters where key like 'ip:%'`,
      );
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.some((k) => /\d+\.\d+\.\d+\.\d+/.test(k.key))).toBe(false);
    });

    it('a lock earned on one instance holds on the other, alike for known and unknown addresses', async () => {
      const a = await instance();
      const b = await instance();
      const p = await register(a);
      const unknown = `nobody-${Date.now()}@graumark.test`;
      const run = async (email: string) => {
        const out: number[] = [];
        for (let i = 0; i < free; i += 1)
          out.push((await login(i % 2 ? a : b, email, 'wrong-guess-1')).statusCode);
        // The failure that locks, on the other instance than the last free one.
        out.push((await login(free % 2 ? a : b, email, 'wrong-guess-1')).statusCode);
        // The right password (or any) is refused on both, without a check.
        const ra = await login(a, email, PASSWORD);
        const rb = await login(b, email, PASSWORD);
        out.push(ra.statusCode, rb.statusCode);
        // The class only: the seconds left depend on how long the steps took.
        const cls = (r: LightMyRequestResponse) => r.json().error.details.limit as string;
        return { out, details: [cls(ra), cls(rb)] };
      };
      const known = await run(p.email);
      const stranger = await run(unknown);
      expect(known.out).toEqual([...Array(free + 1).fill(401), 429, 429]);
      expect(stranger).toEqual(known);
      expect(known.details).toEqual(['account', 'account']);
    });

    it('parallel guesses on both instances get no more checks than sequential ones', async () => {
      const a = await instance();
      const b = await instance();
      const p = await register(a);
      const burst = await Promise.all(
        Array.from({ length: free * 4 }, (_, i) =>
          login(i % 2 ? a : b, p.email, `parallel-guess-${i}`, `203.0.113.${i + 20}`),
        ),
      );
      expect(burst.every((r) => [401, 429].includes(r.statusCode))).toBe(true);
      const checked = count(burst, 401);
      expect(checked).toBeGreaterThan(0);
      expect(checked).toBeLessThanOrEqual(free + 1);
      const [audit] = await queryRows<{ n: number }>(
        database.db,
        sql`select count(*)::int as n from audit_log
            where event = 'auth.login_failed' and account_id = ${p.id}`,
      );
      expect(audit!.n).toBe(checked);
      // Nothing left in flight: once the lock is over the right password works, on either.
      offset += DEFAULT_LOGIN_THROTTLE.maxLockMs;
      expect((await login(b, p.email, PASSWORD)).statusCode).toBe(200);
    });

    it('the mail class holds across both instances (reset letters per address)', async () => {
      const mail = { max: 2, windowMs: 60 * 60_000 };
      const a = await instance({}, { mailLimit: mail });
      const b = await instance({}, { mailLimit: mail });
      const p = await register(a);
      const before = mailer.outbox.filter(
        (m) => m.to === p.email && m.kind === 'reset_password',
      ).length;
      const rs: LightMyRequestResponse[] = [];
      for (let i = 0; i < 5; i += 1)
        rs.push(
          await (i % 2 ? a : b).inject({
            method: 'POST',
            url: '/api/auth/forgot-password',
            payload: { email: p.email },
          }),
        );
      // The same answer every time (it never tells whether a letter went out).
      expect(new Set(rs.map((r) => `${r.statusCode} ${r.body}`)).size).toBe(1);
      const after = mailer.outbox.filter(
        (m) => m.to === p.email && m.kind === 'reset_password',
      ).length;
      expect(after - before).toBe(2);
    });
  });

  describe('scheduler leader election', () => {
    it('exactly one instance leads each job; failover when its connection drops', async () => {
      const x = new SchedulerLeader(database);
      const y = new SchedulerLeader(database);
      try {
        const first = await Promise.all([x.lead('settlement'), y.lead('settlement')]);
        expect(first.filter(Boolean)).toHaveLength(1);
        const [leader, standby] = first[0] ? [x, y] : [y, x];
        // Again and again: the same one.
        for (let i = 0; i < 3; i += 1) {
          expect(await leader.lead('settlement')).toBe(true);
          expect(await standby.lead('settlement')).toBe(false);
        }
        // The leader's connection drops (killed on the server).
        const pid = await leader.backendPid();
        await database.db.execute(sql`select pg_terminate_backend(${pid})`);
        // The standby takes over once PostgreSQL has freed the lock.
        expect(await until(() => standby.lead('settlement'))).toBe(true);
        // The old leader notices, reconnects and competes again: it is a standby now.
        expect(await leader.lead('settlement')).toBe(false);
        expect(await leader.lead('settlement')).toBe(false);
        // The new leader closes (an instance shuts down): the old one takes the lead again.
        await standby.close();
        expect(await until(() => leader.lead('settlement'))).toBe(true);
      } finally {
        await x.close();
        await y.close();
      }
    });

    it('two schedulers: each job runs on one instance, the other stands by', async () => {
      const a = await instance({ activity: { settleIntervalMs: 40 } });
      const b = await instance({ activity: { settleIntervalMs: 40 } });
      const detail = (app: FastifyInstance) => app.schedulerState.jobs.settlement.detail;
      expect(
        await until(
          () =>
            detail(a) !== null &&
            detail(b) !== null &&
            a.schedulerState.jobs.tradeSweep.detail !== null &&
            b.schedulerState.jobs.tradeSweep.detail !== null,
        ),
      ).toBe(true);
      for (const job of [
        'settlement',
        'leaderboardSweep',
        'seasonJobs',
        'eventJobs',
        'tradeSweep',
      ] as const) {
        const roles = [a, b].map((app) =>
          app.schedulerState.jobs[job].detail?.startsWith('standby') ? 'standby' : 'leader',
        );
        expect(roles.sort(), job).toEqual(['leader', 'standby']);
      }
      expect([...a.schedulerLeader.leading(), ...b.schedulerLeader.leading()].sort()).toEqual(
        [
          'eventJobs',
          'leaderboardSweep',
          'pruning',
          'seasonJobs',
          'settlement',
          'tradeSweep',
        ].sort(),
      );
    });
  });

  describe('cache invalidation across instances', () => {
    const flag = 'warehouseRestored' as const;
    const setFlag = async (on: boolean) =>
      withTransaction(database.db, async (tx) => {
        if (on)
          await tx
            .insert(worldFlags)
            .values({ flagId: flag, projectId: null, setAt: new Date() })
            .onConflictDoNothing();
        else await tx.delete(worldFlags).where(sql`${worldFlags.flagId} = ${flag}`);
        await bumpCacheVersion(tx, 'world');
      });

    it('NOTIFY drops the other instance’s copy at once (no version check, 60 s TTL)', async () => {
      const a = await instance({ shared: { limits: 'postgres', cachePollMs: 0 } });
      const b = await instance({ shared: { limits: 'postgres', cachePollMs: 0 } });
      expect(await until(() => a.cacheSync.stats.listening && b.cacheSync.stats.listening)).toBe(
        true,
      );
      const start = b.cacheSync.stats.notified;
      await setFlag(false);
      expect(await until(async () => !(await b.worldState.flags())[flag])).toBe(true);
      // That change's notify has arrived before the next one (one at a time, in order).
      expect(await until(() => b.cacheSync.stats.notified > start)).toBe(true);
      const heard = b.cacheSync.stats.notified;
      await setFlag(true);
      expect(await until(async () => (await b.worldState.flags())[flag])).toBe(true);
      // Heard by NOTIFY (a load racing the drop is not stored, so the flag can show first).
      expect(await until(() => b.cacheSync.stats.notified > heard)).toBe(true);
      expect(b.cacheSync.stats.invalidatedByPoll).toBe(0);
    });

    it('a missed NOTIFY: the version check converges well inside 60 s', async () => {
      const c = await instance({
        shared: { limits: 'postgres', cachePollMs: 100, cacheListen: false },
      });
      await setFlag(false);
      expect(await until(async () => !(await c.worldState.flags())[flag])).toBe(true);
      await setFlag(true);
      expect(await until(async () => (await c.worldState.flags())[flag], 5_000)).toBe(true);
      expect(c.cacheSync.stats.notified).toBe(0);
      expect(c.cacheSync.stats.invalidatedByPoll).toBeGreaterThan(0);
    });

    it('a dropped listener: the version check covers the gap, then it listens again', async () => {
      const d = await instance({ shared: { limits: 'postgres', cachePollMs: 100 } });
      expect(await until(() => d.cacheSync.stats.listening)).toBe(true);
      await setFlag(false);
      expect(await until(async () => !(await d.worldState.flags())[flag])).toBe(true);
      await database.db.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity
            where application_name = 'worldforge-listen' and datname = current_database()`,
      );
      await setFlag(true);
      expect(await until(async () => (await d.worldState.flags())[flag], 5_000)).toBe(true);
      // Reconnected (after its 2 s pause), it hears the next change by NOTIFY.
      expect(await until(() => d.cacheSync.stats.listening, 10_000)).toBe(true);
      const heard = d.cacheSync.stats.notified;
      await setFlag(false);
      expect(await until(() => d.cacheSync.stats.notified > heard, 5_000)).toBe(true);
    });
  });

  describe('cost on the database', () => {
    it('db:migrate makes the limiter tables unlogged (once)', async () => {
      expect((await makeLimiterTablesUnlogged(database.db)).sort()).toEqual([
        'login_throttle',
        'rate_limit_counters',
      ]);
      expect(await makeLimiterTablesUnlogged(database.db)).toEqual([]);
      const rows = await queryRows<{ relname: string; p: string }>(
        database.db,
        sql`select relname, relpersistence as p from pg_class
            where relname in ('rate_limit_counters', 'login_throttle')`,
      );
      expect(rows.map((r) => r.p)).toEqual(['u', 'u']);
    });

    it('a counted request stays within the budget (docs/DEPLOY.md: mean under 10 ms)', async () => {
      const store = createPostgresLimitStore(database.db);
      const windows = [
        { windowMs: 60_000, max: 900 },
        { windowMs: 60_000, max: 300 },
      ];
      const t = Date.now();
      // Warm the connection pool and the plan.
      for (let i = 0; i < 20; i += 1) await store.hit(`perf-warm|${i}`, windows, [1, 1], t);
      const times: number[] = [];
      for (let i = 0; i < 400; i += 1) {
        const s = performance.now();
        await store.hit(`perf|account-${i % 40}`, windows, [1, i % 3 === 0 ? 1 : 0], t + i);
        times.push(performance.now() - s);
      }
      times.sort((p, q) => p - q);
      const mean = times.reduce((s, x) => s + x, 0) / times.length;
      const p50 = times[Math.floor(times.length / 2)]!;
      const p95 = times[Math.floor(times.length * 0.95)]!;
      console.log(
        `limiter hit on real PostgreSQL: mean ${mean.toFixed(3)} ms, p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms`,
      );
      expect(mean).toBeLessThan(10);
    });

    it('requests per second: the shared store against the in-process one (logged)', async () => {
      const mem = await instance({ shared: { limits: 'memory' } });
      const pgApp = await instance();
      const p = await register(pgApp);
      const rate = async (app: FastifyInstance) => {
        const go = () =>
          app.inject({
            method: 'GET',
            url: '/api/account',
            cookies: { [SESSION_COOKIE]: p.token },
          });
        for (let i = 0; i < 30; i += 1) await go();
        const n = 300;
        const s = performance.now();
        // Ten clients at once, as a busy minute would bring them.
        await Promise.all(
          Array.from({ length: 10 }, async () => {
            for (let i = 0; i < n / 10; i += 1) expect((await go()).statusCode).toBe(200);
          }),
        );
        const ms = performance.now() - s;
        return { rps: (n * 1000) / ms, msPerRequest: ms / n };
      };
      const m = await rate(mem);
      const q = await rate(pgApp);
      const overhead = q.msPerRequest - m.msPerRequest;
      console.log(
        `GET /api/account, 10 at once: memory ${m.rps.toFixed(0)} req/s, postgres ${q.rps.toFixed(0)} req/s, overhead ${overhead.toFixed(3)} ms per request`,
      );
      expect(overhead).toBeLessThan(10);
    });
  });
});
