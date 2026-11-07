/**
 * Admin panel API (ticket D.3): the permission matrix (anonymous / player / moderator / admin ×
 * every admin route), invites through the API (create, list, revoke, the code shown once, the
 * redemption list), the read-only sections and the audit trail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, like } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { auditLog, reports, sanctions } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { setAccountRole } from '../social/roles.js';
import { createTestDatabase } from '../test/db.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';

type Who = 'anonymous' | 'player' | 'moderator' | 'admin';
const WHO: Who[] = ['anonymous', 'player', 'moderator', 'admin'];

/** Every admin route, with a body an admin would send. */
const ROUTES: { method: 'GET' | 'POST'; url: string; payload?: object; ok: number }[] = [
  { method: 'GET', url: '/api/admin/invites', ok: 200 },
  {
    method: 'POST',
    url: '/api/admin/invites',
    payload: { maxUses: 1, expiresInHours: 24 },
    ok: 201,
  },
  { method: 'POST', url: '/api/admin/invites/:invite/revoke', payload: {}, ok: 200 },
  { method: 'GET', url: '/api/admin/telemetry', ok: 200 },
  { method: 'GET', url: '/api/admin/telemetry?reconcile=true', ok: 200 },
  { method: 'POST', url: '/api/admin/players/search', payload: { query: 'Tester' }, ok: 200 },
  { method: 'GET', url: '/api/admin/players/:handle', ok: 200 },
  { method: 'GET', url: '/api/admin/status', ok: 200 },
  { method: 'GET', url: '/api/admin/roles', ok: 200 },
];

describe('admin panel API', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;
  const who = {} as Record<Exclude<Who, 'anonymous'>, TestAccount>;
  const actor = (w: Who) => (w === 'anonymous' ? null : who[w]);

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: { registrationMode: 'invite' },
      admin: {
        build: { gitSha: 'abc1234', buildTime: '2026-11-06T10:00:00Z' },
        reconcileLimit: { max: 100, windowMs: 60_000 },
      },
    });
    await app.ready();
    call = caller(app);
    who.player = await insertAccount(database.db, { name: 'Plain Pell' });
    who.moderator = await insertAccount(database.db, { role: 'moderator', name: 'Warden Brann' });
    who.admin = await insertAccount(database.db, { role: 'admin', name: 'Castellan Ysolde' });
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const resolveUrl = async (url: string) => {
    if (url.includes(':invite')) {
      const res = await call(who.admin, 'POST', '/api/admin/invites', {
        maxUses: 1,
        expiresInHours: 1,
      });
      return url.replace(':invite', res.json().invite.id);
    }
    return url.replace(':handle', who.player.handle);
  };

  describe('permission matrix', () => {
    for (const route of ROUTES) {
      for (const w of WHO) {
        const expected = w === 'admin' ? route.ok : 404;
        it(`${w} × ${route.method} ${route.url} → ${expected}`, async () => {
          const url = await resolveUrl(route.url);
          const res = await call(actor(w), route.method, url, route.payload);
          expect(res.statusCode).toBe(expected);
          if (expected === 404) {
            // Exactly the not-found handler's body: indistinguishable from a missing route.
            const missing = await call(actor(w), route.method, url.replace('/admin/', '/nope/'));
            expect(res.json().error.code).toBe('not_found');
            expect(res.json().error.message).toBe(
              missing.json().error.message.replace('/nope/', '/admin/'),
            );
          }
        });
      }
    }

    it('answers 404 before body validation for non-admins', async () => {
      for (const w of ['anonymous', 'player', 'moderator'] as const) {
        const res = await call(actor(w), 'POST', '/api/admin/invites', { maxUses: 'lots', x: 1 });
        expect(res.statusCode).toBe(404);
      }
      const bad = await call(who.admin, 'POST', '/api/admin/invites', { maxUses: 'lots' });
      expect(bad.statusCode).toBe(400);
    });

    it('has no route that changes a role', async () => {
      for (const url of ['/api/admin/roles', '/api/admin/roles/grant', '/api/admin/role']) {
        const res = await call(who.admin, 'POST', url, {
          handle: who.player.handle,
          role: 'admin',
        });
        expect(res.statusCode).toBe(404);
      }
      expect((await call(who.admin, 'GET', '/api/account')).json().account.role).toBe('admin');
    });

    it('stops a demoted admin at once', async () => {
      const temp = await insertAccount(database.db, { role: 'admin' });
      expect((await call(temp, 'GET', '/api/admin/status')).statusCode).toBe(200);
      await setAccountRole(database.db, temp.handle, 'player');
      expect((await call(temp, 'GET', '/api/admin/status')).statusCode).toBe(404);
      expect(
        (await call(temp, 'POST', '/api/admin/invites', { maxUses: 1, expiresInHours: 1 }))
          .statusCode,
      ).toBe(404);
    });
  });

  describe('invites', () => {
    it('creates an invite, shows its code once, and lists who redeemed it', async () => {
      const created = await call(who.admin, 'POST', '/api/admin/invites', {
        maxUses: 2,
        expiresInHours: 48,
        note: 'guild friends',
      });
      expect(created.statusCode).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');
      const { code, invite } = created.json();
      expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
      expect(invite).toMatchObject({
        status: 'active',
        uses: 0,
        maxUses: 2,
        note: 'guild friends',
        createdBy: { handle: who.admin.handle, displayName: 'Castellan Ysolde' },
        redeemedBy: [],
      });

      // Redeem it twice through the real registration.
      for (const [i, name] of ['Iron Ada', 'Ash Bero'].entries()) {
        const reg = await app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: {
            email: `redeemer-${i}@graumark.test`,
            displayName: name,
            password: 'ashes-and-iron-42',
            inviteCode: code.toLowerCase(),
          },
        });
        expect(reg.statusCode).toBe(201);
      }

      const list = await call(who.admin, 'GET', '/api/admin/invites');
      expect(list.statusCode).toBe(200);
      const body = list.body;
      // The code never comes back: not in the list, not in the audit log.
      expect(body).not.toContain(code);
      expect(body).not.toContain(code.replace(/-/g, ''));
      const row = list.json().invites.find((x: { id: string }) => x.id === invite.id);
      expect(row).toMatchObject({ status: 'used_up', uses: 2 });
      expect(row.redeemedBy.map((r: { displayName: string }) => r.displayName)).toEqual([
        'Iron Ada',
        'Ash Bero',
      ]);
      expect(row.redeemedBy[0].handle).toMatch(/^[0-9a-z]{12}$/);
      expect(body).not.toMatch(/@graumark\.test/);

      const audit = await database.db.select().from(auditLog).where(like(auditLog.event, '%'));
      const dump = JSON.stringify(audit);
      expect(dump).not.toContain(code);
      expect(dump).not.toContain(code.replace(/-/g, ''));
      const create = audit.find(
        (a) => a.event === 'invite.create' && a.data.inviteId === invite.id,
      );
      expect(create).toMatchObject({ accountId: who.admin.id, data: { via: 'admin' } });
    });

    it('creates a never-expiring invite and rejects bad input', async () => {
      const res = await call(who.admin, 'POST', '/api/admin/invites', {
        maxUses: 1,
        expiresInHours: null,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().invite.expiresAt).toBeNull();
      for (const payload of [
        { maxUses: 0, expiresInHours: 1 },
        { maxUses: 1, expiresInHours: 0 },
        { maxUses: 1, expiresInHours: 1, note: 'x'.repeat(201) },
        { maxUses: 1 },
        { maxUses: 1, expiresInHours: 1, code: 'AAAA-BBBB-CCCC-DDDD' },
      ]) {
        expect((await call(who.admin, 'POST', '/api/admin/invites', payload)).statusCode).toBe(400);
      }
    });

    it('revokes by id, audited, idempotent; the code no longer registers', async () => {
      const { code, invite } = (
        await call(who.admin, 'POST', '/api/admin/invites', { maxUses: 5, expiresInHours: 24 })
      ).json();
      const first = await call(who.admin, 'POST', `/api/admin/invites/${invite.id}/revoke`, {});
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ changed: true, invite: { status: 'revoked' } });
      const again = await call(who.admin, 'POST', `/api/admin/invites/${invite.id}/revoke`);
      expect(again.json().changed).toBe(false);
      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'late@graumark.test',
          displayName: 'Late Lorn',
          password: 'ashes-and-iron-42',
          inviteCode: code,
        },
      });
      expect(reg.statusCode).not.toBe(201);
      const [row] = await database.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.event, 'invite.revoke'))
        .orderBy(auditLog.createdAt);
      expect(row).toMatchObject({ accountId: who.admin.id, data: { via: 'admin' } });
      expect(
        (await call(who.admin, 'POST', `/api/admin/invites/${uuidv7()}/revoke`)).statusCode,
      ).toBe(404);
    });

    it('pages the list with a cursor', async () => {
      const first = (await call(who.admin, 'GET', '/api/admin/invites?limit=2')).json();
      expect(first.invites).toHaveLength(2);
      expect(first.nextCursor).toBe(first.invites[1].id);
      const second = (
        await call(who.admin, 'GET', `/api/admin/invites?limit=2&cursor=${first.nextCursor}`)
      ).json();
      expect(second.invites[0].id).not.toBe(first.invites[0].id);
      expect(second.invites[0].createdAt <= first.invites[1].createdAt).toBe(true);
    });
  });

  describe('players', () => {
    it('finds players by name or handle and shows their file without email', async () => {
      const subject = await insertAccount(database.db, { name: 'Grim Tobold' });
      const now = new Date();
      const [sanction] = await database.db
        .insert(sanctions)
        .values({
          id: uuidv7(),
          subjectId: subject.id,
          kind: 'mute',
          reason: 'Spam in chat',
          issuedBy: who.moderator.id,
          createdAt: new Date(now.getTime() - 1000),
          expiresAt: new Date(now.getTime() + 86_400_000),
        })
        .returning();
      await database.db.insert(reports).values({
        id: uuidv7(),
        reporterId: who.player.id,
        subjectId: subject.id,
        targetKind: 'player',
        targetKey: `player:${subject.id}`,
        target: { kind: 'player', handle: subject.handle },
        reason: 'spam',
        note: 'keeps spamming',
      });

      const byName = await call(who.admin, 'POST', '/api/admin/players/search', {
        query: 'tobo',
      });
      expect(byName.json().players).toEqual([
        expect.objectContaining({ handle: subject.handle, displayName: 'Grim Tobold' }),
      ]);
      const byHandle = await call(who.admin, 'POST', '/api/admin/players/search', {
        query: subject.handle.toUpperCase(),
      });
      expect(byHandle.json().players[0].handle).toBe(subject.handle);
      // Wildcards are literal.
      const wild = await call(who.admin, 'POST', '/api/admin/players/search', { query: '%' });
      expect(wild.json().players).toEqual([]);

      const res = await call(who.admin, 'GET', `/api/admin/players/${subject.handle}`);
      expect(res.statusCode).toBe(200);
      const { player } = res.json();
      expect(player).toMatchObject({
        handle: subject.handle,
        displayName: 'Grim Tobold',
        role: 'player',
        actionable: true,
        characters: [],
        registration: null,
      });
      expect(player.sanctions).toEqual([
        expect.objectContaining({
          id: sanction!.id,
          kind: 'mute',
          status: 'active',
          issuedBy: { handle: who.moderator.handle, displayName: 'Warden Brann' },
        }),
      ]);
      expect(player.reports).toEqual([
        expect.objectContaining({
          status: 'open',
          reason: 'spam',
          reporter: { handle: who.player.handle, displayName: 'Plain Pell' },
        }),
      ]);
      expect(res.body).not.toMatch(/@graumark\.test|email/i);
      expect(player).not.toHaveProperty('id');

      const admin = await call(who.admin, 'GET', `/api/admin/players/${who.admin.handle}`);
      expect(admin.json().player.actionable).toBe(false);
      expect((await call(who.admin, 'GET', `/api/admin/players/zzzzzzzzzzzz`)).statusCode).toBe(
        404,
      );
      expect((await call(who.admin, 'GET', `/api/admin/players/nope`)).statusCode).toBe(400);
    });

    it('shows which invite an account registered with', async () => {
      const { code, invite } = (
        await call(who.admin, 'POST', '/api/admin/invites', {
          maxUses: 1,
          expiresInHours: 24,
          note: 'for Wenna',
        })
      ).json();
      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'wenna@graumark.test',
          displayName: 'Wenna Vale',
          password: 'ashes-and-iron-42',
          inviteCode: code,
        },
      });
      const handle = reg.json().account.handle;
      const { player } = (await call(who.admin, 'GET', `/api/admin/players/${handle}`)).json();
      expect(player.registration.invite).toEqual({ id: invite.id, note: 'for Wenna' });
    });

    it('does not put the search text in the audit log', async () => {
      await call(who.admin, 'POST', '/api/admin/players/search', { query: 'Secretname' });
      const rows = await database.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.event, 'admin.player.search'));
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain('Secretname');
      expect(rows.every((r) => r.accountId === who.admin.id)).toBe(true);
    });
  });

  describe('status, roles, telemetry', () => {
    it('reports build, db, mode, counts and migrations', async () => {
      const res = await call(who.admin, 'GET', '/api/admin/status');
      const body = res.json();
      expect(body).toMatchObject({
        build: { gitSha: 'abc1234', buildTime: '2026-11-06T10:00:00Z' },
        db: { status: 'up' },
        registrationMode: 'invite',
        migrations: { pending: [] },
      });
      expect(body.migrations.applied).toBe(body.migrations.available);
      expect(body.counts.accounts).toBeGreaterThanOrEqual(3);
      // The admin's own requests count as presence.
      expect(body.counts.active24h).toBeGreaterThanOrEqual(1);
      expect(body.counts.active7d).toBeGreaterThanOrEqual(body.counts.active24h);
      expect(res.body).not.toMatch(/lastSeen/i);
    });

    it('lists moderators and admins read-only', async () => {
      const { staff } = (await call(who.admin, 'GET', '/api/admin/roles')).json();
      const roles = Object.fromEntries(
        staff.map((s: { handle: string; role: string }) => [s.handle, s.role]),
      );
      expect(roles[who.admin.handle]).toBe('admin');
      expect(roles[who.moderator.handle]).toBe('moderator');
      expect(roles[who.player.handle]).toBeUndefined();
      expect(staff[0].role).toBe('admin');
    });

    it('serves the telemetry report, validates the window and limits reconcile', async () => {
      const res = await call(
        who.admin,
        'GET',
        '/api/admin/telemetry?from=2026-11-01&to=2026-11-06',
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().report.window).toMatchObject({ from: '2026-11-01', to: '2026-11-06' });
      expect(res.json().report.reconcile).toBeUndefined();
      const rec = await call(who.admin, 'GET', '/api/admin/telemetry?reconcile=true');
      expect(Array.isArray(rec.json().report.reconcile)).toBe(true);
      for (const q of ['from=2026-13-01', 'from=yesterday', 'from=2026-11-06&to=2026-11-01']) {
        expect((await call(who.admin, 'GET', `/api/admin/telemetry?${q}`)).statusCode).toBe(400);
      }

      const strict = buildApp({
        database,
        admin: { reconcileLimit: { max: 1, windowMs: 60_000 } },
      });
      await strict.ready();
      const first = await caller(strict)(who.admin, 'GET', '/api/admin/telemetry?reconcile=true');
      expect(first.statusCode).toBe(200);
      const second = await caller(strict)(who.admin, 'GET', '/api/admin/telemetry?reconcile=true');
      expect(second.statusCode).toBe(429);
      expect(second.json().error.details.limit).toBe('reconcile');
      await strict.close();
    });
  });
});
