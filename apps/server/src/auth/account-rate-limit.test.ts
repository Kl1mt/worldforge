/**
 * Per-account rate limits on the game routes (ticket 3.9, docs/API_CONVENTIONS.md "Rate limits").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { auditLog, characters } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { DEFAULT_ACCOUNT_RATE_LIMIT } from './account-rate-limit.js';
import { SESSION_COOKIE } from './index.js';

const LIMIT = { requests: 12, actions: 4, windowMs: 60_000 };

let database: DatabaseHandle;
let app: FastifyInstance;
/** The session and rate-limit clock (real time in production). */
let nowMs = Date.parse('2026-11-06T09:00:00Z');

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: {
      registerRateLimit: { max: 1000, timeWindowMs: 60_000 },
      accountRateLimit: LIMIT,
      now: () => new Date(nowMs),
    },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

let n = 0;
async function player() {
  n += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `limited-${n}@graumark.test`,
      displayName: `Limited ${n}`,
      password: 'ashes-and-iron-42',
    },
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const call = (
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
      cookies: { [SESSION_COOKIE]: token },
    });
  return { call, accountId: res.json<{ account: { id: string } }>().account.id };
}

async function hero(call: Awaited<ReturnType<typeof player>>['call'], name: string) {
  const res = await call('POST', '/api/characters', {
    name,
    classId: 'warrior',
    appearance: { banner: 'ash' },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ character: { id: string } }>().character.id;
}

const expectLimited = (res: LightMyRequestResponse, limit: 'actions' | 'requests') => {
  expect(res.statusCode).toBe(429);
  const body = res.json<{
    error: { code: string; details: { retryAfterSeconds: number; limit: string } };
  }>();
  expect(body.error.code).toBe('rate_limited');
  expect(body.error.details.limit).toBe(limit);
  expect(Number(res.headers['retry-after'])).toBe(body.error.details.retryAfterSeconds);
  return body.error.details.retryAfterSeconds;
};

describe('per-account rate limits (ticket 3.9)', () => {
  it('limits actions per account with 429, Retry-After and details; reads go on; the window resets', async () => {
    nowMs += 10 * 60_000;
    const { call } = await player();
    const id = await hero(call, 'Ratewarden'); // action 1
    const base = `/api/characters/${id}`;
    expect((await call('POST', `${base}/activity`, { areaId: 'abandonedFields' })).statusCode).toBe(
      201,
    ); // 2
    expect((await call('POST', `${base}/activity/settle`)).statusCode).toBe(200); // 3
    expect((await call('POST', `${base}/activity/settle`)).statusCode).toBe(200); // 4
    nowMs += 20_000;
    const retry = expectLimited(await call('POST', `${base}/activity/settle`), 'actions');
    expect(retry).toBe(40);
    // Reads still count against the request limit, but are not actions.
    expect((await call('GET', `${base}/inventory`)).statusCode).toBe(200);
    // After the window the account may act again.
    nowMs += retry * 1000;
    expect((await call('POST', `${base}/activity/settle`)).statusCode).toBe(200);
  });

  it('limits all requests per account; a refused request is not counted', async () => {
    nowMs += 10 * 60_000;
    const { call } = await player();
    for (let i = 0; i < LIMIT.requests; i++) {
      expect((await call('GET', '/api/characters')).statusCode).toBe(200);
    }
    expectLimited(await call('GET', '/api/characters'), 'requests');
    expectLimited(await call('GET', '/api/account'), 'requests');
    nowMs += LIMIT.windowMs;
    // Refusals did not extend or refill the window.
    expect((await call('GET', '/api/characters')).statusCode).toBe(200);
  });

  it('counts per account: other characters share it, other accounts and logged-out calls do not', async () => {
    nowMs += 10 * 60_000;
    const a = await player();
    const b = await player();
    const first = await a.call('POST', '/api/characters', {
      name: 'Shareda',
      classId: 'mage',
      appearance: { banner: 'ash' },
    });
    expect(first.statusCode).toBe(201);
    await hero(a.call, 'Sharedb');
    const [one, two] = (await a.call('GET', '/api/characters')).json<{
      characters: { id: string }[];
    }>().characters;
    expect((await a.call('POST', `/api/characters/${one!.id}/select`)).statusCode).toBe(200);
    expect((await a.call('POST', `/api/characters/${two!.id}/select`)).statusCode).toBe(200);
    // Four actions spent across two characters of one account.
    expectLimited(await a.call('POST', `/api/characters/${one!.id}/select`), 'actions');
    // Another account is unaffected, and so is an unauthenticated request (401, not counted).
    await hero(b.call, 'Unbothered');
    expect((await app.inject({ method: 'GET', url: '/api/characters' })).statusCode).toBe(401);
  });

  it('refuses before any game work: nothing runs, nothing is audited, the idempotency key stays free', async () => {
    nowMs += 10 * 60_000;
    const { call, accountId } = await player();
    const id = await hero(call, 'Patienta'); // 1
    await database.db.update(characters).set({ gold: 500 }).where(eq(characters.id, id));
    for (let i = 0; i < 3; i++) {
      expect((await call('POST', `/api/characters/${id}/select`)).statusCode).toBe(200); // 2–4
    }
    const audits = async () =>
      (
        await database.db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.accountId, accountId), eq(auditLog.event, 'merchant.buy')))
      ).length;
    const shop = await call('GET', `/api/characters/${id}/merchant`);
    const offer = shop.json<{ offers: { offerId: string; price: number }[] }>().offers[0]!;
    const key = randomUUID();
    const buy = () =>
      call(
        'POST',
        `/api/characters/${id}/merchant/buy`,
        { offerId: offer.offerId },
        { 'idempotency-key': key },
      );
    expectLimited(await buy(), 'actions');
    expect(await audits()).toBe(0);
    const [row] = await database.db.select().from(characters).where(eq(characters.id, id));
    expect(row!.gold).toBe(500);
    // The same key works after the window: the refused attempt never claimed it.
    nowMs += LIMIT.windowMs;
    const later = await buy();
    expect(later.statusCode).toBe(200);
    expect(later.headers['idempotency-replayed']).toBeUndefined();
    expect(await audits()).toBe(1);
  });

  it('the defaults fit a busy minute of play in three tabs at once', () => {
    const { requests, actions, windowMs } = DEFAULT_ACCOUNT_RATE_LIMIT;
    expect(windowMs).toBe(60_000);
    // Per tab and minute: the web client's polls are POSTs (farming settle every 8 s, the crypt
    // run every 2 s; SETTLE_POLL_MS, CRYPT_POLL_MS), plus a click a second and a read a second.
    const polls = 60 / 8 + 60 / 2;
    const clicks = 60;
    const reads = 60;
    expect(actions).toBeGreaterThanOrEqual(3 * (polls + clicks));
    expect(requests).toBeGreaterThanOrEqual(3 * (polls + clicks + reads));
  });
});
