/**
 * Real-PostgreSQL races for the trading settings (ticket T.2, docs/TRADING.md "T.2 as built").
 * Runs when `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). An edit locks
 * the `game_settings` row (`for update`) and names the version it was made from; a first save
 * racing another first save loses on the primary key. Three rounds each in varied orders,
 * asserting only what holds in every order, no retries.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { DEFAULT_TRADING_SETTINGS, type TradingSettings } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { auditLog, gameSettings } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertAccount, type TestAccount } from '../test/social.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const ROUNDS = 3;
const ADMINS = 4;

describe.skipIf(!url)('real PostgreSQL: trading settings edits race safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  const admins: TestAccount[] = [];

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 20 });
    app = buildApp({
      database,
      auth: { accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 } },
    });
    await app.ready();
    for (let i = 0; i < ADMINS; i++) {
      admins.push(await insertAccount(database.db, { role: 'admin' }));
    }
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const save = (as: TestAccount, settings: TradingSettings, expectedVersion: number) =>
    app.inject({
      method: 'PUT',
      url: '/api/admin/settings/trading',
      payload: { expectedVersion, settings },
      headers: { 'idempotency-key': randomUUID() },
      cookies: { [SESSION_COOKIE]: as.token },
    });

  const settingsFor = (n: number): TradingSettings => {
    const s = JSON.parse(JSON.stringify(DEFAULT_TRADING_SETTINGS)) as TradingSettings;
    s.limits.goldPerWeek = 1_000 + n;
    s.trading = n % 2 === 0;
    return s;
  };

  const stored = async () => {
    const [row] = await database.db
      .select()
      .from(gameSettings)
      .where(eq(gameSettings.key, 'trading'));
    const audits = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'settings.update'));
    return { row, audits };
  };

  it('admins saving from one version at once: exactly one wins, every round', async () => {
    let n = 0;
    for (let round = 0; round < ROUNDS; round++) {
      // Round 0 races the first-ever save (no row yet: the insert path).
      const { row } = await stored();
      const from = row?.version ?? 0;
      const order = [...admins.keys()];
      if (round % 2 === 1) order.reverse();
      const tries = order.map((i) => ({ i, settings: settingsFor((n += 1)) }));
      const results = await Promise.all(tries.map((t) => save(admins[t.i]!, t.settings, from)));
      const won = results.flatMap((r, k) => (r.statusCode === 200 ? [tries[k]!] : []));
      expect(won).toHaveLength(1);
      for (const r of results) {
        if (r.statusCode !== 200) {
          expect(r.statusCode).toBe(409);
          expect(r.json().error.code).toBe('settings_conflict');
        }
      }
      const after = await stored();
      expect(after.row?.version).toBe(from + 1);
      expect(after.row?.value).toEqual(won[0]!.settings);
      expect(after.row?.updatedBy).toBe(admins[won[0]!.i]!.id);
      // Audit = holdings: one row per version, the newest naming the winner.
      expect(after.audits).toHaveLength(from + 1);
      const versions = after.audits.map((a) => (a.data as { version: number }).version).sort();
      expect(versions).toEqual(Array.from({ length: from + 1 }, (_, k) => k + 1));
    }
  });

  it('chained saves that each read the latest version all land, in order', async () => {
    const { row } = await stored();
    let version = row?.version ?? 0;
    for (let round = 0; round < ROUNDS; round++) {
      const res = await save(admins[round % ADMINS]!, settingsFor(100 + round), version);
      expect(res.statusCode).toBe(200);
      version = res.json().version;
    }
    const after = await stored();
    expect(after.row?.version).toBe(version);
    expect(after.audits).toHaveLength(version);
  });
});
