import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { accounts, auditLog, reports, sanctions } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { socialWrite } from './social-write.js';
import { setAccountRole } from './roles.js';

const HOUR = 3_600_000;

describe('safety & moderation (ticket 4.1)', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let nowMs = Date.parse('2026-11-06T12:00:00Z');
  const now = () => new Date(nowMs);
  let call: ReturnType<typeof caller>;
  let mod: TestAccount;
  let admin: TestAccount;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: {
        now,
        socialWriteLimit: { windows: [{ windowMs: 60_000, max: 5 }] },
        registerRateLimit: { max: 1000, timeWindowMs: 60_000 },
        loginRateLimit: { max: 1000, timeWindowMs: 60_000 },
      },
      // A route that stands in for a later ticket's social write (chat), to test the helper.
      testRoutes: (api) => {
        api.post('/test/chat', { preHandler: api.requireAccount }, async (request, reply) =>
          socialWrite(api, request, reply, 'chat', async () => ({ posted: true })),
        );
      },
    });
    await app.ready();
    call = caller(app);
    mod = await insertAccount(database.db, { role: 'moderator', now: now() });
    admin = await insertAccount(database.db, { role: 'admin', now: now() });
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  // Each test gets a fresh social-write window.
  beforeEach(() => {
    nowMs += 10 * 60_000;
  });

  const player = () => insertAccount(database.db, { now: now() });
  const report = (who: TestAccount, target: object, reason = 'harassment', note?: string) =>
    call(who, 'POST', '/api/reports', { target, reason, ...(note === undefined ? {} : { note }) });
  const queue = async (who: TestAccount) => {
    const res = await call(who, 'GET', '/api/mod/queue?limit=50');
    expect(res.statusCode).toBe(200);
    return res.json<{ cases: Case[]; openCases: number; nextCursor: string | null }>();
  };
  interface Case {
    reportId: string;
    target: { kind: string; handle: string; field?: string };
    subject: { handle: string; displayName: string; role: string; sanctions: { kind: string }[] };
    current: { value: string; hidden: boolean };
    reports: { id: string; reason: string; note: string | null; reporter: { handle: string } }[];
  }
  const caseFor = async (who: TestAccount, handle: string, kind = 'player') =>
    (await queue(who)).cases.find((c) => c.subject.handle === handle && c.target.kind === kind);
  const act = (who: TestAccount, reportId: string, body: object) =>
    call(who, 'POST', `/api/mod/reports/${reportId}/resolve`, body);
  async function reportedCase(subject: TestAccount, kind: 'player' | 'profileField' = 'player') {
    const reporter = await player();
    const target =
      kind === 'player'
        ? { kind, handle: subject.handle }
        : { kind, handle: subject.handle, field: 'displayName' };
    expect((await report(reporter, target)).statusCode).toBe(201);
    return (await caseFor(admin, subject.handle, kind))!;
  }
  const audits = (event: string, accountId: string) =>
    database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.event, event), eq(auditLog.accountId, accountId)));

  describe('reports', () => {
    it('files a report once per reporter and target, audited', async () => {
      const [a, b] = [await player(), await player()];
      const res = await report(a, { kind: 'player', handle: b.handle }, 'spam', '  sells gold ​ ');
      expect(res.statusCode).toBe(201);
      const { report: r } = res.json();
      expect(r).toMatchObject({
        target: { kind: 'player', handle: b.handle },
        reason: 'spam',
        note: 'sells gold',
        status: 'open',
      });
      expect(JSON.stringify(r)).not.toContain(b.id);
      const again = await report(a, { kind: 'player', handle: b.handle });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toMatchObject({
        code: 'report_open',
        details: { reportId: r.id },
      });
      // Another target of the same player is a separate report.
      const field = await report(a, {
        kind: 'profileField',
        handle: b.handle,
        field: 'displayName',
      });
      expect(field.statusCode).toBe(201);
      const rows = await audits('report.create', a.id);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.data).toMatchObject({
        reportId: r.id,
        subjectId: b.id,
        reason: 'spam',
        noteLength: 10,
      });
    });

    it('rejects self, unknown handles, bad reasons and long notes', async () => {
      const a = await player();
      expect((await report(a, { kind: 'player', handle: a.handle })).json().error.code).toBe(
        'cannot_report_self',
      );
      expect((await report(a, { kind: 'player', handle: 'zzzzzzzzzzzz' })).statusCode).toBe(404);
      expect((await report(a, { kind: 'player', handle: 'not a handle' })).statusCode).toBe(404);
      expect((await report(a, { kind: 'player', handle: mod.handle }, 'nope')).statusCode).toBe(
        400,
      );
      expect((await report(a, { kind: 'guild', guildId: 'x' })).statusCode).toBe(400);
      const long = await report(
        a,
        { kind: 'player', handle: mod.handle },
        'other',
        'x'.repeat(501),
      );
      expect(long.statusCode).toBe(400);
      expect(long.json().error.details.problems.note).toBe('too_long');
      expect(
        (await report(a, { kind: 'player', handle: mod.handle, accountId: mod.id } as object))
          .statusCode,
      ).toBe(400);
    });

    it('counts reports in the social-write class (429 with Retry-After), not refused ones', async () => {
      const a = await player();
      const targets = await Promise.all(Array.from({ length: 6 }, () => player()));
      for (const t of targets.slice(0, 5)) {
        expect((await report(a, { kind: 'player', handle: t.handle })).statusCode).toBe(201);
      }
      const over = await report(a, { kind: 'player', handle: targets[5]!.handle });
      expect(over.statusCode).toBe(429);
      expect(over.headers['retry-after']).toBeDefined();
      expect(over.json().error.details).toMatchObject({ limit: 'social' });
      // Game routes are not affected by the social class.
      expect((await call(a, 'GET', '/api/account')).statusCode).toBe(200);
      nowMs += 61_000;
      expect((await report(a, { kind: 'player', handle: targets[5]!.handle })).statusCode).toBe(
        201,
      );
    });

    it('finds players by display name, not by hidden names', async () => {
      const [a, b] = [await player(), await player()];
      const res = await call(
        a,
        'GET',
        `/api/players/lookup?name=${encodeURIComponent(b.displayName.toUpperCase())}`,
      );
      expect(res.json()).toEqual({ player: { handle: b.handle, displayName: b.displayName } });
      expect((await call(a, 'GET', '/api/players/lookup?name=Nobody%20Here')).statusCode).toBe(404);
      expect((await call(null, 'GET', `/api/players/lookup?name=x`)).statusCode).toBe(401);
    });
  });

  describe('the moderator queue', () => {
    it('is a 404 for players and visitors, the same as an unknown route', async () => {
      const p = await player();
      const unknown = await call(p, 'GET', '/api/mod/nothing-here');
      for (const [who, method, url] of [
        [p, 'GET', '/api/mod/queue'],
        [null, 'GET', '/api/mod/queue'],
        [p, 'POST', '/api/mod/reports/0190a000-0000-7000-8000-000000000000/resolve'],
        [null, 'POST', '/api/mod/sanctions/0190a000-0000-7000-8000-000000000000/lift'],
      ] as const) {
        const res = await call(
          who,
          method,
          url,
          method === 'POST' ? { action: 'dismiss' } : undefined,
        );
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe(unknown.json().error.code);
        expect(res.json().error.message).toBe(`Route ${method} ${url} not found`);
      }
    });

    it('groups open reports by target with context, and closes the case at once', async () => {
      const subject = await player();
      const [r1, r2] = [await player(), await player()];
      await report(r1, { kind: 'player', handle: subject.handle }, 'spam', 'first');
      await report(r2, { kind: 'player', handle: subject.handle }, 'hate');
      const c = (await caseFor(mod, subject.handle))!;
      expect(c.reports.map((r) => r.reason)).toEqual(['spam', 'hate']);
      expect(c.reports[0]!.reporter.handle).toBe(r1.handle);
      expect(c.subject).toMatchObject({
        displayName: subject.displayName,
        role: 'player',
        sanctions: [],
      });
      expect(JSON.stringify(c)).not.toContain(subject.id);

      const res = await act(mod, c.reportId, { action: 'dismiss', note: 'banter' });
      expect(res.json()).toEqual({ closedReports: 2, sanction: null });
      expect(await caseFor(mod, subject.handle)).toBeUndefined();
      const second = await act(admin, c.reportId, { action: 'dismiss' });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('report_closed');
      // The reporter may report again after a dismissal (a new case).
      expect((await report(r1, { kind: 'player', handle: subject.handle })).statusCode).toBe(201);
      const [audit] = await audits('report.resolve', mod.id);
      expect(audit!.data).toMatchObject({
        action: 'dismiss',
        subjectId: subject.id,
        note: 'banter',
      });
    });

    it('hides reports a viewer may not act on (self, peers, higher roles)', async () => {
      const otherMod = await insertAccount(database.db, { role: 'moderator', now: now() });
      const r = await player();
      await report(r, { kind: 'player', handle: otherMod.handle });
      await report(r, { kind: 'player', handle: mod.handle });
      await report(r, { kind: 'player', handle: admin.handle });
      expect(await caseFor(mod, otherMod.handle)).toBeUndefined();
      expect(await caseFor(mod, mod.handle)).toBeUndefined();
      expect(await caseFor(mod, admin.handle)).toBeUndefined();
      expect(await caseFor(admin, otherMod.handle)).toBeDefined();
      expect(await caseFor(admin, admin.handle)).toBeUndefined();
    });

    it('pages with a cursor', async () => {
      const firstPage = await call(admin, 'GET', '/api/mod/queue?limit=1');
      const body = firstPage.json();
      expect(body.cases).toHaveLength(1);
      expect(body.openCases).toBeGreaterThan(1);
      const next = await call(admin, 'GET', `/api/mod/queue?limit=1&cursor=${body.nextCursor}`);
      expect(next.json().cases[0].reportId > body.cases[0].reportId).toBe(true);
    });
  });

  describe('sanctions', () => {
    it('mute: visible to the player, blocks social writes but not reports', async () => {
      const subject = await player();
      const c = await reportedCase(subject);
      const res = await act(mod, c.reportId, {
        action: 'mute',
        reason: 'Spamming trade offers',
        durationHours: 24,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sanction).toMatchObject({ kind: 'mute', reason: 'Spamming trade offers' });
      expect(res.json().sanction.expiresAt).toBe(new Date(nowMs + 24 * HOUR).toISOString());

      const standing = (await call(subject, 'GET', '/api/account/standing')).json();
      expect(standing.sanctions).toEqual([res.json().sanction]);
      const chat = await call(subject, 'POST', '/api/test/chat');
      expect(chat.statusCode).toBe(403);
      expect(chat.json().error).toMatchObject({
        code: 'muted',
        details: { sanction: res.json().sanction },
      });
      expect((await report(subject, { kind: 'player', handle: mod.handle })).statusCode).toBe(201);
      // Game routes keep working.
      expect((await call(subject, 'GET', '/api/characters')).statusCode).toBe(200);
      // A second mute while one is active: lift first.
      const again = await reportedCase(subject);
      expect(
        (
          await act(mod, again.reportId, { action: 'mute', reason: 'Again', durationHours: 1 })
        ).json().error.code,
      ).toBe('already_sanctioned');
      const [issue] = await audits('sanction.issue', subject.id);
      expect(issue!.data).toMatchObject({
        kind: 'mute',
        issuedBy: mod.id,
        reason: 'Spamming trade offers',
      });

      // It expires on its own.
      nowMs += 25 * HOUR;
      expect((await call(subject, 'POST', '/api/test/chat')).statusCode).toBe(200);
      expect((await call(subject, 'GET', '/api/account/standing')).json().sanctions).toEqual([]);
    });

    it('suspend: stops the live session at once and refuses login, then expires', async () => {
      const email = `suspend-${Date.now()}@graumark.test`;
      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email,
          displayName: `Suspect ${String.fromCharCode(97 + (nowMs % 26))}x`,
          password: 'ashes-and-iron-42',
        },
      });
      expect(reg.statusCode).toBe(201);
      const handle = reg.json().account.handle;
      const token = reg.cookies.find((c) => c.name === 'wf_session')!.value;
      const subject = { id: reg.json().account.id, handle, token } as TestAccount;
      const c = await reportedCase(subject);
      const res = await act(admin, c.reportId, {
        action: 'suspend',
        reason: 'Botting',
        durationHours: 48,
      });
      expect(res.statusCode).toBe(200);

      for (const [method, url] of [
        ['GET', '/api/account'],
        ['GET', '/api/characters'],
        ['POST', '/api/test/chat'],
      ] as const) {
        const r = await call(subject, method, url);
        expect(r.statusCode).toBe(403);
        expect(r.json().error).toMatchObject({
          code: 'account_suspended',
          details: { sanction: { kind: 'suspend', reason: 'Botting' } },
        });
      }
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: 'ashes-and-iron-42' },
      });
      expect(login.statusCode).toBe(403);
      expect(login.json().error.code).toBe('account_suspended');
      expect(login.cookies.find((ck) => ck.name === 'wf_session')).toBeUndefined();
      // A wrong password still answers like any wrong password (no hint that the account is suspended).
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: 'wrong-password-1' },
      });
      expect(wrong.statusCode).toBe(401);
      expect(await audits('auth.login_refused', subject.id)).toHaveLength(1);

      nowMs += 49 * HOUR;
      expect((await call(subject, 'GET', '/api/account')).statusCode).toBe(200);
    });

    it('force rename: placeholder at once, the player chooses a new name, audited', async () => {
      const subject = await player();
      const old = subject.displayName;
      const c = await reportedCase(subject, 'profileField');
      const res = await act(mod, c.reportId, {
        action: 'forceRename',
        reason: 'Offensive name',
        durationHours: 7 * 24,
      });
      expect(res.statusCode).toBe(200);
      const account = (await call(subject, 'GET', '/api/account')).json().account;
      expect(account.displayName).toMatch(/^Wanderer \d{6}$/);
      const standing = (await call(subject, 'GET', '/api/account/standing')).json();
      expect(standing.renameRequired).toBe(true);

      const rename = (displayName: string) =>
        call(subject, 'POST', '/api/account/display-name', { displayName });
      expect((await rename(old)).statusCode).toBe(400);
      expect((await rename('Admin Prime')).json().error.details.fields.displayName).toMatch(
        /reserved/,
      );
      expect((await rename(mod.displayName)).json().error.code).toBe('display_name_taken');
      const ok = await rename('  Ｑuiet  Ember ');
      expect(ok.json()).toEqual({ displayName: 'Quiet Ember' });
      expect((await call(subject, 'GET', '/api/account/standing')).json().renameRequired).toBe(
        false,
      );
      expect((await rename('Another Name')).json().error.code).toBe('rename_not_required');
      const [audit] = await audits('account.rename', subject.id);
      expect(audit!.data).toMatchObject({ from: account.displayName, to: 'Quiet Ember' });
    });

    it('lifting a forced rename gives the old name back', async () => {
      const subject = await player();
      const c = await reportedCase(subject, 'profileField');
      const s = (
        await act(mod, c.reportId, { action: 'forceRename', reason: 'Name', durationHours: 24 })
      ).json().sanction;
      const lift = await call(mod, 'POST', `/api/mod/sanctions/${s.id}/lift`, {
        reason: 'Mistake, sorry',
      });
      expect(lift.statusCode).toBe(200);
      const [row] = await database.db.select().from(accounts).where(eq(accounts.id, subject.id));
      expect(row!.displayName).toBe(subject.displayName);
      expect(
        (await call(mod, 'POST', `/api/mod/sanctions/${s.id}/lift`, { reason: 'twice' })).json()
          .error.code,
      ).toBe('sanction_inactive');
      const [audit] = await audits('sanction.lift', subject.id);
      expect(audit!.data).toMatchObject({
        kind: 'rename',
        liftedBy: mod.id,
        restoredName: subject.displayName,
      });
    });

    it('hide content: only content kinds; hides the name from lookups until it expires', async () => {
      const subject = await player();
      const asPlayer = await reportedCase(subject);
      const refused = await act(mod, asPlayer.reportId, {
        action: 'hideContent',
        reason: 'x'.repeat(5),
        durationHours: 24,
      });
      expect(refused.json().error.code).toBe('not_hideable');
      const c = await reportedCase(subject, 'profileField');
      const res = await act(mod, c.reportId, {
        action: 'hideContent',
        reason: 'Slur in name',
        durationHours: 24,
      });
      expect(res.json().sanction).toMatchObject({
        kind: 'hide',
        target: { kind: 'profileField', handle: subject.handle, field: 'displayName' },
      });
      const lookup = () =>
        call(mod, 'GET', `/api/players/lookup?name=${encodeURIComponent(subject.displayName)}`);
      expect((await lookup()).statusCode).toBe(404);
      const standing = (await call(subject, 'GET', '/api/account/standing')).json();
      expect(standing.sanctions.map((s: { kind: string }) => s.kind)).toEqual(['hide']);
      nowMs += 25 * HOUR;
      expect((await lookup()).statusCode).toBe(200);
    });

    it('validates reasons and durations', async () => {
      const subject = await player();
      const c = await reportedCase(subject);
      expect(
        (await act(mod, c.reportId, { action: 'mute', reason: 'x', durationHours: 2 })).statusCode,
      ).toBe(400);
      expect(
        (await act(mod, c.reportId, { action: 'forceRename', reason: 'Bad', durationHours: 2 }))
          .statusCode,
      ).toBe(400);
      expect(
        (await act(mod, c.reportId, { action: 'mute', reason: 'Bad', durationHours: 0 }))
          .statusCode,
      ).toBe(400);
      expect(
        (await act(mod, c.reportId, { action: 'ban', reason: 'Bad', durationHours: 2 })).statusCode,
      ).toBe(400);
      expect((await act(mod, c.reportId, { action: 'mute', reason: 'Bad' })).statusCode).toBe(400);
      const [row] = await database.db.select().from(reports).where(eq(reports.id, c.reportId));
      expect(row!.status).toBe('open');
      expect(
        await database.db.select().from(sanctions).where(eq(sanctions.subjectId, subject.id)),
      ).toEqual([]);
    });
  });

  describe('roles', () => {
    it('no API path sets a role', async () => {
      const p = await player();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/auth/register',
            payload: {
              email: 'role@graumark.test',
              displayName: 'Role Seeker',
              password: 'ashes-and-iron-42',
              role: 'admin',
            },
          })
        ).statusCode,
      ).toBe(400);
      expect((await call(p, 'POST', '/api/account/guide', { role: 'admin' })).statusCode).toBe(400);
      expect(
        (await call(p, 'POST', '/api/account/display-name', { displayName: 'Xyz', role: 'admin' }))
          .statusCode,
      ).toBe(400);
      const [row] = await database.db.select().from(accounts).where(eq(accounts.id, p.id));
      expect(row!.role).toBe('player');
    });

    it('setAccountRole (the CLI) grants and revokes by email or handle, audited', async () => {
      const p = await player();
      const [row] = await database.db.select().from(accounts).where(eq(accounts.id, p.id));
      expect(
        await setAccountRole(database.db, row!.email.toUpperCase(), 'moderator'),
      ).toMatchObject({
        from: 'player',
        to: 'moderator',
        changed: true,
      });
      expect((await call(p, 'GET', '/api/mod/queue')).statusCode).toBe(200);
      expect(await setAccountRole(database.db, p.handle, 'moderator')).toMatchObject({
        changed: false,
      });
      expect(await setAccountRole(database.db, p.handle, 'player')).toMatchObject({
        to: 'player',
        changed: true,
      });
      expect((await call(p, 'GET', '/api/mod/queue')).statusCode).toBe(404);
      expect(await setAccountRole(database.db, 'nobody@nowhere.test', 'admin')).toBeNull();
      expect((await audits('role.grant', p.id))[0]!.data).toEqual({
        from: 'player',
        to: 'moderator',
        via: 'cli',
      });
      expect(await audits('role.revoke', p.id)).toHaveLength(1);
    });
  });
});
