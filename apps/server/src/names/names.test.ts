/**
 * Ticket 6.9: look-alike and reserved names through the API (docs/SOCIAL.md "Look-alike and
 * reserved names"): display names at registration and the forced rename, hero names, guild names
 * at founding and the forced rename; the admins' reserved-names store (panel API and CLI
 * functions); grandfathered names; the skeleton backfill.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { GUILD_CREATE_COST, nameSkeleton } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { accounts, auditLog, characters, dataBackfills, guilds, sanctions } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { insertCharacter } from '../test/heroes.js';
import { addReservedName, listReservedNames, removeReservedName } from '../admin/reserved-names.js';
import { NAME_SKELETON_BACKFILL_ID, backfillNameSkeletons } from './checks.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let seq = 0;
const GENEROUS = { max: 10_000, timeWindowMs: 60_000 };

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { registerRateLimit: GENEROUS, loginRateLimit: GENEROUS },
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await database.close();
});

const db = () => database.db;
const register = (displayName: string) => {
  seq += 1;
  return app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: `names-${seq}@graumark.test`, displayName, password: 'ashes-and-iron-42' },
  });
};
const as = (who: TestAccount, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    headers: method === 'GET' ? {} : { 'idempotency-key': randomUUID() },
    cookies: { [SESSION_COOKIE]: who.token },
  });
const errorOf = (res: { json: () => unknown }) =>
  (res.json() as { error: { code: string; message: string } }).error;

describe('display names', () => {
  it('refuses look-alikes of another player’s name; other case stays the unique index’s answer', async () => {
    expect((await register('Rowena')).statusCode).toBe(201);
    for (const look of ['Rоwena' /* Cyrillic о */, 'R0wena', 'Rowenа', 'Rowe na', 'RΟwena']) {
      const res = await register(look);
      expect(res.statusCode, look).toBe(409);
      expect(errorOf(res).code).toBe('name_too_similar');
    }
    const upper = await register('ROWENA');
    expect(upper.statusCode).toBe(409);
    expect(errorOf(upper).code).toBe('display_name_taken');
    expect((await register('Rowenna')).statusCode).toBe(201);
    const [row] = await db()
      .select({ s: accounts.displayNameSkeleton })
      .from(accounts)
      .where(eq(accounts.displayName, 'Rowenna'));
    expect(row!.s).toBe(nameSkeleton('Rowenna'));
  });

  it('refuses the built-in reserved names in any disguise', async () => {
    for (const name of [
      'Admín',
      'Adm1n',
      'ADMlN',
      'The Gravewarden',
      'Ashen Wаrden',
      'Forge Tyrant',
      'Captain Ysolde',
    ]) {
      const res = await register(name);
      expect(res.statusCode, name).toBe(400);
      expect(res.json().error.details.fields.displayName).toBe(
        'That name is reserved. Choose another.',
      );
    }
    expect((await register('Maud Brightwater')).statusCode).toBe(201);
  });

  it('a forced rename may not pick a look-alike of the removed name', async () => {
    const who = await insertAccount(db(), { name: 'Placeholder One' });
    await db()
      .insert(sanctions)
      .values({
        id: uuidv7(),
        subjectId: who.id,
        kind: 'rename',
        reason: 'Offensive name.',
        data: { previousName: 'Grimbold', placeholder: 'Placeholder One' },
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    const res = await as(who, 'POST', '/api/account/display-name', { displayName: 'Grlmbold' });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).message).toBe('Choose a different name from the one that was changed.');
    expect(
      (await as(who, 'POST', '/api/account/display-name', { displayName: 'Hallvard' })).statusCode,
    ).toBe(200);
  });
});

describe('hero names', () => {
  it('refuses look-alikes of another hero’s name and reserved names', async () => {
    const a = await insertAccount(db());
    const b = await insertAccount(db());
    const create = (who: TestAccount, name: string) =>
      as(who, 'POST', '/api/characters', {
        name,
        classId: 'warrior',
        appearance: { banner: 'ash' },
      });
    expect((await create(a, 'Wulfgar')).statusCode).toBe(201);
    const look = await create(b, 'WuIfgar');
    expect([look.statusCode, errorOf(look).code]).toEqual([409, 'name_too_similar']);
    const l = await create(b, 'Wuifgar');
    expect([l.statusCode, errorOf(l).code]).toEqual([409, 'name_too_similar']);
    const same = await create(b, 'WULFGAR');
    expect([same.statusCode, errorOf(same).code]).toEqual([409, 'character_name_taken']);
    const boss = await create(b, 'Gravewarden');
    expect(boss.statusCode).toBe(400);
    expect((await create(b, 'Wulfric')).statusCode).toBe(201);
  });
});

describe('guild names', () => {
  it('refuses look-alikes at founding and of the removed name after a forced rename', async () => {
    const leader = async () => {
      const acc = await insertAccount(db());
      const h = await insertCharacter(db(), acc.id);
      await db()
        .update(characters)
        .set({ gold: GUILD_CREATE_COST + 500 })
        .where(eq(characters.id, h.id));
      return { acc, h };
    };
    const found = (who: { acc: TestAccount; h: { id: string } }, name: string, tag: string) =>
      as(who.acc, 'POST', '/api/guilds', { characterId: who.h.id, name, tag, emblem: 'crow' });
    const first = await leader();
    expect((await found(first, 'Iron Covenant', 'IRC')).statusCode).toBe(201);
    const second = await leader();
    const look = await found(second, 'lron Covenant', 'IRK');
    expect(look.statusCode).toBe(409);
    expect(errorOf(look).code).toBe('name_too_similar');
    const reserved = await found(second, 'The Forge Tyrant', 'TFT');
    expect(reserved.statusCode).toBe(400);
    expect((await found(second, 'Iron Wolves', 'IRW')).statusCode).toBe(201);

    // A moderator's forced rename (the name became a placeholder): the leader may not bring the
    // old name back in disguise.
    const [g] = await db().select().from(guilds).where(eq(guilds.name, 'Iron Covenant'));
    await db()
      .update(guilds)
      .set({ name: 'Nameless Company 123456', renameRequired: true, renamedFrom: 'Iron Covenant' })
      .where(eq(guilds.id, g!.id));
    const back = await as(first.acc, 'POST', '/api/guild/rename', {
      name: 'Iron Covenаnt',
      tag: 'IRC',
    });
    expect(back.statusCode).toBe(400);
    expect(errorOf(back).message).toBe('Choose a different name from the one that was changed.');
    expect(
      (await as(first.acc, 'POST', '/api/guild/rename', { name: 'Ember Covenant', tag: 'EMC' }))
        .statusCode,
    ).toBe(200);
  });
});

describe('the reserved-names store', () => {
  it('is admin-only (404 for everyone else), audited, and refuses new names that imitate an entry', async () => {
    const admin = await insertAccount(db(), { role: 'admin' });
    const mod = await insertAccount(db(), { role: 'moderator' });
    const player = await insertAccount(db());
    for (const who of [mod, player]) {
      expect((await as(who, 'GET', '/api/admin/reserved-names')).statusCode).toBe(404);
      expect(
        (await as(who, 'POST', '/api/admin/reserved-names', { name: 'Kestrel', reason: 'staff' }))
          .statusCode,
      ).toBe(404);
    }
    const list = await as(admin, 'GET', '/api/admin/reserved-names');
    expect(list.statusCode).toBe(200);
    const names = list.json<{ names: { name: string; group: string; id: string | null }[] }>()
      .names;
    expect(names.filter((n) => n.group === 'boss').map((n) => n.name)).toContain('Gravewarden');
    expect(names.every((n) => n.group === 'custom' || n.id === null)).toBe(true);

    const added = await as(admin, 'POST', '/api/admin/reserved-names', {
      name: 'Kestrel',
      note: 'a staff member',
      reason: 'staff name',
    });
    expect(added.statusCode).toBe(201);
    const entry = added
      .json<{ names: { id: string | null; name: string; group: string }[] }>()
      .names.find((n) => n.name === 'Kestrel')!;
    expect(entry.group).toBe('custom');
    // The same look again, and a built-in name: refused.
    const again = await as(admin, 'POST', '/api/admin/reserved-names', {
      name: 'KestreI',
      reason: 'x again',
    });
    expect([again.statusCode, errorOf(again).code]).toEqual([409, 'already_reserved']);
    const builtIn = await as(admin, 'POST', '/api/admin/reserved-names', {
      name: 'Gravewarden',
      reason: 'boss',
    });
    expect([builtIn.statusCode, errorOf(builtIn).code]).toEqual([409, 'already_reserved']);

    for (const name of ['Kestrel', 'KestreI', 'Kestrel the Bold']) {
      expect((await register(name)).statusCode, name).toBe(400);
    }
    const audit = await db()
      .select({ event: auditLog.event, data: auditLog.data })
      .from(auditLog)
      .where(and(eq(auditLog.event, 'admin.reserved_name.add'), eq(auditLog.accountId, admin.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.data).toMatchObject({
      by: admin.id,
      reason: 'staff name',
      after: { name: 'Kestrel' },
    });

    const removed = await as(admin, 'DELETE', `/api/admin/reserved-names/${entry.id}`, {
      reason: 'left the team',
    });
    expect(removed.statusCode).toBe(200);
    expect((await register('Kestrel')).statusCode).toBe(201);
  });

  it('grandfathers names taken before: they keep them, and new names may not imitate them', async () => {
    // Taken before 6.9 (no skeleton stored), then the backfill runs.
    const old = await insertAccount(db(), { name: 'Corvinus' });
    const oldHero = await insertCharacter(db(), old.id, { name: 'Halbrand' });
    await db().delete(dataBackfills).where(eq(dataBackfills.id, NAME_SKELETON_BACKFILL_ID));
    const first = await backfillNameSkeletons(db());
    expect(first.ran).toBe(true);
    expect(first.updated).toBeGreaterThan(0);
    expect((await backfillNameSkeletons(db())).ran).toBe(false);
    const [h] = await db().select().from(characters).where(eq(characters.id, oldHero.id));
    expect(h!.nameSkeleton).toBe(nameSkeleton('Halbrand'));

    // The owner reserves the name (the CLI's function): the player keeps it and plays on.
    await addReservedName(db(), { name: 'Corvinus', by: null, now: new Date() });
    const me = await as(old, 'GET', '/api/account');
    expect(me.statusCode).toBe(200);
    expect(me.json<{ account: { displayName: string } }>().account.displayName).toBe('Corvinus');
    // Nobody new may take it or a look-alike.
    expect((await register('C0rvinus')).statusCode).toBe(400);
    expect((await removeReservedName(db(), { name: 'CorvinuS' }))?.name).toBe('Corvinus');
    // Still not a look-alike of the grandfathered player's name.
    const look = await register('Corvlnus');
    expect([look.statusCode, errorOf(look).code]).toEqual([409, 'name_too_similar']);
    expect((await listReservedNames(db())).some((n) => n.name === 'Corvinus')).toBe(false);
  });
});
