/**
 * Real-PostgreSQL races for the ticket 4.11 fixes (runs when `DATABASE_URL` is set, skipped
 * otherwise; CI sets `REQUIRE_PG_TESTS=1`). Each race runs a few rounds in varied orders and
 * asserts only what holds in every order (Phase 3 retrospective):
 * - one reporter filing many reports at once never has more than `MAX_OPEN_REPORTS` waiting;
 * - a block racing the blocked player's petitions and a leader's invites leaves no hidden offer
 *   behind (the block and every offer between the pair take the same social lock);
 * - a block racing a moderator's report cases never deadlocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { buildApp } from './app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from './activity/settle.js';
import { blocks, guildApplications, guildInvites, guildMembers, reports } from './db/schema.js';
import { transactionStats } from './db/transaction.js';
import type { DatabaseHandle } from './db/types.js';
import { MAX_OPEN_REPORTS } from './social/routes.js';
import { createPostgresTestDatabase } from './test/db.js';
import { insertGuild } from './test/guilds.js';
import { caller, insertAccount, type TestAccount } from './test/social.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const ROUNDS = 3;

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

describe.skipIf(!url)('real PostgreSQL: the 4.11 fixes race safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 40 });
    app = buildApp({
      database,
      auth: { socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS },
    });
    await app.ready();
    call = caller(app);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const db = () => database.db;
  const account = (role: TestAccount['role'] = 'player') => insertAccount(db(), { role });

  it('a reporter racing 30 reports keeps exactly the cap waiting', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const before = transactionStats.retries;
      const reporter = await account();
      const targets = await Promise.all(Array.from({ length: 30 }, () => account()));
      const results = await Promise.all(
        shuffled(targets, round).map((t) =>
          call(reporter, 'POST', '/api/reports', {
            target: { kind: 'player', handle: t.handle },
            reason: 'spam',
          }),
        ),
      );
      const codes = results.map((r) =>
        r.statusCode === 201 ? 201 : (r.json() as { error: { code: string } }).error.code,
      );
      expect(codes.filter((c) => c === 201)).toHaveLength(MAX_OPEN_REPORTS);
      expect(codes.filter((c) => c !== 201).every((c) => c === 'report_limit')).toBe(true);
      const open = await db()
        .select()
        .from(reports)
        .where(and(eq(reports.reporterId, reporter.id), eq(reports.status, 'open')));
      expect(open).toHaveLength(MAX_OPEN_REPORTS);
      expect(transactionStats.retries).toBe(before);
    }
  });

  it('a block racing petitions and invites between the pair leaves no hidden offer', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const before = transactionStats.retries;
      // The pest petitions the target's guild and two strangers' guilds; the target and an
      // officer of the target's guild invite the pest; the target blocks the pest meanwhile.
      const target = await account();
      const officer = await account();
      const pest = await account();
      const own = await insertGuild(db(), target.id, {
        members: [{ accountId: officer.id, role: 'officer' }],
      });
      const others = await Promise.all(
        [0, 1].map(async () => insertGuild(db(), (await account()).id)),
      );
      const jobs = shuffled(
        [
          () => call(target, 'POST', '/api/blocks', { handle: pest.handle }),
          () => call(pest, 'POST', `/api/guilds/${own.handle}/apply`),
          ...others.map((g) => () => call(pest, 'POST', `/api/guilds/${g.handle}/apply`)),
          () => call(officer, 'POST', '/api/guild/invites', { handle: pest.handle }),
          () => call(target, 'POST', '/api/guild/invites', { handle: pest.handle }),
        ],
        round,
      );
      const results = await Promise.all(jobs.map((j) => j()));
      expect(results.every((r) => r.statusCode < 500)).toBe(true);
      const [blocked] = await db()
        .select()
        .from(blocks)
        .where(and(eq(blocks.blockerId, target.id), eq(blocks.blockedId, pest.id)));
      expect(blocked).toBeDefined();
      // Whatever the order: nothing between the pest and the target's guild is left waiting
      // (an applying-while-invited join may have taken the pest in before the block: then
      // there is nothing waiting either).
      const applications = await db()
        .select()
        .from(guildApplications)
        .where(
          and(eq(guildApplications.accountId, pest.id), eq(guildApplications.guildId, own.id)),
        );
      expect(applications).toEqual([]);
      const invites = await db()
        .select()
        .from(guildInvites)
        .where(and(eq(guildInvites.accountId, pest.id), eq(guildInvites.guildId, own.id)));
      expect(invites).toEqual([]);
      // Petitions to guilds the target does not lead are the strangers' to answer (unless the
      // pest joined the target's guild first, which drops its other petitions).
      const joined = await db()
        .select()
        .from(guildMembers)
        .where(eq(guildMembers.accountId, pest.id));
      const kept = await db()
        .select()
        .from(guildApplications)
        .where(
          and(
            eq(guildApplications.accountId, pest.id),
            inArray(
              guildApplications.guildId,
              others.map((g) => g.id),
            ),
          ),
        );
      expect(kept).toHaveLength(joined.length ? 0 : 2);
      expect(transactionStats.retries).toBe(before);
    }
  });

  it('moderators acting on guild cases while leadership changes hands never deadlock', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const before = transactionStats.retries;
      const founder = await account();
      const officer = await account();
      const mods = await Promise.all([account('moderator'), account('moderator')]);
      const guild = await insertGuild(db(), founder.id, {
        members: [{ accountId: officer.id, role: 'officer' }],
      });
      const reportIds: string[] = [];
      for (let n = 0; n < 3; n++) {
        const res = await call(await account(), 'POST', '/api/reports', {
          target: { kind: 'guild', handle: guild.handle },
          reason: 'other',
        });
        reportIds.push(res.json<{ report: { id: string } }>().report.id);
      }
      const results = await Promise.all(
        shuffled(
          [
            () => call(founder, 'POST', `/api/guild/members/${officer.handle}/transfer`),
            () =>
              call(mods[0]!, 'POST', `/api/mod/reports/${reportIds[0]}/resolve`, {
                action: 'renameGuild',
                reason: 'Offensive name.',
              }),
            () =>
              call(mods[1]!, 'POST', `/api/mod/reports/${reportIds[1]}/resolve`, {
                action: 'dismiss',
              }),
          ],
          round,
        ).map((j) => j()),
      );
      expect(results.every((r) => r.statusCode < 500)).toBe(true);
      // One case: at most one moderator's answer closed it; every report is closed or open, once.
      const rows = await db().select().from(reports).where(inArray(reports.id, reportIds));
      const closedBy = new Set(rows.filter((r) => r.status !== 'open').map((r) => r.resolvedBy));
      expect(closedBy.size).toBeLessThanOrEqual(1);
      expect(transactionStats.retries).toBe(before);
    }
  });
});
