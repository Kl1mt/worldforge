/**
 * Real-PostgreSQL races for ticket 6.11's sinks (docs/COSMETICS.md "The exchange and
 * engravings"). Runs when `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`).
 * Several heroes of one account buy the same exchange offer at once (and engrave at once): the
 * cosmetic is granted exactly once, paid exactly once, and every holding reconciles with the
 * audit. Asserts only what holds in every order (CLAUDE.md "Races").
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { auditLog, characterMaterials, cosmeticUnlocks, itemInstances } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertCharacter, insertItem } from '../test/heroes.js';
import { giveMaterials, insertTrader } from '../test/trading.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const N = 5;
const ROUNDS = 3;
const HOUR = 3_600_000;

describe.skipIf(!url)('real PostgreSQL: the exchange and the engraver race safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  const nowMs = Math.floor(Date.now() / HOUR) * HOUR;
  const now = () => new Date(nowMs);

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: N * 2 + 4 });
    app = buildApp({
      database,
      auth: {
        now,
        accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 },
      },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const db = () => database.db;
  const post = (token: string, url: string, payload: object) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'idempotency-key': randomUUID() },
      cookies: { wf_session: token },
    });
  const seals = async (characterId: string) =>
    (
      await db()
        .select()
        .from(characterMaterials)
        .where(
          and(
            eq(characterMaterials.characterId, characterId),
            eq(characterMaterials.materialId, 'gravewardenSeal'),
          ),
        )
    )[0]?.quantity ?? 0;

  it('heroes of one account buying the same offer at once: one grant, one payment', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const s = await insertTrader(db(), now());
      const heroes = [s.hero.id];
      for (let i = 1; i < N; i += 1) heroes.push((await insertCharacter(db(), s.id)).id);
      for (const h of heroes) await giveMaterials(db(), h, { gravewardenSeal: 10 });
      const ordered = round % 2 === 0 ? heroes : [...heroes].reverse();
      const results = await Promise.all(
        ordered.map((h) =>
          post(s.token, `/api/characters/${h}/exchange`, { cosmeticId: 'crest.seal-wax' }),
        ),
      );
      const codes = results.map((r) => r.statusCode);
      expect(
        codes.filter((c) => c === 200),
        JSON.stringify(codes),
      ).toHaveLength(1);
      expect(
        codes.every((c) => c === 200 || c === 409),
        JSON.stringify(codes),
      ).toBe(true);
      let left = 0;
      for (const h of heroes) left += await seals(h);
      expect(left).toBe(10 * N - 4);
      const rows = await db()
        .select()
        .from(cosmeticUnlocks)
        .where(eq(cosmeticUnlocks.accountId, s.id));
      expect(rows.map((r) => r.cosmeticId)).toEqual(['crest.seal-wax']);
      const audits = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.accountId, s.id), eq(auditLog.event, 'cosmetic.exchange')));
      expect(audits).toHaveLength(1);
    }
  });

  it('engravings racing on one item each pay for what they wrote', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const s = await insertTrader(db(), now());
      await giveMaterials(db(), s.hero.id, { gravewardenSeal: 2 * N });
      const sword = await insertItem(db(), s.hero.id, { rarityId: 'epic' });
      const words = ['ashbound', 'unbowed', 'oathworn', 'nameless', 'last-light'].slice(0, N);
      const results = await Promise.all(
        words.map((w) =>
          post(s.token, `/api/characters/${s.hero.id}/forge/engrave`, {
            itemId: sword.id,
            finish: 'seal',
            engravingId: w,
          }),
        ),
      );
      const ok = results.filter((r) => r.statusCode === 200).length;
      expect(results.every((r) => r.statusCode === 200 || r.statusCode === 409)).toBe(true);
      expect(await seals(s.hero.id)).toBe(2 * N - 2 * ok);
      const engraves = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.accountId, s.id), eq(auditLog.event, 'forge.engrave')));
      expect(engraves).toHaveLength(ok);
      const [row] = await db().select().from(itemInstances).where(eq(itemInstances.id, sword.id));
      // The item bears the last engraving written.
      const last = engraves
        .sort((a, b) => Number(a.data.forgeCounter) - Number(b.data.forgeCounter))
        .at(-1)!;
      expect(row!.engraving).toBe(last.data.engraving);
    }
    const checks = await reconcileWithAudit(db());
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });
});
