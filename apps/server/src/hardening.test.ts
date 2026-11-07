/**
 * Ticket 4.11 (Phase 4 hardening): one test per finding of the exploit and abuse review of the
 * Phase 4 endpoints that was fixed. The findings and the accepted risks are listed in
 * docs/ROADMAP.md ("Phase 4 retrospective").
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp } from './app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from './activity/settle.js';
import {
  accounts,
  auditLog,
  guildApplications,
  guildInvites,
  guildMembers,
  guilds,
  reports,
} from './db/schema.js';
import type { DatabaseHandle } from './db/types.js';
import { createTestDatabase } from './test/db.js';
import { insertGuild } from './test/guilds.js';
import { insertCharacter } from './test/heroes.js';
import { MAX_OPEN_REPORTS } from './social/routes.js';
import { caller, insertAccount, type TestAccount } from './test/social.js';

const MIN = 60_000;

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-09T12:00:00Z');
const now = () => new Date(nowMs);
let call: ReturnType<typeof caller>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { now, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 1000 }] } },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
  });
  await app.ready();
  call = caller(app);
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

beforeEach(() => {
  nowMs += 10 * MIN;
});

const db = () => database.db;
const player = (role: TestAccount['role'] = 'player') => insertAccount(db(), { role, now: now() });
const code = async (p: Promise<{ statusCode: number; body: string }>) => {
  const r = await p;
  return [r.statusCode, (JSON.parse(r.body || '{}') as { error?: { code: string } }).error?.code];
};
const reportGuild = async (who: TestAccount, handle: string, note?: string) => {
  const res = await call(who, 'POST', '/api/reports', {
    target: { kind: 'guild', handle },
    reason: 'other',
    ...(note ? { note } : {}),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ report: { id: string } }>().report.id;
};
type Case = { reportId: string; subject: { handle: string }; reports: { id: string }[] };
const queue = async (who: TestAccount) =>
  (await call(who, 'GET', '/api/mod/queue')).json<{ cases: Case[]; openCases: number }>();

describe('moderation cases are one target and one subject (finding: guild reports after a handover)', () => {
  it('a moderator who took over a reported guild never sees or closes the reports about them', async () => {
    const founder = await player();
    const mod = await player('moderator');
    const peer = await player('moderator');
    const guild = await insertGuild(db(), founder.id, {
      members: [{ accountId: mod.id, role: 'officer' }],
    });
    const early = await reportGuild(await player(), guild.handle); // about the founder
    const transfer = await call(founder, 'POST', `/api/guild/members/${mod.handle}/transfer`);
    expect(transfer.statusCode, transfer.body).toBe(200);
    const late = await reportGuild(await player(), guild.handle, 'The new leader is worse.'); // about the moderator

    // The moderator sees the founder's case only, without the report about themselves.
    const theirs = await queue(mod);
    const seen = theirs.cases.filter((c) => c.reports.some((r) => [early, late].includes(r.id)));
    expect(seen.map((c) => c.subject.handle)).toEqual([founder.handle]);
    expect(seen[0]!.reports.map((r) => r.id)).toEqual([early]);
    expect(JSON.stringify(theirs)).not.toContain('The new leader is worse.');

    // Dismissing it closes the founder's report only; the one about the moderator stays open.
    const dismissed = await call(mod, 'POST', `/api/mod/reports/${early}/resolve`, {
      action: 'dismiss',
    });
    expect(dismissed.json()).toMatchObject({ closedReports: 1 });
    const [still] = await db().select().from(reports).where(eq(reports.id, late));
    expect(still!.status).toBe('open');
    // A peer moderator cannot act on it either (same rank); an admin can.
    expect((await queue(peer)).cases.some((c) => c.reportId === late)).toBe(false);
    expect(
      await code(call(peer, 'POST', `/api/mod/reports/${late}/resolve`, { action: 'dismiss' })),
    ).toEqual([403, 'forbidden']);
    const admin = await player('admin');
    expect((await queue(admin)).cases.find((c) => c.reportId === late)?.subject.handle).toBe(
      mod.handle,
    );
  });

  it('a guild action checks the rank of the leader now, not the leader the report named', async () => {
    const founder = await player();
    const admin = await player('admin');
    const mod = await player('moderator');
    const guild = await insertGuild(db(), founder.id, {
      members: [{ accountId: admin.id, role: 'officer' }],
    });
    const rep = await reportGuild(await player(), guild.handle); // about the founder
    expect(
      (await call(founder, 'POST', `/api/guild/members/${admin.handle}/transfer`)).statusCode,
    ).toBe(200);
    for (const action of ['disbandGuild', 'renameGuild']) {
      expect(
        await code(
          call(mod, 'POST', `/api/mod/reports/${rep}/resolve`, { action, reason: 'Offensive.' }),
        ),
      ).toEqual([403, 'forbidden']);
    }
    const [g] = await db().select().from(guilds).where(eq(guilds.id, guild.id));
    expect(g!.disbandedAt).toBeNull();
    expect(
      await db().select().from(guildMembers).where(eq(guildMembers.guildId, guild.id)),
    ).toHaveLength(2);
    // Back with a player as leader, the old report can be acted on.
    expect(
      (await call(admin, 'POST', `/api/guild/members/${founder.handle}/transfer`)).statusCode,
    ).toBe(200);
    expect(
      (
        await call(mod, 'POST', `/api/mod/reports/${rep}/resolve`, {
          action: 'renameGuild',
          reason: 'Offensive.',
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('a block takes the guild offers it hides with it (findings: blocked applicants and invites fill caps)', () => {
  const apply = (who: TestAccount, handle: string) =>
    call(who, 'POST', `/api/guilds/${handle}/apply`);
  const invite = (who: TestAccount, target: TestAccount) =>
    call(who, 'POST', '/api/guild/invites', { handle: target.handle });
  const block = (who: TestAccount, target: TestAccount) =>
    call(who, 'POST', '/api/blocks', { handle: target.handle });
  type Hall = {
    guild: { applications: unknown[]; invites: unknown[] } | null;
    invites: { guild: { handle: string } }[];
  };
  const hall = async (who: TestAccount) => (await call(who, 'GET', '/api/guild')).json<Hall>();

  it("a leader's block drops the blocked player's petition; the guild's slots free up", async () => {
    const leader = await player();
    const guild = await insertGuild(db(), leader.id);
    const spammers = [await player(), await player(), await player()];
    for (const s of spammers) expect((await apply(s, guild.handle)).statusCode).toBe(200);
    for (const s of spammers) expect((await block(leader, s)).statusCode).toBe(200);
    expect((await hall(leader)).guild!.applications).toEqual([]);
    expect(
      await db().select().from(guildApplications).where(eq(guildApplications.guildId, guild.id)),
    ).toEqual([]);
    const audit = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, leader.id), eq(auditLog.event, 'friend.block')));
    expect(audit.map((a) => a.data.guildOffers)).toEqual(
      spammers.map(() => ({ invites: 0, applications: 1 })),
    );
    // A player blocked by the applicant's side works the same way round.
    const shy = await player();
    expect((await apply(shy, guild.handle)).statusCode).toBe(200);
    expect((await block(shy, leader)).statusCode).toBe(200);
    expect(
      await db().select().from(guildApplications).where(eq(guildApplications.guildId, guild.id)),
    ).toEqual([]);
  });

  it("an invitee's block drops the hidden invites; the inbox and the guild profile agree", async () => {
    const victim = await player();
    const leaders = [await player(), await player()];
    const gs = [];
    for (const l of leaders) {
      const g = await insertGuild(db(), l.id);
      gs.push(g);
      expect((await invite(l, victim)).statusCode).toBe(200);
    }
    const leader3 = await player();
    const officer = await player();
    const g3 = await insertGuild(db(), leader3.id, {
      members: [{ accountId: officer.id, role: 'officer' }],
    });
    expect((await invite(officer, victim)).statusCode).toBe(200);
    expect((await hall(victim)).invites).toHaveLength(3);

    // Blocking a leader drops their guild's invite; blocking an inviting officer drops theirs.
    expect((await block(victim, leaders[0]!)).statusCode).toBe(200);
    expect((await block(victim, officer)).statusCode).toBe(200);
    expect((await hall(victim)).invites.map((i) => i.guild.handle)).toEqual([gs[1]!.handle]);
    expect(
      await db().select().from(guildInvites).where(eq(guildInvites.accountId, victim.id)),
    ).toHaveLength(1);
    const profile = await call(victim, 'GET', `/api/guilds/${g3.handle}`);
    expect(profile.json<{ standing: string }>().standing).toBe('none');
  });

  it("an officer cannot invite a player blocked either way with the guild's leader", async () => {
    const leader = await player();
    const officer = await player();
    await insertGuild(db(), leader.id, { members: [{ accountId: officer.id, role: 'officer' }] });
    const [blocker, blocked] = [await player(), await player()];
    expect((await block(blocker, leader)).statusCode).toBe(200);
    expect((await block(leader, blocked)).statusCode).toBe(200);
    const unknown = await call(officer, 'POST', '/api/guild/invites', { handle: 'zzzzzzzzzzzz' });
    for (const target of [blocker, blocked]) {
      const res = await invite(officer, target);
      expect([res.statusCode, res.json()]).toEqual([unknown.statusCode, unknown.json()]);
      expect((await hall(target)).invites).toEqual([]);
    }
  });

  it('an officer cannot withdraw (or probe) an invite to a player blocked either way', async () => {
    const leader = await player();
    const officer = await player();
    const target = await player();
    await insertGuild(db(), leader.id, { members: [{ accountId: officer.id, role: 'officer' }] });
    expect((await invite(leader, target)).statusCode).toBe(200);
    expect((await block(target, officer)).statusCode).toBe(200);
    const cancel = (who: TestAccount) =>
      call(who, 'POST', `/api/guild/invites/${target.handle}/cancel`);
    const unknown = await call(
      officer,
      'POST',
      `/api/guild/invites/${(await player()).handle}/cancel`,
    );
    const refused = await cancel(officer);
    expect([refused.statusCode, refused.json()]).toEqual([unknown.statusCode, unknown.json()]);
    expect(refused.statusCode).toBe(404);
    expect((await cancel(leader)).statusCode).toBe(200);
  });
});

describe('requests and answers that told more than they should', () => {
  it('a non-finite number is a 400, never a 500 (query, params and body)', async () => {
    const who = await player();
    await insertGuild(db(), who.id);
    const admin = await player('admin');
    for (const [account, url] of [
      [who, '/api/guild/chat?since=1e309'],
      [who, '/api/guild/chat?before=-Infinity'],
      [admin, '/api/mod/queue?limit=1e309'],
      [admin, '/api/admin/invites?limit=Infinity'],
    ] as const) {
      expect(await code(call(account, 'GET', url)), url).toEqual([400, 'validation_failed']);
    }
    const body = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { 'content-type': 'application/json' },
      payload: '{"maxUses":1e309,"expiresInHours":null}',
      cookies: { wf_session: admin.token },
    });
    expect(body.statusCode).toBe(400);
  });

  it('staff routes look exactly like missing ones to everyone else, malformed bodies included', async () => {
    const who = await player();
    for (const account of [null, who]) {
      for (const url of [
        '/api/mod/reports/0190a1b2-0000-7000-8000-000000000000/resolve',
        '/api/mod/no-such-thing',
        '/api/admin/players/search',
        '/api/admin/no-such-thing',
      ]) {
        const res = await app.inject({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/json' },
          payload: '{bad',
          ...(account ? { cookies: { wf_session: account.token } } : {}),
        });
        expect(res.statusCode, url).toBe(404);
        expect(res.headers['cache-control'], url).toBeUndefined();
        expect(res.json()).toEqual({
          error: { code: 'not_found', message: `Route POST ${url} not found` },
        });
      }
    }
    const admin = await player('admin');
    const own = await call(admin, 'GET', '/api/admin/status');
    expect(own.headers['cache-control']).toBe('no-store');
  });

  it("a report cannot confirm a guessed name of a hidden player's hero", async () => {
    const owner = await player();
    const hero = await insertCharacter(db(), owner.id, { name: 'Secretus' });
    expect(hero.name).toBe('Secretus');
    await db()
      .update(accounts)
      .set({ profileVisibility: 'hidden' })
      .where(eq(accounts.id, owner.id));
    const reporter = await player();
    const guess = (name: string) =>
      code(
        call(reporter, 'POST', '/api/reports', {
          target: { kind: 'characterName', handle: owner.handle, name },
          reason: 'other',
        }),
      );
    const unknown = await guess('Guessname');
    expect(await guess('secretus')).toEqual(unknown);
    expect(unknown).toEqual([404, 'not_found']);
    // The player can still be reported; on a public profile the hero name can too.
    expect(
      (
        await call(reporter, 'POST', '/api/reports', {
          target: { kind: 'player', handle: owner.handle },
          reason: 'other',
        })
      ).statusCode,
    ).toBe(201);
    await db()
      .update(accounts)
      .set({ profileVisibility: 'public' })
      .where(eq(accounts.id, owner.id));
    expect((await guess('secretus'))[0]).toBe(201);
  });

  it('a player can have at most 20 reports waiting', async () => {
    const reporter = await player();
    for (let n = 0; n < MAX_OPEN_REPORTS; n++) {
      const target = await player();
      expect(
        (
          await call(reporter, 'POST', '/api/reports', {
            target: { kind: 'player', handle: target.handle },
            reason: 'spam',
          })
        ).statusCode,
      ).toBe(201);
    }
    const one = await player();
    expect(
      await code(
        call(reporter, 'POST', '/api/reports', {
          target: { kind: 'player', handle: one.handle },
          reason: 'spam',
        }),
      ),
    ).toEqual([409, 'report_limit']);
  });

  it("an admin's player file never shows who reported an admin", async () => {
    const admin = await player('admin');
    const other = await player('admin');
    const reporter = await player();
    expect(
      (
        await call(reporter, 'POST', '/api/reports', {
          target: { kind: 'player', handle: other.handle },
          reason: 'other',
          note: 'A note about an admin.',
        })
      ).statusCode,
    ).toBe(201);
    const file = await call(admin, 'GET', `/api/admin/players/${other.handle}`);
    expect(file.statusCode, file.body).toBe(200);
    expect(file.json<{ player: { reports: unknown[] } }>().player.reports).toEqual([]);
    expect(file.body).not.toContain(reporter.handle);
    expect(file.body).not.toContain('A note about an admin.');
  });

  it('names that pass for staff in other scripts, and placeholder names, are refused at registration', async () => {
    for (const displayName of ['ΑDΜΙΝ', 'ΜΟDΕRΑΤΟR', 'ADMlN', 'Wanderer 123456']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        remoteAddress: `10.9.0.${displayName.length}`,
        payload: {
          email: `x${displayName.length}@graumark.test`,
          displayName,
          password: 'ashes-and-iron-42',
        },
      });
      expect(res.statusCode, displayName).toBe(400);
    }
  });
});

describe('the presence setting (finding: unlimited and audited on every call)', () => {
  it('is a social write and is audited only when it changes', async () => {
    const tight = buildApp({
      database,
      auth: { now, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 3 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    });
    await tight.ready();
    try {
      const who = await player();
      const set = (hidden: boolean) =>
        caller(tight)(who, 'POST', '/api/account/presence', { hidden });
      expect((await set(true)).statusCode).toBe(200);
      expect((await set(true)).statusCode).toBe(200);
      expect((await set(true)).statusCode).toBe(200);
      expect(await code(set(false))).toEqual([429, 'rate_limited']);
      const audits = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.accountId, who.id), eq(auditLog.event, 'presence.setting')));
      expect(audits.map((a) => a.data)).toEqual([{ hidden: true }]);
    } finally {
      await tight.close();
    }
  });
});
