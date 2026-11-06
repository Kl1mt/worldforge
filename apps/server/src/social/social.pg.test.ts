/**
 * Real-PostgreSQL races for reports, sanctions and roles (ticket 4.1). Like
 * `src/concurrency.pg.test.ts`: runs when `DATABASE_URL` is set, skipped otherwise (CI sets
 * `REQUIRE_PG_TESTS=1`). These move nothing of value, but they must still be race-safe: at most
 * one open report per reporter and target, one moderator wins a report, a sanction and the
 * target's own requests serialise. Each race runs a few rounds in varied orders and asserts only
 * what holds in every order (Phase 3 retrospective).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { auditLog, reports, sanctions } from '../db/schema.js';
import { transactionStats } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { setAccountRole } from './roles.js';
import { socialWrite } from './social-write.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const N = 8;
const ROUNDS = 3;

function shuffled<T>(xs: T[], round: number): T[] {
  const out = [...xs];
  // Deterministic per round, so a failure reproduces.
  let seed = 7 + round * 31;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe.skipIf(!url)('real PostgreSQL: reports, sanctions and roles race safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: N * 3 + 2 });
    app = buildApp({
      database,
      auth: { socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
      // A stand-in social write (a later ticket's chat message) that leaves an audit row.
      testRoutes: (api) => {
        api.post('/test/chat', { preHandler: api.requireAccount }, async (request, reply) =>
          socialWrite(api, request, reply, 'chat', async (tx, { account }) => {
            await writeAudit(tx, { event: 'test.chat', accountId: account.id });
            return { posted: true };
          }),
        );
      },
    });
    await app.ready();
    call = caller(app);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const account = (role: 'player' | 'moderator' | 'admin' = 'player') =>
    insertAccount(database.db, { role });
  const reportOn = (who: TestAccount, subject: TestAccount, kind = 'player') =>
    call(who, 'POST', '/api/reports', {
      target:
        kind === 'player'
          ? { kind, handle: subject.handle }
          : { kind, handle: subject.handle, field: 'displayName' },
      reason: 'harassment',
    });
  const auditCount = async (event: string, accountIds: string[]) =>
    (
      await database.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.event, event), inArray(auditLog.accountId, accountIds)))
    ).length;

  it('concurrent reports on one target: one open report per reporter, every one audited', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const subject = await account();
      const reporters = await Promise.all(Array.from({ length: N }, () => account()));
      // Every reporter sends the same report three times, all at once, interleaved.
      const sends = shuffled(
        reporters.flatMap((r) => [r, r, r]),
        round,
      );
      const results = await Promise.all(sends.map((r) => reportOn(r, subject)));
      for (const r of reporters) {
        const mine = results.filter((_, i) => sends[i] === r).map((res) => res.statusCode);
        expect(mine.sort()).toEqual([201, 409, 409]);
      }
      for (const res of results.filter((x) => x.statusCode === 409)) {
        expect(res.json().error.code).toBe('report_open');
      }
      const rows = await database.db
        .select()
        .from(reports)
        .where(eq(reports.subjectId, subject.id));
      expect(rows).toHaveLength(N);
      expect(new Set(rows.map((r) => r.reporterId)).size).toBe(N);
      expect(rows.every((r) => r.status === 'open')).toBe(true);
      expect(
        await auditCount(
          'report.create',
          reporters.map((r) => r.id),
        ),
      ).toBe(N);
    }
  });

  it('a mute racing the target’s social writes: each write sees it or commits before it', async () => {
    const mod = await account('moderator');
    for (let round = 0; round < ROUNDS; round++) {
      const subject = await account();
      const reporter = await account();
      const reportId = (await reportOn(reporter, subject)).json().report.id;
      const writes = Array.from({ length: N }, () => () => call(subject, 'POST', '/api/test/chat'));
      const mute = () =>
        call(mod, 'POST', `/api/mod/reports/${reportId}/resolve`, {
          action: 'mute',
          reason: 'Flooding the channel',
          durationHours: 24,
        });
      const order = shuffled([...writes, mute], round);
      const results = await Promise.all(order.map((f) => f()));
      const muteRes = results[order.indexOf(mute)]!;
      expect(muteRes.statusCode).toBe(200);
      const chats = results.filter((_, i) => order[i] !== mute);
      for (const c of chats) {
        expect([200, 403]).toContain(c.statusCode);
        if (c.statusCode === 403) expect(c.json().error.code).toBe('muted');
      }
      // Every accepted write is in the audit log, and none was accepted without its row.
      expect(await auditCount('test.chat', [subject.id])).toBe(
        chats.filter((c) => c.statusCode === 200).length,
      );
      // Once the mute has answered, every write is refused.
      const after = await Promise.all(
        Array.from({ length: 3 }, () => call(subject, 'POST', '/api/test/chat')),
      );
      expect(after.map((r) => r.statusCode)).toEqual([403, 403, 403]);
      const active = await database.db
        .select()
        .from(sanctions)
        .where(eq(sanctions.subjectId, subject.id));
      expect(active).toHaveLength(1);
      expect(await auditCount('sanction.issue', [subject.id])).toBe(1);
    }
  });

  it('a suspension racing the target’s requests stops the session for every later request', async () => {
    const admin = await account('admin');
    for (let round = 0; round < ROUNDS; round++) {
      const subject = await account();
      const reporter = await account();
      const others = await Promise.all(Array.from({ length: 3 }, () => account()));
      const reportId = (await reportOn(reporter, subject)).json().report.id;
      const requests = [
        ...others.map((o) => () => reportOn(subject, o)),
        () => call(subject, 'GET', '/api/characters'),
        () => call(subject, 'GET', '/api/account/standing'),
        () => call(subject, 'POST', '/api/test/chat'),
      ];
      const suspend = () =>
        call(admin, 'POST', `/api/mod/reports/${reportId}/resolve`, {
          action: 'suspend',
          reason: 'Botting',
          durationHours: 72,
        });
      const order = shuffled([...requests, suspend], round);
      const results = await Promise.all(order.map((f) => f()));
      expect(results[order.indexOf(suspend)]!.statusCode).toBe(200);
      const theirs = results.filter((_, i) => order[i] !== suspend);
      for (const r of theirs) {
        expect([200, 201, 403]).toContain(r.statusCode);
        if (r.statusCode === 403) expect(r.json().error.code).toBe('account_suspended');
      }
      // Reports by the subject that were accepted are exactly the stored ones.
      const filed = await database.db
        .select()
        .from(reports)
        .where(eq(reports.reporterId, subject.id));
      expect(filed).toHaveLength(theirs.filter((r) => r.statusCode === 201).length);
      expect(await auditCount('report.create', [subject.id])).toBe(filed.length);
      const after = await Promise.all([
        call(subject, 'GET', '/api/account'),
        call(subject, 'GET', '/api/characters'),
        reportOn(subject, reporter),
      ]);
      expect(after.map((r) => r.statusCode)).toEqual([403, 403, 403]);
    }
  });

  it('two moderators acting on one report: exactly one wins, the case closes once', async () => {
    const [m1, m2] = [await account('moderator'), await account('moderator')];
    const admin = await account('admin');
    for (let round = 0; round < ROUNDS; round++) {
      const subject = await account();
      const reporters = await Promise.all(Array.from({ length: 3 }, () => account()));
      const ids = await Promise.all(
        reporters.map(async (r) => (await reportOn(r, subject)).json().report.id),
      );
      const reportId = ids[0];
      const resolve = (who: TestAccount, body: object) => () =>
        call(who, 'POST', `/api/mod/reports/${reportId}/resolve`, body);
      const attempts = shuffled(
        [
          resolve(m1, { action: 'mute', reason: 'Abuse', durationHours: 24 }),
          resolve(m2, { action: 'suspend', reason: 'Abuse', durationHours: 24 }),
          resolve(admin, { action: 'dismiss' }),
          resolve(m1, { action: 'forceRename', reason: 'Name', durationHours: 48 }),
          resolve(m2, { action: 'dismiss' }),
          resolve(admin, { action: 'mute', reason: 'Abuse', durationHours: 1 }),
        ],
        round,
      );
      const results = await Promise.all(attempts.map((f) => f()));
      const wins = results.filter((r) => r.statusCode === 200);
      expect(wins).toHaveLength(1);
      for (const r of results.filter((x) => x.statusCode !== 200)) {
        expect(r.statusCode).toBe(409);
        expect(r.json().error.code).toBe('report_closed');
      }
      const winner = wins[0]!.json();
      expect(winner.closedReports).toBe(3);
      const rows = await database.db.select().from(reports).where(inArray(reports.id, ids));
      const expectedStatus = winner.sanction ? 'actioned' : 'dismissed';
      expect(rows.map((r) => r.status)).toEqual([expectedStatus, expectedStatus, expectedStatus]);
      const issued = await database.db
        .select()
        .from(sanctions)
        .where(eq(sanctions.subjectId, subject.id));
      expect(issued).toHaveLength(winner.sanction ? 1 : 0);
      expect(await auditCount('sanction.issue', [subject.id])).toBe(issued.length);
      expect(await auditCount('report.resolve', [m1.id, m2.id, admin.id])).toBe(round + 1);
    }
  });

  it('a role revoke racing the moderator’s actions: each action ran as staff or not at all', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const mod = await account('moderator');
      const subjects = await Promise.all(Array.from({ length: N }, () => account()));
      const reporter = await account();
      const ids: string[] = [];
      for (const s of subjects) ids.push((await reportOn(reporter, s)).json().report.id);
      const actions = ids.map(
        (id) => () => call(mod, 'POST', `/api/mod/reports/${id}/resolve`, { action: 'dismiss' }),
      );
      const revoke = () => setAccountRole(database.db, mod.handle, 'player');
      const order = shuffled<() => Promise<unknown>>([...actions, revoke], round);
      const results = await Promise.all(order.map((f) => f()));
      const answered = results.filter((_, i) => order[i] !== revoke) as { statusCode: number }[];
      for (const r of answered) expect([200, 404]).toContain(r.statusCode);
      const done = answered.filter((r) => r.statusCode === 200).length;
      expect(await auditCount('report.resolve', [mod.id])).toBe(done);
      const closed = await database.db.select().from(reports).where(inArray(reports.id, ids));
      expect(closed.filter((r) => r.status !== 'open')).toHaveLength(done);
      expect(closed.filter((r) => r.status !== 'open').every((r) => r.resolvedBy === mod.id)).toBe(
        true,
      );
      // After the CLI returns, the queue and every action are gone for them.
      expect((await call(mod, 'GET', '/api/mod/queue')).statusCode).toBe(404);
      expect(await auditCount('role.revoke', [mod.id])).toBe(1);
    }
  });

  it('the races above ran without a single deadlock or serialization retry', () => {
    expect(transactionStats.retries).toBe(0);
  });
});
