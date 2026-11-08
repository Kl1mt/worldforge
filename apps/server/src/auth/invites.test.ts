import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp, type AppOptions } from '../app.js';
import { accounts, auditLog, inviteCodes } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { SESSION_COOKIE } from './index.js';
import {
  createInvite,
  inviteCodeHash,
  inviteStatus,
  listInvites,
  newInviteCode,
  normalizeInviteCode,
  parseInviteDuration,
  revokeInvite,
} from './invites.js';

const DAY = 24 * 60 * 60 * 1000;
let nowMs = Date.parse('2026-11-06T12:00:00Z');
const now = () => new Date(nowMs);

let database: DatabaseHandle;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await database.close();
});

async function makeApp(auth: NonNullable<AppOptions['auth']> = {}): Promise<FastifyInstance> {
  const a = buildApp({
    database,
    auth: { registerRateLimit: { max: 1000, timeWindowMs: 60_000 }, now, ...auth },
  });
  apps.push(a);
  await a.ready();
  return a;
}

let seq = 0;
function identity() {
  seq += 1;
  return {
    email: `invitee${seq}@graumark.test`,
    displayName: `Invitee ${seq}`,
    password: 'ashes-and-iron-42',
  };
}
const register = (a: FastifyInstance, payload: object) =>
  a.inject({ method: 'POST', url: '/api/auth/register', payload });

const invite = (maxUses = 1, ttlMs: number | null = 14 * DAY, note = '') =>
  createInvite(
    database.db,
    { maxUses, expiresAt: ttlMs === null ? null : new Date(nowMs + ttlMs), note, via: 'cli' },
    now(),
  );

describe('invite codes', () => {
  it('are random, formatted and normalised', () => {
    const codes = new Set(Array.from({ length: 200 }, newInviteCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    const code = [...codes][0]!;
    const canonical = code.replace(/-/g, '');
    expect(normalizeInviteCode(code)).toBe(canonical);
    expect(normalizeInviteCode(` ${code.toLowerCase()} `)).toBe(canonical);
    expect(normalizeInviteCode('ABCD-EFGH-JKMN-PQOI')).toBe('ABCDEFGHJKMNPQ01');
    expect(normalizeInviteCode('short')).toBeNull();
    expect(normalizeInviteCode('ABCD-EFGH-JKMN-PQRU')).toBeNull(); // U is not in the alphabet
  });

  it('parses durations', () => {
    expect(parseInviteDuration('14d')).toBe(14 * DAY);
    expect(parseInviteDuration('12h')).toBe(12 * 60 * 60 * 1000);
    expect(parseInviteDuration('30m')).toBe(30 * 60 * 1000);
    expect(parseInviteDuration('never')).toBeNull();
    expect(() => parseInviteDuration('0d')).toThrow();
    expect(() => parseInviteDuration('2w')).toThrow();
  });

  it('stores only the hash, and audits creation without the code', async () => {
    const { code, invite: row } = await invite(3, 14 * DAY, 'for the guild');
    expect(row.codeHash).toBe(inviteCodeHash(normalizeInviteCode(code)!));
    const raw = JSON.stringify(await database.db.select().from(inviteCodes));
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(code.replace(/-/g, ''));
    const [audit] = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'invite.create'))
      .orderBy(auditLog.id);
    expect(audit).toBeDefined();
    const logged = JSON.stringify(await database.db.select().from(auditLog));
    expect(logged).not.toContain(code.replace(/-/g, ''));
    expect((await listInvites(database.db)).some((i) => i.id === row.id)).toBe(true);
  });

  it('rejects bad create input', async () => {
    await expect(invite(0)).rejects.toThrow(/uses/);
    await expect(invite(1, -DAY)).rejects.toThrow(/future/);
  });
});

describe('REGISTRATION_MODE', () => {
  it('serves the mode publicly', async () => {
    for (const mode of ['open', 'invite', 'closed'] as const) {
      const a = await makeApp({ registrationMode: mode });
      const res = await a.inject({ method: 'GET', url: '/api/config' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ registration: { mode }, email: { enabled: false } });
    }
  });

  it('open: registers without a code and ignores one', async () => {
    const a = await makeApp({ registrationMode: 'open' });
    expect((await register(a, identity())).statusCode).toBe(201);
    expect((await register(a, { ...identity(), inviteCode: 'whatever' })).statusCode).toBe(201);
  });

  it('closed: refuses every registration, login and sessions keep working', async () => {
    const open = await makeApp({ registrationMode: 'open' });
    const who = identity();
    const created = await register(open, who);
    const token = created.cookies.find((c) => c.name === SESSION_COOKIE)!.value;

    const closed = await makeApp({ registrationMode: 'closed' });
    const { code } = await invite();
    for (const body of [identity(), { ...identity(), inviteCode: code }]) {
      const res = await register(closed, body);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('registration_closed');
    }
    const login = await closed.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: who.email, password: who.password },
    });
    expect(login.statusCode).toBe(200);
    const me = await closed.inject({
      method: 'GET',
      url: '/api/account',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(me.statusCode).toBe(200);
  });

  it('invite: asks for a code next to the other field errors', async () => {
    const a = await makeApp({ registrationMode: 'invite' });
    const res = await register(a, { ...identity(), displayName: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    expect(Object.keys(res.json().error.details.fields).sort()).toEqual([
      'displayName',
      'inviteCode',
    ]);
  });

  it('invite: refuses unknown, malformed, expired and revoked codes', async () => {
    const a = await makeApp({ registrationMode: 'invite' });
    const expired = await invite(1, DAY);
    const revoked = await invite();
    await revokeInvite(database.db, revoked.invite.id, now());
    nowMs += 2 * DAY;
    try {
      for (const inviteCode of [newInviteCode(), 'nonsense', expired.code, revoked.code]) {
        const res = await register(a, { ...identity(), inviteCode });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('invite_invalid');
        expect(res.json().error.details.fields.inviteCode).toBeTruthy();
      }
      expect(inviteStatus(expired.invite, now())).toBe('expired');
    } finally {
      nowMs -= 2 * DAY;
    }
  });

  it('invite: a code is used up after its uses, and records which account it created', async () => {
    const a = await makeApp({ registrationMode: 'invite' });
    const { code, invite: row } = await invite(2);
    const first = await register(a, { ...identity(), inviteCode: code.toLowerCase() });
    expect(first.statusCode).toBe(201);

    // A registration that fails after redeeming (email taken) gives the use back.
    const taken = await register(a, {
      ...identity(),
      email: first.json().account.email,
      inviteCode: code,
    });
    expect(taken.statusCode).toBe(409);
    let [stored] = await database.db.select().from(inviteCodes).where(eq(inviteCodes.id, row.id));
    expect(stored!.uses).toBe(1);

    const second = await register(a, { ...identity(), inviteCode: code.replace(/-/g, ' ') });
    expect(second.statusCode).toBe(201);
    const third = await register(a, { ...identity(), inviteCode: code });
    expect(third.statusCode).toBe(403);
    expect(third.json().error.code).toBe('invite_invalid');
    [stored] = await database.db.select().from(inviteCodes).where(eq(inviteCodes.id, row.id));
    expect(stored!.uses).toBe(2);
    expect(inviteStatus(stored!, now())).toBe('used_up');

    const audits = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'account.register'));
    for (const created of [first, second]) {
      const id = created.json().account.id as string;
      expect(audits.find((r) => r.accountId === id)?.data).toEqual({ inviteId: row.id });
    }
    const [account] = await database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, second.json().account.id));
    expect(account).toBeDefined();
    expect(JSON.stringify(audits)).not.toContain(code.replace(/-/g, ''));
  });

  it('revoke by id or code is idempotent and keeps created accounts', async () => {
    const a = await makeApp({ registrationMode: 'invite' });
    const { code, invite: row } = await invite(5);
    const created = await register(a, { ...identity(), inviteCode: code });
    expect(created.statusCode).toBe(201);
    expect((await revokeInvite(database.db, code, now()))?.changed).toBe(true);
    expect((await revokeInvite(database.db, row.id, now()))?.changed).toBe(false);
    expect(await revokeInvite(database.db, newInviteCode(), now())).toBeNull();
    expect(await revokeInvite(database.db, 'not-a-code', now())).toBeNull();
    expect((await register(a, { ...identity(), inviteCode: code })).statusCode).toBe(403);
    const login = await a.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: created.json().account.email, password: 'ashes-and-iron-42' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('registration attempts with bad codes count against the register rate limit', async () => {
    const a = await makeApp({
      registrationMode: 'invite',
      registerRateLimit: { max: 2, timeWindowMs: 60_000 },
    });
    for (let i = 0; i < 2; i++) {
      expect((await register(a, { ...identity(), inviteCode: newInviteCode() })).statusCode).toBe(
        403,
      );
    }
    const limited = await register(a, { ...identity(), inviteCode: newInviteCode() });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
  });
});
