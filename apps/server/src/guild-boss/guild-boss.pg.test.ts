/**
 * Real-PostgreSQL races for the weekly guild boss (ticket 4.9, docs/GUILD_BOSS.md). Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Each race runs a few
 * rounds in varied orders and asserts only what holds in every order (Phase 3 retrospective):
 * attempts per account and week never exceed the cap and are numbered 1..n, the guild's total is
 * exactly the sum of its attempts, each stage is reached once and paid once per account, every
 * stored attempt is exactly the fight its stream and snapshot decide (invariance), the audit log
 * and telemetry reconcile, and no transaction is retried.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  GUILD_BOSS_ATTEMPTS_PER_WEEK,
  getGuildBoss,
  guildBossStageOf,
  guildBossWeek,
  guildBossWeekFromKey,
  simulateGuildBossAttempt,
  bossModifierOfWeek,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  auditLog,
  guildBossAttempts,
  guildBossRewards,
  guildBossStages,
  guildBossStreams,
  guildBossWeeks,
  guildMembers,
  type Guild,
} from '../db/schema.js';
import { transactionStats } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { attemptSeed } from './model.js';
import { setTestAccount } from '../admin/test-accounts.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const N = 8;
const ROUNDS = 3;
const boss = getGuildBoss('risenGravewarden');
const SATURDAY = Date.parse('2026-11-07T12:00:00Z');
const MONDAY = Date.parse('2026-11-09T00:00:00Z');

function shuffled<T>(xs: T[], round: number): T[] {
  const out = [...xs];
  let seed = 11 + round * 37;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe.skipIf(!url)('real PostgreSQL: the guild boss races safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;
  /** The game clock; a test may swap in one that differs per call. */
  let clock: () => number = () => SATURDAY;
  const now = () => new Date(clock());

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: N * 4 + 2 });
    app = buildApp({
      database,
      auth: { now, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    });
    await app.ready();
    call = caller(app);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const db = () => database.db;
  const status = (r: { statusCode: number; json: () => unknown }) =>
    r.statusCode < 300
      ? r.statusCode
      : `${r.statusCode} ${(r.json() as { error: { code: string } }).error.code}`;
  const attempt = (who: TestAccount, characterId: string, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: '/api/guild/boss/attempts',
      payload: { characterId },
      headers: { 'idempotency-key': key },
      cookies: { [SESSION_COOKIE]: who.token },
    });

  async function guildOf(size: number) {
    const accounts = await Promise.all(
      Array.from({ length: size }, () => insertAccount(db(), { now: new Date(SATURDAY) })),
    );
    const guild = await insertGuild(db(), accounts[0]!.id, {
      now: new Date(SATURDAY - 86_400_000),
      members: accounts.slice(1).map((a) => ({ accountId: a.id })),
    });
    const heroes = await Promise.all(
      accounts.map((a, i) =>
        insertCharacter(db(), a.id, {
          level: 14 + (i % 10),
          classId: (['warrior', 'mage', 'hunter', 'warlock'] as const)[i % 4]!,
        }),
      ),
    );
    return { guild, accounts, heroes: heroes.map((h) => h.id) };
  }

  async function nearStage(guild: Guild, week: string, stage: number) {
    await db()
      .insert(guildBossWeeks)
      .values({
        guildId: guild.id,
        week,
        bossId: boss.id,
        total: boss.stages[stage - 1]!.threshold - 1,
        attempts: 0,
        stage: stage - 1,
        updatedAt: now(),
      });
  }

  /** What holds for a guild in every order: counters, stages, rewards and invariance. */
  async function expectExact(guild: Guild, seeded: Record<string, number> = {}) {
    const attempts = await db()
      .select()
      .from(guildBossAttempts)
      .where(eq(guildBossAttempts.guildId, guild.id));
    const weeks = await db()
      .select()
      .from(guildBossWeeks)
      .where(eq(guildBossWeeks.guildId, guild.id));
    for (const w of weeks) {
      const mine = attempts.filter((a) => a.week === w.week);
      expect(w.total).toBe((seeded[w.week] ?? 0) + mine.reduce((s, a) => s + a.counted, 0));
      expect(w.attempts).toBe(mine.length);
      expect(w.stage).toBe(guildBossStageOf(boss, w.total));
      const stages = await db()
        .select()
        .from(guildBossStages)
        .where(and(eq(guildBossStages.guildId, guild.id), eq(guildBossStages.week, w.week)));
      const before = guildBossStageOf(boss, seeded[w.week] ?? 0);
      expect(stages.map((s) => s.stage).sort()).toEqual(
        Array.from({ length: w.stage - before }, (_, i) => before + 1 + i),
      );
      // Every fighter who is still a member holds exactly one earned row per stage reached.
      const members = (
        await db().select().from(guildMembers).where(eq(guildMembers.guildId, guild.id))
      ).map((m) => m.accountId);
      const fighters = [...new Set(mine.map((a) => a.accountId!))].filter((id) =>
        members.includes(id),
      );
      if (fighters.length > 0 && stages.length > 0) {
        const rows = await db()
          .select()
          .from(guildBossRewards)
          .where(
            and(eq(guildBossRewards.week, w.week), inArray(guildBossRewards.accountId, fighters)),
          );
        for (const id of fighters) {
          expect(
            rows
              .filter((r) => r.accountId === id && r.status === 'earned')
              .map((r) => r.stage)
              .sort(),
          ).toEqual(stages.map((s) => s.stage).sort());
        }
      }
    }
    // Per account and week: at most the cap, numbered 1..n, in the window of its own moment.
    const byAccountWeek = new Map<string, number[]>();
    for (const a of attempts) {
      const k = `${a.accountId}:${a.week}`;
      byAccountWeek.set(k, [...(byAccountWeek.get(k) ?? []), a.attemptNo]);
      expect(a.week).toBe(guildBossWeek(a.createdAt.getTime()).key);
    }
    // Invariance: each stored attempt is exactly the fight its stream and snapshot decide.
    const secrets = new Map(
      (await db().select().from(guildBossStreams)).map((s) => [s.accountId, s.seedSecret]),
    );
    for (const a of attempts) {
      const r = simulateGuildBossAttempt({
        bossId: a.bossId,
        character: { classId: a.snapshot.classId, level: a.snapshot.level },
        equipment: a.snapshot.equipment,
        seed: attemptSeed(secrets.get(a.accountId!)!, guildBossWeekFromKey(a.week), a.attemptNo),
        // Ticket 6.3: the stored modifier, which is always the attempt's own week's.
        bossModifier: a.bossModifier,
      });
      expect(a.bossModifier).toBe(bossModifierOfWeek(guildBossWeekFromKey(a.week)).id);
      expect([a.damage, a.counted, a.end]).toEqual([r.damage, r.counted, r.end]);
    }
    return { attempts, byAccountWeek };
  }

  async function expectAccountsWithinCap() {
    const rows = await db()
      .select({
        accountId: guildBossAttempts.accountId,
        week: guildBossAttempts.week,
        nos: sql<
          number[]
        >`array_agg(${guildBossAttempts.attemptNo} order by ${guildBossAttempts.attemptNo})`,
      })
      .from(guildBossAttempts)
      .groupBy(guildBossAttempts.accountId, guildBossAttempts.week);
    for (const r of rows) {
      expect(r.nos.length).toBeLessThanOrEqual(GUILD_BOSS_ATTEMPTS_PER_WEEK);
      expect(r.nos).toEqual(Array.from({ length: r.nos.length }, (_, i) => i + 1));
    }
  }

  async function expectReconciled() {
    const checks = await reconcileWithAudit(db());
    for (const c of checks) expect(c, c.check).toMatchObject({ ok: true });
  }

  it('one account racing many attempts (different keys): exactly the cap', async () => {
    const retries = transactionStats.retries;
    clock = () => SATURDAY;
    for (let round = 0; round < ROUNDS; round++) {
      const { guild, accounts, heroes } = await guildOf(2);
      const [me] = accounts as [TestAccount];
      // Two heroes of one account, at once: still one budget.
      const second = (await insertCharacter(db(), me.id, { level: 18 })).id;
      const jobs = shuffled(
        Array.from({ length: N }, (_, i) => () => attempt(me, i % 2 ? second : heroes[0]!)),
        round,
      );
      const res = await Promise.all(jobs.map((j) => j()));
      const codes = res.map(status);
      expect(codes.filter((c) => c === 201)).toHaveLength(GUILD_BOSS_ATTEMPTS_PER_WEEK);
      expect(codes.filter((c) => c === '409 no_attempts_left')).toHaveLength(
        N - GUILD_BOSS_ATTEMPTS_PER_WEEK,
      );
      await expectExact(guild);
    }
    await expectAccountsWithinCap();
    await expectReconciled();
    expect(transactionStats.retries).toBe(retries);
  });

  it('one key racing itself: one attempt, one answer', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const { guild, accounts, heroes } = await guildOf(1);
      const key = randomUUID();
      const res = await Promise.all(
        Array.from({ length: N }, () => attempt(accounts[0]!, heroes[0]!, key)),
      );
      expect(res.map(status)).toEqual(Array.from({ length: N }, () => 201));
      const bodies = res.map((r) => r.json<{ attempt: unknown }>().attempt);
      for (const b of bodies) expect(b).toEqual(bodies[0]);
      const { attempts } = await expectExact(guild);
      expect(attempts).toHaveLength(1);
    }
    expect(transactionStats.retries).toBe(retries);
  });

  it('a whole guild racing across stage thresholds: exact total, each stage once, rewards once', async () => {
    const retries = transactionStats.retries;
    clock = () => SATURDAY;
    for (let round = 0; round < ROUNDS; round++) {
      const { guild, accounts, heroes } = await guildOf(N);
      const week = guildBossWeek(SATURDAY).key;
      // Start just below stage 1 so a few attempts break stages 1 and 2 in some order.
      await nearStage(guild, week, 1);
      const seeded = { [week]: boss.stages[0]!.threshold - 1 };
      const jobs = shuffled(
        accounts.flatMap((a, i) =>
          Array.from({ length: GUILD_BOSS_ATTEMPTS_PER_WEEK }, () => () => attempt(a, heroes[i]!)),
        ),
        round,
      );
      const res = await Promise.all(jobs.map((j) => j()));
      expect(res.map(status).every((c) => c === 201)).toBe(true);
      const { attempts } = await expectExact(guild, seeded);
      expect(attempts).toHaveLength(N * GUILD_BOSS_ATTEMPTS_PER_WEEK);
      // The stage audits match the stage rows, and each stage's crossing attempt is one of ours.
      const stageAudits = await db()
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.event, 'guild_boss.stage'),
            sql`${auditLog.data}->>'guildId' = ${guild.id}`,
          ),
        );
      const stageRows = await db()
        .select()
        .from(guildBossStages)
        .where(eq(guildBossStages.guildId, guild.id));
      expect(stageAudits.map((a) => a.data.stage).sort()).toEqual(
        stageRows.map((s) => s.stage).sort(),
      );
      expect(stageRows.length).toBeGreaterThanOrEqual(1);
    }
    await expectAccountsWithinCap();
    await expectReconciled();
    expect(transactionStats.retries).toBe(retries);
  });

  it('attempts racing a kick: each lands before it (counted) or is refused (404)', async () => {
    const retries = transactionStats.retries;
    clock = () => SATURDAY;
    for (let round = 0; round < ROUNDS; round++) {
      const { guild, accounts, heroes } = await guildOf(3);
      const [leader, target] = accounts as [TestAccount, TestAccount];
      const jobs = shuffled(
        [
          ...Array.from(
            { length: GUILD_BOSS_ATTEMPTS_PER_WEEK },
            () => () => attempt(target, heroes[1]!),
          ),
          () => call(leader, 'POST', `/api/guild/members/${target.handle}/kick`),
        ],
        round,
      );
      const res = await Promise.all(jobs.map((j) => j()));
      const codes = res.map(status);
      expect(codes).toContain(200);
      const landed = codes.filter((c) => c === 201).length;
      expect(landed + codes.filter((c) => c === '404 not_in_guild').length).toBe(
        GUILD_BOSS_ATTEMPTS_PER_WEEK,
      );
      const { attempts } = await expectExact(guild);
      expect(attempts.filter((a) => a.accountId === target.id)).toHaveLength(landed);
      // Each landed attempt is audited once and the kick once. Their order is not checked from
      // the rows: `created_at` is the transaction's start, and a request queued on the guild's
      // lock can start before the kick yet commit after it. "Before the kick" is what the 404s
      // above and the membership below show (an attempt after it is refused).
      const events = await db()
        .select({ id: auditLog.id, event: auditLog.event })
        .from(auditLog)
        .where(
          and(
            inArray(auditLog.event, ['guild_boss.attempt', 'guild.kick']),
            sql`${auditLog.data}->>'guildId' = ${guild.id}`,
          ),
        )
        .orderBy(sql`${auditLog.createdAt}`, auditLog.id);
      expect(events.map((e) => e.event).sort()).toEqual(
        [...Array.from({ length: landed }, () => 'guild_boss.attempt'), 'guild.kick'].sort(),
      );
      const [still] = await db()
        .select()
        .from(guildMembers)
        .where(eq(guildMembers.accountId, target.id));
      expect(still).toBeUndefined();
    }
    expect(transactionStats.retries).toBe(retries);
  });

  // Ticket 6.10 (docs/PHASE6_EXPLOIT_REVIEW.md F1): a test account fights only for a guild of test
  // accounts. Ticket 8.7 (docs/PHASE8_EXPLOIT_REVIEW.md F4): a real player may not join such a
  // guild at all (its stages stay with it). Racing its attempts, in every order: the join is
  // refused, the attempts all land, and nothing ever reaches the real player.
  it('a test account’s attempts racing a real player’s join: the join refused in every order', async () => {
    const retries = transactionStats.retries;
    clock = () => SATURDAY;
    const week = guildBossWeek(SATURDAY).key;
    for (let round = 0; round < ROUNDS; round++) {
      const { guild, accounts, heroes } = await guildOf(2);
      const [leader, tester] = accounts as [TestAccount, TestAccount];
      await setTestAccount(db(), leader.handle, true);
      await setTestAccount(db(), tester.handle, true);
      await nearStage(guild, week, 1);
      const real = await insertAccount(db(), { now: new Date(SATURDAY) });
      expect(
        status(await call(leader, 'POST', '/api/guild/invites', { handle: real.handle })),
      ).toBe(200);
      const jobs = shuffled(
        [
          ...Array.from(
            { length: GUILD_BOSS_ATTEMPTS_PER_WEEK },
            () => () => attempt(tester, heroes[1]!),
          ),
          () => call(real, 'POST', `/api/guilds/${guild.handle}/invite/accept`),
        ],
        round,
      );
      const codes = (await Promise.all(jobs.map((j) => j()))).map(status);
      expect(codes.filter((c) => c === '403 test_guild')).toHaveLength(1);
      expect(codes.filter((c) => c === 201)).toHaveLength(GUILD_BOSS_ATTEMPTS_PER_WEEK);
      expect(
        await db().select().from(guildMembers).where(eq(guildMembers.accountId, real.id)),
      ).toEqual([]);
      expect(
        await db().select().from(guildBossRewards).where(eq(guildBossRewards.accountId, real.id)),
      ).toEqual([]);
      await expectExact(guild, { [week]: boss.stages[0]!.threshold - 1 });
    }
    expect(transactionStats.retries).toBe(retries);
  });

  it('attempts racing a guild switch: the account keeps one weekly budget', async () => {
    const retries = transactionStats.retries;
    clock = () => SATURDAY;
    for (let round = 0; round < ROUNDS; round++) {
      const a = await guildOf(2);
      const b = await guildOf(1);
      const mover = a.accounts[1]!;
      const moverHero = a.heroes[1]!;
      // Leave A, then join B, racing attempts that land in A, in B, or nowhere.
      const jobs = shuffled(
        [
          ...Array.from({ length: N }, () => () => attempt(mover, moverHero)),
          async () => {
            const left = await call(mover, 'POST', '/api/guild/leave');
            await db().insert(guildMembers).values({
              accountId: mover.id,
              guildId: b.guild.id,
              role: 'member',
              joinedAt: now(),
            });
            return left;
          },
        ],
        round,
      );
      const res = await Promise.all(jobs.map((j) => j()));
      expect(res.map(status).filter((c) => c === 201).length).toBeLessThanOrEqual(
        GUILD_BOSS_ATTEMPTS_PER_WEEK,
      );
      await expectExact(a.guild);
      await expectExact(b.guild);
    }
    await expectAccountsWithinCap();
    expect(transactionStats.retries).toBe(retries);
  });

  it('the week boundary: every attempt counts in the window of its own moment', async () => {
    const retries = transactionStats.retries;
    const seen = new Set<string>();
    for (let round = 0; round < ROUNDS; round++) {
      // Each read of the clock alternates between the last millisecond of Sunday and Monday 00:00,
      // so concurrent attempts fall on both sides in an order that varies between rounds.
      let tick = round;
      clock = () => (tick++ % 2 === 0 ? MONDAY - 1 : MONDAY);
      const { guild, accounts, heroes } = await guildOf(N / 2);
      const jobs = shuffled(
        accounts.flatMap((a, i) =>
          Array.from(
            { length: GUILD_BOSS_ATTEMPTS_PER_WEEK * 2 },
            () => () => attempt(a, heroes[i]!),
          ),
        ),
        round,
      );
      const res = await Promise.all(jobs.map((j) => j()));
      const codes = res.map(status);
      expect(codes.every((c) => c === 201 || c === '409 no_attempts_left')).toBe(true);
      const { attempts } = await expectExact(guild);
      for (const a of attempts) seen.add(a.week);
      expect(attempts.every((a) => ['2026-11-02', '2026-11-09'].includes(a.week))).toBe(true);
    }
    clock = () => SATURDAY;
    expect([...seen].sort()).toEqual(['2026-11-02', '2026-11-09']);
    await expectAccountsWithinCap();
    await expectReconciled();
    expect(transactionStats.retries).toBe(retries);
  });
});
