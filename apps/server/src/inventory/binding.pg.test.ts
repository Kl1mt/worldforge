/**
 * Real-PostgreSQL races for item binding (ticket T.1, docs/TRADING.md). Runs when `DATABASE_URL`
 * is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Equip and every Forge action lock the
 * character, then the item, and set the binding in their own transaction; the backfill takes item
 * rows with `skip locked` and only writes rows still unbound. Three rounds each in varied orders,
 * asserting only what holds in every order, no retries.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { generateItem, itemBinding } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  accounts,
  auditLog,
  characterMaterials,
  characters,
  dataBackfills,
  itemInstances,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { ITEM_BINDING_BACKFILL_ID, backfillItemBinding } from './binding-backfill.js';
import { itemBindingColumns } from './columns.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const ROUNDS = 3;

describe.skipIf(!url)('real PostgreSQL: item binding races safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  const nowMs = Date.parse('2031-08-01T10:00:00Z');

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 20 });
    app = buildApp({
      database,
      auth: { accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  beforeEach(async () => {
    await db().delete(dataBackfills);
  });

  const db = () => database.db;
  const post = (who: TestAccount, path: string, payload?: object, keyed = false) =>
    app.inject({
      method: 'POST',
      url: `/api${path}`,
      ...(payload ? { payload } : {}),
      headers: keyed ? { 'idempotency-key': randomUUID() } : {},
      cookies: { [SESSION_COOKIE]: who.token },
    });
  const row = async (id: string) =>
    (await db().select().from(itemInstances).where(eq(itemInstances.id, id)))[0]!;

  async function smith() {
    const who = await insertAccount(db());
    const c = await insertCharacter(db(), who.id, { level: 14 });
    await db().update(accounts).set({ activeCharacterId: c.id }).where(eq(accounts.id, who.id));
    await db().update(characters).set({ gold: 1_000_000 }).where(eq(characters.id, c.id));
    await db()
      .insert(characterMaterials)
      .values(
        (['timber', 'rawHide', 'ironOre', 'soulShard'] as const).map((materialId) => ({
          characterId: c.id,
          materialId,
          quantity: 10_000,
        })),
      );
    return { who, id: c.id };
  }

  /** A fresh Epic; `legacy` writes it as pre-T.1 code did (no binding). */
  async function epic(h: { who: TestAccount; id: string }, legacy = false) {
    const item = generateItem({ seed: 9, itemLevel: 14, baseId: 'barbute', rarityId: 'epic' })!;
    const id = uuidv7();
    await db()
      .insert(itemInstances)
      .values({
        id,
        characterId: h.id,
        ...item,
        ...(legacy ? {} : itemBindingColumns(item, 'farming', h.who.id)),
        source: 'farming',
      });
    return id;
  }

  async function forgeAudits(characterId: string, itemId: string) {
    return (
      await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.characterId, characterId), eq(auditLog.event, 'forge.upgrade')))
    ).filter((a) => (a.data as { itemId: string }).itemId === itemId);
  }

  it('equip racing a Forge upgrade on one item: both commit, bound once', async () => {
    const h = await smith();
    for (let round = 0; round < ROUNDS; round++) {
      const id = await epic(h);
      const equip = () => post(h.who, `/characters/${h.id}/items/${id}/equip`);
      const upgrade = () => post(h.who, `/characters/${h.id}/forge/upgrade`, { itemId: id }, true);
      const calls = round % 2 === 0 ? [equip, upgrade] : [upgrade, equip];
      const results = await Promise.all(calls.map((f) => f()));
      for (const r of results) expect(r.statusCode, r.body).toBe(200);
      const r = await row(id);
      expect(r).toMatchObject({ binding: 'account', boundAccountId: h.who.id, forgeCounter: 1 });
      expect(r.firstEquippedAt?.getTime()).toBe(nowMs);
      expect(itemBinding(r).binding).toBe('account');
      expect(await forgeAudits(h.id, id)).toHaveLength(1);
      expect((await post(h.who, `/characters/${h.id}/items/${id}/unequip`)).statusCode).toBe(200);
    }
  });

  it('the backfill racing equip and an upgrade on a legacy item never undoes them', async () => {
    const h = await smith();
    for (let round = 0; round < ROUNDS; round++) {
      await db().delete(dataBackfills);
      const id = await epic(h, true);
      const calls = [
        () => post(h.who, `/characters/${h.id}/items/${id}/equip`),
        () => post(h.who, `/characters/${h.id}/forge/upgrade`, { itemId: id }, true),
        () => backfillItemBinding(db(), { now: () => new Date(nowMs), force: true }),
      ];
      const order = [calls[round % 3]!, calls[(round + 1) % 3]!, calls[(round + 2) % 3]!];
      const results = await Promise.all(order.map((f) => f()));
      for (const r of results) {
        if ('statusCode' in r) expect(r.statusCode, r.body).toBe(200);
      }
      const r = await row(id);
      // Whoever came first, the item ends worn, forged once and account-bound to its owner.
      expect(r).toMatchObject({ binding: 'account', boundAccountId: h.who.id, forgeCounter: 1 });
      expect(r.firstEquippedAt?.getTime()).toBe(nowMs);
      expect(await forgeAudits(h.id, id)).toHaveLength(1);
      expect((await post(h.who, `/characters/${h.id}/items/${id}/unequip`)).statusCode).toBe(200);
    }
  });

  it('skips a row a request holds, records nothing, and finishes on the next pass', async () => {
    const h = await smith();
    const held = await epic(h, true);
    const free = await epic(h, true);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = db().transaction(async (tx) => {
      await tx.execute(sql`select id from item_instances where id = ${held} for update`);
      locked();
      await released;
    });
    await isLocked;
    const first = await backfillItemBinding(db(), { now: () => new Date(nowMs) });
    expect(first.skipped).toBeGreaterThanOrEqual(1);
    expect((await row(held)).binding).toBeNull();
    expect((await row(free)).binding).toBe('equip');
    expect(
      await db().select().from(dataBackfills).where(eq(dataBackfills.id, ITEM_BINDING_BACKFILL_ID)),
    ).toHaveLength(0);
    release();
    await holder;
    const second = await backfillItemBinding(db(), { now: () => new Date(nowMs) });
    expect(second).toMatchObject({ ran: true, skipped: 0 });
    expect((await row(held)).binding).toBe('equip');
    expect(
      await db().select().from(itemInstances).where(isNull(itemInstances.binding)),
    ).toHaveLength(0);
    expect(
      await db().select().from(dataBackfills).where(eq(dataBackfills.id, ITEM_BINDING_BACKFILL_ID)),
    ).toHaveLength(1);
  });
});
