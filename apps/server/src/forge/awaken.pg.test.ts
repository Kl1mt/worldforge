/**
 * Real-PostgreSQL races for Item Awakening (ticket 6.5b, docs/AWAKENING.md "As built"). Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). The awaken action takes
 * the idempotency key, the hero (settling first), then the item, like every Forge action; a shelf
 * move takes the shelf lock, the hero and its items; a trade send takes the account and hero rows
 * and then the items. Each race runs a few rounds in varied orders and asserts only what holds in
 * every order (CLAUDE.md "Races"): the price is paid at most once and only for an awakening that
 * happened, the item is in exactly one place, an awakened item is never escrowed, every holding
 * reconciles with the audit, and no request fails with a server error.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { awakeningCost, generateItem } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { auditLog, characterMaterials, characters, itemInstances } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { openWarehouse } from '../test/warehouse.js';
import { ALL_SHELF_ON, setShelfSwitches, shelfCalls } from '../test/shelf.js';
import {
  ALL_TRADING_ON,
  befriendSince,
  giveMaterials,
  insertTrader,
  setTradingSettings,
  tradeCalls,
  type Trader,
} from '../test/trading.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const ROUNDS = 4;
const HOUR = 3_600_000;
const GOLD = 200_000;

describe.skipIf(!url)('real PostgreSQL: awakening races safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  // Derived from the wall clock (CLAUDE.md "Dates").
  const nowMs = Math.floor(Date.now() / HOUR) * HOUR;
  const now = () => new Date(nowMs);

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 30 });
    app = buildApp({
      database,
      auth: {
        now,
        accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 },
        socialWriteLimit: { windows: [{ windowMs: 60_000, max: 10_000 }] },
        tradeWriteLimit: { windows: [{ windowMs: 60_000, max: 10_000 }] },
      },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    });
    await app.ready();
    await openWarehouse(app, database.db, now());
    await setShelfSwitches(app, database.db, ALL_SHELF_ON);
    await setTradingSettings(app, database.db, ALL_TRADING_ON);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const db = () => database.db;

  async function smith(): Promise<Trader> {
    const s = await insertTrader(db(), now(), { gold: GOLD });
    await giveMaterials(db(), s.hero.id, { tyrantsEmber: 9, gravewardenSeal: 6, soulShard: 90 });
    return s;
  }

  async function sword(characterId: string, seed: number) {
    const g = generateItem({
      seed,
      itemLevel: 37,
      baseId: 'longsword',
      rarityId: 'legendary',
      classId: 'warrior',
    })!;
    const [row] = await db()
      .insert(itemInstances)
      .values({
        id: uuidv7(),
        characterId,
        ...g,
        source: 'farming',
        binding: 'account',
        upgradeLevel: 10,
      })
      .returning();
    return row!;
  }

  const awaken = (s: Trader, itemId: string, key = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: `/api/characters/${s.hero.id}/forge/awaken`,
      payload: { itemId },
      headers: { 'idempotency-key': key },
      cookies: { wf_session: s.token },
    });

  const itemRow = async (id: string) =>
    (await db().select().from(itemInstances).where(eq(itemInstances.id, id)))[0]!;
  const gold = async (heroId: string) =>
    (await db().select().from(characters).where(eq(characters.id, heroId)))[0]!.gold;
  const embers = async (heroId: string) =>
    (
      await db()
        .select()
        .from(characterMaterials)
        .where(
          and(
            eq(characterMaterials.characterId, heroId),
            eq(characterMaterials.materialId, 'tyrantsEmber'),
          ),
        )
    )[0]?.quantity ?? 0;
  const awakenAudits = async (heroId: string) =>
    (
      await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.event, 'forge.awaken'), eq(auditLog.characterId, heroId)))
    ).length;

  /** Paid exactly once per awakened item, and nothing for a refused one. */
  async function expectPaidFor(s: Trader, awakenedItems: number, itemLevel = 37) {
    const price = awakeningCost({ itemLevel }).gold;
    expect(await awakenAudits(s.hero.id)).toBe(awakenedItems);
    expect(await gold(s.hero.id)).toBe(GOLD - awakenedItems * price);
    expect(await embers(s.hero.id)).toBe(9 - 3 * awakenedItems);
  }

  const noServerError = (codes: number[]) => expect(codes.filter((c) => c >= 500)).toEqual([]);

  it('awaken vs a shelf deposit of the same item: one place, paid once or not at all', async () => {
    const shelf = shelfCalls(app);
    const seen = new Set<string>();
    for (let round = 0; round < ROUNDS; round++) {
      const s = await smith();
      const item = await sword(s.hero.id, 100 + round);
      const calls = [
        () => awaken(s, item.id),
        () => shelf.move(s.token, s.hero.id, 'deposit', { itemIds: [item.id] }),
      ];
      const ordered = round % 2 === 0 ? calls : [...calls].reverse();
      const [first, second] = await Promise.all(ordered.map((f) => f()));
      const [aw, dep] = round % 2 === 0 ? [first!, second!] : [second!, first!];
      noServerError([aw.statusCode, dep.statusCode]);
      // The deposit never fails because of the awakening (awakened items may be shelved).
      expect(dep.statusCode).toBe(200);
      const after = await itemRow(item.id);
      expect(after.onShelf).toBe(true);
      expect(after.equippedSlot).toBeNull();
      if (aw.statusCode === 200) {
        seen.add('awakened first');
        expect(after.awakening).toEqual({ option: 'effect', effectStrength: 1.1 });
        await expectPaidFor(s, 1);
      } else {
        seen.add('shelved first');
        expect(aw.json().error.code).toBe('item_on_shelf');
        expect(after.awakening).toBeNull();
        await expectPaidFor(s, 0);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(1);
    expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
  });

  it('awaken vs a trade offer of the same item: never escrowed while awakened', async () => {
    const t = tradeCalls(app);
    for (let round = 0; round < ROUNDS; round++) {
      const s = await smith();
      const friend = await insertTrader(db(), now());
      await befriendSince(db(), s, friend, now());
      const item = await sword(s.hero.id, 200 + round);
      const calls = [
        () => awaken(s, item.id),
        () => t.send(s, friend, { give: { itemIds: [item.id] } }),
      ];
      const ordered = round % 2 === 0 ? calls : [...calls].reverse();
      const results = await Promise.all(ordered.map((f) => f()));
      const [aw, offer] = round % 2 === 0 ? results : [...results].reverse();
      noServerError([aw!.statusCode, offer!.statusCode]);
      const after = await itemRow(item.id);
      // A +10 item is bound (any Forge work binds); awakened or not, it never enters escrow.
      expect(offer!.statusCode).toBe(409);
      expect(after.escrowOfferId).toBeNull();
      expect(aw!.statusCode).toBe(200);
      expect(after.awakening).toEqual({ option: 'effect', effectStrength: 1.1 });
      await expectPaidFor(s, 1);
      // Once awakened, the refusal names it.
      const again = await t.send(s, friend, { give: { itemIds: [item.id] } });
      const checks = again.json().error.details.reasons.map((r: { check: string }) => r.check);
      expect(checks).toContain('item_awakened');
    }
    expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
  });

  it('a double submit with the same key awakens and pays once; a second key is refused', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const s = await smith();
      const item = await sword(s.hero.id, 300 + round);
      const key = randomUUID();
      const same = await Promise.all([1, 2, 3].map(() => awaken(s, item.id, key)));
      noServerError(same.map((r) => r.statusCode));
      // Every answer is the one awakening (or "this key is still in use", never a second pay).
      for (const r of same) expect([200, 409]).toContain(r.statusCode);
      expect(same.some((r) => r.statusCode === 200)).toBe(true);
      await expectPaidFor(s, 1);
      const other = await Promise.all([1, 2].map(() => awaken(s, item.id)));
      noServerError(other.map((r) => r.statusCode));
      for (const r of other) expect(r.json().error.code).toBe('already_awakened');
      await expectPaidFor(s, 1);
    }
    // Two different items at once on one hero: both awaken, each paid once.
    const s = await smith();
    const [a, b] = [await sword(s.hero.id, 400), await sword(s.hero.id, 401)];
    const both = await Promise.all([awaken(s, a.id), awaken(s, b.id)]);
    expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
    await expectPaidFor(s, 2);
    expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
  });
});
