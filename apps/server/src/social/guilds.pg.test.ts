/**
 * Real-PostgreSQL races for guilds (ticket 4.4, docs/SOCIAL.md "Guilds"). Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Membership rows change
 * only under the guild's lock (joins also under the joiner's social lock), names under name locks,
 * gold under the hero's lock. Each race runs a few rounds in varied orders and asserts only what
 * holds in every order (Phase 3 retrospective): exactly one leader, the cap, at most one founder
 * per name, membership equal to what the audit log says, gold reconciled with audit and telemetry,
 * and no transaction retried.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { GUILD_CREATE_COST, GUILD_LIMITS } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  auditLog,
  characters,
  guildApplications,
  guildInvites,
  guildMembers,
  guilds,
  telemetryDaily,
} from '../db/schema.js';
import { transactionStats } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const N = 8;
const ROUNDS = 3;

function shuffled<T>(xs: T[], round: number): T[] {
  const out = [...xs];
  let seed = 7 + round * 41;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe.skipIf(!url)('real PostgreSQL: guilds race safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: N * 4 + 2 });
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
  const account = () => insertAccount(db());
  const status = (r: { statusCode: number; json: () => unknown }) =>
    r.statusCode < 300
      ? r.statusCode
      : `${r.statusCode} ${(r.json() as { error: { code: string } }).error.code}`;

  async function heroWith(acc: TestAccount, gold: number) {
    const h = await insertCharacter(db(), acc.id);
    await db().update(characters).set({ gold }).where(eq(characters.id, h.id));
    return h;
  }

  const found = (who: TestAccount, body: object) =>
    app.inject({
      method: 'POST',
      url: '/api/guilds',
      payload: body,
      headers: { 'idempotency-key': randomUUID() },
      cookies: { [SESSION_COOKIE]: who.token },
    });

  const membersOf = async (guildId: string) =>
    db().select().from(guildMembers).where(eq(guildMembers.guildId, guildId));
  const guildAudit = async (guildId: string) =>
    db()
      .select()
      .from(auditLog)
      .where(sql`${auditLog.event} like 'guild.%' and ${auditLog.data}->>'guildId' = ${guildId}`);

  /**
   * The members the audit log says a guild has: the seeded ones plus `guild.join` minus
   * `guild.leave` / `guild.kick` (each account joins or leaves a given guild once in these races),
   * or nobody after `guild.disband`.
   */
  async function membersByAudit(guildId: string, seeded: string[]) {
    const rows = await guildAudit(guildId);
    if (rows.some((r) => r.event === 'guild.disband')) return [];
    const set = new Set(seeded);
    for (const r of rows) {
      if (r.event === 'guild.join') set.add(r.accountId!);
      if (r.event === 'guild.leave') set.delete(r.accountId!);
      if (r.event === 'guild.kick') set.delete(String(r.data.target));
    }
    return [...set].sort();
  }

  async function expectOneLeader(guildId: string) {
    const rows = await membersOf(guildId);
    if (rows.length > 0) expect(rows.filter((r) => r.role === 'leader')).toHaveLength(1);
  }

  it('concurrent founders with the same name: one guild, one charge, reconciled', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const name = `Racing Banner ${round}${randomUUID().slice(0, 4)}`.replace(
        /[^A-Za-z0-9 ]/g,
        'x',
      );
      const founders = await Promise.all(Array.from({ length: N }, () => account()));
      const heroes = await Promise.all(founders.map((f) => heroWith(f, GUILD_CREATE_COST + 7)));
      // Same name, different tags (and a second race on one tag below).
      const jobs = shuffled(
        founders.map(
          (f, i) => () =>
            found(f, {
              characterId: heroes[i]!.id,
              name: name.toUpperCase().slice(0, 1) + name.slice(1),
              tag: `R${round}${i}`,
            }),
        ),
        round,
      );
      const results = await Promise.all(jobs.map((j) => j()));
      const codes = results.map(status);
      expect(codes.filter((c) => c === 201)).toHaveLength(1);
      expect(codes.filter((c) => c === '409 guild_name_taken')).toHaveLength(N - 1);
      const gold = await db()
        .select({ id: characters.id, gold: characters.gold })
        .from(characters)
        .where(
          inArray(
            characters.id,
            heroes.map((h) => h.id),
          ),
        );
      expect(gold.filter((g) => g.gold === 7)).toHaveLength(1);
      expect(gold.filter((g) => g.gold === GUILD_CREATE_COST + 7)).toHaveLength(N - 1);
      const created = await db()
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.event, 'guild.create'),
            inArray(
              auditLog.accountId,
              founders.map((f) => f.id),
            ),
          ),
        );
      expect(created).toHaveLength(1);
      expect(created[0]!.characterId).toBe(gold.find((g) => g.gold === 7)!.id);
    }
    // Same tag, different names; and one account founding twice with two heroes.
    const a = await account();
    const b = await account();
    const [ha, hb, ha2] = await Promise.all([
      heroWith(a, GUILD_CREATE_COST),
      heroWith(b, GUILD_CREATE_COST),
      heroWith(a, GUILD_CREATE_COST),
    ]);
    const tagRace = await Promise.all([
      found(a, { characterId: ha.id, name: 'Tag Race One', tag: 'TGR' }),
      found(b, { characterId: hb.id, name: 'Tag Race Two', tag: 'tgr' }),
      found(a, { characterId: ha2.id, name: 'Tag Race Three', tag: 'TGQ' }),
    ]);
    const tagCodes = tagRace.map(status);
    expect(tagCodes.filter((c) => c === 201).length).toBeGreaterThanOrEqual(1);
    expect(tagCodes.filter((c) => c === 201).length).toBeLessThanOrEqual(2);
    const aGuilds = await db().select().from(guildMembers).where(eq(guildMembers.accountId, a.id));
    expect(aGuilds.length).toBeLessThanOrEqual(1);
    const tagged = await db()
      .select()
      .from(guilds)
      .where(and(eq(guilds.tag, 'TGR'), sql`${guilds.disbandedAt} is null`));
    expect(tagged).toHaveLength(1);
    // Gold, audit and telemetry agree after every race (the rollups commit with the audit row).
    const checks = await reconcileWithAudit(db());
    for (const c of checks.filter((c) => c.check.startsWith('guilds:')))
      expect(c, c.check).toMatchObject({ ok: true });
    const [rollup] = await db()
      .select({ amount: sql<number>`coalesce(sum(${telemetryDaily.amount}), 0)::int` })
      .from(telemetryDaily)
      .where(and(eq(telemetryDaily.metric, 'gold.out'), eq(telemetryDaily.dim1, 'guild_create')));
    const [audited] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(eq(auditLog.event, 'guild.create'));
    expect(rollup!.amount).toBe(audited!.n * GUILD_CREATE_COST);
    expect(transactionStats.retries).toBe(retries);
  });

  it(`joins at the cap: ${GUILD_LIMITS.members - 1} members, many invites and applications accepted at once → exactly one joins`, async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const leader = await account();
      const officer = await account();
      const filler = await Promise.all(
        Array.from({ length: GUILD_LIMITS.members - 3 }, () => account()),
      );
      const g = await insertGuild(db(), leader.id, {
        members: [
          { accountId: officer.id, role: 'officer' },
          ...filler.map((f) => ({ accountId: f.id })),
        ],
      });
      expect(await membersOf(g.id)).toHaveLength(GUILD_LIMITS.members - 1);
      const invited = await Promise.all(Array.from({ length: N / 2 }, () => account()));
      const applicants = await Promise.all(Array.from({ length: N / 2 }, () => account()));
      await db()
        .insert(guildInvites)
        .values(invited.map((p) => ({ guildId: g.id, accountId: p.id, invitedBy: leader.id })));
      await db()
        .insert(guildApplications)
        .values(applicants.map((p) => ({ guildId: g.id, accountId: p.id })));
      const jobs = shuffled(
        [
          ...invited.map((p) => () => call(p, 'POST', `/api/guilds/${g.handle}/invite/accept`)),
          ...applicants.map(
            (p, i) => () =>
              call(i % 2 ? leader : officer, 'POST', `/api/guild/applications/${p.handle}/accept`),
          ),
        ],
        round,
      );
      const codes = (await Promise.all(jobs.map((j) => j()))).map(status);
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      expect(codes.filter((c) => c === '409 guild_full')).toHaveLength(N - 1);
      const rows = await membersOf(g.id);
      expect(rows).toHaveLength(GUILD_LIMITS.members);
      expect(
        await membersByAudit(g.id, [leader.id, officer.id, ...filler.map((f) => f.id)]),
      ).toEqual(rows.map((r) => r.accountId).sort());
      await expectOneLeader(g.id);
    }
    expect(transactionStats.retries).toBe(retries);
  });

  it('one player accepted by several guilds at once joins exactly one', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const p = await account();
      const leaders = await Promise.all(Array.from({ length: N }, () => account()));
      const gs = await Promise.all(leaders.map((l) => insertGuild(db(), l.id)));
      await db()
        .insert(guildApplications)
        .values(gs.map((g) => ({ guildId: g.id, accountId: p.id })));
      await db()
        .insert(guildInvites)
        .values(gs.map((g, i) => ({ guildId: g.id, accountId: p.id, invitedBy: leaders[i]!.id })));
      const jobs = shuffled(
        gs.flatMap((g, i) => [
          () => call(leaders[i]!, 'POST', `/api/guild/applications/${p.handle}/accept`),
          () => call(p, 'POST', `/api/guilds/${g.handle}/invite/accept`),
        ]),
        round,
      );
      const codes = (await Promise.all(jobs.map((j) => j()))).map(status);
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      expect(
        await db().select().from(guildMembers).where(eq(guildMembers.accountId, p.id)),
      ).toHaveLength(1);
      expect(
        await db().select().from(guildInvites).where(eq(guildInvites.accountId, p.id)),
      ).toHaveLength(0);
    }
    expect(transactionStats.retries).toBe(retries);
  });

  it('accept vs disband: the guild ends empty; every join the audit shows came before the disband', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const leader = await account();
      const g = await insertGuild(db(), leader.id);
      const invited = await Promise.all(Array.from({ length: N }, () => account()));
      await db()
        .insert(guildInvites)
        .values(invited.map((p) => ({ guildId: g.id, accountId: p.id, invitedBy: leader.id })));
      const jobs = shuffled(
        [
          ...invited.map((p) => ({
            disband: false,
            run: () => call(p, 'POST', `/api/guilds/${g.handle}/invite/accept`),
          })),
          {
            disband: true,
            run: () => call(leader, 'POST', '/api/guild/disband', { name: g.name }),
          },
        ],
        round,
      );
      const results = await Promise.all(jobs.map((j) => j.run()));
      expect(status(results[jobs.findIndex((j) => j.disband)]!)).toBe(200);
      const codes = results.map(status);
      for (const c of codes) expect([200, '404 not_found']).toContain(c);
      expect(await membersOf(g.id)).toEqual([]);
      expect(await db().select().from(guildInvites).where(eq(guildInvites.guildId, g.id))).toEqual(
        [],
      );
      const audit = await guildAudit(g.id);
      const disbands = audit.filter((a) => a.event === 'guild.disband');
      expect(disbands).toHaveLength(1);
      const joined = audit
        .filter((a) => a.event === 'guild.join')
        .map((a) => a.accountId!)
        .sort();
      // Everyone who joined was a member when it was disbanded, and nobody else.
      expect(
        (disbands[0]!.data.members as string[]).filter((id) => id !== leader.id).sort(),
      ).toEqual(joined);
      expect(codes.filter((c) => c === 200)).toHaveLength(joined.length + 1);
    }
    expect(transactionStats.retries).toBe(retries);
  });

  it('leave vs promote: the member is gone either way; a promote that won shows in the leave', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const leader = await account();
      const members = await Promise.all(Array.from({ length: N }, () => account()));
      const g = await insertGuild(db(), leader.id, {
        members: members.map((m) => ({ accountId: m.id })),
      });
      const jobs = shuffled(
        members.flatMap((m) => [
          { m, kind: 'leave', run: () => call(m, 'POST', '/api/guild/leave') },
          {
            m,
            kind: 'promote',
            run: () => call(leader, 'POST', `/api/guild/members/${m.handle}/promote`),
          },
        ]),
        round,
      );
      const results = await Promise.all(jobs.map((j) => j.run()));
      const audit = await guildAudit(g.id);
      for (const m of members) {
        const leave = results[jobs.findIndex((j) => j.m === m && j.kind === 'leave')]!;
        const promote = results[jobs.findIndex((j) => j.m === m && j.kind === 'promote')]!;
        expect(status(leave)).toBe(200);
        expect([200, '404 not_a_member']).toContain(status(promote));
        const left = audit.find((a) => a.event === 'guild.leave' && a.accountId === m.id)!;
        expect(left.data.role).toBe(status(promote) === 200 ? 'officer' : 'member');
      }
      expect((await membersOf(g.id)).map((r) => r.accountId)).toEqual([leader.id]);
      await expectOneLeader(g.id);
    }
    expect(transactionStats.retries).toBe(retries);
  });

  it('leaders and officers acting on each other at once: one leader, at most one of each pair removed', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      // The leader hands over to officer A while each tries to kick or demote the other; officers
      // A and B try to kick each other while member C is kicked by A and promoted by the leader.
      const [leader, a, b, c] = await Promise.all(Array.from({ length: 4 }, () => account()));
      const g = await insertGuild(db(), leader!.id, {
        members: [
          { accountId: a!.id, role: 'officer' },
          { accountId: b!.id, role: 'officer' },
          { accountId: c!.id },
        ],
      });
      const act = (who: TestAccount, path: string) => () =>
        call(who, 'POST', `/api/guild/members/${path}`);
      const jobs = shuffled(
        [
          act(leader!, `${a!.handle}/transfer`),
          act(leader!, `${a!.handle}/kick`),
          act(leader!, `${a!.handle}/demote`),
          act(a!, `${leader!.handle}/kick`),
          act(a!, `${leader!.handle}/demote`),
          act(a!, `${b!.handle}/kick`),
          act(b!, `${a!.handle}/kick`),
          act(a!, `${c!.handle}/kick`),
          act(leader!, `${c!.handle}/promote`),
        ],
        round,
      );
      const codes = (await Promise.all(jobs.map((j) => j()))).map(status);
      for (const code of codes) {
        expect([
          200,
          '403 guild_forbidden',
          '404 not_a_member',
          '404 not_in_guild',
          '409 not_an_officer',
          '409 already_officer',
        ]).toContain(code);
      }
      const rows = await membersOf(g.id);
      const ids = rows.map((r) => r.accountId);
      await expectOneLeader(g.id);
      // Never both the leader and A gone; the audit explains the roster exactly.
      expect(ids.includes(leader!.id) || ids.includes(a!.id)).toBe(true);
      expect(ids.sort()).toEqual(await membersByAudit(g.id, [leader!.id, a!.id, b!.id, c!.id]));
      const audit = await guildAudit(g.id);
      const transferred = audit.some((x) => x.event === 'guild.transfer');
      const leaderNow = rows.find((r) => r.role === 'leader')!.accountId;
      expect(leaderNow).toBe(transferred ? a!.id : leader!.id);
      // Officers cannot kick officers: B is never kicked by A while A is an officer, and A kicks B
      // only after becoming the leader.
      const kickB = audit.find((x) => x.event === 'guild.kick' && x.data.target === b!.id);
      if (kickB) expect(transferred).toBe(true);
    }
    expect(transactionStats.retries).toBe(retries);
  });
});
